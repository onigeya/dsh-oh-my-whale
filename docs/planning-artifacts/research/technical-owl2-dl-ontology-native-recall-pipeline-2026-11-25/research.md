---
title: 'technical research: OWL2-DL ontology-native recall pipeline'
type: 'technical'
topic: 'OWL2-DL ontology-native recall pipeline'
decision: '是否与如何基于 OWL 2 重新设计 oh-my-whale 的存储 schema，使 TBox/ABox 天然嵌入，并支撑 5 步证明式召回'
source: 'native run (harness web search + fetch)'
status: draft
preset: 'deep'
validation: 'normal'
created: '2026-11-25'
updated: '2026-11-25'
---

# technical research: OWL2-DL ontology-native recall pipeline

**Decision this research serves:** 是否与如何基于 OWL 2 重新设计 oh-my-whale 的存储 schema，使 TBox/ABox 天然嵌入，并支撑 5 步证明式召回

_Sections are appended per the approved research plan; the executive summary is written last and placed here, first._
---

## 0. 目标的三次收敛（研究过程中被用户修正，此处记录以避免误读后文）

这条研究线最初的问题（m00001）是「深入研究 OWL 与 OWL-DL，优化召回管路」，把 OWL 2 当成给定前提。研究进行中用户三次收窄了问题，三次都以用户原话为准：

| 轮次 | 用户原话 | 对研究的影响 |
|---|---|---|
| 1 | 「不一定非要局限于OWL 2，我想要的其实是一个'信念'系统。」 | OWL 2 从前提降级为**候选载体**。研究问题变成「哪种认识论载体能同时做信念维护与否定证明」。 |
| 2 | 「核心思想就是使用信念基半修正、相关性替代等方式在推理机层面实现核收缩，以此达成AGM的一种工程妥协。」 | 目标机制被**指定为 AGM 的工程近似**：belief base + kernel contraction + relevance，且收缩必须发生在推理机层面而非应用层。 |
| 3 | 「不，我可能是被人误导了。如果Chronos与这无关，我们也不用从零开始研究。」 | 否决 Lean 形式化验证路线与外购路线（Chronos 经核实为空壳仓库，55 文件 / 71,590 字节，`src/lib.rs` 仅 4 行 `pub mod`，子目录全空）。**不为此另开研究线。** |

因此本报告的组织原则是：**以「信念系统 + AGM 核收缩」为判据，评估 OWL 2 能否承载，并给出可落地的混合形态**。凡是「OWL 2 做不到但信念系统需要」的地方，都显式记为缺口，而不是绕过。

仍成立的两条硬约束：
- 宿主存储 `triviumdb@0.9.3` 不可替换，它**没有 RDF 三元组、没有 SPARQL、没有推理层**，只有「带 label 的边 + 节点 JSON payload + 二级索引 + 向量」这套原语。
- 原 5 步召回语义（粗召 → 概念查询证实/证伪 → 溯因补最小 delta → 缺口与部分证明树 → 合并提交）仍是要被满足的运行时契约。

---

## d3a. 信念基范式：Lemmalog 的 Datalog 半修正路线

来源：GitHub `JordyZomer/lemmalog`（源码直读，非二手描述）。

### 它解决的问题与本项目同构

Lemmalog 是一个 stratified Datalog 解释器，把「记忆」建模为规则 + 事实，核心主张是**派生关系永不持久化**（event sourcing）：所有推导结果在每次 epoch 重算，只有输入事实与规则被存储。这条主张直接对应本项目「证明必须可重放、不可缓存成不可追溯的物化结果」的要求。

### 四个可直接借用的机制

**（a）semiring annotation —— 置信度与溯源同构融合**

它把每个推导结果的注释定义为「confidence × provenance」的 semiring 元素：
- confidence 组合用 **product t-norm**（乘法，乘性衰减，符合「链越长相乘越小」的直觉）
- provenance 组合用 **set union**（并集，保留所有支撑来源）
- 重新推导出同一结论时做 **annotation merge**（不是覆盖，是合并）

这一点对本项目是决定性的：它证明「置信度」和「证明来源」可以放在**同一个代数结构**里随推导传播，而不需要事后拼接。本项目第 ④ 步要把「已证实/已证伪/缺口」与「支撑证据」一起交给宿主，这个 semiring 正好是那个数据结构的理论基础。

**（b）`why()` 证明树，带环保护**

直接产出推导树，且对递归规则做了环检测（否则证明树会无限展开）。这是本项目第 ④ 步「部分证明子树」最直接的参考实现。

**（c）scoped negative deltas —— 撤销只重算传递依赖**

这一条正好是 AGM 核收缩的工程落地：撤销一条事实时，不整体重算，而是只重算**传递依赖它的那些推导**。对应 DRed（Delete-Rederive，Gupta/Mumick/Subrahmanian 1993）的 lite 版：按 stratum 逐层清空，只在输入的 key set 真的变化时才重建。

实现细节值得抄的是它的**触发条件判断**：只有输入的 key set 发生集合层面的变化才重建，而不是「收到更新就重建」。这避免了大量无变化的空转重算。

**（d）四分支更新协议：ADD / UPDATE / NOOP / escalate**

新证据进来时先分类再处理：能新增就 ADD、能就地修正就 UPDATE、与已有等价就 NOOP（不产生新 epoch）、无法判定则 escalate 给上层。这个协议是「信念修正」在工程上的最小可用形态——**关键是 NOOP 分支**，它让「无变化的更新」不污染版本历史。

> 对本项目：triviumdb 没有版本历史概念，但现有 schema 已经有 `superseded_at` + `active_slot` 的失效机制，四分支协议可以直接映射成「写不写新 payload / 翻不翻 active_slot / 报不报冲突」。

### 评测数据（可核验，seed 42，1000 turns）

| 指标 | 结果 |
|---|---|
| knowledge updates | 30/30（含 220 次 supersession） |
| multi-hop 查询 | 40/40，7.6ms |
| **conflict abstention** | **29/29，且保留全部开放偏好** |
| 端到端准确率 | 100% |
| 上下文效率 | 422 ctx vs 5386 transcript tokens（12.8×） |
| 单轮延迟 | 1.5ms |

`conflict abstention 29/29` 是这批数据里最重要的一个：它说明**在冲突时弃权而不是猜**是可以做到 100% 的。本项目第 ④ 步「如实报缺口」在工程上是可达的，不是理想主义。

### 但它与 OWL 2 在认识论上互斥（必须二选一作基底）

| 维度 | Lemmalog（Datalog） | OWL 2 DL |
|---|---|---|
| 世界假设 | 封闭（negation-as-absence，带负环拒绝） | 开放（OWA） |
| 证伪来源 | 「推不出来」即假 | 必须显式证明 `¬γ` |
| 单调性 | 非单调（新证据可翻转结论） | 单调（新证据只加强） |
| documentation annotation | semiring confidence **参与推导** | annotation **不参与语义**（是定理，见 d6） |

**结论：两者不能简单叠加。** 一个 KB 不可能同时「缺省即假」和「缺省即未知」。这是本研究最重要的一个分叉判断，它直接决定了 schema 设计的方向：不是「把 OWL 塞进 triviumdb」，而是**在推理机层面显式分层，让不同层用不同认识论**。

---

## d5. 三态语义、概念查询与部分证明树

来源：W3C 规范全文（本地下载后 grep 原文）+ DOI/arXiv 书目核验。

### 5.1 一致性检查是第 0 关，不是三态之一

SPARQL 1.1 Entailment Regimes §7.2 表格中原文：
> "**Inconsistency** If the queried ontology is inconsistent under OWL 2 Direct Semantics, the system **MUST raise an error**."

理由是爆炸原理：不一致 KB 上「证实」与「证伪」同时成立，任何证明树都平凡为真，也就毫无价值。**管线必须维护 `kbConsistent` 标志，为假时第 ② 步直接返回 `INCONSISTENT`，禁止输出任何证明树。**

### 5.2 三态 = 两次可满足性检查

| 状态 | 形式条件 | 判定式 |
|---|---|---|
| ENTAILED | KB ⊨ γ | KB ∪ {¬γ} 不可满足 |
| REFUTED | KB ⊨ ¬γ | KB ∪ {γ} 不可满足 |
| UNKNOWN | 两者皆非 | 两个并集均可满足 |

工程含义：**不需要新的推理原语**，一个 `isSatisfiable()` 调两次就够，缓存键 `(goal, kbVersion)`。

### 5.3 「查不到」永远不等于「证伪」

OWA 里 `KB ⊭ γ` 只给出 UNKNOWN 的一半。要成为 REFUTED，必须真的证明 `¬γ` 被蕴含——而 OWL API 里没有「instance checking 的否定版本」，证伪就是「把 γ 当假设导致不可满足」。

**证伪能力的六种燃料（决定 schema 必须存什么）**：
1. 显式否定断言（`NegativeObjectPropertyAssertion`、`complementOf`）
2. **不相交性 + 成员关系**（`DisjointClasses(C D)` + `D(a)`）
3. **基数/函数性 + 两个不同填充者**（`FunctionalObjectProperty(R)` + `R(a,b)`, `R(a,c)`）
4. domain/range + 值域不相交
5. 数据类型面约束冲突
6. `AllDifferent` / `differentFrom` 提供的不等性

> **推论：如果 TBox 里不含上述任何一条，整个 KB 的证伪能力为零，三态退化成二态。** 这是 schema 设计的硬要求，不是可选项。建议加 schema 自检：TBox 不相交公理数为 0 时，在整个召回结果上打 `lowRefutationPower` 标签——否则宿主会误以为「没证伪 = 可能」。

### 5.4 最容易误报的一行：概念已证实但实体未定位

Certain answers 只收 named 项，所以「alice 有父亲」可以成立，而「alice 的父亲是谁」的 certain answer 是空集。**必须把「概念层已证实」与「实体层已定位」拆成两个字段**，否则会把匿名见证误报成「没找到人」。

### 5.5 查询级四态（比裸三态更适合交给 LLM）

同时算两个界：`Cert(q)` = certain answers、`Poss(q)` = 可满足的候选。

| 状态 | 条件 | 对 LLM 的表述 |
|---|---|---|
| CERTAIN | a ∈ Cert | 确定成立 + 证明树 |
| POSSIBLE | a ∈ Poss \ Cert | 可能成立，取决于未定事实 + gap |
| IMPOSSIBLE | a ∉ Poss | 确定不成立 + 反驳树 |
| OUT-OF-SCOPE | 不在 active domain | 不输出 |

`POSSIBLE` 就是第 ④ 步的原材料。工程上 Cert / Poss 各一张物化表，索引友好。

### 5.6 三轴，不要四值逻辑

OWL 2 的模型论是二值的：「既不能证实也不能证伪」不是世界的第三个真值，而是**推理者知识的不完备**。编码成真值会破坏 `C(a) ∨ ¬C(a)` 这类重言式。正交拆三轴：

```
axis1 真值（DL 决定，二值）  ∈ { true, false }
axis2 认知状态（管线决定）   ∈ { ENTAILED, REFUTED, UNKNOWN }
axis3 来源 provenance        ∈ { OWL_INFERRED, SHACL_CLOSED_CHECK, ASSERTED, ABDUCTED }
```

`ENTAILED + SHACL_CLOSED_CHECK` 就自然表达「封闭假设下被否掉、开放世界下未定」，不需要第四个真值。

### 5.7 SHACL 与 OWL 的合并边界

可核验事实：SHACL 规范里 `world` 一词出现 **0 次**，它的封闭世界性来自语义结构（在给定图上校验，无模型概念），不是文本宣示。

- **violation 不是 OWL 语义下的 `KB ⊨ ¬γ`**。若校验的图已是 OWL 物化闭包 → 可提升为 REFUTED；若校验原始 ABox → 只能算「按封闭假设看是错的」，必须降级为 POSSIBLE/UNKNOWN，**不能进证明树**。
- 规范明文允许组合（SHACL §1.5 `sh:entailment`）：「SHACL processors MAY operate on RDF graphs that include entailments — either **pre-computed before being submitted** or performed on the fly」。这就是「先 OWL 物化 → 再把闭包交给 SHACL」这条路的合法依据。
- **SHACL-AF 不是真值合并层**。它是前向链生产规则（带 `sh:condition` 守卫与 `sh:order`），原文承认「the data graph will be modified if triples get inferred」，不解决开放世界结论与封闭世界违规之间的真值冲突。

### 5.8 LCWA 的三条硬约束

**（a）Grounded Circumscription 2011 的 tableau 算法已知错误。** Delivorias & Rudolph (RR 2016) 原文：「identifies some problems with the original semantics definition, which gives rise to counter-intuitive consequences and renders the **proposed tableau algorithm incorrect**」。→ 按那篇实现会得到系统性错误结论，且只影响非单调部分，极难测出。

**（b）关闭谓词的代价是复杂度跃升。** Lutz/Seylan/Wolter (LMCS 15(3:23) 2019)：「a **dichotomy between FO-rewritable and coNP-complete for DL-Lite** and between **PTime and coNP-complete for EL**」。→ **250ms 预算下不可能对每个概念查询现场做 closed-predicate 推理。LCWA 只能是写时物化的产物**，closed scope 应作为**数据**存在（`omw:ClosureScope` 节点 + 成员谓词表），而非全局语义开关。

**（c）** Knorr/Alferes/Hitzler (AIJ 2011) 把 LCWA 放进 well-founded semantics——即标准三值语义（true/false/undefined）。条款已核验到 DOI 层，具体定义因付费墙未读，不作更强声明。

### 5.9 证明树的截断算法

证明 DAG 节点是 `(结论, 规则, 前提集)`，边是「前提 → 结论」。四态标签 + 三值传播：

```
enum ProofStatus { PROVED, CONDITIONAL, GAP, REFUTED }
AND 节点（前提合取）: min(子)   // GAP 吞掉整支
OR  节点（多分支择一）: max(子)  // 一支 PROVED 即整体 PROVED
```

四类叶子：**REFUTED**=clash 节点（必须记录 clashing pair，这是反驳树的全部价值）；**PROVED**=断言在 assertional base 中；**GAP**=既不在 base 也不 clash，且**必须携带「我已检查过它不可驳」的标志**——否则它只是「没查」而不是「查了没有」；**CONDITIONAL**=至少一个前提是 GAP 的内点。

**截断必须在 laconic 化之后。** Kalyanpur 等人的 justification 枚举用 Reiter Hitting Set Tree，最坏指数级——所以全部 justification 只能离线算。而交给 LLM 的证明子树若带 40 条冗余公理，LLM 会开始编故事。

### 5.10 缺口节点 schema（骨架，完整字段见 digest）

```
node label: omw:Gap          // 独立 label 空间，reasoner 输入永不含它
  gapGoal / gapMissingPattern（模板，不是断言）/ gapPolarity(wouldProve|wouldRefute)
  gapCutFrontier / gapProvedSubtree / gapRefutationEvidence
  gapKind ∈ { missingAssertion, missingWitness, missingDisjointness }
  gapStatus ∈ { open, answered, superseded } / gapCostEstimate / gapKbVersion
```

四个设计要点：`gapMissingPattern` 是**模板**所以不破坏 OWA；`gapKind` 三分中 **`missingDisjointness` 最易忽略且只能靠改 TBox 解决**，是给上层的元级建议；`gapRefutationEvidence` 是 gap 与「没查」的唯一区分依据；`gapKbVersion` 支持失效，避免陈旧缺口污染召回。

**绝对禁止**三种写法：用 `¬C(a)` 表示「没找到」（可能与 TBox 冲突导致整个系统拒答）；把缺口挂在域内命名空间（会触发 domain/disjoint 公理制造真实但错误的推论）；用「闭包里没有」当 false。

### 5.11 第 ③ 步的正确名字：ABox abduction

Klarman/Endriss/Schlobach, "ABox Abduction in the Description Logic ALC", JAR 2010。解是一个断言集 D，使 `KB ∪ D ⊨ γ` 且 `KB ∪ D` 一致，通常要求 D 在集合包含下最小。

**与本项目的对接口**：每个 `gapPolarity = wouldProve` 的 gap 就是一个 abduction 子问题，而因为已记下 `gapMissingPattern`，搜索空间被**预先收窄到模板匹配**而非全 ABox 组合爆炸。这是延迟预算内唯一可行的溯因路径。

---

## d6. 概念嵌入与不确定性标注

来源：AAAI/NeurIPS/arXiv 论文 + W3C 规范状态核验。

### 6.1 几何嵌入只能排序，不能证明

这决定了它在管路里的位置：**只用于第 ① 步粗召，绝不参与第 ② 步判定**。

| 模型 | 数据集 | 结果 |
|---|---|---|
| Box²EL | Anatomy | H@1 = 0.16 |
| Box²EL | GALEN | H@1 = 0.05 |
| BoxEL | GALEN | H@1 = **0.00**，MRR 0.01 |
| BoxEL | GO | AUC 0.68 |

H@1 归零不是训练不足，是模型表达能力与 EL 公理形状不匹配的结构性结果。

> **出处强度：转述，非一手**（2026-11-25 标注）。上表四个数值与 §6.2 的四代演进只在来源表第 14 条下有登记，而该条**不可核验**（无标题、无 DOI，把 Deferred / Box²EL / BoxEL 三个工作混写成一格）。结论方向（几何嵌入只能排序、不能证明）另有 §6.3 的语义定理作硬支撑，故不影响设计判决；但**不要把上表数值当引用凭证**——要用须先补齐一手出处。

### 6.2 四代演进的教训

`ELEm`（n-ball，问题：**n-ball 的交不是 n-ball**，闭式表达失效）→ `ELBE`（改轴对齐盒，交封闭）→ `BoxEL`（仿射变换增加表达力）→ `Box²EL`（bumping，处理多父继承的「liability」问题）。每一代都在解决上一代的**几何封闭性缺陷**，不是单纯调参。

### 6.3 三条注释路线的可行性判决

| 路线 | 判决 | 依据 |
|---|---|---|
| annotation 语义 | **语义为空是定理**：`Models(KB ⊕ ann) = Models(KB)` → 蕴含判定不变 | 注释可以放心作为 metadata 存，但**不能指望它改变推理结果** |
| fuzzy DL | **不可判定**（含 GCI 即 undecidable，arXiv:1107.4212） | 直接排除 |
| probabilistic | 公理级 NP-complete / interpretation-based PEXP | 排除 |
| **Defeasible DL（KLM rational closure）** | **复杂度不超过 ALC，是唯一实用答案**（arXiv:1904.07559） | 这是本项目「可推翻的默认结论」的正解 |

### 6.4 triviumdb 的三条几何约束（实测代码得出）

- **没有 edge label 索引**（`triviumdb.d.ts:916-925` 全是 payload 字段索引）→ class 节点必须在 payload 里物化 `ancestors` / `descendants` 数组 + `createBitmapIndex`。
- **概念层应 `exact:true` 暴力**而非 ANN：10³ 概念 × 1024 维 ≈ 1ms / 4MB，暴力更快更准。
- **不能用 BoxE 做 EL TBox 推理**：BoxE 支持的构造子（inverse、symmetry）恰是 EL 禁用的那批，而 EL 唯一的 role chain 它不支持。

### 6.5 一个必须知道的能力边界

`single` 基数（`FunctionalObjectProperty`）在 EL 里**写不出来**——被 EL profile 排除。这意味着若用 EL 作运行时推理层，唯一索引不变量不能靠 OWL 公理表达，必须由存储层自己维持。

---

## d8. OWL 2 RL 的规则可实现性与复杂度（一手规范核实）

来源：W3C OWL 2 Web Ontology Language Profiles (Second Edition), REC 2012-12-11，https://www.w3.org/TR/owl2-profiles/ 。本地副本 $env:TEMP/owl2pf.html（182,784 字节）。

这一节回答的是整个双引擎设计的关键问题：**契约层是否需要第二个推理器**。答案是「不需要」。

### 8.1 RL 就是「正向 Datalog 规则 + 完整性约束」

规范 §4.3 原文三句：

> OWL 2 RL reasoning systems can be implemented using rule-based reasoning engines.
> This is achieved by defining a syntactic subset of OWL 2 which is amenable to implementation using rule-based technologies, and presenting a **partial axiomatization** of the OWL 2 RDF-Based Semantics in the form of first-order implications.
> OWL 2 RL supports all axioms of OWL 2 apart from disjoint unions of classes (DisjointUnion) and reflexive object property axioms (ReflexiveObjectProperty).

规则形式是「universally quantified first-order implications over a ternary predicate T」——即 `T(?s, ?p, ?o)`，本质就是三元组。

**我逐表清点了 Table 4–9 的全部规则：共 78 条具名规则（eq 9 / prp 20 / cls 19 / cax 5 / dt 5 / scm 20），所有规则的 body 只含正向原子，没有一条含否定文字。** 其中**恰好 17 条**的 head 是常量 `false`：

`eq-diff1` `eq-diff2` `eq-diff3` `prp-irp` `prp-asyp` `prp-pdw` `prp-adp` `prp-npa1` `prp-npa2` `cls-nothing2` `cls-com` `cls-maxc1` `cls-maxqc1` `cls-maxqc2` `cax-dw` `cax-adc` `dt-not-type`

这 17 条正是 OWL 2 里所有**冲突型公理**的规则化：不同个体相等、非自反属性被自反填充、非对称属性被对称填充、不相交属性被同对填充、负属性断言被正断言满足、`owl:Nothing` 有个体、补类同时被填充、`maxCardinality 0/1` 被两个不同填充者违反、`DisjointClasses` 成员重叠、`AllDisjointClasses` 重叠、数据类型冲突。

### 8.2 三个直接后果

| 问题 | 答案 | 依据 |
|---|---|---|
| 契约层是否要第二个推理器 | **不需要**。同一个 Datalog 内核跑 RL 规则集 + IC 检查 | §4.3 全部 body 为正、只有 false 头 |
| 第②步的证伪怎么实现 | **证伪 = IC 触发** | 17 条 false 头规则 |
| 核收缩（G3）的 kernel 从哪来 | **IC 触发本身就携带 kernel** | 触发实例 = 支撑该 false 的规则实例集合 |

这三条合起来意味着：G5 的双引擎在**实现层可以只有一个求值器**，OWL 与 Datalog 的区别退化为「用哪组规则、用哪个 annotation semiring」。

### 8.3 RL 的边界

- **只排除两个构造子**：`DisjointUnion`、`ReflexiveObjectProperty`。
- **不支持预定义属性**：`owl:topObjectProperty` / `owl:bottomObjectProperty` / `owl:topDataProperty` / `owl:bottomDataProperty`。
- **数据类型禁项**：`owl:real` 与 `owl:rational` MUST NOT be used in OWL 2 RL。
- **SubClassOf 句法位置受限**（subclass 位置可是 class / 交 / 并 / oneOf / someValuesFrom / hasValue / someDataValuesFrom / hasDataValue；superclass 位置更严）——这些限制是保证多项式复杂度的关键。
- **§4.1 原文**：「These restrictions are designed so as to **avoid the need to infer the existence of individuals not explicitly present in the knowledge base**, and to **avoid the need for nondeterministic reasoning**.」——无存在量词在规则头、无析取。这两条正是 Datalog 可终止的充要条件。

### 8.4 Theorem PR1：部分公理化的代价是「可能不完备，但永不错误」

对满足 §4.2 句法约束、且 IRI 未被用作多种实体类型的 RL 本体，规则实现返回 all and only the correct answers。但对任意 RDF 图：

> it is no longer possible to guarantee that all correct answers can be returned
> Such an implementation will, however, **still produce only correct entailments**.

即 **soundness 恒保、completeness 有条件**。这与此前 d5 得出的「未命中必须标 `unknown` 而非 `false`」是同一件事的两面：规则引擎答不出不等于假。

### 8.5 Table 10 复杂度（补齐此前未取到的数据）

| Language | Reasoning Problem | Taxonomic | Data | Query | Combined |
|---|---|---|---|---|---|
| OWL 2 RDF-Based | 全部 | Undecidable | Undecidable | Undecidable | Undecidable |
| OWL 2 Direct | Consistency / CE-Sat / Subsumption / Instance | N2EXPTIME-complete | Decidable, complexity open (NP-Hard) | N/A | N2EXPTIME-complete |
| OWL 2 EL | Consistency / CE-Sat / Subsumption / Instance | PTIME-complete | PTIME-complete | N/A | PTIME-complete |
| OWL 2 EL | CQ Answering | in EXPTIME | PTIME-complete | NP-complete | in EXPTIME |
| OWL 2 QL | Consistency / CE-Sat / Subsumption / Instance | NLogSpace-complete | In AC⁰ | N/A | NLogSpace-complete |
| OWL 2 QL | CQ Answering | NLogSpace-complete | In AC⁰ | NP-complete | NP-complete |
| **OWL 2 RL** | **Consistency** | **PTIME-complete** | **PTIME-complete** | N/A | **PTIME-complete** |
| **OWL 2 RL** | **CE-Sat / Subsumption / Instance** | **PTIME-complete** | **PTIME-complete** | N/A | **co-NP-complete**（原子类表达式为 PTIME） |
| **OWL 2 RL** | **CQ Answering** | **PTIME-complete** | **PTIME-complete** | **NP-complete** | **NP-complete** |
| OWL 1 DL | Consistency / CE-Sat / Subsumption / Instance | NEXPTIME-complete | Decidable, complexity open | N/A | NEXPTIME-complete |

### 8.6 这张表对设计的三个硬约束

1. **一致性检查（第 0 关）落在 PTIME-complete**，三列全 PTIME。这是 RL 相对 OWL DL（N2EXPTIME）唯一能承受的落点——「先在 RL 上做一致性」是必须而非可选。
2. **组合复杂度 co-NP-complete 是硬墙**。CE-Sat / Subsumption / Instance 在**组合**维度 exponentiates；**但原子类表达式降到 PTIME-complete**。所以契约层必须把查询约束在「原子类 + 具名属性」，**禁止运行时构造任意类表达式**。
3. **CQ Answering 的查询复杂度 NP-complete**。共轭查询求值是 database theory 的经典 NP-完全问题。**第②步的「概念查询」绝不能做成任意 CQ 求值**，必须限制成形如 `?x rdf:type :C` 的原子查询（可归约成索引查找，PTIME），或把多原子 CQ 拆成多个原子查询后取交集。

### 8.7 诚实标注

- Table 10 数值来自规范 HTML 逐字核对；`N2EXPTIME` 的上标在纯文本里丢格式，含义是 double exponential。
- 我没有独立验证 RL 规则集的完备性证明（规范只给部分公理化；PR1 第三条约束在原文截断处以 `O1 does not contain S...` 开头，未取全）。若设计依赖 completeness，需回去读完整 PR1。
- 复杂度表给的是**判定问题的理论界**，不是实现耗时。

---

## d9a. Lemmalog 源码级核实：双引擎内核的现成候选

来源：https://github.com/JordyZomer/lemmalog @ `9cc2cf1bc050ddd67cc1c6b644953377b0b9ef9d`，本地克隆 `imports/lemmalog`（以 gitlink 入库，提交号即上）。v0.2.0，license MIT，accessed 2026-11-25。

### 9a.1 依赖图决定能否内嵌

`Cargo.toml` 全文仅两个依赖，且都是 optional：

```toml
[dependencies]
serde_json = { version = "1", optional = true }
ureq = { version = "2", optional = true }

[features]
llm = ["dep:ureq", "dep:serde_json"]
mcp = ["dep:serde_json"]
```

**纯引擎零必需依赖**：无 tokio、无 async runtime。这意味着它可以独立编译成一个 .node addon，与 triviumdb 的依赖树不冲突。

### 9a.2 G5/G3 需求与现成实现的对应

| 需求 | lemmalog 实现 | 位置 |
|---|---|---|
| 基事实断言 | `declare(pred, args, ann)` | `eval.rs:618` |
| 递归查询 | doc 注释示例 `reports_to(X,Z) :- reports_to(X,Y), reports_to(Y,Z)` | `lib.rs:19-26` |
| 聚合 | `validate_aggregates`：Agg 只在 head + range restriction | `lib.rs:89-173` |
| 增量 | `run()` seminaive over per-epoch deltas | `lib.rs:558-561` |
| 分层否定 | `strata()` SCC 缩并，负环报 `StratError` | `eval.rs:758-832` |
| **核收缩（G3）** | `scoped_recompute`（DRed-lite）+ `retract` + epoch 日志 | `eval.rs:1047, 699, 722` |
| **证明树** | `why(pred,args)` 递归到源 episode | `eval.rs:2091-2146` |
| **provenance** | `Ann{confidence, provenance}`，join 时相乘 / 并集 | `eval.rs:13-60` |
| 双时间轴 | `edge(E,R,O,VF,VT,_)` + `now(T)` 时间投影 | `lib.rs:23` |
| magic sets | `ask_deep` | `eval.rs:1946` |
| 假设推理 | `hypothetical()` | `eval.rs:640` |

### 9a.3 决定性发现：`negate` 是 trait 钩子，NAF 不是硬编码

`eval.rs:143-155`：

```rust
fn negate(found: Option<&Self>) -> Self {
    match found {
        Some(_) => Self::zero(),
        None => Self::one(),
    }
}
```

注释原文：

> The default is negation-as-absence, the current semantics exactly: a match yields `zero()` and prunes the body, an absence yields `one()` and multiplies away. **This is the only hook that can change which facts exist**, which is why it is a trait method and not a post-pass.

`Annotation` 是可自定义的 semiring trait（`one` / `zero` / `times` / `plus` / `is_zero` / `derive` / `negate` / `render` / `interpret`）。于是：

- **Datalog 运行时层**用默认 `negate`：NAF，分层 Datalog 标准语义，可终止可验证。
- **OWL 契约层**覆写 `negate`，让 `None` 返回非 `one()` 的「未知」标注 → **OWA 证伪与 NAF 运行时判断共用同一个求值器**。

这一条**修正**了此前 d3a 的判定。d3a 说「Lemmalog 与 OWL 2 是互斥认识论，不能简单叠加，必须选一个作基底」。源码核实后应修正为：**互斥的只是默认语义；semiring 钩子提供了工程调和点——同一个引擎的两个 `Annotation` 实例**。

### 9a.4 两个直接可用的模式

**(a) 粗召到内核的现成写法**（`semantics.rs`，5,001 字节）：`HashEmbedder` 用 FNV-1a 把 token 投到 dim 桶、L2 归一化（确定性、无模型、无网络，测试用）；`seed_mentions` 把 cosine 相似度作为 `Ann::base(sim, ["semantic"])` 断言成 `mentions` 事实；然后：

```
near(S,E,1) :- mentions(S,E).
diffuse: near(S,E2,D) :- near(S,E1,Dm), Dm < 3, D = Dm + 1, current(E1,"links",E2).
```

3 跳有界扩散，**衰减由 confidence 乘积自然给出，不需要额外衰减因子**。这正是第①步「粗召几百条」要的形态：向量粗召 → 断言成带相似度的事实 → 规则在图上扩散，全在同一次不动点内完成，输出远超 topK 也不违反 AD-8（内部工作集不进注入）。

**(b) 原子查询的索引形态**：`Relation::lookup(bound: &[Option<Value>]) -> Vec<usize>`（`eval.rs:392`）是索引化的部分绑定查找——正是 8.6 里「原子类查询 PTIME」要的形态。

### 9a.5 一个实现坑（源码注释明确警告）

`derive(self, _clause: ClauseId, _body: &[Key])` 注释（`eval.rs:111-141`）：body 以 **FIRING ORDER** 到达且求值器不排序，**同一条逻辑推导会按 body 的排列各来一次**。若按 distinct derivations 计数，必须自己 `sort(body)` 再指纹，否则「对推导求平均」会静默变成「按排列加权平均」。

### 9a.6 诚实标注

- **没有跑通它的 benchmark，未复现任何数字**。d3a 里的评测数字（seed 42 / 1000 turns / updates 30/30）来自 README 自述。
- **没有验证它在 Windows + napi-rs 下能否编译成 .node。这是未做的关键实验。**
- `magic.rs`（9,941 字节）只看了文件名与大小，未读实现。
- lemmalog **无持久化**：`changes_from` / `changes_since` 说明它定位为「可重放的派生视图」，持久化靠外部存储。与 d3a「派生关系永不持久化（event sourcing）」一致。

---

## d3b. 「Schema 即本体」的工程先例、SHACL/OWL 分工、TBox 版本化与 ABox 迁移

source: 各产品官方文档逐页抓取 + W3C 规范全文 + arXiv/Crossref 书目核验
publisher: W3C / Stardog / Ontotext / AllegroGraph(Franz) / Apache Jena / Oracle / Oxford Semantic(RDFox) / TerminusDB / OBO Foundry
pub_date: 规范 2004–2017；产品文档 2023–2026
accessed: 2026-11-25
confidence: high（规范与产品文档均取原文逐句核对；TerminusDB 无同行评议论文，只有官方文档）
class: 工程先例 + 规范边界 + 版本化机制
digest: `digests/d3b-schema-as-ontology-and-versioning.md`（881 行，§0–§8）

### d3b.1 判决速览：没有一家在生产里跑 query-time OWL 2 DL

| 问题 | 判决 | 依据 |
|---|---|---|
| 有没有系统真的「schema 就是 TBox、ABox 同存储」 | 有，但**无一例外放弃了 query-time OWL DL**。真实存在的只有四种形态：查询重写（Stardog）、前向链物化（GraphDB/Oracle/AllegroGraph/RDFox）、纯存储无推理（Jena TDB2/Oxigraph/MillenniumDB）、文档型同 commit（TerminusDB） | §1 |
| OWL 2 DL 有没有在生产里跑起来 | **没有找到任何一个是 query-time OWL 2 DL 的**。Jena 自认只到 OWL Lite 且不完整；GraphDB 最高 OWL 2 RL；Stardog 的 SL 是 QL∪EL∪RL 超集；Oracle 最高 OWL 2 RL/EL；AllegroGraph 最高 OWL 2 RL；RDFox 规则不支持析取 | §5 |
| SHACL 能否替代 OWL 推理 | **不能，但能承担「封闭世界否定」这一半**。SHACL-AF 的 rules 是**单轮、不可自迭代**的前向规则引擎，规范自己说多轮行为「left to future work」 | §2 |
| owl:versionIRI / priorVersion / backwardCompatibleWith 够不够 | **完全不够**。全是 annotation，规范明说「has no meaning in the model-theoretic semantics」。本体序列在 OWL 2 结构规范里**根本没有显式表示** | §3 |
| schema 改动要不要全量重推 | **要**。Oracle 增量推理「supports only the addition of triples. With updates or deletions, the inferred graph will be completely rebuilt」；GraphDB 说删 schema 语句代价可能极差 | §4 |
| TerminusDB 的 schema 演进值得抄吗 | **值得抄的是判据，不是实现**。判据一句话：「The most useful question about a schema change is: can it make data that is valid today invalid?」配套两阶段（先 weakening 后 strengthening）| §6 |

### d3b.2 Stardog：查询重写路线的完整参数（对第 2 步最有参考价值）

- **反物化四条理由（原文）**：data freshness（数据/schema 一变就要重做，不适合高频变更）、data size（膨胀成本摊到每次查询 I/O）、fixed schema（无法按应用切规则集）、resources（真值维护昂贵，删除后尤甚）。
- **机制是 QUERY REWRITING**：「it does not materialize inferences; rather, reasoning is performed at query time」。schema 被译成内部 Datalog 程序，查询被改写后再执行。文档例子：`?person a :Person` 改写成 `{?person a :Person} UNION {?person a :Customer} UNION {?person a :Employee}`，并明说「RDFS and OWL axioms along with user-defined rules are (basically) Datalog rules over a graph」。
- **TBox 不是 schema 文件，而是命名的图**（reasoning schema，默认 IRI `tag:stardog:api:context:schema`）。7.0 起支持多 schema 并存，动机原文之一就是「两个版本的本体并存，老应用用旧版」。
- **Blackout（成熟版）**：`reasoning.type` ∈ RDFS|QL|RL|EL|SL，默认 SL = RDFS+QL+RL+EL+SWRL 并集。硬约束原文：「Any axiom outside the selected type will be ignored by the reasoner」；坏规则只记日志**仍继续推理**。
- **Blackout 的 SL 明确「不在推理里」的三条**：`owl:hasKey`、`owl:propertyChainAxiom`、`owl:DisjointClasses`（后者只在一致性检查阶段用）。→ 与 d8 的 RL 规则表对照：这三条 RL 都有规则（prp-key / prp-spo2 / cax-dw），**Stardog 主动砍掉了**。
- **Stride（9.0 起 beta）只支持七种公理**：`rdfs:subClassOf`、`owl:equivalentClass`、`rdfs:subPropertyOf`、`owl:equivalentProperty`、`owl:inverseOf`、`owl:SymmetricProperty`、`owl:TransitiveProperty`，其余一律忽略；有坏规则则**拒绝任何推理**。
- **递归限制原文**：「these restrictions are recursive ... the axiom `SubClassOf(ObjectSomeValuesFrom(p, ObjectAllValuesFrom(q, C)))` is not supported.」
- **Proof Trees 的工业先例**：「An explanation of an inference is the minimum set of statements explicitly stored in the database that, together with the schema and any valid inferences, logically justify the inference.」输出形如 INFERRED / ASSERTED / INFERRED 三层嵌套，多解释可 merge 成带编号分支的单棵树。**但该页开头写「The advanced reasoning features explained in this chapter are deprecated as they are not supported by the new Stride reasoner.」——证明树是被放弃的方向。**
- **Schema 版本化是哈希不是语义**：对 reasoning schema graph 内容算 64 位哈希，用途原文是「an optimization used by the reasoner to avoid reloading and reprocessing the schema unless the schema graphs have been updated」。文档自承百万三元组量级频繁更新时哈希开销明显。
- **Virtual Graph 对本项目的直接含义**：查询重写不必发生在自己的存储内部，可以把「概念查询」改写成宿主 TQL。

### d3b.3 GraphDB：前向链物化路线的参数

- 推论在 **LOAD 时算完**，以装载成本换查询速度。规则集是 `.pie` 文件（三节 Prefixes / Axioms / Rules），编译成 Java 源码，需 JDK ≥ 1.6。
- **方言与完备性三条明确取舍（原文）**：「GraphDB does not provide the extended support for typed literals ... it is our understanding that the performance penalty is too high for most applications」；「There are no inconsistency rules by default」；「There is extended support for schema-level (T-Box) reasoning in GraphDB」。
- **主动砍语义完备性的官方承认**：被优化掉的推论包括「每个 URI 节点推 `X rdf:type rdfs:Resource`」「`owl:sameAs` 自反」「所有个体 `rdf:type owl:Thing`」。理由原文：「Although the above inferences are important for formal semantics completeness, users rarely execute queries that seek such statements. Moreover, these inferences generate so many inferred statements that performance and scalability can be significantly degraded.」

### d3b.4 SHACL 与 OWL 的分工（规范级判决）

SHACL 只能承担「封闭世界否定」这一半，不能替代 OWL 推理：SHACL-AF 的 `sh:rule` 是**单轮、不可自迭代**的前向规则引擎，规范自己说多轮行为「left to future work」。这与 d5 的结论（SHACL 规范里 world 一词出现 0 次、violation 只有已在物化闭包上才能提升为 REFUTED、`sh:entailment` 允许 pre-computed entailments）互相印证。

### d3b.5 TBox 版本化：OWL 2 结构规范里的词汇没有一个可用

`owl:versionIRI` / `owl:priorVersion` / `owl:backwardCompatibleWith` / `owl:incompatibleWith` **全部是 annotation**，规范明说「has no meaning in the model-theoretic semantics」。本体序列（ontology series）在 OWL 2 结构规范里**根本没有显式表示**。→ 契约版本必须落成我们自己的字段，不能指望 OWL 词汇。

### d3b.6 变更判据：TerminusDB 的一句话是唯一可执行的

判据原文：「The most useful question about a schema change is: can it make data that is valid today invalid?」配套机制是两阶段迁移——先 weakening（放松）后 strengthening（收紧）+ 有序迁移操作列表。**本项目事实在 triviumdb、契约在别处，TerminusDB 的 same-commit 解法做不到**，必须显式存 `promoted_under_contract_version`。

### d3b.7 分层先例：五个真实系统，没有一个是靠「本体系统」实现的

| 系统 | 事实在哪 | 契约在哪 | 提升通道 | 出处 |
|---|---|---|---|---|
| **Ontop / R2RML** | 关系库原表（「data remains in the data sources instead of being moved to another database」） | 虚拟本体，只声明映射 | `TriplesMap` = logical table + subject map + predicate-object map；`rr:parentTriplesMap`+`rr:joinCondition` 表达外键 | ontop-vkg.org/guide/ 、w3.org/TR/r2rml/ |
| **Confluent Schema Registry** | Kafka 消息（事实不可变） | 版本化 schema | 写前兼容性检查（Backward/Forward/Full/Transitive）；「Each schema version gets a unique ID and an incremented version number」 | docs.confluent.io schema-evolution |
| **OMOP CDM v5.4** | `condition_source_value`（verbatim，varchar(50)） | `condition_concept_id`（Standard Concept） | `SOURCE_TO_CONCEPT_MAP` 显式映射表（Usagi/Perseus 工具辅助） | ohdsi.github.io/CommonDataModel/cdm54.html |
| **Freebase** | 用户自由创建的 type | public commons | **人工闸门**：「User-created types were not adopted in the public commons until promoted by a Metaweb employee」 | Freebase (database) Wikipedia |
| **dbt / ODCS** | 模型输出 | model contracts | 构建时强制「or it will fail to build」 | docs.getdbt.com model-contracts |

**关键判决：OMOP 的容忍度值得直接抄。** 文档对 source value 的原话只有「discouraged from use in analysis」——**从未要求必须提升**。也就是说「大量事实永远停在 verbatim 层」在一个被全球数百家医院使用的标准里是**合法常态**，不是技术债。这直接支撑 C4/C5（不对整层记忆施加 OWL）。

### d3b.8 提升触发条件：**业界空白，判据本身不存在**

逐系统核过，**没有任何系统记录定量触发条件**：Freebase 是一个 Metaweb 员工的主观判断（无数字）；OMOP 是 Usagi/Perseus 工具辅助人工，文档只写「recommended for use in ETL processes」；Confluent 只有「写前兼容性检查」，没有「该不该提升」的判据；dbt 官方明说「increase maintenance if adopted too early」，把判断推回给用户；Ontop/R2RML 映射由人写，无自动提升。

→ 所以我们设计的 `(K 个互异定义) ∧ (每定义 ≥ N 次检索引用) → 待评审` **必须标注为自研建议，不是既有实践**。这是 A1 第 ③ 项（事实如何提升为契约的触发条件）唯一诚实的位置。

### d3b.9 反例：整层本体化的公开失败

- **Cyc**：Pedro Domingos 的公开评价是「catastrophic failure」，两条理由「the unending amount of data required to produce any viable results」+「the inability for Cyc to evolve on its own」。
- **Clay Shirky《Ontology is Overrated》(2005)**：原文「even the ontological ideal is a mistake. Even using theoretical perfection as a measure of practical success leads to misapplication of resources」。但他自己也承认「Ontological classification works well in some places」——**这个保留意见正好支持 C4 的契约层设定**。
- **沉默回退**：Jena / Oxigraph / MillenniumDB 三家都是「文档里根本不提推理」，是 4/4 的集体沉默而非公开复盘。**未找到厂商回退复盘，应视为未证实而非不存在。**
- **Freebase 冻结**：「The reason Freebase could not open up permissions of schemas is that external applications relied on them; thus, changing a type schema ... might have broken queries for API users」。→ **契约一旦发布就冻结**的最强论据。

### d3b.10 分层后哪些代价消失、哪些照旧（回答我发给子代理的三问）

**① 失效或大幅简化的（6 条）**：DL 的 N2EXPTIME 不再是约束（概念数小且可离线）；SHACL+OWL 组合从 **EXPTIME 降为 PTIME**（Oudshoorn 原文「PTIME-complete in data complexity」——爆炸来自**本体侧**，本体小了就不爆）；RDFox 的 **320 倍膨胀**（14,820 → 4,740,705）在 schema 侧不再是问题；track information 的 90% 存储与全库重建停机消失；OWL 全套工具链的必要性消失；「必须做一致性检查」变成可选。

**② 仍成立且更重要的（8 条）**：六家公理白名单的长度（Stride 只 7 种、AllegroGraph 跳 1/3、GraphDB「no inconsistency rules by default」）**恰恰证明契约层必须显式列举支持的公理**；证明表结构必须（前提 ID 列表 + 规则名）且**写入时就要开着**（Oracle 硬约束：没有 proof 信息的推断图「you must first drop the inferred graph and create it again specifying PROOF=T」）；`owl:versionIRI` 等全是 annotation 这个事实不变；TerminusDB 的判据「can it make valid data invalid?」在契约层更适用。

**③ 消失的 8 项**：全库物化延迟、schema 变更的全量重建、RDFox 级膨胀、DL 复杂度、大规模 `owl:sameAs` 物化压力等。

**③ 照旧的 6 项**：`owl:sameAs` 等价闭包（**规模由个体数决定，与概念数无关**——Stardog 是唯一 eager 物化的，且需 canonical individual 避免「combinatorial explosion」）；证明存储成本（Oracle 只说「requires additional CPU time and disk resources」，**无数字**）；**契约版本与既有事实的对应**（TerminusDB 靠 same-commit 解决，本项目做不到，必须显式存 `promoted_under_contract_version`）；提升决策不可自动化；OWL 解析工具链；**翻译失败的诊断取舍**——建议学 Stride 严格模式（「有坏规则则拒绝任何推理」）而非 Blackout 宽松模式（坏规则只记日志继续推理），因为契约层小、作者有义务让每条公理可执行。

**两条派生硬约束**：RDFox「`owl:sameAs` 的 use in rules precludes the use of aggregation or negation-as-failure」→ sameAs 必须留在事实层做显式等价表；Oracle「NGLI currently does not work together with proof generation, user-defined rules, optimized owl:sameAs handling, or incremental inference」→ **推理与生成证明互斥，版本必须落成字段**。

### d3b.11 存储 schema 的落地建议（来自 §8-B）

`contract_axiom` + `contract_rule` + `contract_consistency` 三表设计；`non_executable` 标记用来记录「声明了但引擎不支持」的公理（对应 Stardog 的 ignored 与 GraphDB 的无 inconsistency rules）；OMOP 双列建模（verbatim 与 normalized 相邻两列 + 一张映射表）；OBO 式不可变快照做契约版本；`promoted_under_contract_version` 字段；证明表（前提 ID 列表 + 规则名）且写入时即开启。
---

## d2b. TBox/ABox 到 triviumdb 原语的映射：三种范式与十一组实测

source: 子代理 11 个探针脚本（probe1–probe11.mjs）+ DL-Lite/LPG 重写论文 + triviumdb@0.9.3 d.ts 与实测
publisher: arXiv/CIKM 2026 / ACM SIGMOD / AAAI / W3C / 本地实测
pub_date: 1993–2026；实测 2026-11-25
accessed: 2026-11-25
confidence: high（实测数字均为本机跑出）；DRed 与 FBF 正文未取到，仅书目核验，标 med
class: 存储映射范式 + 硬约束 + 物化判据
raw_report: `D:/src/dsh-oh-my-whale/.agents/research-owl2/REPORT-tbox-mapping.md`（357 行）

### d2b.1 三个范式，三个代价位置

| 范式 | 代表 | 代价落在哪 | 对本项目的判决 |
|---|---|---|---|
| QL 查询重写 | DL-Lite → SQL/Cypher | 重写后的查询**可指数膨胀** | 不能进 250ms 粗召；且 QL「does not support anonymous individuals」→ 选 QL 等于放弃 Skolem |
| RL 前向物化 | OWL 2 RL 规则集 | 存储与写入摊还成本 | 落在事实层与契约层之间，需按谓词分别判 |
| 唯一 LPG 上的 DL-Lite 重写 | ARCO（arXiv:2608.20092, CIKM 2026, Löhnert/Augsten/Okulmus/Ortiz） | 重写完仍是**笛卡尔积** | **重写 <600ms 但求值 2–8s，MMM 5 查 3 超时（20s）** → 只配做精确验证，不能做粗召 |

**ARCO 是唯一一篇把 DL-Lite 搬到 labeled property graph 上的论文**，也是最接近本项目存储形态的先例。它的实测结论对我们是否定的：重写本身不贵，贵的是重写后的连接。这直接否掉了「用查询重写做第 ① 步粗召」的路线。

### d2b.2 RL 里 ∃ 的物化形态：cls-svf1 反向不造节点

OWL 2 RL 的 `cls-svf1` 处理 `∃R.C`：
```
T(?u,?p,?v)  T(?v,rdf:type,?y)  T(?p,rdfs:subPropertyOf,?p1)?  →  T(?u,rdf:type,?x)
```
关键在于：它是**已被断言的 R 边**上做类型提升，**不反向创造成员**。所以 RL 物化不引入存在性个体，这正是 RL 能被 Datalog 实现的原因（d8 结论一致）。

**但对第 ③ 步不成立**：第 ③ 步「未找到实体」的情形正是**没有 R 边**，`cls-svf1` 帮不上。**想靠 RL 物化免掉 Skolem 化是错的**——只有在已经存在见证边时才免。

### d2b.3 增量维护：counting / DRed / FBF 的落地判据

| 方案 | 原始出处 | 实现代价 | 健全性 |
|---|---|---|---|
| counting | 通用 | 最低：`patchPayload(id, {$inc: n})` 是原生原子自增 | **对递归谓词不健全**（计数无法表达「两条路径支撑同一结论」） |
| DRed | Gupta/Mumick/Subrahmanian, SIGMOD 1993, DOI 10.1145/170035.170066 | 纯逻辑，无需额外存储结构 | 健全，但重推会过度（over-delete 后 rederive 全量） |
| FBF | AAAI 2015, pp.1560–1568 | **最高**：需反向索引（derived_from），边数翻数倍；而删边在 triviumdb 里恰是最慢路径 | 健全且精确 |

**建议：非递归谓词用 counting，递归谓词用 DRed。** 不与 FBF 纠缠——我们没有它的写入预算。

**诚实标注**：DRed 与 FBF 的**正文都抓不到**（仅 ACM/AAAI 书目页核验），上面的代价判断来自方案结构推理，不是论文自述数字。

### d2b.4 类层级实测：遍历 vs 物化（二叉树，subClassOf 边）

```
                    遍历           物化闭包边       加速   物化构建代价
N=1000   全后代   15.58ms/q      1.30ms/q         12x    136ms / 7987 边 / 0.92MiB
N=10000  全后代   232.77ms/q     20.60ms/q        11.3x  2432ms / 113631 边 / 11.50MiB
N=10000  祖先     0.160ms/q      0.050ms/q        3.2x   仅省 0.11ms 却要 11.5MiB
```

**两个判决**：
1. **N=10000 时「取全部后代」单条遍历 232.77ms，一条查询直接吃掉整个 250ms 候选预算。** 这不是理论风险，是实测。
2. **祖先查询物化纯亏**：省 0.11ms，花 11.5MiB。祖先方向必须现场遍历。

**自适应判据**：结果集是否达到类层级量级。查询期可用 `numEdges`（入度）做**廉价估计**再决定走哪条路——不需要预知类层级规模。

### d2b.5 triviumdb 六条硬约束（实测，直接改设计）

1. **`dim` 是每个数据库文件的全局属性，不是每节点的。** `insert` 强制校验（「向量维度不匹配: 期望 8，实际 1」），重开也强制，`dim:0` 被拒，`dim:1` 可用。→ **新架构必须先定这件事。**
   - 实测：dim=1536 时每个 class 节点 6379 B（96% 是向量）；dim=1 时 239 B。5000 类：30.42MiB vs 1.14MiB（**26.7×**）。
   - **推荐分两个文件**：`facts.tdb`（dim:1，全部结构与 TBox/ABox）+ `emb.tdb`（dim:1536，纯向量，只有需要语义相似度的节点）
2. **数组型 payload 字段不可索引、不可匹配。** `createIndex("arr")` → `entry_count: 0`；`indexedLookup({arr:"X"})` → `[]`；`FIND {arr:"X"}` → 0 行。标量正常（`{s:"X"}` → `[1,3]`）。
   - 变通：一值一标量字段（`has_X: 1` → `[1,4]` 正常）
   - **这直接破坏了「类成员集合」的自然建模，也证伪了「payload 存祖先数组 + createIndex」这一看起来最直观的方案。**
3. **边 metadata 无二级索引。** `createIndex("conf")` 之后 `indexInfo()` = `{distinct_count: 0, entry_count: 0}`——索引只认 payload。而 Datalog 事实最需要按 ts/src/conf 过滤。
4. **`indexedLookup` 返回 `number[]` 不是行**（d.ts:917）→ 用它做过滤必然 N+1。
5. **TQL 变长 MATCH 有固定 100000 步硬预算且不可配。** 10k 层级实测抛「MATCH 遍历超过 100000 步预算」。而 `reachable()` 的 `maxVisitedNodes`/`maxFrontierSize`/`maxResults`/`maxEdges` **可配**。→ 层级遍历必须走 `reachable()`，不能走变长 MATCH。
6. **literal 不能挂边；triviumdb 无空白节点原语**（每个节点必有 u64 ID）→ 必须 Skolem 化 + `bnode://` 前缀（n10s 先例）。

**第 7 条（语义层，最隐蔽）**：RDF 1.1 Semantics §5.1.1 原文「Taking the union of graphs which share a blank node changes the implied quantifier scopes」→ **跨召回批次复用 Skolem ID 会破坏语义**。必须带 `gen`（证明树/批次 ID）字段做作用域隔离；否则 `(src,dst,label)` 的唯一性会让跨批次重复 `link` **静默变成 no-op，直接丢见证**。

### d2b.6 边 vs 具化节点：不是选哪个，是选对维度

```
                       边                      具化节点              比值
dim=4,  50k 实体   4.08MiB (214B/n) 建105ms   3.75MiB (98B/n) 建257ms   盘 0.92x  写 2.4x
dim=1,  50k 实体   3.85MiB (202B/n) 建122ms   3.29MiB (86B/n)  建249ms   盘 0.85x  写 2.0x
dim=1536, 2k 实体  12.15MiB(96%向量) 建11ms    23.74MiB        建2816ms   盘 1.95x  写 256x
删除方向相反：unlink 19999 条 = 192ms  vs  deleteManyAtomic = 50ms（具化快 3.8x）
```

**判决**：
- **dim=1 时具化节点几乎不花钱**（比边省 15% 磁盘），换来**全字段可索引** + **删除快 3.8×**，代价是写入 2.0×（249ms / 20k 条，可接受）。
- **只有事实必须携带 embedding 时才用边**（边无向量槽），但那时放弃 ts/src/conf 过滤能力。
- **绝不要在 1536 统一文件里具化事实**：写入 256×，96% 磁盘花在永远不会被查的向量上。

### d2b.7 两个映射能否共存：可以，但受 dim 约束

同一 dim=4 文件混放三类节点，用 `kind` 判别 + composite index，全部走索引互不污染：
```
{kind:"datalog:fact"}                FIND → 100 行
{kind:"datalog:fact", rel:"parent"} FIND → 100 行
{kind:"owl:individual", cls:"ex:C3"} indexedLookup → 10 个 id
{kind:"owl:class"}                  FIND → 5 行
```
边用 label 前缀做语义分区（`dl:` / `owl:` / `sk:`）。技术上完全可行。**但受 dim 单值约束，仍推荐分两个文件**——否则要么给纯结构节点付 1536 维的钱，要么让带向量节点无处可放。

### d2b.8 物化判据（回答「内核已算闭包时再物化是否冗余」）

**判据不是「冗余不冗余」，是「闭包要不要跨进程存活」。**

- 进程内内核已算出 → 存储物化是**纯冗余**（双写 + 双份维护 + 两份可能不一致）
- 进程重启后 → **不冗余**：内存闭包全丢，重算 10k 类要 **2432ms**。**这才是物化的真正理由：冷启动成本。**
- 第三条理由：删边比删节点慢 3.8×，闭包边物化会落在 DRed 删除路径最贵的位置。

**推荐判据（三条件同时成立才物化）**：
```
物化(pred) :=  (结果集 ≥ 层级量级)
            ∧ (冷启动重算代价 > 存储+维护代价)
            ∧ (删除频率低)
```
→ **TBox 传递闭包最该物化**（结果集大、几乎不变、删边近似为 0）。**ABox 推导事实最不该物化**（频繁增删、结果集小、重算便宜）。

### d2b.9 SHACL 1.5 的正面结论：契约层用 SHACL 比用 OWL 推理便宜一个量级

SHACL 1.5 原文「full RDFS inferencing is not required」——它的类型判定是**沿 subClassOf 的显式传递闭包**，不是蕴含。→ **契约层用 SHACL，成本从「RL 物化」降到「一次 O(边数) 闭包」**，正好匹配 C4 的「少数核心概念」。

而且 `sh:ValidationReport` / `sh:ValidationResult`（`focusNode` / `resultPath` / `resultMessage` / `sourceShape`）**结构上就是第 ④ 步「信息缺口」的现成产物格式**——不需要自创缺口 schema，直接用它，只需额外挂 d5 设计的 gap 字段。

### d2b.10 图数据库映射的反面先例（n10s / Neptune / TigerGraph）

**n10s（Neosemantics）的四个坑，全部有注释佐证**：
- blank node 降级为 `"bnode://"+id` **普通 URI**——存在量化语义丢失
- **literal 上的 reification 被直接丢弃**，注释原文：「cannot be easily mapped to a PG. Ignore」
- 推理**不是物化**，是现场拼 UNION Cypher + `[*0..]` 变长路径，**无剪枝、无缓存**
- README 自称 experimental
→ **反面教训：把 RDF 语义当「查询期字符串拼接」处理，会同时丢失存在量化、丢失字面量证明、且无法剪枝。** 本项目不能走这条路。

**Neptune**：quad 的第 4 位「it [G] is used to store the edge ID」——正是「边可被再断言」的位置，等价 RDF-star triple term。但该页仅 2238 字符，blank node 零指导。**TigerGraph 零一手材料。**

### d2b.11 RDF-star 判决 + R2RML 的唯一用处

**RDF-star**：CG spec 只有 385 字节跳转页，SPARQL 1.2 正文是 241 字符空壳 → **对 SPARQL-star 语法不做任何断言**。可用的只有 RDF 1.2 Concepts 的 triple term + reifier（已进 REC 轨道）。
**结论：triviumdb 的「边 + metadata」已经等于「triple term + 内联 reifier」，比 RDF reification 省一个量级，不需要 RDF-star 建模。**

**R2RML 唯一值得抄的一点**：`rr:template` 的**确定性 ID 生成**思想——Skolem / ABox ID 必须模板生成、不能自增，才能幂等 + 去重。
另外两条规范依据有用：`rr:BlankNode` 是「W3C 认可存在量化映射」的唯一依据；§9.1「An R2RML-generated blank node can never be shared by two triples in two different graphs」= **作用域边界的规范出处**（与 d2b.5 第 7 条互补）。

---

## d10. 记忆分层与提炼管线的真实先例（A1 三项的直接依据）

source: 论文全文（arXiv/ar5iv）+ PubMed E-utilities + 各产品官方文档一手页面
publisher: APA / Stanford+Google / UC Berkeley / Zep AI / Microsoft Research / Mem0+UCSD / Databricks / Confluent / Letta / W3C / schema.org
pub_date: 1995-07 至 2025-04；living doc 无固定日期
accessed: 2026-11-25
confidence: high（论文与文档均取原文）；负面结论已逐字检索确认
class: 分层先例 + 提炼管线 + 提升触发条件的空白证明
digest: `digests/d10-memory-layering.md`（152 行）；完整报告 `docs/research/memory-layering-precedents.md`（258 行）

### d10.1 层数校准：没有任何单进程系统做到 4 层以上

| 系统 | 层数 | 分层依据 | 出处 |
|---|---|---|---|
| CLS（互补学习系统） | 2 | 学习速率（海马快 / 皮层慢） | Psych. Review 102(3):419-457, 1995-07, PMID 7624455 |
| Generative Agents | 2 | memory stream（平铺流）+ reflection | arXiv:2304.03442 v2 2023-08-06 |
| MemGPT / Letta | 2 | OS 隐喻：main vs external context | arXiv:2310.08560 v2 2024-02-12 |
| Zep / Graphiti | 3 | episode / semantic entity / community | arXiv:2501.13956 v1 2025-01-20 |
| GraphRAG | 多级但**单一轴** | Leiden 模块度 | arXiv:2404.16130 v2 2025-02-19 |
| Mem0 | **实际 1 层（平的）** | 只有 ADD/UPDATE/DELETE/NOOP，无层 | arXiv:2504.19413 v1 2025-04-28 |
| medallion | 3 | bronze/silver/gold，**无量化门槛** | docs.databricks.com（living doc） |

**层数与语义丰富度无关，与「写规则有几种」强相关。** 这是本项目把层数压在 3 层（2 层承重）的直接依据。

### d10.2 CLS：给的是分层的**理由**，不是分层的结论

原文：「memories are first stored via synaptic changes in the hippocampal system, that these changes support reinstatement of recent memories in the neocortex, that neocortical synapses change a little on each reinstatement, and that remote memory is based on accumulated neocortical changes」；「The hippocampal system permits rapid learning of new items without disrupting this structure」。

→ 单层统一学习率必然二选一：学得慢（保结构、丢近期）或学得快（保近期、毁结构）。**这正是「事实层（高频写改）」与「契约层（极少改动）」必须分开的理由，不是审美理由。**
**但 CLS 本身没有给出「什么条件下一条记忆升级到语义层」的判据**——这个空白一直延续到今天的工程系统。

### d10.3 真实存在的「升级触发条件」只有四类，全是单调可判定量

| 触发机制 | 原文措辞 | 系统 | 性质 |
|---|---|---|---|
| 累积重要性阈值 | 「when the sum of the importance scores for the latest events perceived by the agents exceeds a threshold (150 in our implementation)」 | Generative Agents | 单调累加，写入时递增、触发后清零；实际每天反思 2–3 次 |
| 容量压力阈值 | 「When the prompt tokens exceed the warning token count ... (e.g., 70% of the context window)」；超 100% 时 flush 并驱逐约 50%，用旧 recursive summary 生成新 summary | MemGPT | 资源水位，与语义无关 |
| 图结构（模块度） | Leiden 社区检测，Level 0 = 最大模块度划分 | GraphRAG / Zep | 结构涌现，非计数 |
| 契约兼容性门禁 | 「checks compatibility before accepting the new version」；默认 BACKWARD；四类 Backward/Forward/Full/Transitive | Confluent Schema Registry | **唯一机器可判定、拒绝即发布失败的同步门禁** |

**这四类的共同点（本节最重要的发现）**：全部是写入时或离线批处理时**可由机器单调判定的量**——一个累加分数、一个字节水位、一个图划分、一次 schema 兼容比较。**没有一个是「依赖历史分歧统计」或「依赖人工事故复盘」的。**
原因（推断）：只有单调、可增量维护的量才能放进写入热路径。「第 M 次分歧」需要全量扫描定义历史，「事故后补」需要人的判断——二者都无法自动化，所以成熟系统干脆不做自动提升，改为人工评审（Confluent 的 schema change review 是流程，不是算法）。

### d10.4 核心负面结论：提升触发条件在工业界**根本不作为算法存在**

在 12 个一手来源里逐字检索，**没有任何一个系统或规范写出过**以下三类触发条件中的任何一类：
- 「某概念被第 N 个消费者引用」→ **没找到**
- 「同一概念出现第 M 次定义分歧」→ **没找到**
- 「发生过一次生产事故后补上契约」→ **没找到**（Confluent 是**事前**强制，无「事故驱动」措辞）

**这不是检索不足——从机制上说得通**：这三类条件都需要「多个独立写入方 + 可统计的分歧计数」这项能力，而检索到的系统里**没有一个具备这个概念**（Graphiti 有 dedup 但没有分歧计数；Mem0 有 ADD/UPDATE/DELETE 但没有版本化定义；medallion 靠人工判断）。

### d10.5 与 C4 的直接冲突：C4 在 DSH 里几乎永不触发（**须用户裁定**）

- **「被多个系统争用」的前提是多个独立写入方。** DSH 是单进程单用户，写入方是**代码模块**（技能、工具适配器、插件），不是组织。数量个位数到十几个，且随代码发布**离散变化**——「第 N 个消费者」在这里可以**静态查出来**，不需要运行时计数。
- **「定义不一致导致生产故障」的前提是有生产。** 单用户场景下故障形态是「助手记错了」，代价低、可当场纠正，不构成契约化的经济理由。
- **判决：若照搬 C4 三条件，在 DSH 里它几乎永不触发；若据此建一整层 OWL，就是在为零次提升建基础设施。**

**替代判据（memory-layering 自拟，无先例，须标注为自研）**——一个概念**才有资格**进契约层，需同时满足：
- **C1 双写方**：至少 2 个**独立代码路径**断言它（如「技能写记忆」与「工具适配器写记忆」各一份）。判据从「N 个消费者」改为「≥2 个独立写方」——单用户场景下可静态枚举。
- **C2 可判定不变量**：存在一个**能在 <5ms 内算完的确定性检查**，只判「结构合法」不判「语义正确」。直接来自 Confluent：能机器判定的才进门禁。
- **C3 失败代价 > 检查代价**：写错会让召回给出**错误**结论（而非仅仅少召回一条）。若代价只是「少记一条」，留在事实层。

**不满足 C2 的概念，一律不允许进契约层。这是防止契约层膨胀成「第二套业务逻辑」的唯一硬闸。**
另加两条运维纪律：**契约层变更必须版本化 + 兼容性检查**（照抄 Confluent 的 BACKWARD 默认），不能热改；**提升是人工动作，不是自动动作**。

### d10.6 提炼管线的真实阶段划分

| 系统 | 同步（写入时） | 异步（后台/离线） | 二者如何共处 |
|---|---|---|---|
| Mem0 | extraction（每轮新消息对触发）、ADD/UPDATE/DELETE/NOOP 判定 | 无明确异步阶段 | —— |
| Generative Agents | importance 打分（创建时同步，LLM 按 poignancy 给 1–10） | reflection（阈值 150 触发） | 异步产物**回写同一 memory stream**，与同步产物同层同构，**不分表** |
| MemGPT | LLM function call 触发的显式迁移 | 队列 flush / recursive summary（token 压力触发） | 同一存储，靠容量水位切换 |
| GraphRAG | 无（纯离线索引） | 全流程离线：分块→抽取→Leiden→摘要 | 索引与查询彻底分离 |
| Zep/Graphiti | episode 追加（无损） | 实体/边抽取、社区摘要 | 双时间轴 T/T-prime 让异步滞后可被解释 |
| Letta | 正常对话 | background subagents 巩固（Dreaming），触发条件「after a set number of completed agent steps or when the context window is compacted」 | 后台不阻塞前台 |

**Zep 的成本控制手段值得直接抄**：写入期去重约束原文「The hybrid search for relevant edges is constrained to edges existing between the same entity pairs as the proposed new edge」——**把 O(n²) 降为按实体对局部搜索**。

**Mem0 四操作原文**：「ADD for creation of new memories when no semantically equivalent memory exists; UPDATE for augmentation of existing memories with complementary information; DELETE for removal of memories contradicted by new information; and NOOP when the candidate fact requires no modification to the knowledge base.」→ **有显式 supersede/contradict 语义，但完全没有「提升到契约层」的概念**。

**第二个负面结论：没找到任何系统在一条管线里同时做「LLM 摘要/聚类」和「规则校验/推理」并记录二者如何共处。** 这是要自创的部分。
可行分工（推断）：**统计式提炼产出候选，符号式校验只做否决、不做生成**（它是 assert 之前的 guard，不是同级步骤）。理由：符号校验器的强项是可判定、可解释、快，弱项是没有生成能力；让它只回答 yes/no 就不必承担它做不到的事。

### d10.7 GraphDB 主动裁规则：契约层必须预设「哪些规则我们不跑」

GraphDB 自述全量物化代价：「the repository uses configured rulesets to compute all inferred statements at load time. To some extent, this process increases the processing cost and time taken to load a repository with a large amount of data.」

**两条主动放弃（本节最可直接借用的工程判断）**：
- 全称类展开：「Not supported. Even if this infinite expansion were possible in a forward chaining rule-based implementation, the resulting statements are of no use during query evaluation.」
- 由 disjoint 推 `owl:differentFrom`：「Impractical for knowledge bases with many members of pairs of disjoint classes such as Wordnet. Instead, this is implemented as a consistency check」

→ **连专门做推理的商业引擎都认为「把闭包全算出来」有两类规则不值得跑。** 契约层要做推理，**必须预设「哪些规则我们不跑」并写进文档**，否则性能预算必然破。
GraphDB 还把「Retraction of assertions」「Provenance」「Reinferring」列为正式章节 → **成熟 RDF 引擎把撤销/重推/溯源当一等公民，而非事后补救**（与 d3a 的 scoped negative deltas 同向）。

### d10.8 反例：只有事前自我约束，没有事后复盘（证据强度须知情）

- **schema.org** 明确否认自己是全局本体：「The type hierarchy presented on this site is not intended to be a global ontology of the world.」并承认为实用性放弃更严约束：「The decision to allow multiple domains and ranges was purely pragmatic. While the computational properties of systems with a single domain and range are easier to understand, in practice, this forces the creation of a lot of artificial types」
- **GraphDB 主动裁规则**（d10.7）。
- **medallion 明确标注**「Following the medallion architecture is a recommended best practice but not a requirement」——**即允许不分层**。

**诚实说明：想找的「某团队把整个领域建成 OWL 本体、维护成本失控、最终回退」这类复盘帖，没找到。** 用规范的自我克制当反例是**间接证据、强度弱**——它只证明「专家不主张全局本体」，不证明「全局本体必然失败」。这个证据缺口须在决策时知情。

### d10.9 过多分层的四条具体代价（不是套话）

1. **失效传播成本按层数乘**：supersede 一条事实必须让所有上层摘要/契约相关缓存失效。GraphRAG/Zep 都因此必须做社区重建（一次编辑触发一个社区重算）。层越多，每次写入的摊还成本越高——**而 DSH 写入是高频的**。
2. **闭包重算超线性**：递归规则下加一条事实可能触发大量新推导；GraphDB 因此把代价挪到 load time。**我们没有 load time，只有热路径。**
3. **契约漂移（dead schema）**：没有任何写入方真的被它约束的契约层会退化成注释文档——**最可能的失败形态，且静默失败**。
4. **同一概念两份定义**：事实层的规则和契约层的约束如果对同一概念各说一套，就**制造了我们本来想消灭的那个 bug**。这是 4 层以上系统最典型的自伤。

### d10.10 三条硬理由：第三层不能用 OWL 全量推理

1. **GraphDB 的教训直接适用**：连专门的商业推理引擎都要主动裁规则，因为 total materialization「increases the processing cost and time taken to load a repository with a large amount of data」。DSH 没有 GraphDB 的优化预算，却有更严的 1000ms 上限。
2. **schema.org 的先例**：连需要服务全网的系统都明确拒绝做「a global ontology of the world」。单用户 Agent 没有理由比 schema.org 更严格。
3. **RL 的复杂度保证是「可算」，不是「够快」**：PTIME-complete 在十万条事实、递归规则、每轮热路径下是否满足 250ms 候选生成，**规范没有回答**。任何声称「OWL 2 RL 一定满足 1000ms」的结论都是外推，不该写进设计文档。

### d10.11 分层建议（直接对应 A1 第 ① 项）

```
L0  情景日志     append-only、无损。现有 session log 已经是这一层，不要新建存储。
L1  事实基 + 规则 Datalog 事实与规则。所有修订（supersede / 收缩 / 推理）在此发生。承重。
L2  语义契约     ≤10 个概念的封闭不变量检查。只做否决，不生成。承重但极小。
```
**两层承重，第三层封顶可选。** 再往上第四层在检索到的先例里没有成功案例（d10.1）。

### d10.12 诚实标注

**明确没查到（负面结论，已尽力检索）**：
1. 没有任何一手来源记录「被 N 个消费者引用」「第 M 次定义分歧」「事故后补契约」这三类提升触发条件。d10.3 给出的是最接近的替代机制，**不是等价物**。
2. 没找到「整层本体化后失败并公开复盘」的一手事例。d10.8 用 schema.org 与 GraphDB 的事前自我约束充当间接证据，**强度弱于复盘**。
3. 没找到「管线过长导致失败」的一手复盘。只有 GraphDB 对加载成本的量化自述与主动裁规则两条间接证据。
4. 没找到任何系统在一条管线里同时做统计式提炼与符号式验证并记录二者如何共处。d10.6 的分工是**推断，无先例**。
5. HippoRAG（arXiv:2405.14831）只核实到元数据（v3, 2025-01-14），未取到支撑分层的正文，**未作为证据使用**。

**不确定 / 证据强度**：
6. OWL 2 Profiles 的 REC 日期 2012-12 标 med（抓取片段未含日期行）。
7. schema.org / Databricks / Confluent / GraphDB / Letta 均为 living doc，**无固定 pub_date**，只标 accessed=2026-11-25。
8. Letta 只取到片段（正文被截断），Dreaming 的完整机制只有两句原文，其余为外推，标 med。
9. **GraphRAG 的索引成本没有量化数字**：论文与官方页面都未给出成本论述。任何「GraphRAG 索引太贵」的说法无法引证。

**外推（不得当作规范/论文结论引用）**：
10. 「Datalog 的 why-provenance 能直接回答『去掉哪条事实结论就不成立』」——本次未引到 provenance semiring 的一手来源。
11. 「符号校验器应只做否决不做生成」——分工建议，无先例。
12. 「OWL 2 RL 在十万条记忆、1000ms 预算内可行」——**没有证据支持，也不主张**。设计文档不应写「已验证可行」。
13. d10.5 的 C1/C2/C3 判据是**为 DSH 新拟**的，不是从任何来源抄来。C2 的 <5ms 阈值按写入热路径常识给出，**未经实测**。

**方法学**：
14. web_search 在本 session 不可用（60s 超时，一次即失败）。所有证据来自 pwsh + Invoke-WebRequest 直连一手页面（arXiv API / ar5iv 全文 / W3C / 官方文档），**未经过搜索引擎的二手摘要**。
15. Crossref 429、doi.org SSL 失败，故 CLS 论文元数据经 PubMed E-utilities 核实（PMID 7624455）。
16. 被拒/无正文来源（列出以免重复踩坑）：SweetTools/SWEET wiki（空正文）、gocardless.com/blog/data-contracts/（404）、confluence.ihtsdotools.org（SSL 失败）、docs.snomed.org/specifications/SNOMED-CT-OWL（空正文）。


## d1. OWL 2 四 profile 的能力边界与契约层选型（一手规范逐条核对）

> 一句话：**只有 OWL 2 RL 同时满足「PTIME」「能做一致性检查」「能直接跑在 Datalog 上」三条**，因此契约层锁 RL 子集，DL/EL/QL 全部出局。

### 1.1 复杂度总表（Table 10 原文数字，本轮复核）

| 语言 | 一致性/可满足/包含/实例检查 | CQ 回答（taxonomic / data / query / combined） |
|---|---|---|
| OWL 2 Full（RDF-Based） | **Undecidable** | Undecidable |
| OWL 2 DL（Direct, SROIQ） | **N2EXPTIME-complete**（property hierarchy 可转多项式 NFA 时 NEXPTIME） | **Decidability open** |
| OWL 2 EL | PTIME-complete | in EXPTIME / PTIME-complete / NP-complete / in EXPTIME |
| OWL 2 QL | NLogSpace-complete（data **In AC0**） | NLogSpace / In AC0 / NP-complete / NP-complete |
| OWL 2 RL | PTIME-complete（**combined 为 co-NP-complete**，atomic 类表达式时 PTIME） | PTIME / PTIME / NP-complete / NP-complete |

**两个容易读错的格子**：
- **DL 的 CQ 回答可判定性是 open，不是某个复杂度类。** 把 DL 放在校验/查询路径上 = 把系统挂在未解问题上。
- **RL 的 combined 复杂度是 co-NP-complete**，只有 atomic 类表达式才 PTIME。→ 契约层 TBox 的类表达式必须控制成「原子类 + 少量交/存在」，不要深度嵌套。

### 1.2 构造子支持矩阵（逐条核对规范）

| 构造子 | DL | EL | QL | RL | 建议落点 |
|---|---|---|---|---|---|
| SubClassOf | 是 | 是 | 是 | 是 | **RL 契约层** |
| 交集 ⊓ | 是 | 是 | 是（superclass 侧） | 是 | **RL 契约层** |
| 存在 ∃R.C | 是 | 是 | subclass 侧仅 ∃R.Thing | 是 | **RL 契约层** |
| 全称 ∀R.C | 是 | **否** | superclass 侧 | superclass 侧 | RL（受限） |
| 基数 Min/Max/Exact | 是 | **全禁** | **全禁** | **仅 Max 0/1** | RL 仅 0/1；≥2 下沉 SHACL/Datalog 聚合 |
| 析取 ⊔ | 是 | **否** | **否** | subclass 侧仅向上推 | **不进契约层** |
| 否定 ¬ | 是 | **否** | superclass 侧 | 仅补集冲突检测 | **不进契约层**；走三态 |
| 逆属性 | 是 | **否** | 是 | 是（prp-inv1/2） | **RL 契约层** |
| 属性链 | 是 | 是 | **否** | 是（prp-spo2） | **RL 契约层** |
| 传递 | 是 | 是 | **否** | 是（prp-trp） | **RL 契约层** |
| 对称 | 是 | **否** | **否** | 是（prp-symp） | **RL 契约层** |
| DisjointClasses | 是 | **是** | 是 | 是（cax-dw） | **RL 契约层**（证伪燃料） |
| HasKey | 是 | 是 | **否** | 是（prp-key） | RL 可选 |
| 时间有效性 | 无原生 | 否 | 否 | 否 | **Datalog 事实层 + n-ary 具体化** |

**两处必须更正的常见误读**：
- **EL 支持 DisjointClasses**（规范原文），它禁的是 disjoint **properties**。
- EL 禁用 xsd:double/float/有界整型，理由原文「The set of supported datatypes has been designed such that the intersection of the value spaces of any set of these datatypes is either empty or infinite」——为保住多项式判定。

### 1.3 为什么「要 cardinality + disjunction + inverse 就必须 DL」只有一半对

- **inverse**：RL 与 QL 都有，不贵。
- **cardinality**：RL 只有 max 0/1；要 ≥2 或 =n，RL/EL/QL 全出局，只剩 DL。
- **disjunction**：RL 只在 subclass 侧允许，**只能从「是某成员」推「是并集」，不能从「不是 c1 也不是 c2」推「不是 c」**。要完整析取推理只剩 DL。

**DL 的四项代价（逐项）**：
1. N2EXPTIME-complete。不是「慢一点」，是理论层面不可用。
2. **必须实现 SROIQ 全部全局限制**，否则连可判定性都没有：
   - *simple object property*：不能是 top/bottom、不能出现在 property chain(n>1)、不能 transitive；规范原文「Roughly speaking, a simple object property expression has no direct or indirect subproperties that are either transitive or are defined by means of property chains」
   - *Restriction on Simple Roles*：Min/Max/ExactCardinality、HasSelf、Functional、InverseFunctional、Irreflexive、Asymmetric、DisjointObjectProperties **只能作用于 simple object property**，「This restriction is necessary in order to guarantee decidability」
   - *Restriction on the Property Hierarchy*：属性链须满足严格偏序（防循环定义），同样「necessary in order to guarantee decidability」
3. **CQ 回答可判定性 open**：连「查询会不会停」都没有保证。
4. 必须自写 SROIQ tableau，单进程约束下不能外挂。

→ **simple role 是全局性质**：任何一条新公理都可能让整个本体非法。这意味着每次写入都要做全局限制检查。典型过度工程化。

### 1.4 OWL 2 RL 规则集：78 条，6 张表

| Table | 主题 | 条数 | 规则名 |
|---|---|---|---|
| 4 | 相等性 | 9 | eq-ref, eq-sym, eq-trans, eq-rep-s, eq-rep-p, eq-rep-o, eq-diff1, eq-diff2, eq-diff3 |
| 5 | 属性 | 20 | prp-ap, prp-dom, prp-rng, prp-fp, prp-ifp, prp-irp, prp-symp, prp-asyp, prp-trp, prp-spo1, prp-spo2, prp-eqp1, prp-eqp2, prp-pdw, prp-adp, prp-inv1, prp-inv2, prp-key, prp-npa1, prp-npa2 |
| 6 | 类 | 19 | cls-thing, cls-nothing1, cls-nothing2, cls-int1, cls-int2, cls-uni, cls-com, cls-svf1, cls-svf2, cls-avf, cls-hv1, cls-hv2, cls-maxc1, cls-maxc2, cls-maxqc1..4, cls-oo |
| 7 | 类公理 | 5 | cax-sco, cax-eqc1, cax-eqc2, cax-dw, cax-adc |
| 8 | 数据类型 | 5 | dt-type1, dt-type2, dt-eq, dt-diff, dt-not-type |
| 9 | schema 词汇 | 20 | scm-cls, scm-sco, scm-eqc1, scm-eqc2, scm-op, scm-dp, scm-spo, scm-eqp1, scm-eqp2, scm-dom1, scm-dom2, scm-rng1, scm-rng2, scm-hv, scm-svf1, scm-svf2, scm-avf1, scm-avf2, scm-int, scm-uni |

**决定性事实：对规则区 grep `naf|negation.as.failure|stratified|stratification` 返回 0 命中。** RL 规则集是**纯 Horn 一阶蕴含式 + 一个 false 常量**，不含任何否定即失败。→ **Datalog 内核不需要实现分层否定就能跑 RL。**

### 1.5 RL 的五个明确不覆盖

1. **不做完整析取**。cls-uni 只从成员向上推类型。
2. **不做完整否定**。cls-com 的互补**只用来报冲突**，不产生新类属。
3. **基数只有 0/1**。文法 `zeroOrOne := 0 | 1`；没有 min、没有 exact、没有 ≥2。
   - **cls-maxc2（max 1）是靠推 `owl:sameAs` 实现，不是靠失败**——这是极容易误解的一点。
4. **不推「不存在个体」**：设计目标明写「avoid the need to infer the existence of individuals not explicitly present in the knowledge base, and to avoid the need for nondeterministic reasoning」。
5. **不含 RDF/RDFS 公理三元组**：规范明说为避免性能问题不包含，且只含「most, but not all」RDFS 蕴含规则；实现 MAY 自行加入。

**Theorem PR1 三条件**（完备性前提）：①无 punning（同一 IRI 不兼作多类实体）②O1 不含 SubAnnotationPropertyOf / AnnotationPropertyDomain / AnnotationPropertyRange ③O2 每条公理都是 ClassAssertion / ObjectPropertyAssertion / DataPropertyAssertion / SameIndividual。
→ **完备性只对断言成立，不覆盖 TBox 公理蕴含，不覆盖 CQ。** 超出句法约束的图上 sound but incomplete。

### 1.6 RL 的一致性检查：78 条规则中恰好 17 条 false 头（已逐行复核定稿）

规范原文：「The propositional symbol false is a special symbol denoting contradiction: if it is derived, then the initial RDF graph was inconsistent」。

**名单（已对规范 Table 4–9 逐行解析复核，最终定稿）**：
```
eq-diff1, eq-diff2, eq-diff3, prp-irp, prp-asyp, prp-pdw, prp-adp,
prp-npa1, prp-npa2, cls-nothing2, cls-com, cls-maxc1, cls-maxqc1,
cls-maxqc2, cax-dw, cax-adc, dt-not-type
```

**复核方法**：把规范 HTML 按 `<tr>` 切行、逐单元格去标签，用容忍双连字符的规则名正则 `^(eq|prp|cls|cax|dt|scm)-[a-z0-9]+(-[a-z0-9]+)*$` 匹配首列取规则名，再判该行是否有单元格恰为 `false`。结果 **78 条具名规则 / 17 条 false 头**，分布：eq 9、prp 20、cls 19、cax 5、dt 5、scm 20。

⚠ **此前 d1 把第 17 条记成 `dt-diff` 是错的，现更正为 `dt-not-type`**。规范 Table 8 原文：
- `dt-diff` 的结论是 `T(lt1, owl:differentFrom, lt2)`，**不是 false**（不同数据值推 differentFrom，是正向推导）
- `dt-not-type` 的结论才是 `false`，条件「for each literal lt and each datatype dt supported in OWL 2 RL such that the data value of lt is not contained in the value space of dt」
- 同理 `dt-type2` 结论是 `T(lt, rdf:type, dt)`（值域内）。→ **dt 表正负成对：值域内推类型/differentFrom 为正，值域外触发 false。**

**计数教训**：第一版正则漏掉了带双连字符的规则名（`eq-rep-s`、`eq-rep-p`、`eq-rep-o`、`dt-not-type`），得到 74/16 的错数。相差的 4 条正好全是双连字符名 —— 这类「数量对不上」几乎总是正则漏字符类，而不是规范版本差异。

**对照 EL**：ELK 论文脚注原文「The ontology and concept consistency problems are, in fact, trivial in EL since this language is too weak to express inconsistencies.」OWL 2 EL 虽含 owl:Nothing，但**无否定与全称，无法用「冲突」方式检测不一致**。→ **17 条 false 规则是 RL 相对 EL 的决定性优势**，直接决定第 ② 步「证伪」能否落地。

### 1.7 混合策略的文献支持：DL 离线，轻量在线

**TrOWL（ESWC 2010）是最直接的证据，但准确说法不是「DL 做 schema 校验」**：
- 动机：「OWL-DL 最坏 NExpTime，OWL 2 是 2NExpTime；三 profile are PTIME-complete or better; however, these profiles all greatly restrict the expressiveness」
- QL 方向（Quill）：对无 non-distinguished 变量的 CQ **结果也是 complete**
- EL 方向（REL）：近似线性时间，「overall complexity for OWL2-DL ontologies can be reduced to PTime. Although known to be incomplete, our evaluation shows that REL can classify existing benchmarks very efficiently with high recall (over 95%)」
- 查询重写爆炸量化：「Using the standard query rewriting algorithm PerfectRef over a deep class or property hierarchy can result in a set of hundreds or thousands of conjunctive queries, where our method will only ever result in a single query」

→ **文献支持的是「DL 建模 → 近似 → 轻量推理」，不是「DL 做运行时校验」**：TrOWL 是**离线**做 DL 一致性检查、**在线**只用近似后的轻量语言。把 DL 放在校验路径上等于把系统挂在一个 open problem 上。

### 1.8 DL-safe rules 与 Abduction 的可判定性（直接约束第 ③ 步）

**SWRL W3C 自认不可判定**：「It is easy to see that OWL DL becomes undecidable when extended in this way as rules can be used to simulate role value maps」。safety 条件「only variables that occur in the antecedent of a rule may occur in the consequent」；且 safety「does not, in fact, restrict the expressive power of the language」。

**DL-safe 的正确定义**（Motik/Sattler/Studer, ISWC 2004）：「A rule r is called DL-safe if each variable in r occurs in a non-DL-atom in the rule body.」直觉：每个变量只能绑定到 **ABox 中显式出现的个体**。

**决定性的一条（对第 ③ 步）**：一阶语义 vs 最小模型语义「对**正** ground atom 两者等价；对负 atom 或概念包含则不同」。原文「equivalence of general programs under minimal model semantics is undecidable [27] whereas, under first-order semantics, it is decidable and can be reduced to satisfiability checking」。
→ **「最小 delta」若定义为「在一阶语义下使查询被蕴含的最小事实集」则可判定；若定义为「最小模型」则不可判定。设计文档必须写死一阶语义，否则 abduction 步骤没有终止保证。**

**EL abduction 的复杂度是 open**（arXiv:2205.08449 原文）：「The theoretical worst-case complexity of connection-minimal abduction is another open question. Our method only gives a very high upper bound ... double exponentially many clauses in the worst case, which would give us a 2ExpTime upper bound ... We have not looked yet at lower bounds.」
→ **不能承诺「找到最小 delta」**。必须三限：限定 delta 大小 |Δ| ≤ k、限定谓词签名（arXiv:2007.00757）、限定深度。工程实现建议 = 「在已物化闭包上找最短未满足子目标链」，即把 RL 规则 body 当缺口模式做反向查询（magic-set / SLD），PTIME。

### 1.9 【最关键】RL 的开放世界缺口：契约层必须补三态

RL 设计目标明写「avoid the need to infer the existence of individuals not explicitly present in the knowledge base」。这意味着：

> **在 RL 语义下，「没有证明 P」和「证明 ¬P」是两件完全不同的事。前者是开放世界的默认状态。**

第 ② 步要求「分别做实体查询与断言的证实/证伪」。**RL 只能给「证实」（推出断言）和「不一致」（推出 false）。「证伪」需要额外的封闭世界机制。**

**建议 payload 三态结构**：
```
{ assertion: "omw:hasRole",
  status: "asserted" | "absent" | "refuted",
  scope: "session:abc123",              // absent 的作用域，必须显式
  derivedBy: ["prp-inv1", "scm-sco"],   // 证明树 = RL 规则名序列
  evidenceRefs: ["m00421", "m00428"] }
```
**三条设计规则**：
1. **absent 必须带 scope。** 没有 scope 的 absent 就是「全知封闭世界」，长会话里会迅速变成错误。
2. **refuted 只能由 17 条 false 规则之一产生，不能由「查不到」升级而来。**
3. **证明树就是 RL 推导树。** Theorem PR1 的证明思路正是「对推导树做变换」→ Datalog 求值 trace **天然就是形式化证明**，不需要额外造证明对象。

### 1.10 契约层选型的最终判决

**用 OWL 2 RL 子集作契约层，不用 DL/EL/QL。** 唯一同时满足「PTIME」「能做一致性检查」「能直接跑在 Datalog 上」的选项。

**四条 schema 硬约束**：
1. **禁 punning**：概念 IRI 与实体 IRI 必须用不同命名空间（Theorem PR1 条件①，也是 RL 完备性前提）。
2. **契约层 TBox 只允许**：类层级、⊓、∃、domain/range、DisjointClasses、Transitive/Symmetric/Inverse、属性链、max 0/1 基数、HasKey。
3. **契约层不允许**：≥2 基数、完整析取、完整否定。这三样下沉到 SHACL 或 Datalog 分层规则。
4. **时间有效性用 n-ary 具体化**（W3C SWBP Note Pattern 1），**不要用 RDF reification**（规范明确不建议）；时间推理放 Datalog 事实层，不进契约层。

**SHACL 的定位（三条）**：
- **只做 closed-world 形状校验，且必须跑在 RL 物化闭包之后**（单向管线）。sh:entailment 允许预计算闭包（原文「either pre-computed before being submitted to a SHACL processor or performed on the fly」），SPARQL 侧亦确认 RL 检查器吃 OWL 2 Full 图。
- `sh:entailment` 的值只要求是 IRI（措辞是「Common values for this property are covered by [sparql11-entailment]」），**不是「MUST be from」**→ 自造 IRI（如 `omw:RLClosure`）合规；但不支持的 IRI **MUST signal a failure**。
- **SHACL 与 OWL 的冲突没有规范裁决规则（查不到）**→ 冲突作为「信息缺口」上报，不自动裁决。

**SHACL 的两个坑**：①**无终止性保证**——执行算法只覆盖「a single iteration over all rules」，需自加迭代上限；②**执行顺序语义很弱**——同 sh:order 的规则互相看不到对方的新推断，不要指望链式推理。

### 1.11 相对「OWL 覆盖全库」省掉的钱（带数字）与照旧的成本

**省掉（7 项）**：SROIQ 全局限制检查（simple role 定义 + regularity 偏序 + typing constraints）；N2EXPTIME 推理降为 PTIME；punning 处理反向变「禁 punning」更简单；DL-safe rules 的 nominals NExpTime 跳变；PerfectRef 查询重写爆炸（「hundreds or thousands」条 CQ）；启动时间（**ELK 分类 SNOMED CT 约 300,000 概念仅 5 秒** → 我们几十到几百条公理是微秒级）；重型工具链（不需要 OWL API / HermiT / Pellet / ELK，不需要第二进程）。

**照旧（5 项）**：
1. **ABox 规模仍是瓶颈**：RL data 复杂度 PTIME 但 join 代价随记忆量增长。10 万条边全量物化在单进程是**秒级不是毫秒级** → 必须增量物化。
2. **eq-rep-* + prp-spo2 的组合爆炸**：稠密图上产生大量冗余推导 → 必须并查集 + 去重。**eq-rep-* 必须建在 sameAs 并查集上，不能当普通 join。**
3. **开放世界的证伪缺口仍在**：OWL 语义本质，不是实现问题；三态设计是唯一出路。
4. **abduction 理论复杂度 open**：只能有界近似。
5. **RL 完备性只覆盖断言**：TBox 蕴含与 CQ 不在保证内；类可满足性/包含检查需另行实现，且 combined 是 co-NP-complete。

### 1.12 诚实标注（查不到 / 存疑）

1. **SHACL 与 OWL 语义冲突的裁决规则**——规范中查不到。只规定 sh:entailment 的失败语义，不规定与 OWL 蕴含冲突时谁赢。
2. **OWL 2 DL 的 CQ 回答复杂度**——Table 10 标为 **Decidability open**，不是某个复杂度类。
3. **EL abduction 的下界**——论文自称「We have not looked yet at lower bounds」。
4. **RL 规则集是否覆盖全部 RL 语义**——规范自称 partial axiomatization，且明说不保证完备。
5. **OWL-Time 成熟度**——取到的是 Candidate Recommendation Draft 2022-11-15，**非 REC**；生产用需自行评估。
6. **「RL 需要分层否定」这一说法规范不支持**（已 grep 0 命中）。**若任何既有文档里写了这条，应改掉。**
7. ~~false 头规则第 17 条到底是 dt-diff 还是 dt-not-type~~ → **已复核定稿为 `dt-not-type`**（见 §1.6 复核方法）。d1 首版记错、已完成更正，d8 与 research.md 原本正确。
8. **DL 下「记忆库 schema」的可行性论证查不到**——没有任何文献把完整 OWL 2 DL 用于运行时记忆/召回；所有分层证据都是「DL 离线、轻量在线」。

## d4. 溯因与最小 delta：可判定性、最小性形式与工程搜索（d4 digest 摘要）

### 4.1 结论先行

溯因（第③步）是整个五步管路里唯一昂贵的环节，但在 RL/EL 片段里它是 **P-complete**，不是不可判定。**通用 ALC 上的 ABox 溯因是半可判定的**，成因单一且明确：假设可以无限引入新个体名。**用 schema 换可判定性**——把假设池限定为「预先声明的谓词 + 已有个体、不许新造个体」（signature-based abduction），最小性检查立刻变成双向可判定。这正是本项目相对通用溯因系统的结构性优势：契约层已经限定了词汇表。

### 4.2 复杂度：按 DL 片段分档（Koopmann IJCAI-21 Thm 3）

| 片段 | ABox abduction（Flat L） | 备注 |
|---|---|---|
| EL | **P-complete** | 契约层主战场 |
| EL++ | EXPTIME-complete | 一旦加 role chain 就跳档 |
| ALCI | coNEXPTIME-complete | |
| ALCF | **不可判定** | 功能性属性 + 溯因 = 不可判定 |

与研究初期「溯因不可判定、不能做」的判断相比，这是关键修正：**在选定的片段里它是多项式时间可解的**。反过来，ALCF 那一行是硬警告：`FunctionalObjectProperty` 一旦出现在契约层且参与溯因搜索，可判定性就没了。d8 的 `prp-fp` 规则（推 `owl:sameAs`）本身没问题，问题在把它交给溯因去补。

### 4.3 半可判定的成因与三个工程出口

Klarman/Endriss/Schlobach（JAR 2011）原文：**minimality checking remains in the worst case a semi-decidable procedure, guaranteed to output the answer in finite time only if the answer is negative**。意思很具体：找不到 delta 时算法会一直跑下去，因为每多引入一个新个体名就多一个候选。

三个出口，本项目三个全用：

1. **local minimality**（深度 n 截断）——Klarman 的 Prop.5 证明 n→∞ 时收敛到真最小性。POC 里对应 `maxDelta` 与 `partialProof` 的 depth 参数。
2. **signature-based**（Koopmann KR 2020）——假设池 = 预声明谓词 × 已有个体。POC 的 `buildSignature()` 就是这个实现：class 5 / property 6 / individual 6，池子有限，搜索必然终止。
3. **分层后战场换到 Datalog/ASP**——见 4.6。

### 4.4 最小 delta 到底等于什么（最容易搞错的一处）

**最小 delta 既不是最小 hitting set，也不是 MCS。** 准确形式是：**「B ∪ {¬G} ∪ A 的 MUS 里属于 A 的那一部分」**。

d4 子代理跑了 600 组随机反链实测对偶关系：

| 关系 | 成立率 |
|---|---|
| MCS == MHS(minF) | 600/600 |
| minF == MHS(MCS) | 600/600 |
| minF == MHS(max(comp)) | 259/600 |
| **MCS == MHS(max(comp))** | **0/600** |

反例极简：`B={goal:-p, q}`、`A={p, q}`、`G=goal` 时 **delta={p,q} 而 MCS={p}/{q}**。方向完全相反——delta 是「补上什么证据能让推论成立」，MCS 是「删掉什么证据能让矛盾消失」。把两者混为一谈，实现出的就是从信念基里悄悄删事实，而不是向用户报缺口。

Klarman Definition 2 的三条筛选，POC 逐条实现了：

- **consistent**：`K ∪ A ⊭ ⊥`；
- **relevant**：`A ⊭ O`——**禁止把目标本身当假设**。这是 POC 修过的一个真 bug：初版无条件把 goal 塞进 delta，于是「dave 不是 Researcher」的答案是「假设 dave 是 Researcher」。代码里对应 `rejected.irrelevant`。
- **minimal**：子集极小。

### 4.5 证明树不要全量物化

Calautti/Livshits/Pieris/Schneider（PACMMOD 2024）：**递归 Datalog 的 why-provenance 不可处理，非递归的高度可处理**。Lemmalog 的选择是现成的工程答案——`SUPPORT_CAP = 4`，`why()` 每条规则只展开一条支撑。POC 采用同样策略：`proofTree` 默认 `maxDepth 24`，`partialProof` 在 depth 3 截断，环显式标 `cut` 而不是继续展开。

### 4.6 运行时禁止 TGD/EGD chase——这条是硬线

两条独立证据：arXiv:2403.16712v2 称 chase 是 **merely a semi-decision procedure**；Gogacz & Marchinkowski（ICDT 2014, LNCS 8757:293–304）证明所有实例的终止性对 oblivious/standard chase **不可判定**。一个不保证终止的机制不能进召回热路径。

EGD（功能性属性）改走 RL 前向规则：`prp-fp` 推 `owl:sameAs`，`eq-diff1` 头是 `false` → **失败点落成一对具体事实**，直接当 justification 用。POC 的 `functional` 场景验证了这条：加 `:alice :affiliatedWith :lab_b` 后 `violations 0`、推出 `lab_a owl:sameAs lab_b`、`labAIsResearcher = REFUTED`。这同时验证了 d1 的一个易误解点：**RL 的 max-1 基数靠推 `owl:sameAs`（cls-maxc2）实现，不是靠失败**。

### 4.7 缺口两类型不能混

- **类型 A「推不出」**：delta 补 ABox 事实。POC 的 `:dave :affiliatedWith :lab_a`。
- **类型 B「推出来但矛盾」**：`eq-diff1`/`cax-dw` 触发 `false`，delta 补区分事实（或直接报冲突供人决策）。

第三种在第 4.4 节之外单列：**契约缺口**——缺的是 schema 公理本身（如 `:bornIn rdfs:domain :Researcher`）。它不是 ABox 假设，再多新观察也补不上，补它属于契约修订（需人工评审）。POC 的 `isTboxAtom()` 与 `contract-gap` 分支就是为它写的。把三类混成一张 delta 列表，是溯因实现最常见的失效方式：**用户会看到一堆看起来像证据、实际上是「请修改本体」的条目**。

### 4.8 分层后主战场从 DL 换到 Datalog/ASP

溯因搜索空间由失败证明树的叶子决定，不由基的规模决定。QuickXplain 在 n=1e6、冲突含 8 元素时只需 **33–270 次一致性检查**。Lemmalog 的 `hypothetical()`/`scoped_recompute()` 只给「变化量小」不给「结果极小」（recompute-equivalence ≠ AGM 极小）→ **第③步缺的是搜索层（命中集/QuickXplain），不是机制**。这条直接决定 §5 的 K4 只做收缩执行、不做极小性保证。

## d9b. Datalog 引擎选型：@suss/datalog 与三个静默错误（d9b digest 摘要）

### 9b.1 结论

**选 `@suss/datalog` 0.40.1（纯 TS、Apache-2.0、零依赖、单文件 2440 行），只跑「查询切片」不跑全库；事实留在 triviumdb。不自研引擎。**

不自研的理由不是「写不出来」——自研到能跑 1.5k–2.5k 行就够。理由是**写不出能信任的**：静默错误（9b.4）不会在开发时暴露，只会在生产里把「没有匹配」和「真的没有匹配」变成同一件事。

### 9b.2 排除清单（带证据）

| 候选 | 排除理由 |
|---|---|
| Cozo | **索引早于数据创建 + 查询在索引列外还绑定其它列 → 静默返回 0 行**，100 条规模可复现，re-put 不能修复；主仓 2024-12 停更 |
| datalog / datalogjs / @datalog/core / ddlog-wasm / nemo-js | npm 全 404 |
| Soufflé | 无 Node 绑定 |
| Nemo (wasm) | experimental，无逐条插入 API |
| DDlog | archived 2022-11-29 |
| datafrog | 2.0.1，停 2019 |
| ascent / crepe | proc-macro，规则在编译期固定 |
| LogicBlox | 状态查不到 |

npm 上真正在维护的只剩 `@suss/datalog` 与 `@dxos/datalog`。Cozo 那条是本次最值钱的排除证据：**「返回没有匹配」与「真的没有匹配」在调用方看来完全相同**——这类缺陷比崩溃危险，因为它让一致性关卡静默通过。

### 9b.3 suss 的决定性优势：provenance 有 absence 叶子

对 `ok(X,Y) :- edge(X,Y), safe(X), not banned(Y)`，suss 的证明树第三条 premise 是 `{kind:"absence", relation:"banned", tuple:["b"]}`——「因为 banned(b) 不存在」。`@dxos` 明确「Aggregates and negation contribute no premises」，拿不到这个。

这正好是第④步「信息缺口」在否定侧的表示：**缺口不只是「缺一条正向事实」，还包括「缺一条本应存在的反面事实」**。没有 absence 叶子，缺口报告只能覆盖一半。

### 9b.4 suss 的三个静默错误（实测 13 变体）

1. **`retract` 不收回派生事实**。线性链撤 a→b，正确答案是 `["a"]`：`retract+evaluate` 得 `["a","b","c"]`（陈旧）、`+evaluate×2` 仍陈旧、`+clearRelations` 得 `[]`（过度删除）。**唯一正确写法：`retract(base) → retractAll(每个派生 relation) → evaluate()`**。分 base/derived 两个 relation 也错。**这与官方 DESIGN.md 原文「With retract, the next run would start again from the base facts」冲突**，尚未提 issue，最需上游确认。
2. **不开 `witnesses` 时 `proofOf` 把派生事实谎报成 `{kind:"fact"}`**。不开这个开关就用 provenance，拿到的是伪造的证明树。
3. **`clearRelations` 静默吞掉后续增量**。清了之后增量更新不再生效，但没有任何报错。

第 1 条直接决定 §5 的 K4 收缩实现方式：**不能用 `retract` 直接撤基事实然后信任结果**，必须显式 `retractAll` 派生 relation。

### 9b.5 表达力边界

- **分层否定判定** = Alice Prop 15.2.7（precedence graph 无含负边的环），四个实现诊断码一致。负环任务怎么做不能靠实现约定，得按规范判。
- **非分层程序的标准处理** = 语法拒绝或 WFS（Van Gelder, DOI 10.1145/116825.116838）。WFS 是 fixpoint queries，stratified 严格更弱。
- **聚合破坏 T_P 单调性**（arXiv:1707.05681）。stratification-over-aggregates 论文自认 can be very inefficient or even non-terminating；实测 `@dxos` 8000 条聚合规则加载 **30845ms**。
- **provenance 不可能性**（arXiv:1105.2255）：有否定或差集时，「每条结论给完整依据」在数学上做不到。**设计必须接受近似**——这是 §9 诚实标注里最该前置说明的一条，它意味着我们永远给不出「完整证明树」，只能给「当前求值下的支撑链」。

### 9b.6 性能实测

| 操作 | 耗时 |
|---|---|
| 插入 10 万条 | 61.3ms |
| 点查 | 0.005ms |
| 全表扫 | 0.3ms |
| **全闭包物化** | **131.9ms** |

结论：**慢的不是读写事实，是物化派生闭包**。这与 §2/§3 的存储判据一致（物化只在结果集大、几乎不变、删除频率低时才划算），也解释了为什么 §5 的检查点全部放在非热路径。

### 9b.7 明确不该交给 Datalog 的

聚合、计数、排序、向量相似度。这四项要么破坏单调性，要么与规则求值的模型不匹配。向量相似度尤其不该绕道 Datalog——`search()` 直接给。

### 9b.8 未验证

- **triviumdb 切片提取延迟没测**：这是「事实留 triviumdb、查询送 suss」这条方案里唯一未验证的环节。
- **DSH 是否存在必须看全库的查询形态未确认**：若存在，切片方案要改。
- 要全路径 provenance 只能自研或 fork suss（Apache-2.0 允许）。

### 9b.9 与 §5 的关系

d9b 是 §5.5「K4 核收缩三策略」的直接依据：counting 对递归不健全、DRed 健全但开销随更新传播、FBF 最快但要反向索引（在 triviumdb 里只能是 `derived_from` 边，边数翻数倍，而删边是最慢路径 192ms vs 50ms）。再叠加 suss 的 `retract` 行为（本人亲测，见 d9c；d9b 原措辞「不收回派生事实」不准确），工程结论是：**非递归谓词用 counting，递归谓词用 DRed**。

## d9c. @suss/datalog 的 retract 语义：本人复现实验（覆盖 d9b §9b.4 第 1、3 条）

d9b 那两条结论来自子代理转述，本次亲自复测后有两个必须更正的地方，并新增了两个更严重的发现。探针脚本已删除，实验参数与输出全部记录在 `digests/d9c-suss-retract-verified.md`。

### 9c.1 机制不是「不收回派生」，而是「只在规则集含否定时自动收回」

类型定义原文（`dist/index.d.ts:635-640`）：「When a rule set uses negation, a new fact can invalidate an old conclusion, so evaluation calls this to remove what it derived last time.」实测对照（2 条边 `a→b`、`b→c`，传递闭包，撤掉 `a→b` 后单次 `evaluate`，正确答案为 `["b c"]`）：

| 用例 | 规则集 | 操作后 reach | 判定 |
| --- | --- | --- | --- |
| P1 | 纯正向 | `["a b","a c","b c"]` | **陈旧，错** |
| P2 | 含否定 | `["b c"]` | 正确 |
| N1 | 含否定，新增 `blocked(a)` 使否定由真变假 | `["b c"]` | 正确 |

**这对本设计是要害**：OWL 2 RL 的 78 条规则全是正向 Horn、没有否定文字（d8 已核实），所以把 RL 直接交给 suss 时**恰好落进不会纠错的那一支**——错得静默，不报任何警告。

### 9c.2 更严重的发现：RL 规范里那个单一三元谓词 `T` 无法安全清理

RL 规则写在**一个三元谓词 `T`** 上，断言与推导同处一个关系。实测这个模型两条路都堵死：

```text
A_initial                      : 4 条（3 条基事实 + 1 条推导 ex:Researcher⊑ex:Agent）
A_afterRetractBase_andEvaluate : 撤掉 ex:Researcher⊑ex:Person 后
                                 仍留着 ex:Researcher⊑ex:Agent ← 陈旧
A_retractAll_wipes             : removed=4, T=[] ← 清则连 3 条断言基事实一起删光
```

拆成 `Ta`（断言）/ `Td`（推导）/ `T = Ta ∪ Td` 后实测正确：撤一条 `Ta` + 清 `Td` 与 `T` + `evaluate`，结果与「从剩余基事实全量重建」逐条一致（`B_match: true`）。代价是多两条并集规则。

**因此「断言与推导必须分关系」升级为 schema 硬约束，写进 DESIGN.md §3.5。**

### 9c.3 `clearRelations` 的失败来自同一个根因

d9b 说它「静默吞掉后续增量」，方向不对。实测：对单 `T` 关系用它 → 返回 `[]`（正确应为 `["b c"]`），因为断言和推导在一起被一起清空了；对拆分后的模型用则正常，但要同时清 `Td` 与并集关系 `T`。**函数本身没错，是单关系混装建模让它无法被正确使用。**

### 9c.4 被否决的负假说：negation tripwire

设想给正向规则集塞一条永不命中的 `notLit("__tripwire__", X)`，骗 suss 认为规则集「用了否定」从而换来自动纠错。功能确实有效，但必须否决：

1. **污染证明树**。开 `witnesses` 后对比同一目标 `reach(a,c)`：纯正向证明 0 个 `ABSENCE` 叶子，tripwire 版 **2 个假缺口**。第 4、5 步正是靠 `absence` 叶子区分真缺口与查不到，这会直接把缺口上报变成噪音。
2. **静默失败面**。只要有人误写一条 `__tripwire__` 事实，所有推导立刻清空且无报错（实测 `silentlyLost: true`）。
3. **性能也不划算**。400 边链三次取中位数：纯正向 35.56ms / tripwire 48.22ms（+35.6%）。

**方法论教训：单次毫秒级计时不可信。** 我最早单次测到 tripwire「-7.1%」，取三次中位数后变成「+35.6%」，方向完全相反。凡毫秒级对比一律重复取中位数。

### 9c.5 证明必须开 witnesses，且子节点字段是 `premises`

`proofOf` 不传 `witnesses` 时返回 `{kind:"absence"}`，语义是「该事实没有见证」（d.ts:521-531），不是「该事实不存在」。d9b 说「谎报成 base fact」实测不成立（返回的是 absence 不是 fact），但「不开 witnesses 拿不到可用证明」成立，表述要改。另注：`ProofDerived` 的子节点字段名是 `premises`，不是 `body`——用 `body` 遍历只能拿到根节点，会误判证明树只有一层。

### 9c.6 成本实测与结论

| 场景 | 规模 | 耗时（中位数） |
| --- | --- | --- |
| 建边链 + 全闭包（纯正向） | 400 条边 | 35.56ms |
| 同上 + 显式两轮 `retractAll` 后重建 | 400 条边 | 79.75ms（约 2.2×） |
| 撤一条 + 清 + 重推 | 300 边链（45,150 条推导事实） | 34.34ms |
| 同上 | 200 边链（20,100 条推导事实） | 14.1ms |

**定稿的正确用法**：`retract/add(Ta) → retractAll(Td) → retractAll(T) → evaluate`，证明全程开 `witnesses`，不用 tripwire。代价是「每次变更付一次全闭包」而非增量，因此只能放 dream 与写路径（去抖 3s），不能进 250ms 召回热路径——与 §5.7 预算结论一致，但把「多大」钉成了具体倍数。

### 9c.7 诚实标注

只测了传递闭包与 `cax-sco` 两类规则形状，**未测 `prp-spo2`（属性链）与 `eq-rep-*`（同一性替换）**——它们正是 RL 组合爆炸的主因，所以 9c.6 的时间**不能外推到完整 78 条规则集**。未提交 issue 到上游。未验证 `deriveOnDemand` / `noteReads` / `rowBudget` 与本写法的交互。
## 来源表（本轮新增）

| # | 来源 | 发布者 | 日期 | 访问 | 用于 | class |
|---|---|---|---|---|---|---|
| 1 | SPARQL 1.1 Entailment Regimes — https://www.w3.org/TR/sparql11-entailment/ | W3C | 2013-03-21 | 2026-11-25 | d5 一致性/答案定义 | 规范 |
| 2 | OWL 2 Direct Semantics (2nd ed.) — https://www.w3.org/TR/owl2-direct-semantics/ | W3C | 2012-12-11 | 2026-11-25 | d5 蕴涵定义 | 规范 |
| 3 | Shapes Constraint Language (SHACL) — https://www.w3.org/TR/shacl/ | W3C | 2017-07-20 | 2026-11-25 | d5 closed/entailment | 规范 |
| 4 | SHACL Advanced Features — https://www.w3.org/TR/shacl-af/ | W3C | 2017-06-08 | 2026-11-25 | d5 规则语义 | 规范 |
| 5 | Krisnadhi/Sengupta/Hitzler, Grounded Circumscription, RR 2011 — https://doi.org/10.1007/978-3-642-23580-1_22 | Springer | 2011 | 2026-11-25 | d5 LCWA | 论文 |
| 6 | Delivorias/Rudolph, Revisiting Grounded Circumscription, RR 2016 — https://doi.org/10.1007/978-3-319-45276-0_5 | Springer | 2016 | 2026-11-25 | d5 算法错误 | 论文 |
| 7 | Knorr/Alferes/Hitzler, LCW under well-founded semantics, AIJ 2011 — https://doi.org/10.1016/j.artint.2011.01.007 | Elsevier | 2011 | 2026-11-25 | d5 三值形式 | 论文 |
| 8 | Lutz/Seylan/Wolter, Data Complexity of OMQs with Closed Predicates, LMCS 15(3:23) 2019 — https://doi.org/10.23638/LMCS-15(3:23)2019 | LMCS | 2019 | 2026-11-25 | d5 复杂度跃升 | 论文 |
| 9 | Kalyanpur et al., Finding All Justifications, ISWC 2007 — https://doi.org/10.1007/978-3-540-76298-0_20 | Springer | 2007 | 2026-11-25 | d5 HST 枚举 | 论文 |
| 10 | Horridge/Parsia/Sattler, Laconic Justifications, ISWC 2008 — https://doi.org/10.1007/978-3-540-88564-1_21 | Springer | 2008 | 2026-11-25 | d5 截断前提 | 论文 |
| 11 | SHACL Validation in the Presence of Ontologies — https://arxiv.org/abs/2507.12286 | arXiv | 2025 | 2026-11-25 | d5 重写语义 | 论文 |
| 12 | Klarman/Endriss/Schlobach, ABox Abduction in ALC, JAR — https://doi.org/10.1007/s10817-010-9168-z | Springer | 2011（正式卷；2010 为 online-first） | 2026-11-25 | d5 第③步形式化 | 论文 |
| 13 | JordyZomer/lemmalog @ 9cc2cf1 — https://github.com/JordyZomer/lemmalog | GitHub | 2025 | 2026-11-25 | d3a 信念基 | 源码 |
| 14 | **不可核验（原样保留编号，勿引用为证据）**：原文此格把「Deferred」「Box²EL」「BoxEL」三个不同工作混写成一条，出版方记 AAAI/NeurIPS、年份记 2019–2024 的区间，无标题、无 DOI、无 URL，按本报告的来源规则（`class` 须到规范/论文/源码）**不满足可核验条件**。d6.1 的四个数值（Box²EL Anatomy H@1=0.16、GALEN 0.05；BoxEL GALEN 0.00/MRR 0.01、GO AUC 0.68）与 d6.2 的四代演进（ELEm→ELBE→BoxEL→Box²EL）因此**只有转述、没有一手出处**，本文档不把它们当作支撑任何设计结论的证据；若后续要用，须补 DOI 与逐年拆分的登记 | （缺） | （缺） | — | d6 嵌入（转述） | **未核实** |
| 15 | Lutz/Schröder, Fuzzy DLs undecidable — https://arxiv.org/abs/1107.4212 | arXiv | 2011 | 2026-11-25 | d6 排除 | 论文 |
| 16 | KLM rational closure for DL — https://arxiv.org/abs/1904.07559 | arXiv | 2019 | 2026-11-25 | d6 defeasible | 论文 |
| 17 | cntm-labs/chronos @ 982d2a1 — https://github.com/cntm-labs/chronos | GitHub | 2026 | 2026-11-25 | 否决（空壳） | 源码核验 |
| 18 | OWL 2 Web Ontology Language Profiles (2nd ed.) — https://www.w3.org/TR/owl2-profiles/ | W3C | 2012-12-11 | 2026-11-25 | d8 RL 规则可实现性 + Table 10 复杂度 | 规范 |
| 19 | JordyZomer/lemmalog 源码 @ 9cc2cf1（v0.2.0, MIT）— https://github.com/JordyZomer/lemmalog ——**与第 13 条同一个仓库、同一个提交，不是两份来源**；分列只因用于两处不同结论（13 用于 d3a 的范式判断，19 用于 d9a 的源码级核实，后者读的是 `lib/` 与 `dist/*.d.ts`） | GitHub | 2025 | 2026-11-25 | d9a 内核候选的源码级核实 | 源码 |
| 20 | ARCO: DL-Lite 查询重写到 labeled property graph — https://arxiv.org/abs/2608.20092 | arXiv / CIKM 2026 | 2026 | 2026-11-25 | d2b 重写路线实测 | 论文 |
| 21 | Gupta/Mumick/Subrahmanian, DRed 增量视图维护 — https://doi.org/10.1145/170035.170066 | ACM SIGMOD | 1993 | 2026-11-25 | d2b 递归增量 | 论文（仅书目核验） |
| 22 | FBF 增量维护, AAAI 2015 pp.1560-1568 | AAAI | 2015 | 2026-11-25 | d2b 反例（代价过高） | 论文（仅书目核验） |
| 23 | Shapes Constraint Language 1.5 — https://www.w3.org/TR/shacl/ ——**与第 3 条同一个 URL**（该页是 living 版本，编号 1.5 时内容有增补；第 3 条记的是 2017-07-20 推荐版口径） | W3C | living | 2026-11-25 | d2b.9 闭包而非蕴含 | 规范 |
| 24 | RDF 1.1 Semantics §5.1.1 — https://www.w3.org/TR/rdf11-mt/ | W3C | 2014-02-25 | 2026-11-25 | d2b.5 Skolem 作用域 | 规范 |
| 25 | R2RML — https://www.w3.org/TR/r2rml/ | W3C | 2012-09-27 | 2026-11-25 | d2b.11 确定性 ID 模板 | 规范 |
| 26 | n10s (Neosemantics) 源码 | GitHub | 2024-2025 | 2026-11-25 | d2b.10 反面先例 | 源码 |
| 27 | CLS 互补学习系统, Psych. Review 102(3):419-457, PMID 7624455 | APA | 1995-07 | 2026-11-25 | d10.2 分层理由 | 论文 |
| 28 | Generative Agents — https://arxiv.org/abs/2304.03442 | arXiv v2 | 2023-08-06 | 2026-11-25 | d10.3 importance 150 | 论文 |
| 29 | MemGPT — https://arxiv.org/abs/2310.08560 | arXiv v2 | 2024-02-12 | 2026-11-25 | d10.3 token 水位 | 论文 |
| 30 | Zep / Graphiti — https://arxiv.org/abs/2501.13956 | arXiv v1 | 2025-01-20 | 2026-11-25 | d10.1/10.6 三层与去重 | 论文 |
| 31 | GraphRAG — https://arxiv.org/abs/2404.16130 | arXiv v2 | 2025-02-19 | 2026-11-25 | d10.1 Leiden 单轴 | 论文 |
| 32 | Mem0 — https://arxiv.org/abs/2504.19413 | arXiv v1 | 2025-04-28 | 2026-11-25 | d10.1 平层 + 四操作 | 论文 |
| 33 | Confluent Schema Registry 兼容性 | Confluent docs | living | 2026-11-25 | d10.3 唯一机器门禁 | 官方文档 |
| 34 | Databricks medallion architecture | Databricks docs | living | 2026-11-25 | d10.1/10.8 允许不分层 | 官方文档 |
| 35 | schema.org「not a global ontology of the world」 | schema.org | living | 2026-11-25 | d10.8 事前自我约束 | 官方文档 |
| 36 | GraphDB 推理规则与裁规则说明 | Ontotext docs | living | 2026-11-25 | d10.7 主动裁规则 | 官方文档 |
| 37 | Letta / MemGPT background consolidation | Letta docs | living | 2026-11-25 | d10.6 异步巩固 | 官方文档（片段，med） |
| 38 | Koopmann, ABox Abduction in EL / IJCAI-21 Thm 3 — https://www.ijcai.org/proceedings/2021/ | IJCAI | 2021 | 2026-11-25 | d4 复杂度分档 | 论文 |
| 39 | Klarman/Endriss/Schlobach, ABox Abduction in ALC, JAR 2011 — https://doi.org/10.1007/s10817-010-9168-z | Springer | 2011 | 2026-11-25 | d4 半可判定与 local minimality | 论文 |
| 40 | Koopmann, Signature-based abduction, KR 2020 — https://doi.org/10.24963/kr.2020/59 | KR | 2020 | 2026-11-25 | d4 用 schema 换可判定性 | 论文 |
| 41 | Calautti/Livshits/Pieris/Schneider, why-provenance, PACMMOD 2024 | ACM | 2024 | 2026-11-25 | d4.5 证明树不全量物化 | 论文 |
| 42 | Gogacz/Marchinkowski, All-instances termination of chase, ICDT 2014 — https://doi.org/10.1007/978-3-662-43951-7_25 | Springer | 2014 | 2026-11-25 | d4.6 禁 chase | 论文 |
| 43 | @suss/datalog 0.40.1 — https://www.npmjs.com/package/@suss/datalog | npm | 2026 | 2026-11-25 | d9b 引擎选型 | 源码 |
| 44 | @dxos/datalog | npm | 2026 | 2026-11-25 | d9b 对比（无 absence 叶子） | 源码 |
| 45 | Van Gelder, Well-Founded Semantics — https://doi.org/10.1145/116825.116838 | ACM | 1993 | 2026-11-25 | d9b 非分层否定 | 论文 |
| 46 | Provenance impossibility (arXiv:1105.2255) | arXiv | 2011 | 2026-11-25 | d9b 设计必须接受近似 | 论文 |
| 47 | Stratification over aggregates (arXiv:1707.05681) | arXiv | 2017 | 2026-11-25 | d9b 聚合破坏单调性 | 论文 |
| 48 | @suss/datalog 0.40.1 类型定义与实现 — 本机 `npm install` 后读 `dist/index.d.ts`（retract 语义见 635-640 行，proofOf 见 521-531 行） | npm / 本机实测 | 0.40.1 | 2026-11-25 | d9c retract 真实语义、proofOf 语义 | 亲自实跑 |
