---
title: '2.3 版本链与决策账本 + 删除静态门'
type: 'feature'
created: '2026-11-24'
status: 'done'
baseline_revision: '7bc31d45f43464b862e62efd5c939361c4124f04'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/docs/implementation-artifacts/epic-2-context.md'
  - '{project-root}/docs/specs/spec-DSH哦鲸鲸/data-model.md'
  - '{project-root}/docs/planning-artifacts/architecture/architecture-DSH哦鲸鲸-2026-11-23/ARCHITECTURE-SPINE.md'
warnings:
  - 'oversized'
deferred:
  - 'CI 未在 GitHub 上实跑：本机无 Actions 运行环境，只验到 YAML 可解析与 lint 链包含该门；首次真实运行尚未发生。'
  - 'ops/retention.ts 与 ops/dispose.ts 是删除豁免清单里的预留路径，文件尚不存在，其内部删除 op 形态要到对应故事才成立；门对不存在的豁免文件不报错。'
  - 'test/store/version-chain.test.ts 的性能用例仍保留绝对墙钟上限 p95 ≤ 20ms；判据主体是「深链不比同库浅链贵 ×2」这一形状，绝对数在更快或更慢的机器上会偏松或抖动。'
---

# 2.3 版本链与决策账本 + 删除静态门

<intent-contract>

## Intent

**Problem:** 2.1 的写入路径碰到「同一业务键已有不同值」直接返回 `E_CONFLICT`（`src/core/patch.ts:893-900` 的文案自己写着「改写属 2.3」），所以 Elliott 改一次主意就写不进去；谓词基数变更虽有退役动作，却只写 `superseded_at`、不写 `valid_to`，历史区间在旧版本上读不出来；账本载荷早已完备（`src/core/decisions.ts`），但除插入路径外没有任何读面能回答「它为什么这么记」；AD-5 的「无物理删除」目前只有一道 `indexOf` 文本门——认不出事务 op 字面量 `type: 'delete'`，也没校验三个豁免文件的 `// AD-15 豁免：` 文件头，仓库里更没有 CI 让这道门成为必过项。

**Approach:** 把改写做成与谓词基数变更同一条退役路径：`resolveAssert` 增 `supersede` 分支，计划里先 `updates` 退役旧版本（写 `superseded_at`、`active_slot` 让位、补 `valid_to`），再 `inserts` 新版本（`active_slot:1`），同批一条 `decision`（`decision_kind:'supersede'`，带 `from`/`to`）。由此得到一条不变量——**活节点从不被原地改写，唯一的 `updates` 就是退役**。读面新增 `createReadGateway().findVersions`、`src/seams/version-reader.ts`、`/omw history <mem_key>`（版本序列：值、`valid_from`→`valid_to`、是否当前）与 `/omw ledger <mem_key>`（该键的决策账本，经 `decisionView` 投影成 AC③ 的十个键）。静态门在 `scripts/check-layers.mjs` 扩成三道：函数名（改用它已有的 `findCall`）、事务 op 字面量（自写词法器，取舍见 Design Notes 1）、豁免文件头；并新增 `.github/workflows/ci.yml`，让 `pnpm lint`（含该门）与 `pnpm test` 成为 CI 必过项。

## Boundaries & Constraints

**Always:**
- 活节点只被退役，不被原地改写：`plan.updates` 的每一项都必须是退役（加 `superseded_at` + `valid_to`，并把 `active_slot` 换成新值）；除退役外不得出现别的 `updatePayload`。
- 退役写三样：`superseded_at`（毫秒数，与 `active_slot` 同值）、`active_slot`（`retirementSlot` = max(now, 该键已用最大槽位+1)）、`valid_to`（`nowIso`）。新版本 `valid_from = nowIso`，不写 `valid_to`、不写 `superseded_at`。
- 一条 decision 只描述一次生效的改动；`op_id = <ms>:<表内序号>:<rand36>`，同一次写入里不同 op 的 `op_id` 不同。
- `affected[]` 按 AD-22 闭包：本 op 新建的证据指针键、被退役与被新建的状态节点键（同键去重），末位是 `target_mem_key` 自己；复用而未改动的证据指针不进闭包，账本类键永不进闭包。
- 账本节点存储仍是 `kind:'decision'`，动作落在 `decision_kind`；AC③ 要的 `kind`（insert/supersede/…）由 `decisionView` 投影出来，读面看到的键名与 AC 一致。
- 历史与账本读面只读：不写库、不建节点、不参与召回与注入；输出不含节点 id（AR-4）。
- 静态门扫**整个仓库**（`src/`、`test/`、`scripts/` 与根目录一层文件）的 `.ts/.mts/.tsx/.js/.mjs/.cjs`；命中即非零退出，并给出文件与行号。层依赖规则仍只管 `src/`。
- 三个豁免文件是唯一例外：`src/ops/snapshots.ts`、`src/ops/retention.ts`、`src/ops/dispose.ts`；文件存在时其首个非空行必须是 `// AD-15 豁免：<非空用途>`。豁免**只免函数名那一道**，事务 op 字面量那一道对它们同样生效。
- CI 必过：`.github/workflows/ci.yml` 至少跑 `pnpm install --frozen-lockfile`、`pnpm lint`、`pnpm test`。

**Never:**
- 不写 `superseded_at: null` 或 `valid_to: null`（未失效一律省略该键）。
- 不提供物理删除、批量删除、解边能力，也不给自己开豁免文件头。
- 不用裸 `indexOf` 或正则冒充第二道门，也不允许门在解析失败时静默跳过：`type` 的取值读不出来时报 `hard-delete-unreadable`，而不是当作干净。
- 不做注入（2.4）、召回（2.5）、审计行与报告脚本（2.6）、导出与遗忘（3.x）。
- 不让 `/omw history`、`/omw ledger` 回写任何节点。
- 不把 `decision` 做成可变节点：账本只增、不改、不删。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
| --- | --- | --- | --- |
| VC_REWRITE | 已有 active `assertion:Elliott:lives_in = 杭州`，remember 改成「上海」 | 旧版 `superseded_at=<ms>`、`active_slot=<ms>`、`valid_to=<nowIso>`；新版 `active_slot:1`、`valid_from=<nowIso>`、无 `valid_to`；一条 `decision`，`decision_kind:'supersede'`，`from{kind:'assertion',value:'杭州'}`、`to{kind:'assertion',value:'上海'}`（值落在 `value`，`obj_norm` 只给 multi） | — |
| VC_DEFAULT_READ | 上一行落库后走 `findLive` | 只返回「上海」这一版 | — |
| VC_HISTORY | `/omw history assertion:Elliott:lives_in` | 两行：`1. [已退役] 杭州（valid_from … → valid_to …，退休于 …，写入者 …）`；`2. [当前版本] 上海（… → 至今，写入者 …）`；末行一条 JSON | 未知键 `ok:true`，一行「没有找到这个业务键的任何版本」；无版本链的记录（如证据指针）`ok:true` 并说明它写一次就不再改写 |
| VC_LEDGER_KEY | `/omw history decision:…` 或 `rejected:…` | 拒绝：账本是记录，不是记忆版本 | code `E_BOUNDARY`；库已关闭时先判关闭，出 `E_GATE_DOWN` |
| VC_NO_VALUE | live `single` 有值，新 op 不带 `obj` | 拒绝，不产生「空值覆盖」的新版本 | code `E_BOUNDARY`，文案说明必须给新值 |
| VC_UNCHANGED | 同值再写一次 | 不新增版本、不新增 decision，item `outcome:'existing'` | — |
| VC_PRED_EDIT | `op:'pred'` 同基数改 aliases/status | 旧谓词节点退役（三件套）+ 同键新节点 `active_slot:1`，一条 `decision(decision_kind:'supersede')` | — |
| LEDGER_ONE | 一次只改一条的写入 | 该 `op_id` 在库中恰好一条 `decision`；投影出 AC③ 的十个键（必需八个常在，`from`/`to` 视改动形态出现，另有可选 `precedent_id`） | 决策载荷读不出必需字段时按条丢弃并计数，全丢出 `E_DEGRADED` |
| LEDGER_NONE | 所有 op 都是 `existing`/`unchanged` | 零条 decision | — |
| GATE_FN | 业务代码写 `db.delete(1)` | 失败，报 `hard-delete-owner`，含文件与行号 | exit 1 |
| GATE_LITERAL | `{ type: 'delete', id }`、`{ type: ('unlink' as const) }`、`{ type: 'del' + 'ete' }`、`{ type: \`unlinkLabel\` }` | 四种形态全部失败，报 `hard-delete-literal` | exit 1 |
| GATE_LITERAL_OK | `{ type: 'link', from, to }`、`{ mode: 'delete' }`、注释里的 `'delete'` | 通过 | — |
| GATE_HEADER | 豁免文件缺文件头，或用途为空 | 失败，报 `ad15-exempt-header` | exit 1；文件不存在不报 |
| GATE_CI | GitHub Actions 触发 | `pnpm lint`（含该门）与 `pnpm test` 全绿才算过 | 门非零退出即 job 失败 |

</intent-contract>

## Code Map

| File | Change |
| --- | --- |
| `src/core/patch.ts` | `resolveAssert` 增 `supersede`；新增 `retireVersion()` 统一退役载荷，断言与谓词两条路径都用；`outcome` 增 `'superseded'` |
| `src/core/decisions.ts` | 新增 `DecisionView` 与 `decisionView(payload)`（AC③ 十键）；`buildDecisionPayload` 结构不变 |
| `src/store/commits/reads.ts` | 增 `findVersions(memKey)` 与 `listDecisionsFor(memKey)` |
| `src/store/templates/assertions.ts` | 复用 `VERSIONS_BY_KEY_QUERY`；新增 `VERSIONS_SINCE_SLOT_QUERY`（有界退役槽位）与 `DECISIONS_ALL_QUERY`（账本读全表后内存按 `target_mem_key`/`affected` 过滤） |
| `src/seams/version-reader.ts` | 新文件：读版本序列与账本，不含节点 id |
| `src/seams/commands.ts` | `/omw history`、`/omw ledger` 与用法文案 |
| `src/seams/runtime.ts` | 装配 `versionReader` |
| `src/seams/write-port.ts` | `describeSuccess` 统计改写；`affected[]` 补证据闭包 |
| `scripts/check-layers.mjs` | 三道门 + 一条兜底：函数名改词法判「调用」、事务 op 字面量词法器（含 `hard-delete-unreadable`）、豁免文件头；扫描范围扩到全仓 |
| `.github/workflows/ci.yml` | 新文件：CI 必过项 |
| `test/**`、`docs/**`、`README.md` | 见 Tasks；data-model 的 decision 字段行随之修正 |

## Tasks & Acceptance

- [ ] **AC1 改写留旧版本**：`remember` 改值成功，旧版本拿到 `superseded_at`/`active_slot`/`valid_to` 三件套，新版本 `active_slot:1` 且 `valid_from` 新值；`findLive` 只返回新版。测试：`test/core/patch.test.ts` 的计划断言 + `test/store/version-chain.test.ts` 端到端（含唯一索引未被破）。
- [ ] **AC2 历史可取回**：`/omw history <mem_key>` 输出每一版的值与 `valid_from`→`valid_to`（当前版显示「至今」），按 `valid_from` 升序；键被完全退役后仍可查；账本键被拒（`E_BOUNDARY`）。测试：`test/seams/version-command.test.ts`。
- [ ] **AC3 一次改动一条 decision**：`decisionView` 投影出 AC③ 十键；单值改值恰好一条；全 `existing` 表零条；`affected[]` 含本 op 新建的证据指针键（复用指针不进）。测试：`test/core/decisions.test.ts`、`test/store/version-chain.test.ts`、`test/seams/evidence-port.test.ts` 补一例。
- [ ] **AC4 静态门两道**：函数名一道按词法 token 判「调用」（`unlink(` 不再被读成 `link(`），范围是全仓而非只有 `src/`；字面量一道认四种形态（裸字面量、`as const`、`+` 拼接、无插值模板），报 `hard-delete-literal` 并带行号，认不出取值时报 `hard-delete-unreadable`；正常形态（`type:'link'`、`mode:'delete'`、注释内文本）不误伤。测试：`test/lint/layers.test.ts` 增 6 组 fixture。
- [ ] **AC5 豁免头与 CI**：三个豁免路径列白名单，存在的文件校验首个非空行；`.github/workflows/ci.yml` 让 lint+test 成为必过项。测试：`test/lint/layers.test.ts` 三组 fixture；CI 文件用 `yaml` 解析断言步骤含 `pnpm lint`。
- [ ] **AC6 不变量**：`plan.updates` 只含退役——用例断言每项都带 `superseded_at` 与 `valid_to`；谓词同基数编辑也产版本与决策（`VC_PRED_EDIT`）。
- [ ] **AC7 全量验证**：`pnpm build`、`pnpm lint`、`pnpm test`、`pnpm test:coverage` 全绿；覆盖率行 ≥80%、分支 ≥70%。
  改写路径的性能判据是**形状**而不是绝对值：同一库里深链键（≥300 版）与浅链键（约 30 版）交错改写，深链中位 ≤ 浅链中位 ×2，深链 p95 ≤20ms（`test/store/version-chain.test.ts`）；planner 只向引擎要 `active_slot >= now` 的槽位（`test/core/patch.test.ts`），所以一次改写不随该键历史长度变贵。**绝对毫秒预算不作判据**：本引擎每次 TQL 查询都扫全节点集，`findLive` 只返 1 行在 1650 节点上也要 2.5ms，固定预算测的是库大小而非本故事行为。实测证据：chain=330 深链 1.949ms / 浅链 1.994ms，cost 0.98x。
- [ ] **AC8 文档**：README 记 `/omw history`、`/omw ledger`（含答案码与 `active_slot` 语义）与门的两道判据及豁免头要求；`sprint-status.yaml` 的 2-3 置 done（CI 未实跑一事在 Auto Run Result 显式记为该条的唯一未验证项）；data-model 的 decision 字段行按 Design Notes 2 修正。

## Spec Change Log

- 2026-11-24：初稿。取 Story 2.3 五条 AC、AD-5/AD-15/AD-21/AD-22 与 data-model 的字段表为输入，定下「活节点只退役不改写」这条不变量，并把 AC③ 的 `kind` 冲突解法（投影）与第二道门的解析器取舍写进 Design Notes。
- 2026-11-24（评审后）：AC7 的性能判据由绝对毫秒改成同库深链/浅链对照，理由见 Design Notes 7 与 AC7 正文；I/O 矩阵的 VC_REWRITE（`from` 用 `value`）、VC_HISTORY（行形与未知键的 `ok:true`）、LEDGER_ONE（十键与降级）三行改为贴实现；「静态门只扫 `src/`」改为全仓扫描，并补「豁免只免函数名那一道」与 `hard-delete-unreadable`；Code Map 的模板与门两行随之更正。

## Review Triage Log

四层评审并行跑完（blind-hunter / edge-case-hunter / verification-gap / intent-alignment）。**发现总数 43**：blind-hunter 19 条、edge-case-hunter 7 条、verification-gap 3 条、intent-alignment 14 条；另有四层各自给出的「本层无发现」结论，见文末。

裁定口径：severity 由 lead 按当前工作树复核后重判（子代理自报的 high 里有 2 条实为 medium/low，也有 2 条实为 high）；route 取 patch / defer / reject / bad_spec / intent_gap。本次**无 intent_gap、无 bad_spec**，故 `review_loop_iteration` 保持 0。判 reject 的 6 条都在下面写明了不成立或不该改的理由。

- **blind23-1** `[medium]` `[patch]` 豁免清单与 README 点名了尚不存在的 `ops/retention.ts`、`ops/dispose.ts` — 门对不存在的豁免文件不报错，属预留路径；README 新小节已明写「后两个是预留、文件尚不存在」，读完不会以为它们在库
- **blind23-2** `[low]` `[reject]` `hard-delete-literal` 对三个豁免文件同样生效，被读成与「只有三个文件豁免」冲突 — 豁免在设计上只免函数名那一道：豁免文件可以写 `delete(...)` 调用，但不能自己造 `type: 'delete'` 事务字面量。口径已写进 spec 的 Always 段与 README
- **blind23-3** `[medium]` `[patch]` `eslint.config.js` 注释把算不出的形状推给不存在的 eslint 规则 — 注释改为明说结构规则全部在 `scripts/check-layers.mjs`、本文件只跑通用 JS 规则且看不见 TypeScript
- **blind23-4** `[high]` `[patch]` `sourceFiles` 只遍历 `<root>/src`，全仓禁止物理删除的要求在 `scripts/`、`test/` 上放行 — 拆成 `SCANNED_DIRS = ['src','test','scripts']` + 根目录一层文件，层依赖规则仍只管 `src/`；门现在报 `layers: 83 个源文件`
- **blind23-5** `[high]` `[patch]` `inChainOrder` 注释自称活版本排最后，同 `valid_from` 时按 `active_slot` 升序把 live(1) 排到最前 — 同 `valid_from` 时先比 `live` 再比 `active_slot`；`test/seams/version-command.test.ts` 与真挂载用例都断言 `versions.map(live) === [false, true]`
- **blind23-6** `[high]` `[patch]` `LedgerAnswer.entries` 承诺 oldest first，但查询与 `ledger()` 都不排序 — 新增 `inLedgerOrder`（按 `ts` 再按 `op_id` 升序）；真挂载用例断言账本顺序为 `['insert','supersede']`
- **blind23-7** `[medium]` `[patch]` 名为 `refuses a rewrite that carries no value` 的用例实种 multi 谓词，单值键不给新值的分支从未被执行 — 改名 `refuses a single-valued rewrite that carries no value`，改种 `lives_in` single + `obj:'Berlin'`，断言 `ops[0].obj` 与完整文案
- **blind23-8** `[medium]` `[patch]` `listDecisionsFor` 只匹配 `target_mem_key`，`affected` 里的键查不到账本 — TQL 无 containment 运算（`CONTAINS` / `IN` 均解析报错），故改为读全表后内存按 `target_mem_key` 或 `affected` 包含过滤；`/omw ledger` 因此查得到证据指针键
- **blind23-9** `[medium]` `[patch]` `decisionView` 返 `undefined` 被 `filter` 静默丢弃，无任何诊断 — `ledger()` 计算 `dropped = 节点数 - 投影数`：全丢返 `E_DEGRADED` 并说明条数，部分丢在 message 后追加「另有 N 条读不出必需字段，未列出」
- **blind23-10** `[medium]` `[patch]` 退役版本 `active_slot≈nowMs`，README 把它描述成小序号语义 — README 写明：活版本恒 `1`，退役版本取 `max(本次写入毫秒, 该键已花槽位+1)`，是 13 位时间戳量级，排序看 `valid_from`
- **blind23-11** `[low]` `[reject]` `superseded_at` 与 `valid_to` 双标记，且称无门禁守「live 不携带 `valid_to`」 — `test/store/version-chain.test.ts` 已逐项断言退役节点 `superseded_at === LATER`、`valid_to === ISO(LATER)`、`active_slot !== 1`，新版本无这两个键
- **blind23-12** `[medium]` `[reject]` 谓词同基数改写 item 仍是 `promoted`，被读成「退役了却报 0 条」 — `describeSuccess` 对 `promoted` 另出「N 条谓词登记已更新」，与 `superseded` 的「N 条旧版本已退役（改写）」并列；两条路径各自有独立文案，不是漏记
- **blind23-13** `[medium]` `[patch]` `createdPointersByOp` 用 `assertions[].index`、decision 用 `draft.index`，两边基准无测试固定 — 新增两条用例：表内两行只有第二行带来源时指针只进第二条账本且 `op_id` 形如 `…:2:`；两行各带一段来源时两条账本各含自己的指针键、互不包含
- **blind23-14** `[medium]` `[patch]` 只读 reader 从写 seam 取 `E_OK` — `E_OK` 迁到 `src/core/tool-errors.ts`，写面改为 import 后 `export { E_OK }` 保持既有路径；两个只读 reader 改从 core 取
- **blind23-15** `[medium]` `[patch]` `test/seams/version-command.test.ts` 的 harness 不装 `installWriteIndexes` — harness 在 `ensureSchema` 之前调用 `installWriteIndexes`，与其它 store 用例同一形状
- **blind23-16** `[medium]` `[patch]` 证据指针特例与 `rejected:` 前缀拒绝都无用例 — 补两条：证据指针键查 history 返 `ok:true` 并说明「写一次就不再改写」；`rejected:` 前缀经真挂载 `/omw history` 被拒且文案含「账本」
- **blind23-17** `[medium]` `[patch]` `ci.yml` 缺 `timeout-minutes`/`concurrency`/`permissions`、无 pnpm 缓存 — 补齐三者与 pnpm 缓存（setup-node 出现两次是有意的：缓存要先有 pnpm 可执行文件才能算 store 路径）
- **blind23-18** `[medium]` `[patch]` README 未写答案码、空键拒绝、不可读的两种输出 — README 补三种答案码 `OK`/`E_BOUNDARY`/`E_GATE_DOWN`、空键被拒、账本前缀被拒
- **blind23-19** `[low]` `[patch]` `readHistory`/`readLedger` 声明 `async` 无 `await`；`retireVersion` 仅本文件用却导出；`textField` 两处重复 — `async` 已去掉；`retireVersion` 保留导出（断言与谓词两条路径都调，属模块内部边界）；`textField` 份重复保留，两侧的取值容忍度不同，合并会把一处放宽
- **edge23-1** `[medium]` `[patch]` `renderVersion` 在 try/catch 之外调 `new Date(...).toISOString()`，越界毫秒抛 `RangeError` 让整个处理函数 reject — 新增 `millisecondLabel`，`Number.isNaN(when.getTime())` 时退回 `String(ms)`，命令不再因一条坏时间戳整体失败
- **edge23-2** `[medium]` `[patch]` 同 `valid_from` 时活版本排到最前（与 blind23-5 同源） — 同 blind23-5，先比 `live` 再比 `active_slot`
- **edge23-3** `[medium]` `[patch]` 同表第二次声明合并 aliases 只改 nodes/updates，先前 push 的 `decision.to.aliases` 不跟改 — pass1 合并后按 `targetMemKey === predKey` 找回该条 draft 并写回 `to.aliases`（`to` 可选，先 `?? {}`）
- **edge23-4** `[low]` `[patch]` `flag:` 这类无 `active_slot` 的键被落成「未找到该业务键」，把存在说成不存在 — history 空链时先查 `findLive`：命中就按 kind 出 `ok:true`「该业务键是[一条证据指针/一条 X 记录/一条没有类型的记录]，没有版本链」
- **edge23-5** `[low]` `[patch]` 决策节点全被 `decisionView` 滤掉时落成「没有决策记录」，与库中记录相悖 — 与 blind23-9 同一修法：全丢返 `E_DEGRADED` 并报条数
- **edge23-6** `[low]` `[patch]` 分派用 `startsWith('history ')`，键解析用 `/\s+/u`，`history\t<key>` 被判未知子命令 — 分派改为先取 `head = /^[^\s]*/u` 的前缀逐个子命令比，制表符与多空格都能分派
- **edge23-7** `[low]` `[patch]` `guard` 把 disposed 判定放在键校验之后，库已关闭时报 `E_BOUNDARY` 而非 `E_GATE_DOWN` — `disposed` 判定挪到最前，关闭的库对任何键都答 `E_GATE_DOWN`
- **vgap23-1** `[high]` `[patch]` `src/index.ts` 与 `runtime.ts` 的 version 接线只在两处，`test/` 里 `runtime.version` 零命中，删掉仍全绿 — 补真挂载三条用例；断线验证：把装配换成不建、getter 换成 `() => undefined`，恰好这 3 条转红（16→13），恢复后 16 全过
- **vgap23-2** `[low]` `[patch]` `HARD_DELETE_OWNERS` 与 README 列了不存在的 `retention.ts`/`dispose.ts` — 同 blind23-1：README 明写这两个是预留路径，门对不存在的文件不报错
- **vgap23-3** `[medium]` `[patch]` `createdPointersByOp` 与 supersede 的 `pushEvidence(index,…)` 索引是否对齐，无测试证据 — 已核实两侧都是 1-based op 序号（`EvidenceDraft.index` 注释即如此），并补两条用例固定（同 blind23-13）
- **intent23-1** `[high]` `[patch]` 单值键改写不给 `obj` 的拒绝已实现但无测试到达，同名用例测的是 multi — 同 blind23-7：改种 `lives_in` single，断言完整拒绝文案
- **intent23-2** `[medium]` `[patch]` 谓词改基数那条决策的 `affected` 末位是 flag 键而非 `target_mem_key` — 改为 `[flagKey, predKey]`，末位回到它讲的键；用例断言顺序
- **intent23-3** `[medium]` `[patch]` 新建证据指针并入 `affected` 无测试 — 同 blind23-13 的两条用例
- **intent23-4** `[medium]` `[patch]` 用例名「恰好十键」实际断言 8 键，`DecisionView` 还多一个可选 `precedent_id` — 改名「reports the eight required keys AC3 names, and adds no optional one on its own」；AC3 的十键读作「八个必需 + `from`/`to` 视改动形态」
- **intent23-5** `[medium]` `[patch]` 未知键走 `E_BOUNDARY`，I/O 矩阵要的是 `ok` 单行「没有找到这个业务键的任何版本」 — history 未知键改 `ok:true` 并给该行文案；矩阵的 VC_HISTORY 行同步改写
- **intent23-6** `[medium]` `[patch]` `renderVersion` 行形（`[当前版本]`/`[已退役]`、无「值：」）与矩阵字面不同 — 矩阵改写为实际行形（含退休时刻与写入者）；测试原本只断子串，现补 `[已退役] 杭州`/`[当前版本] 上海` 的整行前缀
- **intent23-7** `[medium]` `[patch]` 决策 `from` 用 `value` 键，矩阵 VC_REWRITE 写 `from{obj:'杭州'}` — 矩阵改为 `from{kind:'assertion',value:'杭州'}`，并注明 `obj_norm` 只给 multi；实现不动（账本必须带值，这是 2.3 补的实现缺口）
- **intent23-8** `[medium]` `[patch]` CI 只交定义、spec Verification 记未验证，`sprint-status` 却已记 done — AC8 与 Auto Run Result 显式把「GitHub 未实跑」记为该条唯一未验证项；本地能验的部分（YAML 可解析、lint 链含该门）已验
- **intent23-9** `[medium]` `[patch]` `check-layers.mjs` 豁免名单列了两个不存在路径 — 同 blind23-1
- **intent23-10** `[medium]` `[patch]` `deleteLiteralLines` 对认不出的 `type` 表达式静默跳过，注释把责任推给 eslint — 改为返回 `{lines, unreadable}`，新增 `hard-delete-unreadable` 规则；「算不出来」与「算出来是干净的」必须能分开
- **intent23-11** `[low]` `[reject]` 只断言 `active_slot`，未逐项断 `superseded_at` + `valid_to` — `test/store/version-chain.test.ts` 已逐项断言三者（同 blind23-11）
- **intent23-12** `[low]` `[reject]` 谓词元数据编辑 outcome 仍是 `promoted`，assert 改写是 `superseded`，词表分叉 — 两者是不同事件：一条改的是登记表元数据，一条改的是记忆值；文案与 outcome 都分开。合并会把两件事塞进一个词
- **intent23-13** `[low]` `[reject]` 唯一约束文案改动不在契约期望面内 — 该文案原写「改写属 2.3」，2.3 已实现改写后这句话不再成立，属本故事的必然连带修改，已同步两处测试期望
- **intent23-14** `[low]` `[patch]` 评审产物 `.review-2-3.diff` 被算进 28 文件清单，须从提交移除 — 临时件在 `git add -A` 前全部删除（含 `.review23-*.txt`、`.probe-*`），提交前 `git status --porcelain` 复核

合计 **43** 条：high 5 / medium 26 / low 12；patch 37 / reject 6。

各层自报的「无发现」结论：intent-alignment 判版本链写入层、账本键护栏、文档面与门的其余三条均无发现；edge-case-hunter 判删除检查层与声明/claim 层无发现，并实跑 `node scripts/check-layers.mjs` 确认 39 个源文件 exit 0（当时范围仍只管 `src/`）。

## Design Notes

1. **第二道门为何是词法器而不是 AST**：实测 `typescript` 7.0.2 的 `createSourceFile` 为 `undefined`（TS 7 是原生编译器，`./unstable/ast` 才是新出口），仓库里没有 espree、acorn、@typescript-eslint/parser。`unstable/ast` 能用，但一个门依赖 unstable 出口、上游改形状就静默失效，比自写词法器更危险。所以在 `check-layers.mjs` 里实现约 120 行词法器：跳过注释、解码字符串与无插值模板、折叠 `+` 拼接、穿过括号与 `as const`——正好覆盖 AC④ 点名的两种正则盲区。遇到 `${}` 模板或非字面量表达式时既不折叠也不放过：`type` 的取值读不出来就报 `hard-delete-unreadable` 并点出行号，因为「算不出来」和「算出来是干净的」必须能分开——门不能把看不见的当通过。
2. **`kind` 与 `decision_kind`**：节点判别必须留 `kind:'decision'`（data-model §6 的治理查询按它查），动作只能另立字段。AC③ 列的 `kind` 由 `decisionView` 投影提供，data-model §3 的 decision 行据此改成「`kind`=节点判别 + `decision_kind`=动作」。
3. **`valid_to` 的语义**：改值是「此刻才知道旧值不再成立」，写 `valid_to = nowIso` 是最小可信声明，不假装知道世界何时变。
4. **「一次成功写入」怎么读**：按「一次生效的改动」读——N 条改动的表写 N 条 decision，全 `existing` 的表写 0 条。空改动没有可解释的内容，硬凑一条会把账本变成流水日志。
5. **谓词同基数编辑改走版本链**：2.1 让它原地 `updatePayload` 且不写决策，与 AD-21「每次改动一条 decision」和本故事的不变量都不相容；改成退役+新建后自然有 `from`/`to`，`countModelPredicatesToday` 的 live 过滤保证退役节点不占日额度。
6. **读面分家**：命令不持写令牌，历史与账本走 `createReadGateway`；证据排除规则仍只落在 store 的唯一证据查询上，不在读面重写。
7. **退役槽位只读「可能被占用」的那一段**：`retirementSlot` 要算 `max(now, 该键已花的槽位+1)`，原先为此物化整条链，改写成本随链长线性上升（实测 chain=10 1.04ms → chain=400 10.9ms）。因为槽位取的是毫秒时间戳，任何 `slot < now` 都满足 `slot + 1 ≤ now`，不可能抬高这个最大值——所以只查 `active_slot >= now` 是精确的，不是近似。TQL 的过滤器里不能放参数（`{$gte: $now}` 报 `Expected JSON value, got DollarOp`），但 WHERE 右侧可以：`WHERE mem_key == $mem_key AND active_slot >= $since`。
8. **CI 落点**：仓库此前没有 `.github/`，AC⑤ 的「必过项」只能靠新增 workflow 成立。Actions 无法在本机实跑，验证只到「YAML 可解析 + 本地 lint 链确实包含该门」，这一限制写进 Verification 与 Auto Run Result。

## Verification

- `pnpm build`、`pnpm lint`（含 `node scripts/check-layers.mjs`，81 个源文件全规则通过）、`pnpm test`、`pnpm test:coverage`：全部 exit 0。`pnpm test` = Test Files 32 passed | 1 skipped (33)、Tests 437 passed | 1 skipped (438)；覆盖率 lines 88.52%（1682/1900）、branches 74.51%（1073/1440）、functions 90.32%、statements 86.39%。
- 性能按 AC7 的形状判据实测：`chain=330 vs 31 early=0.349ms deep=1.949ms shallow=1.994ms p95=2.391ms cost=0.98x` —— 深链改写不比同库浅链贵。planner 有界读另有一条用例断言：它向引擎只要 `active_slot >= now` 的槽位（参数恰为 `{ memKey: predKey, sinceMs: PLAN_NOW }`），50 条历史旧槽位不被物化。
- 门的三态手验：仓库当前代码通过；四种字面量写法（裸字面量 / `as const` / `+` 拼接 / 无插值模板）各自被抓并点出行号；非删除形态（`type: 'link'`、`mode: 'delete'`、注释、`${name}` 插值）不误伤；豁免文件缺头、空用途各自失败，恢复后通过。逐条落在 `test/lint/layers.test.ts`（17 条）。
- 真库手验（`node .probe-manual.mjs` 跑 `lib/` 编译产物，临时 `DSH_HOME`，脚本用后即删）：`apply` 真挂载输出 `[omw] loaded state=ok section=omw:persona`；`remember` 写 `lives_in=杭州`（`created`）再改 `上海`（`superseded`，message「写入 0 条新事实，1 条旧版本已退役（改写）」）；`/omw history` 给出两版——`[已退役] 杭州（valid_from …611Z → valid_to …614Z，退休于 …614Z）` 与 `[当前版本] 上海（… 至今）`；`/omw ledger` 两条记录的 `from`/`to` 都带值（`insert` 只有 `to`，`supersede` 有 `from 杭州` → `to 上海`，`op_id` 形如 `1795500786614:1:1ila9s`）；关库后重开直读：`findLive` 只回上海（`active_slot:1`、无 `superseded_at`），`findVersions` 两条，杭州的 `active_slot` 已让位为退役毫秒数。
- 证据键与账本键的边界：`/omw history decision:…` 与 `rejected:…` 被拒（「账本是记录，不是记忆版本」），`/omw ledger pred:lives_in` 返「没有决策记录」而不是错误。
- 读面接线有一条真挂载用例守着（`test/seams/runtime-write.test.ts` 的「the version reader (Story 2.3)」三条）：`runtime.version` 存在、改写后 `history` 返两版且活版本在末位、账本两条 `insert`/`supersede`，dispose 后答 `E_GATE_DOWN`，`/omw history` 与 `/omw ledger` 经真 `apply()` 挂载也给同样结果。**断线验证**：把 `runtime.ts` 的 `version = createVersionReader({ db })` 换成不建，并把 `src/index.ts` 的 getter 换成 `() => undefined`，恰好这 3 条转红（16 → 13 passed）；恢复后 16 全过。修复前这两个位置删掉任一，全仓测试仍全绿。
- CI：`yaml` 解析 workflow，断言 `pnpm lint`/`pnpm test` 两个 step 存在，且 `concurrency`/`permissions`/`timeout-minutes` 与 pnpm 缓存齐备。GitHub 上是否实跑：**未验证**（本机无 Actions 运行环境）。
- 门的范围改到全仓后重跑：`node scripts/check-layers.mjs` → `layers: 81 个源文件，全部规则通过`，exit 0（修词法器前该门曾把自己 `scripts/check-layers.mjs:47` 的禁用名常量表判成四处违规，根因是 `stripStrings` 在含反引号的模板上错位、`===` 被拆成三个 `=`）。
- 证据指针与账本的对应关系补两条用例（`test/seams/evidence-port.test.ts`，35 passed）：表里两行只有第二行带来源时，指针只进第二条账本的 `affected`；两行各带一段来源时，两条账本各含自己那段指针键、且互不包含。

## Auto Run Result

**Status:** done

**What was built.** 改写有了版本链：一个业务键再次写入不同值时，旧版本在同一批里被退役（`superseded_at` 毫秒、`active_slot` 让位为 `max(本次写入毫秒, 该键已花槽位+1)`、`valid_to` 为当刻 ISO），新版本以 `active_slot:1` 生效，默认查询只回新版本。每次生效的改动写一条 `decision`——动作落 `decision_kind`，节点判别仍是 `kind:'decision'`，读面由 `decisionView` 投影回 AC③ 的十键形状。两条只读命令 `/omw history <mem_key>` 与 `/omw ledger <mem_key>` 分别回答「它以前说什么」与「为什么变成现在这样」，都走 `createReadGateway`，不持写令牌、不入队。物理删除的静态门扩展成三道加一条兜底（函数名按词法 token 判调用、事务 op 字面量四形态、`hard-delete-unreadable`、豁免文件首行必须写明用途），扫描范围从一个目录扩到整个仓库，并新增 `.github/workflows/ci.yml` 把 `pnpm lint`/`pnpm test` 变成 CI 必过项。

**Changed files.** 源码：`src/core/{patch,tool-errors,decisions}.ts`、`src/store/templates/assertions.ts`、`src/store/commits/{assertions,reads,templates,engine}.ts`、`src/seams/{version-reader,commands,runtime,write-port,evidence-reader}.ts`、`src/index.ts`、`src/ops/audit.ts`。门与配置：`scripts/check-layers.mjs`、`.github/workflows/ci.yml`、`eslint.config.js`。文档：`README.md`、`docs/implementation-artifacts/sprint-status.yaml`、`docs/specs/spec-DSH哦鲸鲸/data-model.md`。测试：新增 `test/core/decisions.test.ts`、`test/store/version-chain.test.ts`、`test/seams/version-command.test.ts`；补 `test/core/patch.test.ts`、`test/seams/{runtime-write,evidence-port,remember-composed,write-port,write-port-failures}.test.ts`、`test/lint/layers.test.ts`、`test/core/tool-errors.test.ts`。

**Findings.** 四层评审共 43 条：high 5、medium 26、low 12；patch 37、reject 6，无 intent_gap、无 bad_spec，`review_loop_iteration` 保持 0。打补丁时发现两处旧实现真的不对，不是措辞问题：①决策账本对单值谓词的首次写入只记 `obj_norm` 不记值，导致「为什么这么记」这一问在 `insert` 条目上答不出来——supersede 条目本来就带值，两侧不对称；②`retirementSlot` 每次改写都物化整条版本链（实测 chain=10 1.04ms → chain=400 10.9ms），改成只查 `active_slot >= now` 的槽位（槽位是毫秒量级，`slot < now` 时 `slot+1 ≤ now` 不可能抬高最大值，故此读是精确的）。另有 6 条判 reject，其中 3 条是子代理把「两个不同的东西」读成矛盾（豁免只免函数名那一道、`promoted` 与 `superseded` 各有文案、谓词元数据编辑与记忆值改写是不同事件）。

**Follow-up.** 无阻塞性遗留。三条记进 `deferred`：CI 未在 GitHub 上实跑（本机无 Actions 环境）；`ops/retention.ts`、`ops/dispose.ts` 是豁免清单里的预留路径、文件尚不存在，其内部的删除 op 形态要到对应故事才成立；`test/store/version-chain.test.ts` 的性能用例仍是绝对墙钟上限（`p95 ≤ 20ms`），在更快的机器上会显得宽松、在更慢的机器上可能抖，判据本身是「深链不比同库浅链贵 ×2」这一形状。

**Verification.** `pnpm build`、`pnpm lint`、`pnpm test`、`pnpm test:coverage` 全部 exit 0；`pnpm test` = Test Files 32 passed | 1 skipped (33)、Tests 437 passed | 1 skipped (438)；覆盖率 lines 88.52%、branches 74.51%、functions 90.32%、statements 86.39%，达 AC7 的行 ≥80 / 分支 ≥70。性能按形状判据实测 `chain=330 vs 31 cost=0.98x`、p95 2.391ms。门跑 `layers: 81 个源文件，全部规则通过`。真库手验：临时 `DSH_HOME` 挂真 `apply()`，写 `lives_in=杭州` 再改 `上海`，`/omw history` 给两版（已退役/当前版本），`/omw ledger` 给 `insert` 与 `supersede` 两条且 `from`/`to` 都带值，关库重开直读只回新版本、旧版本 `active_slot` 已让位。读面接线有断线验证：删掉任一处接线时恰好 3 条用例转红。

**Residual risk.** CI 只在本地验到「YAML 可解析、lint 链包含该门」，GitHub 上首次真实运行仍未发生。`/omw ledger` 为支持按 `affected` 里的键检索，改为读全表后内存过滤（TQL 无 containment 运算），账本条目极多时这条命令会变慢——它不在写路径也不在召回路径上，故未加索引。
