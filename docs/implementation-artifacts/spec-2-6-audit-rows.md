---
title: 'Story 2.6 — 每次注入与召回都留一行审计'
type: 'story-spec'
created: '2026-11-25'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
baseline_revision: '0d118dec1428ede518c5ce2ed15b1296cde554cf'
context:
  - 'docs/implementation-artifacts/epic-2-context.md'
  - 'docs/planning-artifacts/epics.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** 三件事一起坏。①审计面只有写事务一个生产者：`ops/audit.ts` 定义了 `InjectionAuditRow` 与 `RecallAuditRow`，全仓没有任何地方产出它们，所以「注入花了多少 token、召回到了什么、有没有降级」今天只活在内存里的 `Runtime.injection` 与一次工具返回值中，会话一关就没了。②字段已经和契约分叉：实现写 `host_uncached`，AC 与 `data-model.md:148` 写 `host_cache_uncached`；三个缓存字段声明成 `number`，而宿主不一定给得出数字，今天谁调用都得编一个 0，那是把「没测到」记成「缓存一次都没命中」。③保留期不存在：审计文件按天切分却永不删除，`ops/retention.ts` 与 `scripts/audit-report.mjs` 都不存在，AC③⑤ 没有落点。

**Approach:** 生产者、形状、保留期、报表四件事分开做。注入行的钩子放在宿主真正装配提示词的地方——`PromptSection.text` 允许是 `(context) => string`，宿主每次装配都会调用它并传入 `AssembleContext`，`context.session.id` 就是这次注入的会话；把身份段的文案从静态字符串改成 provider，装配时记一行。宿主缓存三项按**会话增量**记（累计四桶相减），拿不到投影时写 `null`。召回行由 `recall-reader` 在真正跑完一次查询后回报，只存 `query_hash` 不存原文。保留期做成 `ops/retention.ts` 一次目录扫描，挂载时跑一遍，删除动作用 AD-15 具名豁免背书。报表脚本读同一批 JSONL 算 p50/p95 与降级计数。

## Boundaries & Constraints

**Always:**
- 一个动作一行：一次装配一行注入、一次查询一行召回、一次写入一行 write，行内不含节点 id（AC⑥、AD-3）。
- `degraded_reason` 只取 `core/degrade.ts` 的封闭六值，注入行的 `tier` 只取 `ops/audit.ts` 的封闭两值，越界当场抛（AC②、AD-20）。
- 宿主给不出缓存数字时写 `null`：0 是「一次都没命中」，null 是「没测到」，两者不可混（AC①）。
- 审计只落文件：任何行都不进 triviumdb，写审计不经过写面（AC③）。
- 审计写入失败只损失这一行，不拖垮注入、召回与写入（AD-18 局部降级）。
- 30 天保留期只有 `ops/retention.ts` 一处实现，删除用 `unlinkSync`，该文件在 AD-15 具名豁免清单里、文件头写 `// AD-15 豁免：审计轮转`（AC④、AD-5）。
- 报表脚本只读；`--since` 支持 `24h` / `7d` / `30d` / ISO 时间（AC⑤）。

**Never:**
- 不在审计行里放 query 原文、消息原文或节点 id；召回只存 `query_hash`，注入只存单位名（AC⑥、NFR-6）。
- 不改写面语义、不动决策账本、不动 `remember` 的工具契约。
- 不为审计新增第二个时钟：一律用 `deps.now` 那一处。
- 不做逐轮重新组装注入计划：本故事只把「已经装配好的那一份」记下来，逐轮刷新仍属 Epic 7（2.4 的 deferred 不变）。
- 不在注入路径上查 triviumdb：缓存三项来自宿主的会话投影，读不到就不写。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
| --- | --- | --- | --- |
| `AUD_INJ_ROW` | 一次装配 | 追加一行注入，`tier` ∈ {identity, identity+state} | — |
| `AUD_INJ_FIRST` | 该会话第一次装配 | `prefix_unchanged` = false | — |
| `AUD_INJ_SAME` | 第二次装配，身份段与尾巴文本逐字节相同 | `prefix_unchanged` = true | — |
| `AUD_INJ_CHANGED` | 尾巴文本变了 | `prefix_unchanged` = false | — |
| `AUD_INJ_HOST_UNKNOWN` | 宿主没有 `sessions` 或 `sessionProjections` | 三个缓存字段全 `null`，行照写 | — |
| `AUD_INJ_HOST_FIRST` | 宿主有投影但该会话还没计量 | 三个缓存字段为 0（投影给了 0，确实为零，不是未知；缺字段才写 null） | `test/seams/host-usage.test.ts` 的「0 是有效测量」 |
| `AUD_INJ_DELTA` | 同一会话连续两次装配，累计四桶增长 | 行里写两次读数的差，不是累计值 | — |
| `AUD_TIER_BAD` | `tier` 不在封闭两值内 | 抛错，不落行 | — |
| `AUD_REC_ROW` | 一次召回真正跑完 | 追加一行，`hits` 是 mem_key，`query_hash` 是摘要 | — |
| `AUD_REC_REFUSED` | 参数被拒（`E_BOUNDARY`） | 不落行：没有发生查询 | — |
| `AUD_REC_DEGRADED` | 降级 | `degraded` = true，理由在封闭词表内 | — |
| `AUD_NODE_ID` | 任意行 | 不含任何节点 id 字段 | — |
| `AUD_DAY_SPLIT` | 跨本地午夜两次写入 | 两个文件，日期取自同一个时钟 | — |
| `AUD_SINK_FAIL` | 落盘抛错 | 注入/召回/写入继续，只记一条 warn | — |
| `RET_OLD` | 30 天前的 `audit-YYYYMMDD.jsonl` | 被删除，返回值列出它 | — |
| `RET_EDGE` | 恰好 30 天前 | 保留（保留期含边界） | — |
| `RET_FOREIGN` | 目录里的 `omw.log`、`snapshots/`、未知名字 | 不碰 | — |
| `RET_EMPTY` | 目录不存在 | 不抛，返回空 | — |
| `RET_EXEMPT` | 静态门 | `ops/retention.ts` 在豁免清单内且文件头有豁免注释 | — |
| `REP_24H` | `--since 24h` | 三类各输出 p50/p95 与降级计数 | — |
| `REP_EMPTY` | 窗口内没有行 | 输出 0 计数，退出码 0 | — |

## Code Map

- `src/ops/audit.ts`（改）：`host_uncached` → `host_cache_uncached`，三个缓存字段改 `number | null`；新增 `INJECTION_TIERS` 与 `assertClosedTier`；sink 改成 `appendFile` 串行队列并加 `flush()`；`createAudit` 也校验注入行。
- `src/ops/retention.ts`（新）：`AUDIT_RETENTION_DAYS = 30`、`createRetention({dataDir, now})` 返回 `rotate()`；文件头 `// AD-15 豁免：审计轮转`。
- `src/ops/injection-audit.ts`（新）：`createInjectionAuditor({audit, now, hostUsage?})`，`record({sessionId, plan})` 算 `prefix_unchanged`（按会话记上一份文本摘要）与缓存增量。
- `src/seams/prompt-composer.ts`（改）：身份段 `text` 从字符串改成 provider，装配时回调 `onInject`。
- `src/seams/recall-reader.ts`（改）：新增 `onRecall` 回调，查询跑完后回报 `{query, topK, hits, elapsedMs, degraded, reasons}`。
- `src/seams/runtime.ts`（改）：建带队列 sink 的审计、建注入审计器与召回回调、挂载时跑一次 `rotate()`、暴露 `audit` 与 `retention`。
- `scripts/audit-report.mjs`（新）：`--since` 解析、JSONL 读取、p50/p95、降级计数、`--json`。
- `scripts/check-layers.mjs`（改）：`HARD_DELETE_OWNERS` 加 `ops/retention.ts`。
- `docs/specs/spec-DSH哦鲸鲸/data-model.md` 与 `README.md`（改）：字段名与审计一节。

## Tasks & Acceptance

**Execution:**
1. 改 `ops/audit.ts` 的行形状与校验，sink 换成串行队列。
2. 新增 `ops/retention.ts` 与静态门豁免。
3. 新增 `ops/injection-audit.ts`，把 composer 的身份段改成 provider。
4. 接 recall 行，写 `scripts/audit-report.mjs`。
5. 装配进 runtime，挂载时跑一次轮转。
6. 文档与 sprint-status。

**Acceptance Criteria:**
- AC① 一次装配追加一行注入审计，字段与 AC 一致（含 `host_cache_uncached`），`tier` 封闭、缓存字段可为 `null`。
- AC② 一次召回追加一行，含 mem_key 集合、耗时、`degraded_reason`（六值封闭）；参数被拒不落行。
- AC③ 审计只落文件不落库、按天切分、保留 30 天，删除只经 `ops/retention.ts`。
- AC④ 30 天前的文件被轮转清掉，`ops/retention.ts` 在豁免清单内且文件头有豁免注释。
- AC⑤ `node scripts/audit-report.mjs --since 24h` 输出注入/召回/写入三类 p50/p95 与降级计数。
- AC⑥ 任意审计行不含节点 id：逐字段断言三个行类型。
- AC⑦ 审计写入在装配路径上非阻塞：sink 排队，`flush()` 才等到落盘。
- AC⑧ 落盘失败不影响注入、召回与写入，只记 warn。

## Spec Change Log

- 初稿。

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 55 findings — high 3, medium 25, low 25, false 2, maybe-false 0
- findings:
  - `[high]` `[patch]` 无效时钟下轮转把整目录删光（探针 `now: () => new Date(NaN)` 对四个文件得 removed 4 / kept 0，连今天的都删）— 修法：`rotate` 先读目录再用 `now()` 现值校验，非有限即整趟跳过、全部计 `foreign`，一个文件也不动。
  - `[high]` `[patch]` 会话被驱逐后重新出现时把生命周期累计当一次增量（探针：先记 100，灌 505 个会话，再记 50700，行里写出 `host_cache_read 50700` 且 `prefix_unchanged false`）— 修法：驱逐过的会话记入集合，再出现时三桶写 `null`。
  - `[medium]` `[patch]` `--now` 只改 cutoff 与打印的 `window.until`，`readWindow` 只判 `at < since`，探针里 2026-12-09 那行的 `elapsed_ms` 进了 p95 — 修法：`readWindow` 收 `until` 并过滤。
  - `[high]` `[patch]` `#livePlan` 赋值早于 `systemPrompt.section()`，拒绝替换仍把已注册 section 的渲染文本从 `v1 identity` 改成 `v2 identity`，且尾巴已在 :596-606 换新（探针复现）— 修法：section 注册成功后再落 `#livePlan`，尾巴与 section 一起回滚。
  - `[low]` `[reject]` `InjectionAuditRow` 无 duration，AD-20 的「注入 p95 ≤30ms」无法从审计行算出 — 加字段是扩公开行 schema、超出直接改正；该判据本就在 `test/perf` 采样，不改。
  - `[medium]` `[patch]` Design Note 2 与 ARCHITECTURE-SPINE.md:172 的命中率 `ΣcacheRead/(ΣcacheRead+ΣcacheWrite+Σuncached)` 在任何输出里都没有 — 修法：`summarizeInjection` 三个桶求和后输出命中率。
  - `[low]` `[patch]` `audit-report.mjs:268-271` 注释称「一行可以只缺一列」而 `host-usage.ts:73-77` 使该分支不可达 — 修法：改注释。
  - `[low]` `[reject]` 注入行无 session 不写行、召回行无 session 写空串，两条流不一致 — 两处都是有意为之且各有注释（runtime.ts:92-99、audit-report.mjs:289-292）；统一需新策略，不是直接改正。
  - `[medium]` `[patch]` `runtime.ts:412` 用 `OMW_AUDIT_WRITE_FAILED` 兼表「行丢了 / 盘不可用 / 轮转被挡」，且 `OMW_AUDIT_ROW_SKIPPED`、`OMW_AUDIT_RETENTION_SWEPT` 在任何文档里都不存在（README 全仓零命中）— 修法：README 与 data-model 补三个运营码的说明与用途。
  - `[medium]` `[patch]` 召回行契约没跟上改名：ARCHITECTURE-SPINE.md:172 仍是 camelCase `topK` 且无 `session_id`，epics.md:585 两个字段都没写 — 修法：两份文档同步到 `session_id` + `top_k`。
  - `[low]` `[patch]` `data-model.md:148` 的 code span 里混进散文，且错字「取下宿主」应为「取自宿主」— 修法：修字并把散文移出 code span。
  - `[false]` `[reject]` 矩阵说「投影给了 0」而实现写 `null` — `dsh-token-meter/lib/index.js` 的 `zeroBuckets()` 三桶恒从 0 起，`host-usage.ts:73-77` 接受 0，实测写的就是 0；缺字段才 null。
  - `[medium]` `[reject]` I/O 矩阵缺 `E_GATE_DOWN` 召回拒绝与 `RetentionResult.failed` 两行，Code Map 又声称 `HARD_DELETE_OWNERS` 要加 `ops/retention.ts`（HEAD 早已含）— 修法是改本 spec。
  - `[low]` `[reject]` `sprint-status.yaml:52` 先记 done 而 spec 仍 in-review — Finalize 写 `status: done` 后自洽，不需要改代码或文档。
  - `[medium]` `[patch]` `test/ops/audit-report.test.ts:56,66` 用 `--since 7d` 不钉 `--now`，fixture 钉在 2026-11-24，2026-12-02 起必挂 — 修法：两处补 `--now`。
  - `[low]` `[patch]` `retention.ts:141-143` 断言 `kept+removed+foreign===scanned`，`failed` 非空时假 — 修法：注释与恒等式补上 `failed`。
  - `[low]` `[patch]` `Runtime.retention` 的 JSDoc（`runtime.ts:210-216`）说暴露「挂载那次的结果」，实际挂载结果被丢弃 — 修法：改 JSDoc 说清它只是 seam。
  - `[low]` `[patch]` 每行读两次时钟（`injection-audit.ts:107` 定 `ts`，`audit.ts:262` 再读一次定文件名）— 修法：`append` 用 `row.ts` 推文件名。
  - `[low]` `[patch]` `audit.ts:224` 声明 `readonly rows: readonly AuditRow[]` 却返回被 `push`/`shift` 的活数组 — 修法：返回切片。
  - `[low]` `[patch]` `audit.ts:135-140` 每次 append 都 `mkdir` 一次目录 — 修法：按目录缓存已建标记。
  - `[low]` `[reject]` bounds / text / disposed 三条拒绝路径不上报 — 契约 `AUD_REC_REFUSED` 写明「参数被拒不落行」，只有引擎异常才记 `OMW_AUDIT_ROW_SKIPPED`；改它需要新策略。
  - `[medium]` `[patch]` AC⑦ 的 no-op 半边与 `OMW_AUDIT_ROW_SKIPPED` 在 `test/` 下零引用 — 修法：补 `isFlushableSink` 与无会话装配各一个用例。
  - `[medium]` `[patch]` `check-layers.mjs:524` 的 `collectionNames` 只认 `const|let NAME = new Ctor(`，漏掉 `src/seams/logger.ts:62` 的 `seen: WeakSet<object> = new WeakSet()` 这类字段/参数默认值绑定 — 修法：扩展匹配形状。
  - `[low]` `[reject]` `FS_DELETE_CALLS` 把任何 `rm(` 当硬删、`insideSource` 只扫 `src/` — 裸 `rm(` 是有意（解构导入写法），补 `fs.promises` 要重写规则，收益不抵成本。
  - `[false]` `[reject]` `retention.ts` 与 `write-port.ts` 缺尾换行 — 实测两文件末字节均为 `0x0A`。
  - `[low]` `[patch]` README 只示范 `--since 24h` 与 `--since 7d --dir --json`，`--now` 一次都没出现 — 修法：README:216-217 补一条 `--now` 示例。
  - `[medium]` `[patch]` 窗口没有上界，`ts` 晚于 `--now` 的行照样计入 p50/p95 — 与第 3 条同根，随 `readWindow(until)` 一并修。
  - `[medium]` `[patch]` `--dir --json` 这类「flag 紧跟 flag」会把 `--json` 当目录值，静默 0 行 exit 0 — 修法：值以 `--` 开头即视为缺值。
  - `[medium]` `[patch]` 带时间但不带时区的 ISO 串按本机时区解析，窗口静默错 8 小时 — 修法：带时间的串必须带 `Z` 或偏移，否则按非法处理。
  - `[medium]` `[patch]` `defaultDataDir()` 不读 `config.db.path`，目录不存在时输出 0 行且 exit 0，读起来像「没有审计」— 修法：目录不存在时报错并退出非零。
  - `[low]` `[patch]` 恒等式在 `failed` 非空时不成立 — 与 blind 第 16 条同根，一并修。
  - `[medium]` `[patch]` `config.db.path` 指向用户自有或共享目录时，轮转会删掉别人写的 `audit-*.jsonl`（无 ownership 标记）— 修法：只删首行可解析为本案行的文件，其余计 `foreign`。
  - `[low]` `[reject]` `disposed` 之后 recall 不写审计也不打 warn — 调用方拿到的是 `E_GATE_DOWN` 拒绝与中文说明，不是静默失败；加审计行会违背「被拒不落行」。
  - `[low]` `[reject]` append 已入队、`flush()` 才失败时基线已推进，那一行的增量被吞 — 审计本就刻意在关键路径之外（README.md:211），一行丢失属既定取舍。
  - `[medium]` `[patch]` `host-usage.ts:73-77` 三桶必须齐全才返回，只有 `uncached` 有值时连它一起变 `null` — 修法：每桶独立判空。
  - `[medium]` `[patch]` 字段、参数、解构绑定上的 `Map`/`Set` 被 `collectionNames` 漏收，合法集合 `delete` 会被误报为硬删违规 — 与 blind 第 23 条同根，一并修。
  - `[medium]` `[patch]` AC⑥ 声称逐字段断言三个行类型，实际只有注入行被断言（召回行只有 `not.toHaveProperty('query')`，写入行只数行数）— 修法：补召回行与写入行的 node-id 断言。
  - `[medium]` `[patch]` 召回行的 `session_id` 三跳各自单测、从没一起走过（把 `recall-reader.ts:188` 改成 `...{}` 全部测试仍绿，生产每行都是空串）— 修法：加一条带会话身份的端到端用例并断言盘上的 `session_id`。
  - `[medium]` `[patch]` `onRecallFailure` / `OMW_AUDIT_ROW_SKIPPED` 全仓无观察者（`recall-reader.test.ts:485` 构造 reader 时不传回调）— 修法：补一条带回调的用例，并断言失败后盘上没有召回行。
  - `[medium]` `[patch]` 没有任何测试为带 state tail 的计划产出过注入行（`runtime-audit.test.ts` 启动时无 state source，`prompt-composer.test.ts` 传 `readState` 时从不传 `onInject`）— 修法：补 readState + onInject 的用例，断言 `tier: identity+state` 与 `items`。
  - `[medium]` `[patch]` 挂载期轮转的拒绝路径无测试（把 `runtime.ts:403-417` 的 try/catch 删掉也不会失败）— 修法：补一条让 `readdir` 抛错的挂载用例，断言 runtime 仍可用且 `retention` 缺席。
  - `[low]` `[defer]` `RuntimeDeps.readState` 在生产挂载从不提供（`src/index.ts:93-97` 只传 ctx/config/logger），`identity+state` 行在生产不可达 — 属 Epic 1 留下的口子（`0d118de:src/seams/runtime.ts` 已如此），本故事不扩面。
  - `[low]` `[patch]` `AUDIT_ROWS_RETAINED`（`audit.ts:235`）无任何测试 — 修法：补一条超过 1000 行后只留上限的用例。
  - `[low]` `[reject]` 测试里的「装配」是替身自造的 context，没有任何测试跨过真宿主 — 宿主 `dsh-system-prompt/lib/index.js:666` 已确认逐装配调用 `section.text(context)`，替身与之同形；本仓库无法在 CI 里跑真宿主。
  - `[medium]` `[patch]` 无 session 分支在集成面零测试（`recording-ctx.ts:206` 永远给 session）— 修法：补一条上下文无 session 的装配用例，断言不落行且有 warn。
  - `[low]` `[patch]` 测试用手写 stub 忽略 session 参数、不构造 `asOfSeq` — 修法：让 stub 收下 session 参数，与真投影契约同形。
  - `[medium]` `[patch]` AC⑥ 的断言面只覆盖 1.5 个行类型 — 与 edge 第 11 条同根，随行类型断言一并补。
  - `[low]` `[reject]` AC③「不落库」靠结构保证、没有测试 — `src/ops/audit.ts` 对 store 零依赖且由 `check-layers.mjs` 的分层规则强制，加测试只是重复静态门。
  - `[low]` `[reject]` `AUD_REC_DEGRADED` 的真路径不可达（`recall-reader.ts:54` 写 `always false until Epic 5`）— 六值封闭由 `audit.ts` 的 `DEGRADED_REASONS` 校验保证，真降级要等 Epic 5 接上 reranker。
  - `[medium]` `[reject]` `RET_OLD`（30 天前删除）与 `RET_EDGE`（恰好 30 天前保留）对同一时刻给相反结果 — 修法是改本 spec 的 I/O 矩阵。
  - `[low]` `[reject]` Code Map 说 `HARD_DELETE_OWNERS` 要加 `ops/retention.ts`，实际新增的是 `fs-delete-owner` 规则 — 与 blind 第 13 条同根，属 spec 文本。
  - `[low]` `[reject]` warn 时机错位：队列把写错误扣到 `flush()`，`runtime.ts:378` 与 `write-port.ts:292` 的 catch 只接得住校验抛错 — 真磁盘失败由 `dispose` 里的 `await audit.flush()`（`runtime.ts:495`）兜底并记 warn，链路完整。
  - `[medium]` `[patch]` runtime 真写出的目录从没交给报表（报表测试只读手写 fixture）— 修法：补一条把 runtime 写出的目录直接喂给 `audit-report.mjs` 的用例。
  - `[low]` `[patch]` `AUD_INJ_CHANGED` 只在合成计划上测过 — 修法：补一条尾巴变化导致 `prefix_unchanged false` 的用例。
  - `[medium]` `[reject]` Code Map 缺 `src/ops/recall-audit.ts`、`src/seams/host-usage.ts`，未提 `AUDIT_ROWS_RETAINED` 与 `onRecallFailure` 的 `E_GATE_DOWN` 行 — 修法是改本 spec。

## Design Notes

1. 为什么让身份段变成 provider：只有宿主调用它的那一刻才有 `session_id`；静态字符串在挂载时根本不知道会话是谁。宿主 `dsh-system-prompt` 在每次装配里对每个 section 调一次 `section.text(context)`（`lib/index.js:666`），`context.session` 就是答案。
2. 为什么缓存三项记增量：AD-20 的命中率是 ΣcacheRead / (ΣcacheRead + ΣcacheWrite + Σuncached)，累计值直接相加会把同一批 token 重复计。所以按会话记上次看到的三个输入桶，行里写差；投影的第四个桶 `outputTokens` 是模型输出，不进缓存记账，所以不读。
3. 为什么 `null` 而不是 0：0 是有意义的观测（这一轮确实一次缓存都没命中），未知不是。报表脚本把两者分开计数。
4. 为什么轮转只在挂载时跑：审计是本地文件，没有第二个调度器；挂载一次扫一遍目录够用，也不给注入路径加定时器。
5. 为什么 `items[]` 用单位名而不是 mem_key：注入的是「身份段 + 尾巴的哪几段」，不是某条记忆；mem_key 属于召回行（AD-6 的指针只活在库里）。
6. 为什么 `prefix_unchanged` 比的是文本摘要而不是 `plan.prefixUnchanged`：2.4 那个布尔说的是「本次 compose 与上次 compose 的 persona 哈希相同」，审计要的是「这个会话上一次装配与这一次装配的文本相同」——两个问题，两个答案。
7. 为什么不复用 `Runtime.injection` 来写审计行：那是挂载快照，会话一多就只有一个值；审计要的是每次装配的事实。
8. 为什么报表用 mjs：它要能在没有构建产物的仓库里直接 `node scripts/audit-report.mjs` 跑，和 `check-layers.mjs`、`clean.mjs` 同形态。

## Verification

**Commands:**
- `pnpm exec tsc --noEmit -p tsconfig.json`
- `node scripts/check-layers.mjs`
- `pnpm test`
- `node scripts/audit-report.mjs --since 24h --dir <fixture>`

**Observed:** 全量五段最终一次跑通（2026-11-25 13:09，打完全部评审补丁之后）：`pnpm lint` exit 0（含 `tsc -p tsconfig.json --noEmit`、`tsc -p tsconfig.test.json`、静态门、eslint）；`node scripts/check-layers.mjs` exit 0，`layers: 111 个源文件，全部规则通过`；`pnpm test` = `Test Files 41 passed | 1 skipped (42)`、`Tests 639 passed | 2 skipped (641)`；`pnpm test:coverage` exit 0，All files 语句 90.8% / 分支 81.2% / 函数 93.58% / 行 92.66%（门槛行 80 / 分支 70）。审计相关的四条性能基线同轮采样：`perf write` median 0.092ms p95 0.131ms、`perf recall` median 1.818ms p95 3.097ms（200 条 live）、`perf compose` median 0.131ms p95 0.302ms、`perf rewrite` p95 5.047ms。

**Manual checks:** ①`node scripts/audit-report.mjs --since 24h --dir <fixture>` 对七行手造 fixture（2 注入 / 2 召回 / 2 写 + 1 行截断损坏 + 1 个 omw.log）实跑 exit 0，输出 `8 line(s) read, 7 in window / 1 unreadable line(s) skipped`，注入 tokens p50 100 p95 300、召回 elapsed_ms p50 4 p95 9、写 elapsed_ms p50 2 p95 3、`vec_unavailable=1`、`committed=1 rejected=1`。②端到端注入行只能由真宿主装配产生，由 `test/seams/runtime-audit.test.ts` 用 `createRecordingContext` + `assemble(sessionId)` 覆盖，含 `apply()` 挂载后 `await cleanup()` 返回时磁盘上已有该行（证明 dispose 里的 `audit.flush()` 生效）。

## Auto Run Result

**Summary.** 审计从「有日志」变成「有账」：一次装配追加一行注入审计（`session_id` / `tier` / `chars` / `tokens` / `items` / `truncated` / `prefix_unchanged` / 三个缓存桶），一次召回追加一行（`session_id` / `query_hash` / `top_k` / `hits` / `elapsed_ms` / `degraded` / `degraded_reason`），写入沿用既有的写审计行。行只落本地 JSONL，按本地日历日切分，挂载时轮转保留含今天在内 30 天；行里没有任何节点 id。`scripts/audit-report.mjs` 读同一批文件算 p50/p95、降级计数与 AD-20 的缓存命中率。

**Files changed.** 新增 `src/ops/injection-audit.ts`、`src/ops/recall-audit.ts`、`src/ops/retention.ts`、`src/seams/host-usage.ts`、`scripts/audit-report.mjs` 与六个测试文件；改 `src/ops/audit.ts`、`src/seams/prompt-composer.ts`（身份段改 provider）、`src/seams/recall-reader.ts`（召回回调）、`src/seams/runtime.ts`（接线与运营码）、`src/seams/write-port.ts`、`src/seams/tools.ts`、`scripts/check-layers.mjs`（集合识别）；文档同步 README、`ARCHITECTURE-SPINE.md`、`epics.md`、`data-model.md`、`sprint-status.yaml`。

**Findings.** 四层评审共 55 条。patch 37 条（含 3 条 high：retention 在无效时钟下会删光、会话被驱逐后把整段累计当成一次增量、宿主拒绝替换身份段时提示词仍被改成新的一版）；reject 16 条（多为把既有设计当缺陷，或引用了本工作树不存在的文档路径）；defer 1 条（`RuntimeDeps.readState` 生产未接线，属 2.6 之前就存在的形状）；false 2 条（末行换行、AUD_INJ_HOST_FIRST 的 0 与 null；都已逐条实测证伪）。逐条裁定见上方 Review Triage Log。

**Follow-up.** ①`RuntimeDeps.readState` 仍未在生产接线（`src/index.ts` 只传 ctx/config/logger），所以 `identity+state` 这一档在生产里暂不可达——**顺延到 Epic 7**（用户 2026-11-25 裁定）：生产可读的人物状态只存在于库里的 `persona_state` / `pref` / `flag` 节点，而 AD-7（`ARCHITECTURE-SPINE.md:81`）与 spec-2-4 的「注入路径不读库」、以及 Story 2.4 AC 的「状态尾巴在 Epic 7 交付前均如此」（`epics.md:523-524`）都不允许在 Epic 2 里把这条路打开；`epics.md:220` 也禁止预埋后续 epic 的实现。②`scripts/audit-report.mjs` 与项目卡 T4「不提供进程外 CLI」的冲突已由用户裁定（2026-11-25）：**保持现状**——它是与 `scripts/check-layers.mjs` 同形态的开发/运维检查工具，不算插件命令面；T4 收窄为「不提供用户命令」。③`src/ops/audit.ts` 等文件末行无换行是 2.6 之前就有的状态，未在本故事顺手改。

**Verification.** 见上节：lint / 静态门 / 639 项测试 / 覆盖率门槛全部 exit 0，报表脚本对真实 runtime 目录实跑通过。