# `eval/` 与 `test/fixtures/`：评测基线的目录约定

> Epic 3 开工前置（`epics.md:2232` 登记的「Epic 3 前置（建议 Story 3.0）」）。这份文档本身不是功能，
> 它交付的是**判据能跑起来的物质条件**：`epics.md` 有 15 处引用 `eval/`，`Story 3.1` 的 Then 要求把 SM-2 的结果
> 写进 `eval/governance-20.md`，`Story 3.4` 要 20 条撤销 fixture。基线落地之前，这些引用全部悬空。

## 一、两个目录的分工

| 目录 | 谁读 | 放什么 |
| --- | --- | --- |
| `eval/` | 人 | 验收物与判定口径：记录（`governance-20.md`）、口径（`rubric.md`）、将来的运行报告（`reports/`） |
| `test/fixtures/` | 工具 | 机器可读样本（`.jsonl`），一行一条 |

一句话：**`eval/` 写给人看的结论，`test/fixtures/` 喂给工具跑的输入**。同一件事不写两遍——
`eval/governance-20.md` 里的 20 条是 `test/fixtures/governance-20.jsonl` 的投影；两者的编号与条数一致性
由 `test/eval/governance-20.test.ts` 强制，漂移即测试失败。

## 二、文件命名约定

| 文件 | 状态 | 谁要求 | 说明 |
| --- | --- | --- | --- |
| `eval/README.md` | **本基线新增** | `epic-3-readiness-2026-11-26.md` P1-5（「写死两个目录与文件命名约定」） | 你正在读的文件 |
| `eval/governance-20.md` | **本基线新增** | `epics.md:725`、`acceptance.md:15`、`acceptance.md:36`（SM-2、AR-16） | 20 条治理三问 fixture 的定义与运行结果记录 |
| `eval/rubric.md` | **本基线新增** | `epics.md:1069-1082`（Story 4.4，SM-1、FR-22）、`acceptance.md:15`（SM-2 人工判据） | 盲判口径 |
| `test/fixtures/governance-20.jsonl` | **本基线新增** | 本约定 | 20 条 fixture 的机器可读形态，一行一条，是唯一事实来源 |
| `test/eval/governance-20.test.ts` | **本基线新增** | 本约定 | 加载并校验上述两份产物的一致性；`pnpm test` 会跑到 |
| `eval/golden-l1.jsonl` | 计划中 | `epics.md:1062`（Story 4.4） | 50 条「该不该记」标注样本，分层抽取后冻结。**不在本基线范围内** |
| `eval/reports/<date>.md` | 计划中 | `ARCHITECTURE-SPINE.md:390` | 每次运行落一份带日期的报告 |
| `eval/duplicate-pairs.jsonl` | 计划中 | `requirements.md:311`（D1） | 近重复阈值标定语料，≥100 对。**造不出来就删掉阈值那条** |
| `eval/persona-probe.jsonl` | 计划中 | `requirements.md:558`（FR-63） | 人格探针，20–30 条 |
| `eval/degradation-persona.md` | 计划中 | `requirements.md:613`（FR-70） | 三种降级情形下身份段字节不变的记录 |
| `eval/context/` | 计划中 | `CONTEXT-GOVERNANCE.md:353`（Epic 8） | 上下文治理压力集与口径 |
| `scripts/eval.ts` | 计划中 | `epics.md:1062`（Story 4.4） | 评测驱动。**不是交付命令**，不 fork 子进程（`acceptance.md:16`） |

命名规则（新增文件照此）：`eval/` 下用 `<主题>-<数量>.md` 或 `<主题>.md`；`test/fixtures/` 下用 `<主题>-<数量>.jsonl`，
数量写进文件名，**样本集一旦冻结就不许替换**（`epics.md:1066`，SM-1 的同一套道理）。

## 三、`governance-20.jsonl` 的字段结构

一行一个 JSON 对象，字段如下。凡是能在 `src/` 或 `docs/specs/` 找到出处的地方，都在括号里点名。

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `id` | 是 | `G20-01`…`G20-20`，全文件唯一、连号 |
| `group` | 是 | `A` 写入与版本链 / `B` 裁决与标态 / `C` 证据形态 / `D` 推断与谓词 |
| `key_form` | 是 | `assertion:3`（三段键）、`assertion:4`（多值谓词带 obj）、`pred:1` |
| `title` / `pins` | 是 | 这条 fixture 叫什么 / 它钉住哪一个判据。`pins` 是给评审看的一句话，不参与判分 |
| `mem_key` | 是 | 被查询的业务键。业务键不含节点 id（AD-3） |
| `query` | 是 | 实际要输入的命令，形如 `/omw-explain <mem_key>` |
| `node` | 是 | 目标节点的当前形态：`assertion` 用 `subj/pred/obj/origin(observed\|inference)/cause(conversation\|tool\|dream\|migration)/prompt_version/settle_state/falsifier/deactivated`；`pred` 用 `pred/cardinality/status/decided_by`（`data-model.md:44`、`:52`） |
| `versions` | 是 | 版本链，按 `version` 升序。`active` 恰有一项为真（撤销/遗忘后为 0 项） |
| `history` | 是 | 决策账本，按 `ts` 升序。字段对齐 `DecisionView`（`src/core/decisions.ts:165-183`）：`ts/actor/decision_kind/op_id/reason/precedent_id/from/to/affected` |
| `evidence` | 是 | 证据指针，按 `recorded_at` 升序。字段对齐 `data-model.md:45`，另加 `recorded_at` 用于判 30 天回读窗口 |
| `flags` | 是 | 标记。字段对齐 `data-model.md:51` |
| `edges` | 是 | 边。`label` 必须落在封闭集 `EDGE_LABELS`（`src/store/templates/evidence.ts:33`） |
| `expected` | 是 | 这条 fixture 的期望答案，见下 |

`expected` 里各字段的含义：`who`（谁改的）、`basis`（依据什么，取 `evidence` 的最后一项）、`basis_count`（该断言上的独立来源数）、
`why`（为什么）、`decision_keys`（末条账本必须出现的键）、`flag`（首条标记或 null）、`contract_version`（恒为 1，`src/store/meta.ts:18`）、
`sample_answer`（给人读的三问答案样本，供 SM-2 的「读得懂」判定使用）。

`decision_keys` 的构成：八个必需键 `ts/actor/kind/op_id/affected/target_mem_key/reason/contract_version` 常在，
`from`/`to` 视改动形态出现，`precedent_id` 可选——这就是 `spec-2-3-version-chain.md:63` 说的「AC③ 的十个键」。

## 四、建模口径：文档没写死的地方，这份基线怎么定的

写 fixture 的过程里遇到四处文档没钉死的地方。这里把选择写出来，而不是让它们变成沉默的假设——
**Story 3.1 落地时若推翻其中任意一条，请连同本文件一起改**，不要只改代码。

1. **`actor` 用代码的封闭集，不用架构文档的旧集合。** `ARCHITECTURE-SPINE.md:197` 写的是 `model|user|dream|migration`，
   而 `src/core/decisions.ts:168` 实现的是 `user|model|seed|system`。「迁移」落在 `cause` 上（`data-model.md:44` 的
   `cause ∈ conversation|tool|dream|migration`），不是 `actor` 的取值——所以 `G20-05` 的 `actor` 是 `user`、`cause` 是 `migration`。
   冲突按代码走：代码是已验收的实现，文档那句话没有实现方。
2. **`flag` 的业务键是占位。** `data-model.md:140` 要求 `affected[]` 点全状态节点，包括 flag，但 flag 的 `mem_key` 形态
   全书未定。fixture 里用 `{ "flag": "flag:<flag_type>:<序号>" }` 的形式占位，只保证「有一个可指名的 flag 条目」，
   不预设正式键形。
3. **`from`/`to` 的取值形态按改动性质分两种。** 改的是值（`obj`）就用字符串；改的是状态（`active`、`settle_state`、
   `flag_status`、`cardinality`）就用对象。`DecisionInput.from/to` 的类型是 `unknown`，两种都合法。
4. **软删除与推断结算借 `supersede`。** `decision_kind` 是封闭六值（`insert/supersede/arbitrate/resolve_flag/migrate/revert`），
   里面没有「delete」「settle」。所以 `G20-11`（遗忘=置失效+tombstone）与 `G20-18`（推断从未定到已确认）都走 `supersede`，
   并在 `reason` 里写明实际动作。这是本基线最可能被推翻的一条：若 Story 3.1 认为该另开 kind，改这里与 fixture 即可。

5. **`affected[]` 可以点名「别人的」对象。** 一次补丁表写三条断言时（`G20-06`），该 op 的闭包里既有本条的断言与证据，
   也有另两条断言及其证据——闭包是**按 op 算**的，不是按某一条记忆算的。所以 fixture 的 `evidence` 只放属于本条的那一条，
   而 `affected[]` 里出现的其它证据键按形态校验（`evidence:<session>#<from>-<to>`），不要求在 `evidence` 数组里能找到。
   这条分不清，就会误以为一条记忆只能被它自己的证据影响。

## 五、覆盖矩阵与范围外

| 维度 | 覆盖 | 由哪几条 |
| --- | --- | --- |
| 六种 `decision_kind` 全覆盖 | `insert` / `supersede` / `arbitrate` / `resolve_flag` / `migrate` / `revert` | 01、02、03、04、05、07、08、10、19 |
| `origin` | `observed` / `inference` | 01、17、18 |
| 证据形态 | 完整 / 截断 / 脱敏 / 多源 / 过期 | 12、13、14、15、16 |
| 标记 | `contradiction`(open、resolved-auto、resolved-human) / `refuted` / `migration` | 07、08、09、10、05 |
| 边 | `supports` / `supersedes` / `contradicts`（有向两条） / `refutes` | 全组、02、07、10 |
| 目标节点类型 | `assertion` / `pred` | 01–18、20 / 19 |
| 生命周期边界 | 软删后仍可答、撤销后仍可答 | 11、04 |

**明确不在这 20 条里的**（写出来是为了不让它们以后被误当成漏做）：

| 没覆盖的 | 为什么 |
| --- | --- |
| `mem_key` 不存在 → `NOT_FOUND` | 它产出不了三问答案，不是 SM-2 的样本；由 `Story 3.1` 的另一条 AC 单独验 |
| 关键词命中多条 → 列候选 | 同上，属命令面而非三问面 |
| `flag_type ∈ {dangling_evidence, rejected, dream_truncated, predicate_new, predicate_rekey}` | 这五类要么不属于记忆（`rejected` 是拒收记录）、要么由尚未交付的路径产生（`dream_truncated` 属 Epic 6、两个 `predicate_*` 由 Story 3.3 的写入路径产生）。给它们造 fixture 等于给不存在的路径写验收 |
| `part_of` 边 | 唯一的首建方是 Epic 6 的 dream 归纳（`data-model.md:93`），v1 此刻没有 `scene` 节点可指 |
| 1000 条库下的计时 | 不是 fixture 的属性，是运行条件——写在 `governance-20.md` 的运行协议里 |

## 六、已知开放项

| # | 事项 | 影响 | 由谁定 |
| --- | --- | --- | --- |
| O1 | FR-11 说「为什么」由账本的「类型、理由、**提示词版本**、引用先例」回答，但 `Story 3.1` 的 AC 只点了 `kind/reason/precedent_id`，没点 `prompt_version` | fixture 的 `expected.why.prompt_version` 目前照 FR-11 填（断言节点上的 `prompt_version`，见 `data-model.md:139`），但 `decision_keys` **不含**它——即它不被当成 20/20 的硬门槛 | Story 3.1 写 AC 时二选一：要么把 `prompt_version` 进 `decision_keys`，要么回改 FR-11 的措辞 |
| O2 | flag 的正式业务键形态未定（本文第四节第 2 条） | `affected[]` 里的 flag 条目是占位形态 | Story 3.1 / `data-model.md` |
| O3 | 软删与推断结算是否该有自己的 `decision_kind`（本文第四节第 4 条） | 目前借 `supersede` | Story 3.1 / `data-model.md` §6 |
| O4 | 命令名在既有文档里仍写作 `/omw explain`，代码与 P0-3 裁定是 `/omw-explain` | fixture 的 `query` 用平铺名 `omw-explain`（`src/seams/commands.ts:400`） | 文档侧待随 Story 3.1 一并改口径；本基线不改既有文档 |

## 七、怎么用这份基线

```text
pnpm test                       # 会跑 test/eval/governance-20.test.ts，校验 fixture、记录与口径三者一致
```

评测本身还没有驱动：`scripts/eval.ts` 属 Story 4.4，`/omw-explain` 属 Story 3.1。
在那之前，这份基线的价值是**把 20 条样本与判定口径先钉死**，让 Story 3.1 不必一边写实现一边编造验收样本。