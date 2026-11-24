---
title: 'Story 2.5 — 召回只读、有界、只给未失效版本'
type: 'story-spec'
created: '2026-11-24'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
baseline_revision: '2e83f92a01c9c783229068cf9518cb582e3f3589'
context:
  - 'docs/implementation-artifacts/epic-2-context.md'
  - 'docs/planning-artifacts/epics.md'
warnings: []
deferred:
  - '扫描没有上限：`LIVE_NODES_QUERY` 返回全部 live 节点，打分内核全量遍历。AC⑦ 的 p95 只是 200 条节点下的基线，不代表真实库规模；NFR-2 的 900ms 与扫描上界都随 Epic 5 的向量检索 + 线程超时一起做。'
  - '`degraded` 与封闭词表在本故事恒为 false：2.5 没有重排、没有向量路径、没有线程超时，能发生的失败只有拒收与库不可用，两者都不是降级。字段先交付是为了 Epic 5 填 `rerank_unavailable` 一类理由时不必改契约，但「降级真的会被填」这一点一条用例都没证明。'
  - '打分内核是子串匹配（`haystack.includes(token)`），短查询几乎必然命中，不具备区分力。真正的打分（向量 + 重排）是 Epic 5 的 AD-8 路径，本故事刻意不扩打分内核。'
  - '`/omw` 命令面没有接 `recall`：`src/index.ts:117` 只把 write / evidence / version 交给 `registerOmwCommand`，而 `src/seams/commands.ts:19-22` 已写明命令面不是召回的一部分。给命令面加召回属后续故事，本故事不扩。'
  - 'CI 未在 GitHub 实跑：静态门改成全仓扫描后，「fixture 上无假阳性」只在本机验过；真实 CI 上的 report 噪声与 `tql-literal` 的宽读法（`+` 拼接、`as const`）是否会误伤别的写法，都还没有观测。'
---

<intent-contract>

## Intent

**Problem:** `recall` 至今是占位工具，调用返回 `E_NOT_IMPLEMENTED`。被它挡住的路径上已经积了三处与 AC 相悖的既有行为：`store/search.ts` 用 `allNodeIds` 全量枚举、不过滤 `superseded_at`，所以改写过的旧值会和当前值一起被查出来；它把 `topK` 用 `Math.min(topK, 8)` 静默夹住，越界不报错；候选池与最终条数共用一个截断点，`recall.candidatePool` 配置项至今无人读取。只要照着现有代码把占位换成实现，模型就会拿到一份混着旧版本、无法解释“为什么只返回这几条”的列表。

**Approach:** 把“边界”与“查询”分开。新增 `core/recall.ts` 承载默认值、上限与 `checkRecallBounds` 纯函数，越界判定不发生任何库访问；新增 `store/templates/recall.ts` 作为唯一的 live 扫描模板并缓存预编译对象；`store/search.ts` 改为在模板给出的 live 节点集合上打分，自己不再枚举节点、不再截断；`seams/recall-reader.ts` 依次做“校验 → 打分 → 候选池截断 → topK 截断 → 组装耗时与降级”，任何一步失败都不把结果拖成空；`tools.ts` 扩输出 schema 七个字段（两个门槛、两个计数、耗时、降级标记与理由）并把 `recall` 接到读取器；`runtime.ts` 在读面装配里建立它。静态门补上 AD-8 缺的那一半：`prepareTql` 第一个实参必须是字符串字面量，或同文件内初始化表达式也是字面量的 `const`。

## Boundaries & Constraints

**Always:**
- 召回路径零写调用：不出现 `insert` / `insertWithId` / `batchInsert` / `upsertWithId` / `patchPayload` / `updatePayload` / `updateVector` / `link` / `upsertEdge` / `commitTransaction` / `tqlMut` / `flush`（AC④）。
- 越界判定在打开任何查询之前完成，被判拒的调用读不读得到库都无关（AC②）。
- 只返回 `superseded_at` 缺席的版本；判定语义只有一处（`store/filters.ts` 的 `isLive`），TQL 拼写只有一处（`store/templates/`）（AC①、AD-8）。
- 候选池与最终条数是两道独立闸门：候选池默认 12 截的是打分结果，`topK` 默认 5、上限 8 截的是注入条数（AC③、AD-26）。
- 排序完全确定：分数降序 → `mem_key` 升序 → 节点 id 升序，同一份数据跑两次得到同一个键序列（AC⑥）。
- 结果永远带 `elapsed_ms`、`degraded` 与 `degraded_reason`，理由只在 `core/degrade.ts` 的封闭六值内取值（AC⑥、AD-20）。
- 只读库（`readOnly` 打开或 schema 未就绪）照常召回：召回不依赖写面装配（AD-18 局部降级）。

**Never:**
- 不加 `offset` / `page` / `cursor`，不做翻页（AC⑧、AD-8）。
- 不在 `store/templates/` 之外出现 TQL 字面量，不在别处调用 `executePreparedTql`（AC⑤、AD-8）。
- 不实现重排、`worker_threads`、250/600/20ms 三段预算与熔断——那是 Epic 5 在同一路径上的工作，本故事只留清边界（AC⑦）。
- 不写审计行、不碰 `ops/audit.ts` 的落盘，那属 Story 2.6（AD-20）。
- 不因为候选不足 `topK` 就凑数、报错或补空条目；取不满就少给（AD-8 第③段）。
- 不把召回结果接进注入通道：注入的两段预算由 2.4 固定，召回文本在 Epic 5 之前不进宿主通道。
- 不为召回新增写方法、不改写面语义、不动 `remember` 与决策账本。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
| --- | --- | --- | --- |
| `RCL_TOPK_OK` | `recall('whale')`，无 `topK` | 至多 5 条，`top_k` 默认 5 | — |
| `RCL_TOPK_EDGE` | `topK` = 8 / 1 | 接受，按 8 / 1 条截断 | — |
| `RCL_TOPK_OVER` | `topK` = 9 | 拒收，零次库访问 | `E_BOUNDARY` |
| `RCL_TOPK_ZERO` | `topK` = 0 或 -1 | 拒收，零次库访问 | `E_BOUNDARY` |
| `RCL_TOPK_NONINT` | `topK` = 5.5 / `'5'` / `null` | 拒收，零次库访问 | `E_BOUNDARY` |
| `RCL_QUERY_EMPTY` | `query` 缺失 / 空串 / 全空白 / 非字符串 | 拒收，零次库访问 | `E_BOUNDARY` |
| `RCL_QUERY_LONG` | `query` = 201 个字符（按码点，非 UTF-16 单元） | 拒收，零次库访问；恰好 200 通过 | `E_BOUNDARY` |
| `RCL_LIVE_ONLY` | 同一 `mem_key` 有 active v2 与退役 v1，查询同时匹配两者的词 | 只返回 v2，v1 不出现 | — |
| `RCL_POOL_TRUNC` | 30 条 live 命中，`candidatePool` = 12，`topK` = 5 | `matched` = 30、`candidates` = 12、`items` 5 条，截断发生在打分之后 | — |
| `RCL_POOL_SMALL` | 12 条命中，`candidatePool` = 12，`topK` = 8 | `candidates` = 12，`items` 8 条：两道闸门互不替代 | — |
| `RCL_HIT_FEWER` | 2 条命中，`topK` = 5 | `matched` = 2、`items` 2 条，不补空条目，`degraded` = false | — |
| `RCL_NO_HIT` | 无一命中 | `ok` = true，`items` = []，`matched` = 0，`candidates` = 0 | — |
| `RCL_ZERO_WRITE` | 一次成功召回 | 库写方法调用次数为 0（含 `flush`） | — |
| `RCL_DETERMINISTIC` | 同一库、同一 query 连跑两次 | 两次 `{mem_key}` 序列逐位相同 | — |
| `RCL_UNNAMED` | live 节点没有 `mem_key` | 不进候选：召回只给有业务键的记忆；这类节点不计入 `matched`，否则答复会自述「找到 1 条」却说「返回前 0 条」 | — |
| `RCL_EVIDENCE_SKIP` | live 的 evidence 节点，引文命中查询词 | 不返回；证据只能经它支持的断言抵达（AD-6） | — |
| `RCL_READONLY` | 库以 `readOnly` 打开，写面未装配 | 召回照常返回结果 | — |
| `RCL_CLOSED` | 库句柄已被 runtime 关闭 / 读取器已 dispose | 拒答，不抛；关闭发生在查询中途时由 catch 翻成同码 | `E_GATE_DOWN` |
| `RCL_BAD_REASON` | 构造一个不在封闭枚举内的降级理由 | 编译期即不成立；运行时校验函数返回 false | — |

</intent-contract>

## Code Map

- `src/core/recall.ts` -- 新增。`DEFAULT_TOP_K` / `MAX_TOP_K` / `DEFAULT_CANDIDATE_POOL` / `MAX_CANDIDATE_POOL` / `MAX_QUERY_CHARS` 五个数值的唯一声明处，加上 `checkRecallBounds(rawTopK)` 与 `checkRecallQuery(rawQuery)` 两个纯函数，返回 `{ok:true,value}` 或 `{ok:false,reason}`；不 import 任何 store 模块。
- `src/store/filters.ts` -- 新增。`isLive(payload): boolean` 与 `isSearchable(payload): boolean`，是“未失效”“可召回”两个判定的唯一语义落点；不出现 TQL 文本。
- `src/store/templates/recall.ts` -- 新增。`LIVE_NODES_QUERY = 'FIND {superseded_at: {$exists: false}} RETURN *'` 与 `createRecallTemplates(db)` 的 `findLiveNodes()`，在构造时 `prepareTql` 一次并复用。
- `src/store/search.ts` -- 改写。改由模板取 live 节点，删掉本地的 `DEFAULT_TOP_K` / `MAX_TOP_K` 与 `Math.min` 夹取，`createTextSearch(templates)` 只做“过滤 → 打分 → 排序 → 全量返回”，截断交给调用方。
- `src/seams/recall-reader.ts` -- 新增。`createRecallReader({db, topK, candidatePool, now?})` 暴露 `recall(query, topK?)` 与 `dispose()`，返回 `RecallAnswer`（`ok` / `code` / `message` / `top_k` / `candidate_pool` / `candidates` / `matched` / `hits` / `elapsed_ms` / `degraded` / `degraded_reason`）。`now` 是注入时钟（默认 `performance.now`），让 `elapsed_ms` 成为可断言的契约而不是「非负整数」；`topK` 省略时取 deps 里的配置值，参数是调用方覆盖。
- `src/seams/tools.ts` -- 改。`OUTPUT_SCHEMA` 增 `top_k` / `candidate_pool` / `candidates` / `matched` / `elapsed_ms` / `degraded` / `degraded_reason`，`recall` 分支改为逐字段命名返回（不再 `...answer` 摊开，`hits` 因此不会漏进输出），`PARAMETERS.recall` 的上限引用 `MAX_TOP_K`，`DESCRIPTIONS.recall` 去掉“占位”字样并写明只给未失效版本、默认 5 条上限 8 条、query 最多 200 字符。
- `src/seams/runtime.ts` -- 改。在 `if (db !== undefined)` 读面装配块内建召回读取器，`finish()` 按 `...(recall === undefined ? {} : { recall })` 暴露，`dispose()` 里与 evidence / version 并列前置处置。
- `src/seams/config.ts` -- 改。`DEFAULT_TOP_K` 改为从 `core/recall.ts` 再导出，`recallSchema` 的 `topK` 上限与 `candidatePool` 默认值改写为引用常量，不再各自写字面量（AD-26）。
- `scripts/check-layers.mjs` -- 改。新增 `tql-literal` 规则：`prepareTql` 首个实参必须是字符串字面量，或同文件内 `const` 且其初始化表达式为字面量。
- `README.md` / `docs/implementation-artifacts/sprint-status.yaml` -- 改。README 记 `recall` 的契约与两道闸门，sprint-status 把 2-5 置 done。

## Tasks & Acceptance

**Execution:**
- `src/core/recall.ts` + `test/core/recall.test.ts` -- 先落边界纯函数与常量，用例覆盖 8 / 9 / 0 / 负数 / 小数 / 字符串 / `null` / 缺失，以及 query 的空串、全空白、非字符串。
- `src/store/filters.ts` + `src/store/templates/recall.ts` + `test/store/filters.test.ts` -- 语义测试锁住模板查询与 `isLive` 一致：插入 active 与退役两版，模板只回 active，`isLive` 对同一批 payload 给出相同判定。
- `src/store/search.ts` 改写 + 更新 `test/degrade/vector-off.test.ts` -- 保留“向量关闭时文本仍可查”的两条用例，另加一条断言退役版本不再出现在结果里。
- `src/seams/recall-reader.ts` + `test/seams/recall-reader.test.ts` -- 候选池与 `topK` 两道闸门、确定性、零写调用、只读库、句柄关闭、证据跳过、无 `mem_key` 跳过。
- `src/seams/tools.ts` / `src/seams/config.ts` / `src/seams/runtime.ts` 接线 + `test/seams/memory-tools.test.ts` 与 `test/seams/runtime-write.test.ts` 增补 -- `recall` 不再返回 `E_NOT_IMPLEMENTED`，越界经由工具面返回 `E_BOUNDARY`，`runtime.recall` 在只读库上仍然存在。
- `scripts/check-layers.mjs` + `test/lint/layers.test.ts` -- 四条 fixture：内联字面量通过、同文件字面量常量通过、模板字面量插值违规、函数调用返回值违规。
- 文档与 sprint-status -- README 补 `recall` 契约，`sprint-status.yaml` 置 done，`Review Triage Log` 与 `Auto Run Result` 在评审后补写。

**Acceptance Criteria:**
- Given 已注册的 `recall` 工具，when 不带 `topK` 调用，then 只返回未失效版本且至多 5 条（AC①）。
- Given `topK=8`，when 调用，then 正常返回至多 8 条；Given `topK=9`，when 调用，then 返回 `E_BOUNDARY` 且库访问计数为 0（AC②）。
- Given `topK` 为 0、负数、非整数，when 调用，then 三种情形都返回 `E_BOUNDARY` 且库访问计数为 0（AC②）。
- Given 30 条 live 命中与 `candidatePool=12`，when 调用 `topK=5`，then 进入候选的是 12 条、最终返回 5 条，两者不互相替代（AC③）。
- Given 一次成功召回，when 监视库句柄，then 写方法调用次数为 0，含 `updatePayload` 与 `flush`（AC④）。
- Given 全仓 `prepareTql` 与 `executePreparedTql`，when 跑静态门，then 调用只在 `store/templates/`、首个实参是字面量或同文件字面量常量、别处无 `executePreparedTql`（AC⑤）。
- Given 同一输入与同一份数据，when 连续两次召回，then `{mem_key}` 序列一致，结果带 `elapsed_ms`、`degraded` 与封闭枚举内的 `degraded_reason`（AC⑥）。
- Given 召回延迟，when 本故事交付，then 只记录不含重排的 p95 基线，NFR-2 的 900ms 等 Epic 5 复测（AC⑦）。
- Given `recall` 的参数 schema，when 检查字段，then 不存在 `offset` / `page` / `cursor`（AC⑧）。
- Given 只读打开的库，when 召回，then 结果与可写库一致，不因写面缺席而拒答（AD-18）。

## Spec Change Log

- 2026-11-24 初稿：按 `epics.md:530-569` 的八条 AC 与 AD-8 / AD-20 起草，裁定 `store/filters.ts` 与 exists-owner 门的分工（见 Design Notes 1），把重排、线程、三段预算显式排除到 Epic 5。

## Review Triage Log

发现总数 51：blind-hunter 20 / edge-case-hunter 15 / verification-gap 6 / intent-alignment 10（intent 层原文是分层论证，编号由 lead 按其指出的缺口逐条落定）。

裁定合计 **high 8 / medium 21 / low 22**；**patch 45 / defer 2 / reject 4**。severity 由 lead 重判，不采信子代理自报；无 `intent_gap`、无 `bad_spec`，故 `review_loop_iteration` 保持 0。

4 条做了断线验证（改坏实现后确认对应用例转红）：`candidatePool` 接线、`#readOrNothing` 式的 try/catch、`matched` 计数口径、`topK` 上限引用。

- **blind25-1** `[medium]` `[patch]` 输出 schema 未声明 `hits`，而 `recallTool` 用 `...answer` 把读取器字段整个摊出去 — `src/seams/tools.ts:91-114` 的 `properties` 无 `hits`、`:113 additionalProperties: false`，`:325-330` 却 `...answer`；改为逐字段命名返回，并加用例 `answers with exactly the fields the output schema declares` 断言键集等于 schema 键集
- **blind25-2** `[medium]` `[patch]` `topK` 上限三处不统一：`MAX_TOP_K`=8、config `.max(MAX_TOP_K)`、工具面硬编码 `maximum: 8` — `src/seams/tools.ts:195` 与 `:284` 的描述都写死 8；改为引用 `MAX_TOP_K` 并在描述里插值，加用例 `keeps the advertised topK ceiling equal to the one the reader enforces`（硬编码 8 能通过所有只调读取器的测试，正是首轮漏掉的漂移）
- **blind25-3** `[medium]` `[patch]` `candidatePool` 无上限、且读取器用 `Math.max(..., 1)` 静默夹取 — `src/seams/config.ts:95` 只有 `.min(1)`，`src/seams/recall-reader.ts:167` `Math.max(deps.candidatePool, 1)`；新增 `MAX_CANDIDATE_POOL = 50` 并在配置处 `.max()`，读取器去掉夹取直接 `slice(0, deps.candidatePool)`
- **blind25-4** `[medium]` `[patch]` `checkRecallQuery` 只 trim 不限长，成本上界全由调用方决定 — `src/core/recall.ts:68-73`；新增 `MAX_QUERY_CHARS = 200`（与 evidence quote 同尺），按码点计数，用例覆盖 200 通过 / 201 拒 / 200 个非 BMP 码点通过
- **blind25-5** `[high]` `[patch]` `matched` 取过滤前的 `found.hits.length`，产出「找到 1 条…返回前 0 条」的自相矛盾文案 — `src/seams/recall-reader.ts:225` `describe(kept.length, pool.length, found.hits.length)` 而 `rank()` 随后丢弃无 `mem_key`/账本节点；改为 `ranked.length` 并新增 `matched` 字段，用例断言 matched=30 / candidates=12 / items=5
- **blind25-6** `[low]` `[patch]` `rank` 的 JSDoc 说两种丢弃，代码做三种过滤 — `src/seams/recall-reader.ts:245-247` 除 liveness 与无键外还过滤 `isSearchable`；改写为 Three drops 并说明 matched 的计数口径
- **blind25-7** `[medium]` `[patch]` `LIVE_NODES_QUERY` 每次全量物化 live 集，模块注释却说引擎侧过滤是为了不读整个文件 — `src/store/templates/recall.ts:10-12` 与 `:26`；注释改为「引擎过滤保证退役行不进 JS、调用方不会漏判，但不让扫描变便宜」，扫描上限记入 deferred（Epic 5 的向量路径）
- **blind25-8** `[low]` `[patch]` spec 写了 `createRecallReader({db, topK, candidatePool, clock?})`，实现没有时钟注入 — `spec:75` vs `src/seams/recall-reader.ts:60-76`；补 `now?: () => number` 并让 `elapsed_ms` 可断言（用例注入每次 +7ms 的时钟，断言 `elapsed_ms === 7`）
- **blind25-9** `[medium]` `[patch]` AC⑦ 要的 p95 基线没有任何产物 — `spec:102` 而 `test/` 与 `src/` 下无 recall 性能用例；新增 `recall: the latency baseline AC⑦ asks for`（200 条 live、WARMUP 20、200 采样），实测 median=0.862ms、p95=1.022ms
- **blind25-10** `[low]` `[patch]` Design Note 6 承诺把扫描上限写进 deferred，frontmatter 里 `deferred: []` — `spec:121` vs `:13`；补四条 deferred
- **blind25-11** `[low]` `[patch]` spec 声称已改 sprint-status，实际仍是 backlog — `spec:80`/`:91` vs `docs/implementation-artifacts/sprint-status.yaml:51`；已置 done
- **blind25-12** `[low]` `[patch]` README 开头仍说四个工具都是占位 — `README.md:3`；改为「`remember` 与 `recall` 已实现，`forget` 与 `explain` 仍是占位」
- **blind25-13** `[medium]` `[patch]` 同一份召回契约在三处写成三种字段集 — `README.md:126-133` 列 `hits` 却漏 `mem_keys`/`items`，OUTPUT_SCHEMA 漏 `hits`，`spec:76` 只说新增四字段；三处按工具面实际返回的十二个键对齐，并写明工具面不回 `hits`
- **blind25-14** `[medium]` `[patch]` 零写测试是 denylist，新增的写方法会被静默放行 — `test/seams/recall-reader.test.ts:20-27` 的 20 项 `WRITE_METHODS`；改为白名单 `READ_METHODS`，断言「出现的每个引擎方法都在读名单内」
- **blind25-15** `[low]` `[patch]` `dispose` 的契约文案说释放预编译语句，实现只翻布尔 — `src/seams/recall-reader.ts:88-94` vs `:146-148`；改为 Stop answering 并说明句柄归 runtime
- **blind25-16** `[medium]` `[patch]` `literalConstNames` 平铺扫描，任意块内的同名字面量常量能为别处的运行时变量放行 — `scripts/check-layers.mjs:454` 起；加 `depth === 0` 只收模块顶层 const，并加 fixture「literal constant in a block」
- **blind25-17** `[low]` `[patch]` 静态门文件头的规则清单漏 `tql-literal`（规则本身已实现） — `scripts/check-layers.mjs:10-22`；补一行
- **blind25-18** `[low]` `[patch]` 没有 kind 缺失或非字符串的召回用例 — `src/store/filters.ts` 对非字符串 kind 返 true、`src/seams/recall-reader.ts:210` 回落 `unknown`；加用例 `recalls a memory whose kind is missing or is not a string`
- **blind25-19** `[low]` `[defer]` 子串匹配让短查询几乎必然命中，打分内核不具备区分力 — `src/store/search.ts:134` `haystack.includes(token)`；打分升级（向量 + 重排）是 Epic 5 的 AD-8 路径，本故事不扩打分内核
- **blind25-20** `[low]` `[patch]` `test/seams/recall-reader.test.ts` 结尾无换行 — diff 末尾 `\ No newline at end of file`；已补
- **edge25-1** `[high]` `[patch]` 成功路径返回字面量 `E_OK`（值为 `OK`），不在 AD-25 封闭码内 — `src/seams/recall-reader.ts:220` `code: 'E_OK'` 而 `src/core/tool-errors.ts:38` `E_OK = 'OK'`；改为 import `E_OK`。两处测试桩与断言也写死 `'E_OK'`，所以测试抓不到
- **edge25-2** `[high]` `[patch]` 全标点 query 通过校验但 tokenize 得空列表，返回 `ok:true` 空结果而不是拒收 — `src/core/recall.ts:68-73` 只 trim、`src/store/search.ts:111` 的 `tokens.length > 0` 守卫实际会被走到，探针实跑确认；加「query 至少要有一个字母或数字」并用例覆盖四种纯符号输入
- **edge25-3** `[high]` `[patch]` `describe` 的 matched 含随后被丢弃的节点，文案自相矛盾 — 与 blind25-5 同一处、同一修法（`src/seams/recall-reader.ts:225`）
- **edge25-4** `[high]` `[patch]` 库句柄被关后 `findLiveNodes()` 抛异常，`recall` 与 `recallTool` 都没有 try/catch — `src/store/templates/recall.ts` 直接执行预编译查询；`recall()` 包 try/catch 翻成 `E_GATE_DOWN` + `sanitizeEngineText`，加用例 `a handle that was closed underneath the reader`
- **edge25-5** `[medium]` `[patch]` `recallTool` 以 `...answer` 展开，把未声明的 `hits` 带进返回值 — 与 blind25-1 同一处，逐字段命名返回
- **edge25-6** `[medium]` `[patch]` `PARAMETERS.recall.topK` 的 `maximum: 8` 写死 — 与 blind25-2 同一处，改 `MAX_TOP_K`
- **edge25-7** `[medium]` `[patch]` `tql-owner` / `tql-literal` 只遍历 `sourceFiles(root)`（src/），test 与 scripts 逃过 — `scripts/check-layers.mjs:760` 用 `sourceFiles(root)`、`:763` 才用 `scanned`；把两条规则搬进独立的 `checkTql(file, root, violations)` 并在 `allSourceFiles(root)` 循环里跑，加 fixture 证明 test/ 与 scripts/ 都会被抓
- **edge25-8** `[medium]` `[patch]` `literalConstNames` 只按名字认字面量，不记录绑定作用域 — 与 blind25-16 同一处，`depth === 0` 修正
- **edge25-9** `[medium]` `[patch]` AC⑦ 声明的 p95 基线不存在 — 与 blind25-9 同一处，新增 perf 用例
- **edge25-10** `[low]` `[patch]` `recall-reader.ts` 导入了未使用的 `DEFAULT_CANDIDATE_POOL` 与 `type Bounded` — `src/seams/recall-reader.ts:17-22`；eslint 只覆盖 `.mjs`、tsc 未开 `noUnusedLocals`，所以没人报；已删
- **edge25-11** `[low]` `[patch]` 配置的 `candidatePool` 只有下界没有上界 — 与 blind25-3 同一处，`.max(MAX_CANDIDATE_POOL)`
- **edge25-12** `[low]` `[reject]` `refuse()` 回显配置值 `deps.topK` 而非本次被拒的参数，`topK=9` 时仍报 `top_k: 5` — `src/seams/recall-reader.ts:167-187`。被拒的调用没有结果宽度；回显配置值并在 message 里说明「9 被拒」才是不撒谎的写法。补 JSDoc 说明并保留用例 `answer.top_k === DEFAULT_TOP_K`
- **edge25-13** `[low]` `[patch]` `search()` 算 `elapsedMs` 两次 `performance.now()`，但没有任何人读 — `src/store/search.ts:105`/`:117`；计时归读取器（可注入时钟、输出 `elapsed_ms`），删掉这第二个计时器
- **edge25-14** `[low]` `[reject]` `isSearchable` 把未知 kind 视为可召回，`toItem` 对非字符串 kind 回落 `unknown` — `src/store/filters.ts:79` 起。宁可多给不可静默不可达；blind25-18 已补用例锁住这个行为
- **edge25-15** `[low]` `[defer]` runtime 暴露了 `recall`，但 `/omw` 命令面只接了 write/evidence/version — `src/index.ts:117` 未传 recall；`src/seams/commands.ts:19-22` 已写明命令面不是召回的一部分，接入属后续故事
- **vgap25-F1** `[high]` `[patch]` `recall.candidatePool` 从配置到读取器没有任何测试：改成硬编码 12 时全量 516 条测试全绿 — `src/seams/runtime.ts:529`；仿 `homeWithTopK` 加 `homeWithCandidatePool(n)`，新增 `takes the candidate pool from the configuration too, not just the width`（写 5 条后断言 candidate_pool=3 / matched=5 / candidates=3 / items=3）
- **vgap25-F2** `[medium]` `[patch]` RCL_UNNAMED 只断言 `hits` 为空，没断言计数与文案，所以自相矛盾的消息没被发现 — `test/seams/recall-reader.test.ts:229-235` 实测消息曾是「找到 1 条未失效记忆，其中 0 条进入候选池，返回前 0 条。」；补 `matched === 0`、`candidates === 0` 与整句文案断言
- **vgap25-F3** `[medium]` `[patch]` 工具返回值从不与 `OUTPUT_SCHEMA` 对照，多出来的键没人管 — `test/seams/memory-tools.test.ts:196-206` 用 `toMatchObject`（子集匹配）、`:230-237` 只断言四个工具的 schema 全等；探针实测 `extra: ["hits"], additionalProperties: false`。改为断言返回键集等于 schema 键集
- **vgap25-A1** `[medium]` `[patch]` `hits` 未在输出 schema 里声明 — 与 blind25-1 同一处
- **vgap25-A2** `[medium]` `[patch]` `describe()` 的文案与计数口径矛盾 — 与 blind25-5 同一处
- **vgap25-A3** `[low]` `[patch]` spec 的 Verification 与 Auto Run Result 仍是占位，sprint-status 仍是 backlog — `spec:133`/`:135`/`:137` 与 `sprint-status.yaml:51`；已补实测数字与 finalize 段落
- **intent25-1** `[medium]` `[patch]` 答案层返回 `hits`，声明层（输出 schema）没有它 — 与 blind25-1 同一处；intent 层的判据是「模型收到的答案必须能被 schema 解释」，故按 patch 而非文档修补
- **intent25-2** `[low]` `[patch]` `candidates` 的 JSDoc 说 How many live nodes matched before either cut，与「进入候选池的条数」矛盾 — `src/seams/recall-reader.ts:46-47`；改为 How many live, nameable hits entered the candidate pool，并新增 `matched` 承担「截断前命中数」
- **intent25-3** `[high]` `[patch]` RCL_CLOSED 判的是读取器自己的 `disposed` 而非库句柄，且无 try/catch，畸形行会抛出去 — `src/seams/recall-reader.ts:125` 判 `disposed`、`:128-144` 原无捕获；补 try/catch 翻成同码，并加用例证明「句柄被关」与「读取器 dispose」两种关闭都不抛
- **intent25-4** `[low]` `[reject]` `degraded_reason` 的封闭性只在 `core/degrade.ts` 的纯函数里强制，答案层不校验 — `src/core/degrade.ts:74-76` 与 `src/seams/recall-reader.ts:271`（直接再导出同一张表）。答案层的每个理由都来自那张表本身，第二份运行时校验只是副本；运行时的强制点在 `src/ops/audit.ts:129-134`，属 2.6 的审计路径
- **intent25-5** `[medium]` `[patch]` `elapsed_ms` 无可注入时钟，用例只能断言非负整数 — 与 blind25-8 同一处；现可断言精确值
- **intent25-6** `[high]` `[patch]` `candidatePool` 从配置到读取器没有测试锁住 — 与 vgap25-F1 同一处
- **intent25-7** `[low]` `[patch]` spec 声称输出 schema 新增四个字段，实际是六个 — spec 的 Approach 段；改为七个字段并逐个点名
- **intent25-8** `[medium]` `[patch]` 参数 schema 的字段集与 description 没有任何用例，声明契约会漂移 — 新增 `advertises no way to page a recall, and says how wide it can get`（字段集恰为 query/topK、无 offset/page/cursor、描述含三个上限）
- **intent25-9** `[low]` `[patch]` `tql-literal` 不在文件头的规则清单里 — 与 blind25-17 同一处
- **intent25-10** `[low]` `[reject]` `readStringExpression` 把 `+` 拼接与 `as const` 都算字面量，属宽读法 — `scripts/check-layers.mjs:441` 起。`'FIND' + ' *'` 与 `as const` 都是编译期常量，AC⑤ 要禁的是运行时拼装；fixture 里 `const Q = read()` 仍被拒

## Design Notes

1. **`filters.ts` 拥有语义，模板拥有拼写。** AD-8 要求“未失效过滤器只在 `store/filters.ts` 的 `liveOnly()` 一处构造”，但 2.3 落地的 exists-owner 门把 `$exists` 锁在 `store/templates/`，而 AC⑤ 又要求 `prepareTql` 首个实参是字面量——三条约束不可能同时靠“把过滤对象从一个文件传到另一个文件”满足。裁定：`store/filters.ts` 导出 `isLive(payload)` 这个 JS 侧判定，TQL 里的 `{$exists: false}` 仍只在 `templates/recall.ts` 出现一次，两者的一致性由 `test/store/filters.test.ts` 的语义测试锁住（同一批 payload 过模板与过 `isLive` 必须给出相同结论）。AD-8 的意图是“规则只有一个来源、不会漂移”，这个组合满足意图，且不动已经上线的门。另外三个已有模板（`LIVE_BY_KEY_QUERY` 等）保持原样，避免本故事扩大改动面。
2. **候选池与最终条数是两道闸门，不是一个数字的两种叫法。** 候选池截的是打分结果（默认 12），`topK` 截的是最终返回条数（默认 5、上限 8）。`createTextSearch` 因此不再接受截断参数：截断是召回的策略，不是检索内核的职责。这样 `candidatePool` 这个至今没人读的配置项第一次真正生效。
3. **`Math.min` 的静默夹取必须删掉。** 越界拒收是 AC②，而夹取把越界变成“悄悄少给”，调用方无法区分“只有 8 条命中”与“我要了 30 条被砍到 8 条”。删掉之后 `topK` 的合法性只由 `core/recall.ts` 判定，且判定早于任何库访问。
4. **边界判定放在 `core` 而不是 `seams`。** 理由是可测性：`checkRecallBounds` 是纯函数，`test/core/recall.test.ts` 不需要库、不需要假句柄就能覆盖八个输入。`seams/recall-reader.ts` 只负责把拒绝理由翻成人话并保证“拒了就真的一次都没查”。
5. **`degraded` 在本故事恒为 false，这是事实而不是省事。** 2.5 没有重排、没有向量路径、没有线程超时，能发生的失败只有“库不可用”（`E_GATE_DOWN`）与“拒收”（`E_BOUNDARY`），两者都不是降级。字段与封闭词表随本故事一起交付，是为了让 Epic 5 填 `rerank_unavailable` 一类理由时不必改契约；测试锁住“不在六值内的理由被拒”，而不是伪造一条降级。
6. **打分内核保持无状态扫描，扫描上限留给 Epic 5。** 本故事对 live 节点做全量打分，不做扫描截断：加一个未经测量的上限会把“召回不全”变成静默的数据丢失，而 AD-8 的答案是用向量检索加线程超时替代整段扫描，那是 Epic 5。这条写进 deferred 并在 README 里说明，避免把当前实现读成“已经满足 NFR-2”。
7. **默认值只有一个声明处。** `DEFAULT_TOP_K` 此前同时存在于 `seams/config.ts` 与 `store/search.ts`，而 `store` 不许 import `seams`——两份副本本来就会漂移。裁定把三个数值提到 `core/recall.ts`（`core` 对 `store` 与 `seams` 都可见），`config.ts` 改为再导出，既有 import 点不动。
8. **证据节点不从召回进入，理由同 2.2。** 证据的文本是宿主事件引文，扫它会同时做两件坏事：同一句话以两个键各返回一次；引文走到没有导出规则（FR-24）的读路径上。判定收在 `store/filters.ts` 的 `isSearchable`，与 2.2 已经在 `search.ts` 里做的排除合并成一处。

## Verification

**Commands:**
- `pnpm build` -- 期望 exit 0。
- `pnpm lint` -- 期望 exit 0。
- `node scripts/check-layers.mjs` -- 期望 exit 0，且规则表含 `tql-literal`。
- `pnpm test` -- 期望全绿，含新增的 `test/core/recall.test.ts`、`test/store/filters.test.ts`、`test/seams/recall-reader.test.ts`。
- `pnpm test:coverage` -- 期望行覆盖不低于 80%、分支不低于 70%（Epic 2 DoD）。

**Observed (2026-11-24, this worktree):**
- `pnpm build`、`pnpm lint`、`node scripts/check-layers.mjs` 均 exit 0；静态门报 `layers: 87 个源文件，全部规则通过`，规则表含 `tql-literal`。
- `pnpm test` -> `Test Files 35 passed | 1 skipped (36)`、`Tests 532 passed | 1 skipped (533)`，15.6s。
- `pnpm test:coverage` -> exit 0，`All files` 语句 90.81% / 分支 79.8% / 函数 92.9% / 行 92.8%（Epic 2 DoD：行 ≥80%、分支 ≥70%）。
- `perf recall: median=0.977ms p95=1.267ms n=200 live=200`（`pnpm test` 那次运行；AC⑦ 要求的就是这条不含重排的基线，判据 p95 ≤ 50ms）。
- `test/seams/recall-reader.test.ts` 用计数代理盯着句柄：一次成功召回的写方法调用次数为 0，且调用序列里出现 `executePreparedTql`（证明读真的发生了而不是早退）。
- 三条接线各自被一条用例锁住：`recall.topK`（`takes the recall width from the configuration`）、`recall.candidatePool`（`takes the candidate pool from the configuration too`）、工具输出字段集（`answers with exactly the fields the output schema declares`）。后两条是评审期间发现的缺口——把 runtime 的 `candidatePool` 接线改成硬编码 12，全量 516 条测试当时全绿。
- 断线验证（评审期做的变异）：把 `src/seams/runtime.ts` 的 `candidatePool: config.recall.candidatePool` 换成字面量 `12`，只有新增的候选池用例转红；恢复后全绿。

**Manual checks:**
- 只读库：`openDatabase({... readOnly: true})` 后装配读取器，召回返回与可写库相同的结果（`recalls from a read-only handle`）。
- 句柄被抽走：先成功召回一次，`closeDatabase` 后再召回，返回 `E_GATE_DOWN` 与「记忆库不可读」的说明，不抛异常；随后 `dispose()` 不抛。
- 决策账本不进召回：写一条 `likes: whale watching` 再触发一次改写（生成 `decision:*` 节点，其 `reason` 含同一个词），召回只回断言键，不回决策键。这条最初是新写的 runtime 用例失败暴露出来的，不是设计时就想到的。

## Auto Run Result

**Status:** done

**What was built.** `recall` 从占位变成真实的有界只读召回：`core/recall.ts` 承载五个数值与两条校验纯函数，`store/filters.ts` 成为「未失效 / 可召回」的唯一语义落点，`store/templates/recall.ts` 是唯一一条 live 扫描模板，`store/search.ts` 退化成无状态打分内核，`seams/recall-reader.ts` 做两道闸门与耗时/降级组装，工具面与 runtime 接线。静态门补上 AD-8 缺的那一半（`prepareTql` 首个实参必须是字面量或模块顶层字面量常量），并把这条与 `tql-owner` 一起从「只扫 src/」改成全仓扫描。

**Changed files.** 新增 `src/core/recall.ts`、`src/store/filters.ts`、`src/store/templates/recall.ts`、`src/seams/recall-reader.ts`、`test/core/recall.test.ts`、`test/store/filters.test.ts`、`test/seams/recall-reader.test.ts` 与本 spec；改 `src/store/search.ts`（改写）、`src/seams/{config,runtime,tools}.ts`、`scripts/check-layers.mjs`、`test/{degrade/vector-off,lint/layers,seams/memory-tools,seams/runtime-write,load/inject}.test.ts`、`README.md`、`docs/implementation-artifacts/sprint-status.yaml`。

**Findings.** 四层 51 条，裁定 high 8 / medium 21 / low 22，patch 45 / defer 2 / reject 4，无 `intent_gap`、无 `bad_spec`。评审挖出的真缺陷里有三条是测试自己看不见的：成功路径的 `code` 写成字面量 `'E_OK'`（而常量值其实是 `'OK'`），因为测试桩也照着写错，两边一起错；`recall.candidatePool` 从配置到读取器完全没人测，改成硬编码 12 时 516 条测试全绿；工具返回值从不与 `OUTPUT_SCHEMA` 对照，`...answer` 一直在泄漏未声明的 `hits`。

**Follow-up.** `followup_review_recommended: true` —— 首轮 patch 里含 8 条 high。下一轮值得盯的是两处：`refuse()` 回显配置宽度而不是被拒参数（判为设计取舍，但这是第二次有人问到它），以及 `isSearchable` 对未知 kind 的宽松默认（现在只有一条用例锁住，模型以后加 kind 时没人提醒分类）。

**Verification.** 见上一节实测：build/lint/gate/test/coverage 五项 exit 0，532 条测试通过，行 92.8% / 分支 79.8%。断线验证四次：把 `candidatePool` 接线改硬编码、把 `describe()` 的 matched 换回 `found.hits.length`、把 `topK` 上限换回字面量 8、把 `recall()` 的 try/catch 去掉，各自只让对应用例转红。

**Residual risk.** ①扫描仍是全量物化 live 集，没有上限——这是 AC⑦ 的 p95 基线只有约 1ms 的原因（200 条节点），不代表真实库规模下的表现，NFR-2 的 900ms 要等 Epic 5 的向量路径复测。②`degraded` 在本故事恒 false，字段与封闭词表是为 Epic 5 预埋的，现在没有任何路径能把它们设成 true，所以「降级真的会被填」这件事一条用例都没证明。③子串匹配的打分内核不具备区分力，短查询几乎必然命中，这条已 defer。④CI 未在 GitHub 实跑，全仓扫描的假阳性风险只在本机 fixture 上验过。
