# d9c. @suss/datalog 的 retract 语义：本人复现实验（推翻了 d9b 的部分措辞）

> 优先级：本 digest **覆盖** d9b §9b.4 第 1、3 条。d9b 那两条来自子代理转述，本文件是本人亲测。
> 环境：node v24.21.0，@suss/datalog 0.40.1（`npm install` 单包，无二次依赖），2026-11-25。
> 探针脚本：`.tmp-suss-verify/probe-retract.mjs`、`probe-negation.mjs`、`probe-neg2.mjs`、`probe-tripwire.mjs`、`probe-proof3.mjs`、`probe-singleT.mjs`。
> 本文所有数字与结论均为本人运行所得，非文献引用。

## 9c.1 结论先行：机制不是「不收回派生」，而是「只在规则集含否定时才自动收回」

d9b 说「`retract` 不收回派生事实」，措辞不准确，会误导实现者以为这是个无条件缺陷。真实机制是**条件性的**：

- **规则集含否定文字（`notLit`）** → `evaluate` 会在重算前自动清掉上次推导的结论，结果正确。
- **规则集纯正向（无任何否定）** → `evaluate` 不做任何清理，旧推导原样留在库里，结果**陈旧且静默**。

类型定义原文（`dist/index.d.ts:635-640`）：「When a rule set uses negation, a new fact can invalidate an old conclusion, so evaluation calls this to remove what it derived last time.」——这句话是准确的，是我此前读成了普遍缺陷。

实验对照（2 条边 `a→b`、`b→c`，传递闭包规则，撤掉基事实 `a→b` 后单次 `evaluate`，正确答案应为 `["b c"]`）：

| 用例 | 规则集 | 操作后 reach | 判定 |
| --- | --- | --- | --- |
| P1 | 纯正向 | `["a b","a c","b c"]` | **陈旧，错** |
| P2 | 含否定 | `["b c"]` | 正确 |
| N1 | 含否定，新增 `blocked(a)` 使否定由真变假 | `["b c"]`（`a b`/`a c` 正确消失） | 正确 |
| N3 | 纯正向 + 推荐写法 | 与全量重建逐条一致 | 正确 |

**这一段对整个设计是要害**：OWL 2 RL 的 78 条规则**全部是正向 Horn 规则、没有否定文字**（d8 已核实），所以把 RL 规则直接交给 suss 时，**恰好落进不会自动纠错的那一支**。

## 9c.2 第二个坑：RL 的单个三元谓词 T 无法安全清理

RL 规则在规范里写在**一个三元谓词 `T`** 上，断言事实与推导事实同处一个关系。实测这个模型有两个致命问题：

```text
A_initial                      : 4 条（3 条基事实 + 1 条推导 ex:Researcher⊑ex:Agent）
A_afterRetractBase_andEvaluate : ["ex:Person⊑ex:Agent", "ex:Researcher⊑ex:Agent", "ex:alice a ex:Researcher"]
                                 ↑ 被撤的基事实没了，但由它推出的 ex:Researcher⊑ex:Agent 还在 —— 陈旧
A_retractAll_wipes             : removed=4, T=[]  ← 「安全写法」把 3 条基事实一起删光
```

也就是说，模型 A（单 T）**两条路都堵死**：不清则陈旧，清则连断言一起没了。

模型 B（拆成 `Ta` 断言 / `Td` 推导 / `T` = 二者并集）实测正确：

```text
B_initial    : T=4 条，Ta=3，Td=1
B_afterSweep : 撤 Ta 一条 + retractAll("Td") + retractAll("T") + evaluate
            → T=["ex:Person⊑ex:Agent", "ex:alice a ex:Researcher"]
B_control    : 从剩余基事实全量重建 → 完全相同
B_match      : true
```

代价是多一条规则（`T :- Ta` 与 `T :- Td` 两条并集规则）与一次额外关系扫描。

## 9c.3 `clearRelations` 的作用域陷阱

d9b 说「`clearRelations` 静默吞掉后续增量」，方向不对。实测它**清的是你点名的关系**，问题在于：

- 对模型 A 的单 T 关系用它 → 结果 `[]`（正确应为 `["b c"]`），因为断言和推导在同一个关系里，一起被清空了；
- 对模型 B 的推导关系用它 → 需要同时清 `T`（并集关系）与 `Td`，只清 `Td` 会残留并集关系里的旧条目。

**结论：`clearRelations` 本身没错，是「单关系混装断言与推导」这个建模让它无法正确使用。** 与 9c.2 是同一个根因。

## 9c.4 被否决的两个「聪明」写法

### negation tripwire（给正向规则集塞一条永不命中的否定文字）

设想：每条规则加 `notLit("__tripwire__", X)`，关系永不填充，借此让 suss 认为规则集「用了否定」从而获得自动纠错。

实测**功能有效**（`C1` 撤基事实后正确得到 `["b c"]`，`C3` 混合操作与重建一致），**但必须否决**，两条理由都是硬的：

1. **污染证明树**。开 `witnesses` 代数后对比同一目标 `reach(a,c)` 的证明：

```text
纯正向    : DERIVED reach(a,c) via reach-step
              FACT edge(a,b)
              DERIVED reach(b,c) via reach-base
                FACT edge(b,c)
tripwire  : DERIVED reach(a,c) via reach-step
              FACT edge(a,b)
              DERIVED reach(b,c) via reach-base
                FACT edge(b,c)
                ABSENCE __tripwire__(b)      ← 假缺口
              ABSENCE __tripwire__(a)        ← 假缺口
```

`absenceLeaves`：纯正向 0，tripwire **2**。第 4、5 步正是靠 `absence` 叶子区分「真缺口」与「查不到」，这两条假叶子会把缺口上报直接变成噪音。

2. **静默失败面**。只要有人误写一条 `__tripwire__` 事实，所有推导立刻清空且无报错（`D2`：`before` 3 条 → `after` 1 条，`silentlyLost: true`）。

3. 性能也不划算。3 次重复取中位数（400 条边链）：纯正向 **35.56ms** / tripwire **48.22ms**（+35.6%）/ 显式双跑 **79.75ms**。早先单次测得 tripwire「-7.1%」是噪声，不可采信——**单次计时在这类毫秒级差异上不可靠，必须重复取中位数**。

### 依赖 `proofOf` 而不开 witnesses

`proofOf(db, rel, tuple)` 不传 `witnesses` 代数时返回 `{kind:"absence", ...}`，看起来像「没有证明」，实际语义是「该事实没有见证」（`dist/index.d.ts:521-531`：「A `fact` leaf has no witness: the caller asserted it, or it was derived without the `witnesses` algebra」）。

**开具证明前必须 `evaluate(db, rules, witnesses)`，否则拿到的 absence 是误读。** d9b 第 2 条说的「谎报成 fact」实测不成立（返回的是 absence 不是 fact），但「不开 witnesses 拿不到可用证明」这个结论成立，只是表述要改。

另注：`proofOf` 内部的子节点字段是 `premises`（`ProofDerived`），不是 `body`。用 `body` 遍历只能拿到根节点，会误以为证明树只有一层。

## 9c.5 定稿的正确用法（写进 DESIGN.md §5.5 / §9.3）

1. **断言与推导必须分关系**：`Ta`（断言，只由写入方 add/retract）、`Td`（推导，每次重算前整体清空）、`T = Ta ∪ Td`（供查询与规则体读取）。这条现在是 schema 硬约束，不是优化建议。
2. **每次变更后的固定序列**：`retract/add(Ta) → retractAll(Td) → retractAll(T) → evaluate` 。不要指望 `evaluate` 自己清理，除非规则集里真的有业务否定。
3. **证明必须开 `witnesses`**，且遍历用 `premises`。
4. **不要用 tripwire**。宁可多写一次 `retractAll`。

## 9c.6 成本实测（可接受的量级）

| 场景 | 规模 | 耗时 |
| --- | --- | --- |
| 建 400 边链 + 全闭包（纯正向） | 400 条边 | 35.56ms（中位数） |
| 同上 + 显式 retractAll 后重建 | 400 条边 | 79.75ms（中位数，约 2.2×） |
| 300 边链全闭包推导事实数 | — | 45,150 条 |
| 撤一条 + retractAll + 重推 | 300 边链 | 34.34ms |
| 200 边链撤一条 + retractAll + 重推 | 200 边链 | 14.1ms（推导 20,100 → 19,900 条） |

显式双跑约为单次的全闭包两倍——这符合预期（清空后需要从头推）。**结论：这套写法的代价是「每次变更付一次全闭包」，而不是增量。** 因此只能落在 dream（后台）与写路径（去抖 3s）上，不能进 250ms 召回热路径。这与 §5.7 的时间预算结论一致，但把「多大」钉成了具体倍数。

## 9c.7 诚实标注

- 本 digest 全部为本机实跑结果，未跑 benchmark，未在 Windows 之外的平台验证。
- 只测了传递闭包与 `cax-sco` 两类规则形状；**未测 `prp-spo2`（属性链）与 `eq-rep-*`（同一性替换）**——而它们正是 RL 里组合爆炸的主因，所以 9c.6 的时间数字**不能外推到完整规则集**。
- 未提交 issue 到 @suss/datalog。上游 DESIGN.md 原文「With retract, the next run would start again from the base facts」与实测不符，但那是**纯正向规则集**下的行为差异，是否算 bug 取决于上游意图，本人倾向认为文档描述的是含否定时的行为。
- 未验证 `deriveOnDemand` / `noteReads` / `rowBudget` 与上述写法的交互。
