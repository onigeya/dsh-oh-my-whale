---
title: '2.2 证据指针与引文脱敏截断'
type: 'feature'
created: '2026-11-24'
status: 'done'
baseline_revision: '3fe497aab1b2288b17774aa48138796a69f17a83'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/docs/implementation-artifacts/epic-2-context.md'
  - '{project-root}/docs/specs/spec-DSH哦鲸鲸/data-model.md'
  - '{project-root}/docs/planning-artifacts/architecture/architecture-DSH哦鲸鲸-2026-11-23/ARCHITECTURE-SPINE.md'
warnings: []
deferred:
  - summary: >-
      证据 payload 不带 vec_state，与其它节点不一致；2.5 建召回检索时必须显式排除 kind:'evidence'，
      否则不可变节点会被当成「待回填向量」的常态化对象。
    evidence: >-
      src/core/evidence.ts 的 buildEvidencePayload 只写 kind/mem_key/session_id/seq_from/seq_to/quote/
      quote_truncated/deidentified 八键，没有 vec_state；src/store/search.ts 的 UNSEARCHABLE_KINDS 已把
      evidence 排除在文本检索之外，但向量回填路径尚未存在（2.5 才建），届时需一并验证回填扫描范围。
    location: 'src/core/evidence.ts:222-233'
    severity: medium
  - summary: >-
      含证据写入的性能判据断言绝对墙钟（median ≤2ms、p95 ≤10ms、与无证据写入比值 ≤5x），
      在慢机器或 CI 抖动下会随机失败；判据本身来自 AC，不能由本故事自行放宽。
    evidence: >-
      test/store/evidence-commit.test.ts 用 WARMUP=100 / SAMPLES=200 取中位数与 p95 直接比绝对阈值；
      改为「相对同机 insert 基线」的做法需要先统一全仓性能用例口径，留给 retro。
    location: 'test/store/evidence-commit.test.ts'
    severity: low
  - summary: >-
      IdReservationError 仍复用 code 'E_GATE_DOWN'，把实现缺陷说成「写面未就绪」。
      文案已专属，但错误码受 AD-25 封闭七码约束，加内部错误码要改契约。
    evidence: >-
      src/core/tool-errors.ts:20-28 的 TOOL_ERROR_CODES 是 E_BUDGET/E_TIMEOUT/E_DEGRADED/E_BOUNDARY/
      E_GATE_DOWN/E_CONFLICT/E_NOT_IMPLEMENTED；src/seams/write-port.ts:668-681 的 IdReservationError
      分支返回 code 'E_GATE_DOWN' 与专属 message。
    location: 'src/seams/write-port.ts:668-681'
    severity: low
  - summary: >-
      宿主工具调用不带 exec 时 sessionIdOf 返回 undefined，模型声明了 evidence 也只会被记为
      「没有会话」而丢掉；是否该在缺 exec 时拒绝整张表属工具面契约问题，本故事不擅自收紧。
    evidence: >-
      src/seams/tools.ts 的 sessionIdOf 在 exec 缺失或 agent.id 非字符串时返回 undefined；
      write-port 收到 undefined 时对每个区间发 OMW_EVIDENCE_NO_SESSION 并在应答里 dropped 计数，
      用例 'a declared source in a write that names no session' 覆盖了这一行为。
    location: 'src/seams/tools.ts:273-281'
    severity: medium
  - summary: >-
      已知未验证分支（不计入 42 条）：write-port 的两处 linkSkipped 日志在现有 id 预留不变量下不可达，
      因此没有任何测试能驱动它；若将来预留额度算法改动，这两处会成为唯一线索，需保留而不是删除。
    evidence: >-
      src/seams/write-port.ts:603 与 :609 的两个 warn 分支分别要求 item.id ?? evidenceIds.get(key)
      为 undefined、以及 assertionIds.get(memKey) 为 undefined；预留额度由 plan.nodes.length +
      fresh.length + ledger.length 同源推出，且 resolved 的已有指针 id 来自 gateway.findEvidenceId，
      现有用例（50 项 evidence/write-port 用例）无法构造该状态。grep 确认 test/ 下 linkSkipped 只出现在
      test/core/evidence.test.ts:233 的常量存在性断言。
    location: 'src/seams/write-port.ts:603,609'
    severity: low
---

# 2.2 证据指针与引文脱敏截断

<intent-contract>

## Intent

**Problem:** 2.1 写下的每条断言目前没有任何来源。AD-6 要求「追得到」：每条断言配一条证据指针，指针里只有 `session_id / seq_from / seq_to / quote / quote_truncated / deidentified` 六个字段，引文 ≤200 字符、脱敏先于截断、原文一律不入库；宿主不提供消息回读时指针仍要存在并标「不可解引用」，绝不伪造原文。今天 `src/` 里证据实现为零，`op:'assert'` 也没有声明来源的位置。

**Approach:** 把来源做成补丁表的一部分：`op:'assert'` 增加可选 `evidence:{seq_from, seq_to}`，`session_id` 由工具执行的 `exec.agent.id` 补；写入路径在排队**之前**经 `ctx.sessionQuery.readEvent` 取回原文、只抽 `type:'text'` 块、脱敏、再截断，然后把证据节点、断言节点与 `supports` 边（证据 → 断言）放进**同一个** `commitTransaction`。引擎不给 id 预分配，所以一个含证据的批次改成先取 `max(allNodeIds())+1` 自己分配显式 id，再用 `insertWithId` + `link` 落库。读取面新增只读命令 `/omw evidence <mem_key>`，被人读行与固定字段 JSON 同时输出，`sessionQuery` 缺席或调用失败时标 `degraded: 'evidence-unresolvable'`。导出的敏感排除落在 store 的唯一一个证据查询上（`createReadGateway(...).listEvidenceFor(key, {includeSensitive})`），真正的 `omw export` 留给 3.5。

## Boundaries & Constraints

**Always:**
- 证据 payload 恰好 8 个键：AD-6 的六个，加上本库每个节点都带的存储局部身份 `kind` 与 `mem_key`。多一个键都是违规。
- 引文只来自宿主事件的 `type:'text'` 内容块；`reasoning`、`tool-call`、`file` 等块一律不贡献文本，隐藏推理不得进库。
- 脱敏先于截断：先对原文做四类掩码，再按 Unicode 码点截到 200，截断后长度必然 ≤200。
- 证据节点与断言节点、`supports` 边同批提交：一次 `commitTransaction`，要么全在，要么全不在。
- 证据节点的 `mem_key` 是 `evidence:<session_id>#<seq_from>-<seq_to>`；同一区间第二次被引用时复用已有节点并补一条边。复用靠**写队列单任务串行 + 队内 `findLive`**成立，不靠唯一索引：证据不可变、不带 `active_slot`，`(mem_key, active_slot)` 索引对它不成立。绕过写队列直接插库的第二个写者可以造出重复节点。
- 引文取不到（`sessionQuery` 缺席、抛错、目标事件没有 text 块）时 `quote` 写空串、`deidentified` 写 `false`，绝不用任何替代文本填充。
- 含证据的批次由写入路径自己分配显式节点 id，分配前用 `src/store/db.ts` 的 `hasNode(db, id)` 兜底防撞号（所有 triviumdb 调用都经该门面）；不含证据的批次保持 2.1 的引擎自动 id。防撞号的前提同样是写队列串行。
- 读取面只读：`/omw evidence` 不写库、不建节点、不进召回与注入。
- 输出、日志、flag 载荷里不出现节点 id（AR-4）；证据节点 id 只在进程内用于建边。

**Never:**
- 不把整段消息体、事件 JSON 或 `data` 原样写进任何 payload。
- 不写 `superseded_at: null`（未失效一律省略该键）。
- 不做断言改写与版本链（2.3）、召回（2.5）、注入（2.4）、审计行与导出命令（2.6、3.5）。
- 不新增物理删除路径。
- 不在写入事务里做网络/磁盘回读：原文读取发生在入队之前，队列任务内只做计划与提交。
- 不因证据不可解引用而整体拒写，也不因此触发 AD-13 全停；这只是 AD-18 的局部降级。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
| --- | --- | --- | --- |
| EV_WRITE_NEW | assert 带 `evidence:{seq_from:12,seq_to:12}`，sessionQuery 返回文本 | 一条证据节点（8 键）+ 断言节点 + 一条 `supports` 边证据→断言，同批提交 | — |
| EV_REUSE | 同一 `(session_id, seq_from, seq_to)` 第二次被引用 | 不新建证据节点，复用已有节点 id 补边 | — |
| EV_DEGRADED_NO_QUERY | `sessionQuery` 缺席或 `readEvent` 抛错 | 证据节点仍落库，`quote:''`、`quote_truncated:false`、`deidentified:false`，写入返回成功 | 记 `warn(OMW_EVIDENCE_UNREADABLE)`，不改变写入结果 |
| EV_INVALID_RANGE | `seq_to < seq_from`、非整数、<1 | 整表拒收 `E_BOUNDARY`，一条 rejected 节点记原因，无证据节点 | 拒绝整张表 |
| EV_BAD_SHAPE | `evidence` 不是对象、含额外键、`seq_from` 缺失 | 整表拒收 `E_BOUNDARY`（strict schema） | 拒绝整张表 |
| EV_QUOTE_200 | 原文恰好 200 码点、无敏感命中 | `quote` = 全文，`quote_truncated:false` | — |
| EV_QUOTE_201 | 原文 201 码点 | `quote` = 前 200 码点，`quote_truncated:true` | — |
| EV_MASK4 | 原文含手机号/身份证/邮箱/银行卡 | 四类都被替换成掩码，`deidentified:true`，原文片段在 payload 任何位置都找不到 | — |
| EV_MASK_THEN_TRUNC | 240 码点且前 200 内含敏感号 | 先掩码再截断，`quote` ≤200 且无敏感数字，`deidentified:true` | — |
| EV_NON_TEXT_BLOCK | 目标事件只有 reasoning / tool-call 块 | 视为取不到引文，走 EV_DEGRADED_NO_QUERY 的写法 | 同上 |
| EV_TX_ATOMIC | 同批断言与证据，引擎在提交阶段失败 | 库内既无证据节点也无边，返回封闭错误码 | 整批 `not_committed` |
| READ_OK | `/omw evidence assertion:Elliott:lives_in`，sessionQuery 可用 | 人读行 + 固定字段 JSON，含 `session_id/seq_from/seq_to/quote/quote_truncated/deidentified`，无 `degraded` | — |
| READ_DEGRADED | 同上但 sessionQuery 缺席 | 同字段并附 `degraded:'evidence-unresolvable'`，引文仍是库内那份 | 不报错 |
| READ_EMPTY | 断言存在但没有证据 | 空列表 + 一句「没有证据指针」 | 不是错误 |
| READ_UNKNOWN | `mem_key` 库里不存在 | 一句「未找到该业务键」，不含节点 id | 不是错误 |
| EXPORT_DEFAULT | 两条证据，一条 `deidentified:true` | 默认只返回 `false` 那条；`includeSensitive` 才两条 | — |
| PERF_EV | 含证据的写入重复 200 次 | 中位 ≤2ms、p95 ≤10ms、与 2.1 无证据写入比值 ≤5x | — |

</intent-contract>

## Code Map

- `src/core/evidence.ts` -- 新增：四类脱敏正则、`maskSensitiveText`、`quoteFromText`（200 码点/truncated）、`evidenceMemKey`、`buildEvidencePayload`（8 键）、`extractQuoteSource`（结构声明的事件文本抽取）、`checkEvidenceRange`（区间上界 20）、`isUnreadableQuote`、`EVIDENCE_LOG_CODES`。导出排除规则**不在**此模块（层级规则不允许 store 反向 import），见 `src/store/commits/reads.ts`
- `src/store/templates/evidence.ts` -- 新增：`findEvidenceByKey`（TQL，唯一一处证据查询）与 `listSupporting`（`getIncomingEdges(id,'supports')` + `getPayload`）
- `src/store/commits/reads.ts` -- 新增：`createReadGateway(db)`，只有 `findLive` + `listEvidenceFor(assertionMemKey, {includeSensitive?})`，不建 commit engine、不 hold 可关句柄；`deidentified:true` 的引文默认不返回，是 AD-6/FR-24 排除规则的**唯一**落点
- `src/store/templates/rows.ts` -- 新增：`DECIMAL`、`toNodeId`、`toStoredNode` 三个模板共用助手（原本在 assertions 与 evidence 两份里逐字重复）
- `src/store/commits/engine.ts` -- 扩 `PlannedLink` 与 `toTransactionOperations`：`inserts` 支持可选 `id`（转 `insertWithId`），新增 `links` 段（`link` 操作，排在 inserts 之后）
- `src/store/commits/assertions.ts` -- `PlannedInsert.id?`、`PlannedCommit.links?`、`WriteGateway.allocateIds(count)`（`allNodeIds()` 取最大 id + `contains` 兜底）、`commit` 透传 links
- `src/core/patch.ts` -- `assertOpSchema` 加 `evidence:{seq_from,seq_to}`（strict）；`planPatchTable` 产出 `EvidenceDraft[]`（带 op index 与目标业务键）；`PatchContext` 不加 IO，保持纯函数
- `src/seams/evidence-source.ts` -- 新增：把 `ctx.sessionQuery` 适配成 `readQuote({sessionId,seq})`，超时与异常一律返回 `undefined`
- `src/seams/write-port.ts` -- `remember` 增第四个参数 `sessionId?`；入队前解析带证据的 op 并 `await readQuote`；队列内分配显式 id、建 `links`；`WritePortDeps.readQuote?`
- `src/seams/tools.ts` -- `execute(args, exec)` 取 `exec.agent.id`；`PARAMETERS` 的 assert 段加 `evidence`；`DESCRIPTIONS` 补一句来源声明
- `src/seams/commands.ts` -- `/omw evidence <mem_key>`：按 `rawInput` 原文取键（不能取小写后的串），人读行 + JSON 行
- `src/seams/runtime.ts` -- 解析 `ctx.sessionQuery`（缺席不阻断写面），建 `readQuote` 注入 WritePort，`Runtime.evidence?`
- `src/index.ts` -- 把 `() => runtime.evidence` 传给 `registerOmwCommand`
- `test/core/evidence.test.ts` -- 新增：脱敏四类、200/201 边界、脱敏先于截断、码点截断、导出判定
- `test/store/evidence-commit.test.ts` -- 新增：同批原子性、显式 id 不撞号、复用去重、边方向
- `test/seams/evidence-port.test.ts` -- 新增：工具带 evidence 的端到端、无 sessionQuery 降级、`/omw evidence` 三种输出

## Tasks & Acceptance

**Execution:**
- `src/core/evidence.ts` -- 写四类正则 + `maskSensitiveText` + `quoteFromText` + `evidenceMemKey` + `buildEvidencePayload` + `extractQuoteSource` -- 全部纯函数，脱敏与截断的唯一实现处，写入与读取共用
- `src/store/commits/reads.ts` -- 只读网关与导出排除规则 -- 规则放在唯一会生效的查询上，不给第二份拷贝留位置
- `src/core/patch.ts` -- `assertOpSchema` 加 `evidence` 子对象；`planPatchTable` 收集 `EvidenceDraft` 并校验 `seq_to >= seq_from` -- 形状与语义仍分两段报错
- `src/store/commits/engine.ts` -- `toTransactionOperations` 接受 `inserts[].id` 与 `links` -- 引擎唯一写入点的形状扩展
- `src/store/commits/assertions.ts` -- `allocateIds` + `commit` 透传 -- id 必须由写路径自带，队列内串行分配才不撞号
- `src/store/search.ts` -- `UNSEARCHABLE_KINDS` 跳过 `kind:'evidence'` -- 证据引文不是可检索的记忆文本
- `src/seams/evidence-source.ts` -- sessionQuery 适配层 -- 宿主能力必须可选，异常不得穿透
- `src/seams/write-port.ts` -- 入队前取引文、队列内分配 id 与建边 -- 回读不能在事务里做
- `src/seams/tools.ts` / `src/seams/runtime.ts` / `src/index.ts` -- 传 `exec.agent.id`、解析 sessionQuery、接命令 -- 会话语义来自宿主，不在插件里猜
- `src/seams/commands.ts` -- `/omw evidence` 子命令 -- AC1 的「读取」需要真实宿主里可见
- `test/**` -- 三个新测试文件 -- 每条 AC 至少一个可断言的用例

**Acceptance Criteria:**
- Given 一张带 `evidence:{seq_from:12,seq_to:12}` 的补丁表与可用的 sessionQuery，when remember 提交，then 库内恰有一条证据节点，payload 的键集合等于 `{kind,mem_key,session_id,seq_from,seq_to,quote,quote_truncated,deidentified}`。
- Given 同上，when 提交成功，then 存在一条 `label:'supports'` 的边由证据节点指向断言节点。
- Given 同批断言与证据，when 引擎在提交阶段拒绝（注入失败），then 库内证据节点数为 0、`supports` 边数为 0，返回码属于封闭错误码集合。
- Given 目标区间第二次被引用，when 提交，then 证据节点总数不变，且新断言节点也有一条 `supports` 入边。
- Given 同一张表里两个 assert op 引用同一区间，when 提交，then 只有一条证据节点、两条 `supports` 边。
- Given `sessionQuery` 缺席，when remember 带证据提交，then 写入返回成功、证据节点存在、`quote` 为空串、`deidentified` 为 false。
- Given `sessionQuery.readEvent` 抛错，when 同上，then 结果与上一条相同，且日志出现 `OMW_EVIDENCE_UNREADABLE`。
- Given 目标事件只含 `reasoning` 与 `tool-call` 块，when 取引文，then `quote` 为空串（不落任何推理文本）。
- Given 原文恰好 200 码点且无敏感命中，when 写入，then `quote` 等于原文、`quote_truncated` 为 false。
- Given 原文 201 码点，when 写入，then `quote` 长度 200、`quote_truncated` 为 true、末字符等于原文第 200 码点。
- Given 原文含手机号、身份证、邮箱、银行卡各一处，when 写入，then 四段原文都不出现在 payload 的任何字符串里，`deidentified` 为 true。
- Given 原文 240 码点且前 200 内有一处手机号，when 写入，then `quote` ≤200 码点、不含该号码、`deidentified` 为 true、`quote_truncated` 为 true。
- Given 原文 210 码点，脱敏后剩 198，when 写入，then `quote_truncated` 为 false、`deidentified` 为 true。
- Given 引文在第 200 码点处是四字节 emoji，when 截断，then 按码点截断而非 UTF-16 单元，`quote` 不出现半个代理对。
- Given `evidence:{seq_from:5,seq_to:3}`，when 写入，then 返回 `E_BOUNDARY`、无证据节点、恰一条 `rejected` 节点记录该表。
- Given `evidence` 里出现额外键或 `seq_from` 不是整数，when 写入，then 返回 `E_BOUNDARY` 且不落任何节点。
- Given assert op 不带 `evidence`，when 写入，then 证据节点与 `supports` 边都为 0（2.1 行为不变）。
- Given 一个含证据的批次，when 分配 id，then 每个插入节点都带显式 id，且没有一个 id 在提交前就已存在于库内。
- Given 断言 `assertion:Elliott:lives_in` 有证据且 sessionQuery 可用，when 执行 `/omw evidence assertion:Elliott:lives_in`，then 输出含 `session_id`、`seq_from`、`seq_to`、`quote`、`quote_truncated`、`deidentified`，且不含 `degraded`。
- Given 同上但 sessionQuery 缺席，when 执行该命令，then 输出附 `degraded:'evidence-unresolvable'`，`quote` 与库内一致。
- Given 断言没有证据，when 执行该命令，then 输出空列表与一句「没有证据指针」，返回成功。
- Given 一个库里不存在的 `mem_key`，when 执行该命令，then 输出「未找到该业务键」，不含任何节点 id。
- Given 任一读取输出，when 检查文本，then 不出现纯十进制节点 id（session_id 与 seq 不受此限）。
- Given 两条证据一条 `deidentified:true`，when 走默认导出判定，then 只返回 false 那条；`includeSensitive` 为真时返回两条。
- Given 含证据的写入重复 200 次，when 统计耗时，then 中位 ≤2ms、p95 ≤10ms，与无证据写入比值 ≤5x。
- Given 全仓，when 跑 `pnpm build`、`pnpm lint`、`pnpm test`、`pnpm test:coverage`、`node scripts/check-layers.mjs`，then 全 exit 0，行覆盖 ≥80%、分支 ≥70%，`link(` 只出现在 `store/commits/**`。

## Spec Change Log

- 2026-11-24 — 初稿。三个公开面由用户拍板：`source=declare`（补丁表声明 seq 区间，`session_id` 取 `exec.agent.id`）、`readback=command`（`/omw evidence <mem_key>`）、`export=filter`（只交共享排除判定与查询开关，命令留给 3.5）。

## Review Triage Log

共 **42** 条发现：blind-hunter 23 + edge-case-hunter 12 + verification-gap 7（intent-alignment 输出的是六种读法与错位分析，无编号条目，不计入表头，结论见本节末）。裁定 **patch 38 / defer 4 / reject 0**；severity 为 lead 判定：high 6 / medium 24 / low 12。另有 1 条评审中发现的已知未验证分支（不可达的 `linkSkipped` 出口）写入 frontmatter `deferred`，不计入这 42 条。

### blind-hunter（23）

- `[medium]` `[patch]` 声明的区间只读了 `seq_from` 一条事件 — `src/seams/write-port.ts` 的 `readDeclaredRanges` 现按 `for (let seq = from; seq <= to; seq += 1)` 逐条回读，只收 `type:'text'` 的块并以换行拼接；任一条读不到即整段判不可读，不拼残缺文本。
- `[high]` `[patch]` 四类脱敏正则不认带分隔符的号码，`138 1234 5678` / `+8613812345678` / `138-1234-5678` 都能原样入库 — `src/core/evidence.ts:64` 新增 `NUMERIC_GAP = '[- \u00A0]?'` 并接进手机号、身份证、银行卡三条规则；新增用例 `masks a phone number before it stores the quote` 与带分隔符的边界用例。
- `[low]` `[patch]` 不含末位 X 的 18 位身份证被标成 `[银行卡]` — 身份证规则改为中间要求可信的 `YYYYMMDD`、末位 `[\dXx]`，不再要求字母；掩码名称因此与证件一致。
- `[high]` `[patch]` 断言已存在时 `continue` 早于证据入队，声明的来源被静默丢弃 — `src/core/patch.ts:911` 在 `resolveAssert` 的 existing 分支补 `pushEvidence`，用例 `a fact that already exists > still gets its pointer` 断言指针节点与 `supports` 边都落在已存在断言的 id 上。
- `[medium]` `[patch]` 两处 `continue` 会静默丢掉 `supports` 边，`EVIDENCE_LOG_CODES.linkSkipped` 从未发出 — `src/seams/write-port.ts:603` 与 `:609` 各发一次 `warn(OMW_EVIDENCE_LINK_SKIPPED, …)`。两处在 id 预留不变量下不可达（预留额度与循环计数同源），属防御性代码，见 deferred。
- `[medium]` `[patch]` 写应答不提证据状态，模型无法区分「指针写好」与「引文降级为空」 — `WriteAnswer.evidence` 新增 `declared/created/reused/redacted/unreadable/dropped` 六键（`src/seams/write-port.ts:183-204`、`:521-530`），`describeSuccess` 一并播报；用例断言无 session 时 `dropped:1`、降级 scene 时 `created:1`。
- `[medium]` `[patch]` `highestNodeId` 每次全量物化 `allNodeIds()`，且 `db.contains` 绕过 `src/store/db.ts` 门面 — 门面补齐 `hasNode(db, id)` 并改由 `allocateIds` 使用（`src/store/commits/assertions.ts:223`）；全量物化的性能问题见 deferred。
- `[medium]` `[patch]` 只拿 `pointers[0]` 探针决定整批降级，且无 `readQuote` 时的文案误称「不可解引用」 — `src/seams/evidence-reader.ts:203-210` 改为逐指针 `Promise.all`，`:223-225` 区分「未接入会话回读」与「此刻不可解引用」两种文案。
- `[medium]` `[patch]` 读取器自建第二套 write gateway，`dispose` 只翻布尔从不 close — 改由 `createReadGateway`（`src/store/commits/reads.ts`）承担，不建 commit engine、不持可关句柄。
- `[low]` `[patch]` `intField` 把缺失的整数读成 0，渲染出伪造的 `#0-0` — `src/seams/evidence-reader.ts:106-109` 改为返回 `undefined` 并跳过该指针。
- `[high]` `[patch]` 不可读引文与「干净的空引文」字节相同，导出判定只看 `deidentified`，读不出来的反而可被导出 — `src/core/evidence.ts` 新增 `isUnreadableQuote`，导出排除规则落在 `src/store/commits/reads.ts` 的 `listEvidenceFor`（AD-6/FR-24 的唯一落点）。
- `[medium]` `[patch]` `filterExportableEvidence` 在 `src/` 零调用者 — 删除该函数，规则改为由 `createReadGateway` 的 `listEvidenceFor(key, { includeSensitive })` 实现；核心层不再持有导出策略。
- `[medium]` `[patch]` 宿主回读不可取消，一次慢读会占住写入 — `src/seams/evidence-source.ts` 改为 `AbortController` + `READ_QUOTE_TIMEOUT_MS = 250` + `Promise.race`，超时 `abort()` 后按不可解引用处理，`finally` 清定时器。
- `[low]` `[patch]` `evidenceRangeSchema` 用 `z.number()` 与工具声明的 `integer` 不符 — 改为 `z.number().int()`（`src/core/patch.ts:159-162`）。
- `[low]` `[patch]` 证据模板的三处 node/row 助手与断言模板重复 — 抽到 `src/store/templates/rows.ts`（`DECIMAL`/`toNodeId`/`toStoredNode`），两个模板共用。
- `[medium]` `[patch]` 测试未覆盖 `seq_to > seq_from`、未断言实际回读的 seq、`sessionIdOf` 未走真实 `exec` — `test/seams/evidence-port.test.ts` 新增三个 describe，`test/seams/memory-tools.test.ts:90` 遍历 `{}`/`{agent:{}}`/`{agent:{id:''}}`/`{agent:{id:7}}`/`undefined`。
- `[low]` `[patch]` `/omw evidence` 的 JSON 行丢掉 `answer.message` — `src/seams/commands.ts:469-477` 的 payload 补 `message`。
- `[low]` `[patch]` 用证据节点自身的 `mem_key` 查询会当成一条没有来源的事实回答 — `src/seams/evidence-reader.ts:181-189` 在 `kind === 'evidence'` 时返 `E_BOUNDARY` 并提示用它所支持的记忆的业务键。
- `[high]` `[patch]` 证据引文可被 `src/store/search.ts` 的文本检索命中 — 新增 `UNSEARCHABLE_KINDS` 与 `searchable()`，`searchText` 跳过 `kind:'evidence'`（`src/store/search.ts:48/54/59`）。引文只经 `/omw evidence` 与导出两条路径出库。
- `[low]` `[patch]` `sprint-status.yaml` 仍写 `2-2: backlog`，README 无证据章节 — `sprint-status.yaml:48` 随本次交付改 `done`；README 新增「追源：/omw evidence」一节（`:93-110`）。
- `[medium]` `[defer]` 证据 payload 不带 `vec_state`，与其它节点不一致 — 证据不可变、不参与版本链，补 `vec_state` 只会让「待回填」语义蔓延到不可变节点。2.5 建召回索引时必须显式排除 `kind:'evidence'`，届时一并验证回填范围，见 deferred。
- `[low]` `[defer]` `test/store/evidence-commit.test.ts` 的性能用例断言绝对墙钟（median ≤2ms、p95 ≤10ms、比值 ≤5x，`WARMUP=100`/`SAMPLES=200`），在慢机器上会随机失败 — 判据本身来自 AC，不能自行放宽；改为相对基线的做法留给 retro 统一处理，见 deferred。
- `[low]` `[patch]` `src/seams/evidence-reader.ts` 本地重声明 `E_OK` — 改为 `import { E_OK } from './write-port.ts'`（`:21`），成功码只有一个出处。

### edge-case-hunter（12）

- `[high]` `[patch]` 已存在的活断言再加证据时指针丢失（与 blind 4 同根，独立复现） — `src/core/patch.ts:911` 已修，用例 `a fact that already exists` 覆盖。
- `[medium]` `[patch]` 同一张表里重复声明同一断言，第二段的区间被丢弃 — `src/core/patch.ts:871` 在表内 `seen` 命中路径补 `pushEvidence`。
- `[medium]` `[patch]` 降级为 scene 的重复键路径丢区间 — `src/core/patch.ts:792`（已有 scene）与 `:797`（新 scene）两处补 `pushEvidence`；新增用例 `a declared source on a write that degrades to a scene` 断言指针指向 scene 节点。
- `[medium]` `[patch]` 无 session 时静默丢弃声明的区间 — `src/seams/write-port.ts:403` 对每个区间发 `warn(OMW_EVIDENCE_NO_SESSION)`，应答里 `evidence.dropped` 如实计数；用例 `a declared source in a write that names no session` 同时断言日志与应答。
- `[medium]` `[patch]` 区间内某个 `seq` 的事件不存在时静默截断 — 逐 seq 回读路径在 `src/seams/write-port.ts:420` 发 `warn(OMW_EVIDENCE_UNREADABLE, {range, seq})` 并把整段判为不可读；用例 `degrades the pointer when an event inside the range cannot be read` 覆盖。
- `[medium]` `[patch]` `linkSkipped` 从未发出（与 blind 5 同根，独立复现） — `src/seams/write-port.ts:603/:609` 已补，可达性讨论见 blind 5 与 deferred。
- `[medium]` `[patch]` `/omw evidence` 未把 `reader.read` 包进 try/catch，读取器抛错会冒到命令层 — `src/seams/commands.ts:463-470` 包住并降级为可读文案。
- `[low]` `[defer]` `IdReservationError` 复用 `code: 'E_GATE_DOWN'`，把实现缺陷说成「写面未就绪」 — 文案已专属（`src/seams/write-port.ts:668/:739`：本次写入没有落库：内部节点 id 预留不足），但 `TOOL_ERROR_CODES` 是 AD-25 的封闭七码，加内部错误码要改契约。路由 defer，见 deferred。
- `[low]` `[patch]` `/omw evidence` 只取第一个空白分隔的 token，多写的词被吞进「未找到」 — `parseEvidenceKey`（`src/seams/commands.ts:403-414`）改为返回 `ok:false` 并点名多写的词；用例 `reports a second word instead of dropping it into a confident not-found` 覆盖。
- `[medium]` `[defer]` 宿主不带 `exec` 时 `sessionIdOf` 返回 `undefined`，模型声明了证据也静默丢 — 现在至少会发 `OMW_EVIDENCE_NO_SESSION` 并在应答里 `dropped` 计数，但「工具调用缺 `exec` 时该不该拒绝整张表」属工具面契约问题，路由 defer，见 deferred。
- `[medium]` `[patch]` 规格断言「同一区间只有一条活动证据」过强 — 证据无 `active_slot`，`(mem_key, active_slot)` 唯一索引对它不成立；规格改写为「靠写队列单任务串行 + 队内 `findLive` 复用，绕过队列的第二个写者可以造出重复节点」。
- `[medium]` `[patch]` 规格断言「id 防撞」未写明前提 — 改写为「用 `hasNode(db, id)` 兜底，前提同样是写队列串行」，与实现一致。

### verification-gap（7）

- `[medium]` `[patch]` `remember` 的第四参 `sessionId` 无测试驱动 — `test/seams/runtime-write.test.ts` 新增 `runtime: the host session log (AD-6)` 三项，`test/seams/memory-tools.test.ts:81` 直接传 `{agent:{id:'session-alpha'}}`。
- `[medium]` `[patch]` `runtime` 解析 `ctx.get('sessionQuery')` 没测过 — 新增用例 `resolves sessionQuery through ctx.get and lands the sentence on the pointer`，断言宿主只被问了声明的那个 seq、引文落到指针上、`degraded` 不出现。
- `[medium]` `[patch]` `runtime.evidence` → `/omw evidence` 没走真实 `apply()` 挂载 — 新增用例 `answers /omw evidence through a real apply() mount`，走 `apply(context, { db })` + 命令注册表 + 真实 `remember` 写入，断言人读行与末行 JSON 一致。
- `[high]` `[patch]` 已存在断言的声明来源被静默丢弃（与 blind 4 同根） — `src/core/patch.ts:911` 已修，证据指针与边都落在已存在断言上。
- `[medium]` `[patch]` 降级 scene 分支的证据收集零测试 — 新增用例 `keeps the pointer and points it at the scene node`，断言 `supports` 边指向 scene 节点而非断言。
- `[low]` `[patch]` `EVIDENCE_LOG_CODES.linkSkipped` 从未发出 — 代码已在 `src/seams/write-port.ts:603/:609` 发出。这两处在当前 id 预留不变量下不可达（预留额度由 `plan.nodes.length + fresh.length + ledger.length` 同源推出），因此仍没有测试能驱动，作为已知未验证分支记入 deferred。
- `[medium]` `[patch]` `takeId` 内部抛错被误报成 `E_GATE_DOWN` 的普通写失败 — `run` 现在先判 `IdReservationError`，发 `OMW_EVIDENCE_ID_RESERVATION` 并回「本次写入没有落库：内部节点 id 预留不足（这是实现缺陷，已写入日志）」，与队列关闭的文案分开。

### intent-alignment

六种读法（A–F）均不构成 intent_gap：用户拍板的三个公开面（`source=declare` / `readback=command` / `export=filter`）在实现里一一对应，AC1–AC5 逐条可指认到代码。该层提出的 §3.0–3.8 错位属叙述顺序问题，不改实现；其中「导出命令」一条已在 Spec Change Log 记明留给 3.5。故本轮无 intent_gap、无 bad_spec，`review_loop_iteration` 保持 0。

## Design Notes

- **证据身份**：`evidence:<session_id>#<seq_from>-<seq_to>`。用 `#` 分隔是因为 `SessionId` 本身可能含冒号，混用会让业务键无法反解；`data-model.md` §2 只规定「其它 kind 用 `<kind>:<稳定名>`」，本形态即该条的实例。
- **为什么 payload 多两个键**：AD-6 写「负载只允许六个字段」，但本库每个节点都需要 `kind` 才能被 TQL 检索（`/omw evidence`、dream 第 ① 步、导出都依赖），而 2.1 的全部 payload 也都显式带 `kind` 与 `mem_key`。这两个键是存储局部身份，不是消息内容，因此按「六个内容字段 + 两个身份字段」执行，并在评审里作为一条已知偏差记录。
- **不写 `active_slot`**：证据不可变、不版本化，`(mem_key, active_slot)` 唯一索引对它不成立（缺键即绕开索引）。去重因此靠队列内的 `findLive`：写队列单任务串行，同一毫秒的两次引用不会并发。
- **AD-6「保留原长度」无法落地**：六字段白名单里没有长度字段，`quote_truncated` 是布尔。要么加第九个键，要么放弃该子句。选择放弃并把矛盾记进 deferred，留给 retro 修正 spine，而不是在 2.2 私自扩字段。
- **`quote_truncated` 的语义**：指「入库引文相对脱敏后文本是否被截断」。原文 210、脱敏后 198、未截断 → `false` + `deidentified:true`。这样两个布尔各自回答一个问题，不重叠。
- **为什么逐条读整个区间**：`seq_from`–`seq_to` 是一段话可能跨的若干事件，只取起点会丢掉后半句，让引文与断言对不上。因此逐 seq 回读、只收 `type:'text'` 的块、以换行拼接；任一条读不到就把整段判为不可读（不拼接残缺文本，避免伪造半句）。区间宽度上限 `MAX_RANGE_EVENTS = 20`，由 `checkEvidenceRange` 在规划前拒绝，读取不会无界。
- **id 分配**：`allNodeIds()` 取最大值 + 1 递增，`hasNode(db, id)`（`src/store/db.ts` 门面，唯一触 triviumdb 的地方）兜底防撞。只有含证据的批次才走显式 id；不含证据时保持引擎自动 id，2.1 的行为与性能不变。
- **降级不伪造**：取不到原文时 `quote:''`。读取面把「空引文」与「sessionQuery 缺席」都归到 `degraded:'evidence-unresolvable'`，因为两者对读者意味着同一件事：这条指针指向的原文此刻不可解引用。
- **命令为何也回读**：`/omw evidence` 是人工审计路径，不属于 AD-6 所说的「召回路径只做 seq 语法校验」。它在读库之外再探一次 `sessionQuery` 只为标出可解引用性，失败不回写任何东西。
- **脱敏正则**：四条规则按 邮箱 → 手机号 → 身份证 → 银行卡 的顺序应用，每条都要求前后非数字，数字内部容忍一个空格或连字符（`[- \u00A0]?`），因此 `138 1234 5678`、`+8613812345678`、`138-1234-5678` 都会被认成手机号。身份证要求中间是可信的 `YYYYMMDD`，否则退化为按银行卡标注——掩码只保证不泄露，不保证命名精确。掩码统一为 `[手机号]`/`[身份证]`/`[邮箱]`/`[银行卡]`，长度均短于被替换文本，所以掩码本身不会撑破 200。

## Verification

**Commands:**
- `pnpm build` -- expected: exit 0，无 TS 错误
- `pnpm lint` -- expected: exit 0
- `node scripts/check-layers.mjs` -- expected: exit 0，`link(` 仅出现在 `store/commits/**`
- `pnpm test` -- expected: 全部通过，新增三个测试文件在内
- `pnpm test:coverage` -- expected: 行 ≥80%、分支 ≥70%
- `pnpm exec vitest run test/core/evidence.test.ts --reporter=verbose` -- expected: 脱敏与 200/201 边界逐条通过

**Manual checks (if no CLI):**
- 临时 `DSH_HOME` 起一次真实 `apply()`，用 `remember` 带 `evidence` 写一条，再执行 `/omw evidence <mem_key>`，确认人读行与 JSON 一致且库内 `nodeCount` 只增加证据节点数。

## Auto Run Result

**Status:** done

**What was built.** 记忆从此可追源：`remember` 的补丁表多了可选的 `evidence:{seq_from,seq_to}`，写入路径在入队前用宿主的 `ctx.sessionQuery` 逐条回读该区间，只收 `type:'text'` 的块，先按四类规则脱敏（邮箱 → 手机号 → 身份证 → 银行卡）再按码点截到 200，落成一条不可变证据节点（payload 八键：`kind`/`mem_key`/`session_id`/`seq_from`/`seq_to`/`quote`/`quote_truncated`/`deidentified`），再用 `supports` 边指向断言；证据与断言同批提交，引擎拒绝时两者一起回滚。`/omw evidence <mem_key>` 是只读审计出口，人读行加 JSON 行，说不清就标 `degraded:'evidence-unresolvable'`，绝不伪造原文。默认导出排除 `deidentified:true` 引文这条规则落在唯一会生效的查询上（`createReadGateway().listEvidenceFor(key, {includeSensitive})`），命令本身留给 3.5。

**Changed files.** 新增 11：`src/core/evidence.ts`（脱敏/截断/身份/区间校验的唯一纯函数处）、`src/seams/evidence-source.ts`（sessionQuery 适配 + 250ms 取消）、`src/seams/evidence-reader.ts`（读面投影与降级）、`src/store/commits/reads.ts`（只读网关，导出排除规则唯一落点）、`src/store/templates/{evidence,rows}.ts`、三个测试文件、本 spec。改 15：`src/seams/write-port.ts`（+381，区间回读、id 预留、建边、应答汇总）、`src/seams/commands.ts`（+134，`/omw evidence`）、`src/core/patch.ts`（+60，证据收集含降级 scene 与已存在断言）、`src/seams/{tools,runtime}.ts`、`src/index.ts`、`src/store/{db,search}.ts`、`src/store/commits/{assertions,engine}.ts`、`src/store/templates/assertions.ts`、两个既有测试、`README.md`、`sprint-status.yaml`。合计 15 files / 918 insertions / 80 deletions（不含新增文件）。

**Findings.** 四层评审共产出 42 条（blind 23 / edge 12 / verification-gap 7），lead 判定 high 6 / medium 24 / low 12；裁定 patch 38 / defer 4 / reject 0，另 1 条已知不可达分支单独记入 deferred。**High 六条均已修补**：带分隔符的号码（`138 1234 5678`、`+8613812345678`）此前原样入库；已存在断言再加证据时来源被静默丢弃（重复出现两次）；不可读引文与干净空引文同字节导致读不出来的反可导出；证据引文进入 `searchText` 可被文本检索命中。Verification-gap 七项中四项（④⑤⑥ 与 remember 的 sessionId 参数）由代码修补一并覆盖，剩余两项（`runtime` 解析 `ctx.get('sessionQuery')`、真实 `apply()` 挂载下的 `/omw evidence`）本轮补了三条用例：`test/seams/runtime-write.test.ts` 的 `runtime: the host session log (AD-6)`。无 intent_gap、无 bad_spec，`review_loop_iteration` 保持 0。

**Follow-up.** 建议下一轮复评盯这五处，均已写进 frontmatter `deferred`：① `src/core/evidence.ts:222-233` 的 `buildEvidencePayload` 不带 `vec_state`，2.5 建召回时必须显式排除 `kind:'evidence'`，否则不可变节点会被当成待回填向量的常态对象；② `src/seams/tools.ts:273-281` 宿主不带 `exec` 时 `sessionIdOf` 返回 undefined，声明了 evidence 会被静默记为 `noSession` 丢掉——是否整表拒收属工具面契约问题，不在本故事拍板；③ `src/seams/write-port.ts:668-681` 的 `IdReservationError` 复用 `E_GATE_DOWN`，文案已专属但 `TOOL_ERROR_CODES` 是 AD-25 的封闭七码；④ `test/store/evidence-commit.test.ts` 的性能用例断言绝对墙钟（median ≤2ms、p95 ≤10ms、比值 ≤5x），改相对基线需先统一全仓口径；⑤ `src/seams/write-port.ts:603/:609` 两处 `linkSkipped` 在现有 id 预留不变量下不可达，保留而未删除。另：AD-6「引文保留原长度」这条子句因六字段白名单无长度字段而主动放弃，需要 retro 时回改 spine。

**Verification.** `pnpm build` / `pnpm lint` / `node scripts/check-layers.mjs` 全 exit 0（38 个源文件层级规则通过）。`pnpm test`：Test Files 29 passed | 1 skipped (30)，Tests 383 passed | 1 skipped (384)，14.56s。`pnpm test:coverage`：lines 87.85%（阈值 80）、branches 75.04%（阈值 70）、statements 85.61%、functions 89.5%。单文件：`src/store/commits/reads.ts` 100/100/100/100，`src/core/evidence.ts` 行 100 / 分支 90.47，`src/seams/write-port.ts` 行 92.4 / 分支 82.72。性能用例（200 次含证据写入）同批通过。

**Residual risk.** 证据节点无唯一索引（不可变、不带 `active_slot`，索引对它不成立），同区间去重靠写队列单任务串行 + 队内 `findLive`；绕过队列直接插库的第二个写者可以造出重复证据节点，这条前提已写进 spec 的 Boundaries。
