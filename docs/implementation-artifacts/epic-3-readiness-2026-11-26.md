# Epic 3 开工前的补齐清单

> 产出日期 2026-11-26。依据：`epic-1-retro-2026-11-23.md`、`epic-2-retro-2026-11-25.md`、`sprint-status.yaml` 的 14 条动作项，加上本轮对 `src/` 与 `docs/` 的重新取证。
> 用途：这份清单是给**另一个 Session 一次性补齐**的输入。补齐过程中不要再做回顾、不要再重新评审——条目已经收敛到「改哪一行、改成什么、怎么算改完」。

## 结论

**Epic 3 现在不能开工。** 有 8 件事不给结论，Story 3.1 的第一份 spec 就写不实：其中 5 件是「同一个名字在文档里指两个东西」（命令面、版本链、flag 类型、边标签、置信带计数），2 件是「Epic 2 交付了但没接上」（召回通道、`/omw stats`），1 件是「闸门记录缺失」（`gates/g0-4.json`）。

| 组 | 条数 | 含义 |
| --- | --- | --- |
| P0 阻塞开工 | 8 | 不裁定，Epic 3 的 story 无法写出可测 AC；其中 5 条是措辞冲突，裁定成本约一行文档 |
| P1 只挡某几个 story | 6 | 可以并行补，最晚在该 story 动工前落地 |
| P2 结转 | 10 | 不挡 Epic 3，但必须登记，否则又变成下一轮回顾里「措辞绑定了不存在的实现」 |

补完 P0 与 P1 的估计量级：文档裁定 8 处、代码小改 4 处（`RuntimeDeps.readRecall`、`config.ts` 两段、`patch.ts` 一处类型、`audit.ts` 两个字段）、一次全量测试。**没有一条需要新架构。**

---

## P0：不补齐就无法开 Story 3.1

### P0-1 召回通道契约归位（AD-7）

- **现状**：`readRecall` 在 `src/` 只出现两次——`src/seams/prompt-composer.ts:247` 声明、`:530` 读取；`src/seams/runtime.ts:345-354` 构造 `PromptComposer` 时只展开 `readState`，`RuntimeDeps` 没有 `readRecall` 字段。实测探针：写入 ok、召回命中 ok、装配文本只有 `You are the whale.` 身份段。
- **而且测试把缺陷当正确**：`test/seams/runtime-write.test.ts:157-158` 断言 `expect(plan?.recall.kept).toEqual([])`——「召回不进注入」被写进了期望值。
- **为什么挡 Epic 3**：G-E3-2 的基线就是 Story 2.5 的召回返回体，而「召回段何时进注入通道」至今两说（`spec-2-4` 说 Story 2.5、`spec-2-5` 说 Epic 5）。在未闭合的接缝上给召回返回体加四个字段，等于给一个可能永远不进注入的通道扩契约。
- **补齐定义**（三件必做，缺一不算）：
  1. 在 `ARCHITECTURE-SPINE.md` 的 AD-7 写明：召回段进入注入通道的触发条件与时机，并明确 `RuntimeDeps` **需要** `readRecall`；
  2. `src/seams/runtime.ts` 接上 `readRecall`，`test/seams/runtime-write.test.ts` 那条断言改成正向（`kept` 非空且装配文本含召回内容）；
  3. 改掉 `spec-2-4` 与 `spec-2-5` 里互相矛盾的那一句，只留 AD-7 的口径。
- **验收方式**：跑 `test/seams/runtime-write.test.ts`，装配文本里能看见召回段的原文片段；`grep -r readRecall src/seams/runtime.ts` 命中。

### P0-2 归档 G0-4 的闸门结论

- **现状**：`docs/implementation-artifacts/gates/` 只有 `g0-5`、`g0-6`、`g0-8`（含两次 run 与 progress log），**没有 `g0-4.json`**。Epic 2 回顾的三条不通过理由里，第一条就是「G0-4 未闭合」。
- **为什么挡**：Epic 3 的 G-E3-2 直接建立在这条闭环上；闸门记录缺失意味着 Epic 3 的验收无法引证前置状态，且下一轮回顾会重复这条欠账。
- **补齐定义**：P0-1 完成后写 `gates/g0-4.json`——通过则记 `status: passed` + 三环证据（写入 / 召回 / 装配文本），未通过则记 `status: blocked` + 缺哪一环。同时把 `sprint-status.yaml` 的 `epic-2-retro-item-2` 置 `done` 并把结论写进 action 字段。
- **验收方式**：文件存在且能被 yaml/json 解析；`sprint-status.yaml` 里该 action item 不再是 `open`。

### P0-3 命令面形态裁定

- **现状**：仓库实测只有**一条**命令 `/omw` 加子命令——注册点 `src/seams/commands.ts:334`（`registry.register`，命令名 `'omw'` 在 `:335`）；分派在 `:346`（doctor）、`:353`（pred promote）、`:358`（evidence）、`:361`（history）、`:364`（ledger），未知子命令落到 `:370`；用法文案 `OMW_USAGE` 在 `:254-258`。但四处文档一律写「七条独立斜杠命令」：`ARCHITECTURE-SPINE.md:225`、`prd.md:299`、`requirements.md:145`、`epics.md:692`。
- **为什么挡 Epic 3**：Epic 3 的八个 story 的交付面**全是命令**（`explain` / `version-chain` / `flag-queue` / `export` / `stats` / `brief`）。形态不定，每个 story 都要在「新增一条斜杠命令」与「加一个子命令」之间自己选，用法文案与测试会分叉，`/omw doctor` 也会出现两种写法。
- **补齐定义**：在 `ARCHITECTURE-SPINE.md` 的 AD-40（工具与命令命名）处落一句裁决，二选一——
  - **A（推荐，与现状一致）**：命令面是**一条** `/omw`，其余全是子命令；文档一律改写成 `/omw explain`、`/omw version-chain` 这类**调用形式**，并说明「七条命令」指的是七个子命令入口。
  - **B**：真按七条独立命令注册，则 `src/seams/commands.ts` 要拆，`OMW_USAGE` 要重排。
  选定后同步改 `prd.md:299`、`requirements.md:145`、`epics.md:692`、`ARCHITECTURE-SPINE.md:225` 四处措辞。
- **验收方式**：四处文档与 `src/seams/commands.ts` 对同一件事的说法一致；`grep -c "register(" src/seams/commands.ts` 与文档声明的命令数能对上。

### P0-4 Story 3.2 与已交付的 `/omw history` + `/omw ledger` 归位

- **现状**：`src/seams/version-reader.ts` 已实现版本链（`VersionView` 含 `valid_from` / `valid_to` / `superseded_at` / `active_slot` / `recorded_at` / `actor`）与账本视图（`decisionView`），文件头 `:1-15` 明写「Neither writes, neither queues, and neither is reachable from recall or injection」。Story 3.2 要求的 `/omw version-chain` 与它是同一件事，只是名字不同。
- **为什么挡**：不归位就等于让 Story 3.2 重写一个已交付的 reader，正面违反 PRD §4.16 第 1 条（既有语义归还既有 epic、原文不改）。
- **补齐定义**：epics 的 Story 3.2 改写成「在既有 `history` 输出上扩展」——新增 `affected[]`（同 `op_id` 的多对象，只含状态类对象与边）与 `superseded_at` 的展示，并写明**基线字段（`valid_from` / `valid_to` / `active_slot` / `recorded_at` / `actor`）逐字段不变**；若最终仍要改名，则在 §4.16 登记「`version-chain` 是 `history` 的对外名，仅登记不改 AC」。
- **验收方式**：Story 3.2 的 AC 里能指出现有字段名；`pnpm test` 里与 `version-reader` 相关的测试不变仍然通过。

### P0-5 flag_type 封闭集补第八值

- **现状**：`data-model.md:142` 与 epics Story 3.3 都写七值封闭集（`dangling_evidence` / `contradiction` / `refuted` / `rejected` / `dream_truncated` / `migration` / `predicate_new`）。但 `src/core/patch.ts:370` 的类型是 `'predicate_new' | 'predicate_rekey'`，`:738` 写 `flag:predicate_rekey:...`、`:759` 落 `flagType: 'predicate_rekey'`——**第八个值已经在库里被写出来了**。
- **为什么挡**：Story 3.3 的 AC 是「flag 字段封闭枚举」，而实际数据能超出这个集合。不改则 Story 3.3 一开工就要处理脏数据；改成开放集则 Story 3.3 的封闭枚举判据作废。
- **补齐定义**：二选一——
  - **A**：把 `predicate_rekey` 计入封闭集（改 `data-model.md:142`、epics Story 3.3、PRD §3 词表，共八值）；
  - **B**：把 rekey 归并进 `predicate_new`，改 `src/core/patch.ts:738` 与 `:759` 两处写入，并在 data-model 里写明 rekey 由 flag 正文的 `cause` 字段表达。
- **验收方式**：`grep -rn "flagType" src/` 得到的值集合与文档列出的封闭集**完全相等**。

### P0-6 三条边标签的落法

- **现状**：`data-model.md:137` 把 `supersedes` / `contradicts` / `part_of` 列入 `affected[]` 闭包，`:89` 把 `contradicts` 定为「两条互斥断言、双向可查」。但 `src/` 里**唯一真实实现的边标签是 `supports`**（`src/store/templates/evidence.ts:22`、`src/core/evidence.ts:38`）；边机制本身在 `src/store/commits/engine.ts:215`（「One edge a plan wants to draw, between two nodes the same batch writes」）。`contradicts` 只在 `src/ops/retention.ts` 与 `src/ops/injection-audit.ts` 各出现一次，都不是写入路径。
- **为什么挡**：Story 3.3 要「一条 `contradicts` 边」，Story 3.2 的 `affected[]` 只含状态类对象**与边**，Story 3.4 撤销要按 `op_id` 重放边。三条 story 都依赖一组尚未实现的标签。
- **补齐定义**：在 `data-model.md` 写明——①边标签封闭集（`supports` / `contradicts` / `supersedes` / `part_of`）；②唯一键与去重规则（同批次两端点同标签只画一条）；③`contradicts` 是**两条有向边**还是**一行双向**（必须选一个，因为它决定 `affected[]` 的计数）；④`affected[]` 的闭包判据落到具体标签。
- **验收方式**：Story 3.3 的 AC 能写出「插入一条 X 边」的确切断言；data-model 里四个标签都有唯一键定义。

### P0-7 置信带与计数器口径统一

- **现状**：两处与 Story 3.7 的 AC 直接相抵——
  - `src/core/patch.ts:476` 给 scene 节点硬编码 `confidence: 0.5`（浮点概率）；
  - `src/core/patch.ts:331`、`:666`、`:721`、`:773` 与 `src/store/tbox.ts:135` 在 **pred 节点**上读写可变的 `evidence_count`（存着的计数器）。
  而 Story 3.7 的 AC 是「库内**不存浮点概率、也不存计数器**，置信带读时由 `evidence` 边计数推导」。
- **为什么挡**：同一个库里会有两套计数（pred 节点上的 `evidence_count` 与断言侧由边推导的数），Story 3.7 的 AC 写不出可测断言，将来 FR-44 的三关与 FR-69 的门槛也会读两套数。
- **补齐定义**：三条各给一句结论——①断言置信带只由 `evidence` 边推导（已有口径，不动）；②`pred.evidence_count` 是「谓词晋升计数」还是也改成边推导（**推荐后者**，否则 FR-69 的门槛会依赖一个可被 patch 篡改的字段）；③`scene.confidence` 删除或标 `deprecated` 并在 §4.16 登记。结论写进 `data-model.md` 的字段表。
- **验收方式**：`grep -rn "evidence_count\|confidence" src/` 的结果与 data-model 的字段表一一对应，没有「文档说不该存但代码在存」的字段。

### P0-8 `/omw stats` 归位

- **现状**：`src/` 搜 `stats` 与 `--since` 零命中，但它被三处要求：Story 2.6 的 AC（`epics.md:669`「运行 `/omw stats --since 24h` → 输出注入/召回/写事务三个 p50/p95 与降级计数」）、Story 5.4（`epics.md:1267`）、`epics.md:140` 的 AR-16 交付物清单。**Epic 2 已标 done。**
- **为什么挡**：G-E3-2 要「同时满足 NFR-2 的 p95 ≤900ms」，而三组 p50/p95 只有 `stats` 能出。没有它，Epic 3 的性能判据无从测量。
- **补齐定义**：二选一——
  - **A**：补实现（最小档：从 `src/ops/injection-audit.ts` 与写事务审计行里按时间窗聚合三个 p50/p95 与降级计数），并把 Epic 2 的 done 改述为「该 AC 由 Epic 3 补交」；
  - **B**：把该 AC 从 Story 2.6 移出、登记到 Story 5.4，并在 Epic 2 回顾里改述（承认 Story 2.6 当时未交付这一条）。
  两个都行，但**必须在 Epic 3 开工前选一个**，否则 Epic 2 的 `done` 是假的，而 Epic 3 的性能验收没有工具。
- **验收方式**：`grep -rn "stats" src/` 有命中，或 `epics.md` 里 Story 2.6 的 AC 段不再出现 `/omw stats`。

---

## P1：只挡某几个 story

### P1-1 脱敏覆盖拒绝路径 → 挡 Story 3.5

`src/seams/write-port.ts:303-316` 的 `patch: raw` 未脱敏即落 `rejected` 节点（FR-24 的漏口）。Story 3.5 的 AC 是「默认档既不含引文也不含节点 id」，而 `rejected` 节点里现在存着原文。补齐：`rejected` 节点落盘前走同一套脱敏，或在 export 默认档里把 `rejected` 节点整个人剔除。验收：写一条违法违规 patch，导出默认档，`grep` 原文片段零命中。

### P1-2 审计行加 `op_id` / `session_id` → 挡 Story 3.1

`WriteAuditRow` 在 `src/ops/audit.ts:100-107` 没有这两个字段，而 `src/core/decisions.ts:63` 写着「also written to the audit row」。Story 3.1 的「谁改的」要 join 账本与审计行。补齐：加两个字段（或改掉 `decisions.ts:63` 那句话）。验收：同一次写入的账本行与审计行能按 `op_id` 对上。

### P1-3 配置段缺失 → 挡 Story 3.6 与 3.7

`src/seams/config.ts` 的 schema 只有 `db` / `snapshot` / `embedding` / `inject` / `recall` / `tbox` 六段（`:122-128`），`tbox` 只有 `maxNewPredsPerDay`（`:108`）。**`consistency` 段不存在**，`tbox.maxConcepts` 与 `consistency.checkTimeoutMs` 在 `src/` 零命中。补齐：增 `consistency.checkTimeoutMs`（默认 5000）与 `tbox.maxConcepts`（值待标定，先给 `null` 或标注占位）。验收：Story 3.6 与 3.7 的 AC 里点到的配置键都能在 schema 里找到。

### P1-4 补两条契约测试 → 挡 Story 3.7

Epic 2 回顾 item-9 列的六条里，最要紧的是「`evidence` 模板两处 throw 与 `reused > 0`」：`src/store/templates/evidence.ts:50-52` 与 `:60-62` 两处 throw 在 `test/` 零引用，而 Story 3.7 的「重复 10 次边净增 10」正依赖 `reused` 语义。补齐：覆盖这两处 throw 与 `reused > 0` 的用例。验收：`pnpm test` 里能看到这两个断言，且 `reused` 的语义有注释。其余四条（isLive 两语义 / `#restoreTail` catch / `sessionIdOf` 三跳 / `onReaderFailure` / `VERSIONS_SINCE_SLOT_QUERY`）不挡 Epic 3，随 P2 结转。

### P1-5 `eval/` 与 `test/fixtures/` 目录不存在 → 挡 Story 3.1 与 3.4

仓库根目录没有 `eval/`，也没有 `test/fixtures/`，而 Story 3.1 要「SM-2 的 20 条 fixture 记 `eval/governance-20.md`」、Story 3.4 要 20 条撤销 fixture、Story 3.6 引用了手工 fixture。补齐：在 `epic-3-context.md`（见 P1-6）里写死两个目录与文件命名约定，由 Epic 3 的第一个 story 建目录。验收：epic-3-context.md 里有这一段。

### P1-6 `epic-3-context.md` 与 spec 模板的三条检查项 → 挡 Story 3.1 的 spec 撰写

`docs/implementation-artifacts/` 下有 `epic-1-context.md` 与 `epic-2-context.md`，**没有 `epic-3-context.md`**；spec 模板也还没写进三条新规则。补齐：建 `epic-3-context.md`（Epic 3 的输入：8 个 story 清单、G-E3-1/2/4 的原文、P0-1…P0-8 的裁定结果、目录约定），并把三条规则写进 spec 模板——①跨故事边界三问（外部通道默认值 / 降级分支可达性 / 诊断命令副作用，Epic 1 的 A7）；②动作项措辞规则（不得指定交付顺序、不得点名已删除的接口，Epic 2 item-8）；③契约可见测试（每条 AC 至少要有一个能看见契约的测试，Epic 2 item-9）。验收：新 spec 的 frontmatter 能引用这三条。

---

## P2：结转（不挡 Epic 3，但必须登记）

登记在这里的目的是别让它们继续以「措辞绑定了不存在的实现」的方式落空——Epic 2 回顾 `:186-196` 已经诊断过这个病灶。

| # | 事项 | 为什么不挡 Epic 3 | 建议去处 |
| --- | --- | --- | --- |
| Q1 | `vec_state: 'pending'` 与 `VectorPolicy.write` 零调用（`src/seams/vector.ts:65`、`:81-118`） | 断言永远 pending 只影响未来的向量召回，不影响 Epic 3 的治理面 | Epic 5（召回真接向量时一并接上，或把字段从 payload 移除） |
| Q2 | 注入审计行读 `plan.identityTokens + plan.tail.tokens` 而 `prompt-composer.ts:569` 是三元相加（`src/ops/injection-audit.ts:139`、`:143`） | 只影响审计行的 token 记账，不影响 Epic 3 的四列与三关 | Epic 3 内顺带修（`explain` 要读审计行时正好碰到） |
| Q3 | 三个 reader seam 同形重复（`evidence-reader` 248 行 / `version-reader` 326 / `recall-reader` 410，一句失败文案逐字重复两处） | 是体量与维护性问题，不是正确性问题 | Epic 3 之后的重构，单独一轮 |
| Q4 | `.github/workflows/ci.yml` 从未在 GitHub 实跑 | 本地 `pnpm test` 与 `pnpm lint` 全绿，Epic 3 的判据不依赖远端 CI | 由用户在 Epic 3 开工时顺手点一次 |
| Q5 | Epic 1 item-4：`/omw doctor` 在 home 目录不像 DSH home 时给出警告 | 与 Epic 3 的 story 无关 | Epic 3 的 `doctor` 收口 story（若开）或 Epic 8 |
| Q6 | Epic 1 spec 两条 deferred：契约版本 flag 的零向量、恢复备份无老化（`spec-epic-1-plugin-foundation.md:194`、`:200`） | 都是备份/向量链路的边缘 | Epic 5 / Epic 8 |
| Q7 | `rejected` 节点要不要保留期（Epic 2 三镜评审 adversarial #6） | 保留策略不影响 Epic 3 的导出与撤销 | Epic 3 的 Story 3.5 定口径，或 Epic 7 的保留期统一 |
| Q8 | no-op 挂载行未实测（verification-gap #7） | 是测试缺口，不影响判据 | 随 P1-4 的契约测试一起补 |
| Q9 | 两个大文件待拆（`src/core/patch.ts` 1151 行、`src/seams/write-port.ts` 824 行） | 重构不该夹在功能 story 里 | Epic 3 之后单独一轮，与 Q3 合并 |
| Q10 | 覆盖率未达标？——**已达标**：语句 90.8% / 分支 81.2% / 函数 93.58% / 行 92.66%（门槛 80/70） | 不是缺口，登记在此以免再被当成待办 | 无 |

---

## 推荐的补齐顺序

前六步全在文档里，可以一次坐完；后三步要动代码，最后跑一次全量测试。

1. **P0-3 命令面裁定**——因为它同时改四处文档，先定它省一次返工。
2. **P0-5 / P0-6 / P0-7 三处措辞冲突**——flag 类型、边标签、置信带计数。每条都是「选一个，改两三行」。
3. **P0-4 版本链归位**——改 epics 的 Story 3.2 一段 AC。
4. **P0-1 召回通道**——先改 AD-7 与两个 spec 的矛盾句，再改代码。
5. **P0-2 写 `gates/g0-4.json`**——必须在 P0-1 之后。
6. **P1-6 建 `epic-3-context.md`**——把 1–5 的裁定结果、G-E3-1/2/4 原文、目录约定、三条 spec 规则都装进去；它是 Epic 3 的开工输入。
7. **P1-3 配置两段 + P1-1 脱敏 + P1-2 审计行两个字段**——三处小改，一个提交。
8. **P1-4 两条契约测试 + P0-8 `/omw stats` 归位**——`stats` 若选 A 补实现，放这一步。
9. **跑 `pnpm test` 与 `pnpm lint`，然后提交**，并在 `sprint-status.yaml` 把 `epic-2-retro-item-1`/`item-2`/`item-3` 收口。

---

## 附录 A：Epic 3 的验收闸门原文（补齐后必须对照）

| 闸门 | 落点 | 关键判据 |
| --- | --- | --- |
| **G-E3-1** | Story 3.6（FR-40 四列 + FR-41 邻域一致性）、Story 3.7（FR-44 三关 + FR-45 置信带）、Story 3.8（FR-39 `brief`） | `justification_id = sha256(sorted(前提业务键))` 可复算；邻域不一致整批返 `UNRELIABLE` 且检查 ≤50ms；`source_independence` 同源只算 1 |
| **G-E3-2** | Epic 3 同场，基线取 Story 2.5 的返回体 | 四个新增字段（FR-41 / FR-42 / FR-43 / FR-58）全缺省时返回体逐字段相同；Epic 3 只负责打开 FR-41 与 FR-58；同时满足 NFR-2 的 p95 ≤900ms |
| **G-E3-4** | Story 3.8 | `assets/copy-rules.json` 的结构检查能拦住故意注入的违规样例，片段 diff 标出改动 |

Epic 3 抬头（`epics.md:680`）覆盖 FR-11、FR-12、FR-13、FR-23、FR-24 + 增量 FR-39、FR-40、FR-41、FR-44、FR-45、FR-58、FR-77；依赖 Epic 1 与 Epic 2 的版本链与账本。

**P0-7 与 G-E3-1 的直接关系**：Story 3.7 的置信带判据就是 G-E3-1 的一半，P0-7 不裁定，这条闸门写不出判据。

## 附录 B：本清单不包含的事

- **两份回顾本身不重做**。`epic-1-retro-2026-11-23.md`（143 行，verdict `accepted-with-open-items`）与 `epic-2-retro-2026-11-25.md`（240 行，同 verdict）已经把材料收齐；这份清单只做「把未落地项落成可执行条目」。
- **不重开任何评审**。Epic 2 的 271 条 finding 已 triage 完（fix now 27 / defer 3 / 已被证伪 3），本清单只引用它们的结果。
- **不动 Epic 1 / Epic 2 的验收线**。PRD §4.16 第 1 条：既有语义归还既有 epic、原文不改；本清单里的 P1-1/P1-2/P0-1 都是「补上没接的线」，不是改既有判据。
- **不给 Epic 3 排期**。story 的划分与顺序属于 `/bmad-create-epics-and-stories` 之外的执行决定，本清单只保证「开工前输入齐」。
