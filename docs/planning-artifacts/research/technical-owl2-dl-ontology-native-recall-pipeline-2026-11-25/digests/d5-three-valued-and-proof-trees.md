# d5 — 三态语义、概念查询与部分证明树（研究子代理 threevalued2 报告，已核验版）

source: W3C 规范全文（本地下载 grep 原文）+ DOI/arXiv 书目核验
publisher: W3C / Springer / ACM / arXiv
pub_date: 规范 2009–2017；论文 2007–2025
accessed: 2026-11-25
confidence: high（规范条文取原文；部分论文只核验到书目层，已在文内标注）
class: 理论选型 + 语义边界

## 1. Certain answers 与 SPARQL 蕴涵制式

### 规范如何定义「答案」（OWL 2 Direct Semantics §2.5）
> "**Ontology Entailment**: O entails O₁ w.r.t. D if every model of O w.r.t. D and V is also a model of O₁…"
> "**Boolean Conjunctive Query Answering**: Q is an answer w.r.t. O and D if Q is true in **each model** of O w.r.t. D and V according to the standard definitions of first-order logic."
> "**Ontology Consistency**: O is consistent (or satisfiable) w.r.t. D if a model of O w.r.t. D and V exists."
（https://www.w3.org/TR/owl2-direct-semantics/）

### SPARQL 1.1 Entailment Regimes 如何机械化（§7.2，https://www.w3.org/TR/sparql11-entailment/）
> "A solution mapping μ is a **possible solution** for BGP from G under the OWL 2 Direct Semantics if dom(μ) = V(BGP) and there is an RDF instance mapping σ … such that … P(BGP) are well-formed RDF triples that are legal for the regime … and OWL 2 Direct Semantics **entailed by O(SG)**."
→ 每找到一个候选绑定 μ，就去问一次 Oracle「O(SG) ⊨ P(BGP) 吗」。**这正是本项目第 ② 步要自己实现的 Oracle。**

三个附加条件（规范硬约束）：
- **(C1)** "Each logical axiom ax in sk(O_E(P(BGP))) is ground and entailed by sk(O(SG))" —— 绑定结果必须能改写成 ground axiom 并被蕴含（Skolem 化处理匿名个体）。
- **(C2)** 变量绑到字面量时必须是 `Lit(SG)` 里的规范字面量或来自 `owl2V-Minus` —— 保证答案有限。
- **(C3)** "Adding all axioms in O_E(P(BGP)) to O(SG) results in a valid OWL 2 DL ontology." —— **查询本身也必须合法 OWL 2 DL。**

变量类型约束："If BGP contains a triple `?x rdf:type TYPE`, where TYPE is one of `owl:Class`, `owl:ObjectProperty`, `owl:DatatypeProperty`, or `owl:NamedIndividual`, ?x is declared to be of type TYPE."
→ 无类型声明时"all possible ways of mapping the BGP into ontology structures have to be considered"（同一三元组可能映射成 ObjectPropertyAssertion / DataPropertyAssertion / AnnotationAssertion）。**概念查询的 BGP 变量必须带类型三元组。**

### 不一致性：三态设计里最重要的一句
> "**Inconsistency** If the queried ontology is inconsistent under OWL 2 Direct Semantics, the system **MUST raise an error**."（§7.2 表格）
> "Since inconsistent graphs entail any triple, special care has to be taken to address the situation."（§3）
→ **一致性检查不是三态之一，而是三态判定之前必须通过的检查。** 不一致 KB 上「证实」和「证伪」会同时成立（爆炸原理），任何证明树都是假的。

### 一条必须提前知道的语义裂痕
SPARQL 的 `OPTIONAL`/`NOT EXISTS`/bag 语义天然是「在给定图上求值」，certain answers 是「对所有模型成立」，二者在 KB 上一般不可兼得。
→ **不要把 SPARQL 查询结果当作证明。** SPARQL 只做候选枚举（① 步粗召），证明必须走独立的 DL 蕴含判定（② 步）。

## 2. 证伪在 OWA 里是什么

### 形式定义（设 KB=⟨T,A⟩，目标 γ 是 ground atom）
| 状态 | 形式条件 | 等价的判定式 |
|---|---|---|
| **ENTAILED（证实）** | KB ⊨ γ | KB ∪ {¬γ} ⊨ ⊥ |
| **REFUTED（证伪）** | KB ⊨ ¬γ | KB ∪ {γ} ⊨ ⊥ |
| **UNKNOWN** | KB ⊭ γ 且 KB ⊭ ¬γ | KB∪{γ} 与 KB∪{¬γ} **均可满足** |

**关键点**：「查不到」只等价于 `KB ⊭ γ`，即 UNKNOWN 的一半。要成为 REFUTED 必须**真的证明 ¬γ 被蕴含**。OWL API 里没有「instance checking 的否定版本」——证伪就是「把 γ 当假设导致不可满足」。

### 证伪的实际来源（决定 schema 必须存什么）
OWL 2 里只有存在**产生否定信息的东西**时 `¬C(a)` 才可能被蕴含：
1. 显式否定断言：`NegativeObjectPropertyAssertion`、`ClassAssertion(owl:complementOf(C) a)`
2. **不相交性 + 成员关系**：`DisjointClasses(C D)` + `D(a)`
3. **基数/函数性 + 两个不同填充者**：`FunctionalObjectProperty(R)` + `R(a,b)`, `R(a,c)`, `DifferentIndividuals(b c)`
4. domain/range + 值域不相交
5. 数据类型面约束冲突
6. `owl:AllDifferent` / `owl:differentFrom` 提供的不等性

→ **schema 推论：如果 TBox 里没有上述任何一条，整个 KB 的证伪能力就是零，三态退化成二态（证实/未知）。不相交性与显式否定断言不是装饰，它们是证伪通道的唯一燃料。**

### Closed-world NAF vs open-world 显式否定
| | NAF（封闭世界） | 显式否定（开放世界） |
|---|---|---|
| 判定 | `not provable(C(a)) ⟹ ¬C(a)` | `provable(¬C(a)) ⟹ ¬C(a)` |
| 认识论 | 非单调：新证据可翻转 | 单调：新证据只加强 |
| 载体 | Prolog/Datalog/SHACL/SPARQL `NOT EXISTS` | OWL 2 DL 否定断言、不相交、基数 |
| 后果 | 「库里没有」当「世界上不成立」 | 「不知道」保持「不知道」 |
| 本项目 | **禁止用于产生 REFUTED** | **REFUTED 的唯一合法来源** |

### 三态判定表（含一致性检查的角色）
| 顺序 | 检查 | 结论 | 输出 | 禁止 |
|---|---|---|---|---|
| 0 | `KB ⊨ ⊥`? | 是 → **INCONSISTENT** | 拒答 + 一致性错误 + 冲突公理集 | 禁止输出任何证明/反驳/答案（都平凡为真） |
| 1 | `KB ∪ {¬γ}` 不可满足? | 是 → **ENTAILED** | 证明树（justification） | — |
| 2 | `KB ∪ {γ}` 不可满足? | 是 → **REFUTED** | 反驳树 + clash 对（哪两条公理打架） | 不得仅凭「闭包里没有 γ」判 REFUTED |
| 3 | 两者都可满足 | **UNKNOWN** | gap 节点 + abduction 候选 | 不得静默降级为 false |
| 4a | `KB ⊨ ∃R.C(a)` 但无 named witness | **ENTAILED（存在）/ UNKNOWN（实体）** | 拆成「概念层已证实、实体层缺口」 | 不得把匿名见证当成「没找到人」 |

第 4a 行是最容易误报的地方：certain answers 只收 named 项（或 Skolem 项），所以「alice 有父亲」可以成立而「alice 的父亲是谁」的 certain answer 是空集。**必须把「概念已证实」和「实体已定位」分成两个字段。**

### 查询级四态（比裸三态更适合交给 LLM）
对概念查询 `q(x)=C(x)` 同时算两个界：`Cert(q)` = certain answers = `{a | KB ⊨ C(a)}`；`Poss(q)` = `{a | KB ∪ {C(a)} 可满足}`。
| 状态 | 条件 | 给 LLM 的话 |
|---|---|---|
| **CERTAIN** | a ∈ Cert | 「确定成立」+ 证明树 |
| **POSSIBLE** | a ∈ Poss \ Cert | 「可能成立，取决于未定事实」+ gap |
| **IMPOSSIBLE** | a ∉ Poss | 「确定不成立」+ 反驳树 |
| **OUT-OF-SCOPE** | a 不在 active domain | 不输出 |
工程上 `Cert` 和 `Poss` 各一张物化表即可。**POSSIBLE 状态就是第 ④ 步的原材料。**

## 3. LCWA 的既有形式化与可判定性

### Grounded Circumscription（Krisnadhi/Sengupta/Hitzler, RR 2011, doi:10.1007/978-3-642-23580-1_22）
> "We present an improved local closed world extension for description logics. It is based on circumscription… extensions of minimized predicates **may contain only extensions of named individuals in the knowledge base**. Besides an (arguably) higher intuitive appeal, the improved semantics is applicable to **expressive description logics without loss of decidability**."
「局部」= 只最小化**指定的**谓词，不是全局 CWA；「grounded」= 最小化后的外延只允许含 KB 中具名个体的像，因此不造匿名个体（这是保住可判定性的关键手法）。

### ⚠️ 该形式化有已知缺陷（Delivorias & Rudolph, RR 2016, doi:10.1007/978-3-319-45276-0_5）
> "Our paper builds on their general idea, but **identifies some problems with the original semantics definition**, which gives rise to **counter-intuitive consequences** and renders the **proposed tableau algorithm incorrect**. … On the algorithmic side, we show that **a big part of the reasoning can actually be transferred to standard Description Logics**, for which tools and results already exist."
→ **最重要踩坑预警：2011 年 GC 语义有问题，配套 tableau 算法是错的。** 按那篇实现会得到系统性错误结论，且很难测出来（只影响非单调部分）。

### LCWA 的三值形式（Knorr/Alferes/Hitzler, AIJ 2011, doi:10.1016/j.artint.2011.01.007）
书目已核验（标题/DOI）；摘要被付费墙挡住，**不声称知道具体定义**。可核验的是：这条线把 LCWA 放进 **well-founded semantics**，而 WFS 是标准三值语义（true/false/undefined）。→ 「证实/证伪/未定」在形式上就是 WFS 的三个值。

### 关闭谓词的代价：复杂度会涨（Lutz/Seylan/Wolter, LMCS 15(3:23) 2019, doi:10.23638/LMCS-15(3:23)2019）
> "At the level of ontologies, we prove a **dichotomy between FO-rewritable and coNP-complete for DL-Lite** and between **PTime and coNP-complete for EL**."
→ **250ms 预算下不可能对每个概念查询现场做 closed-predicate 推理。LCWA 只能作为「写时物化」的产物存在。**

## 4. SHACL 封闭校验 + OWL 开放推理怎么合并

### 一个可核验的事实：SHACL 规范里 `world` 一词出现 0 次
SHACL 的封闭世界性是**语义结构**带来的（在给定图上校验，没有模型概念），不是文本宣示的。
`sh:closed` 精确定义（https://www.w3.org/TR/shacl/ §4.8.1）：
> "**sh:ClosedConstraintComponent**: If $closed is true then there is a validation result **for each triple that has a value node as its subject and a predicate that is not explicitly enumerated as a value of sh:path** in any of the property shapes declared via sh:property at the current shape. If $ignoredProperties has a value then the properties enumerated as members of this SHACL list are also permitted for the value node."

### SHACL 本身就是三态的，只是值不同
三类结果：`conforms=true`、`conforms=false`（有 validation result）、**failure**（校验过程无法完成）。映射：
| SHACL | 我方三态 | 说明 |
|---|---|---|
| conforms | 无违规（≠ ENTAILED） | 只说明「没有反例」，**不能**当证实 |
| validation result | REFUTED（局部） | 构成封闭世界里的反驳 |
| failure | UNKNOWN / 报错 | 校验无法完成 |

**关键判断**：SHACL violation **不是** OWL 语义下的 `KB ⊨ ¬γ`。
- 若校验的图**已是 OWL 物化闭包** → violation 可提升为 REFUTED（闭包对蕴含封闭）。
- 若校验原始 ABox → 只能算「按封闭假设看是错的」，必须降级成 POSSIBLE/UNKNOWN，**不能进证明树**。

### 规范认可的组合姿势：`sh:entailment`（SHACL §1.5）
> "SHACL uses the RDF and RDFS vocabularies, but **full RDFS inferencing is not required**. However, SHACL processors MAY operate on RDF graphs that include entailments — either **pre-computed before being submitted** to a SHACL processor or **performed on the fly** … To support processing of entailments, SHACL includes the property **sh:entailment** to indicate what inferencing is required by a given shapes graph."
> "SHACL implementations MAY, but are **not required to**, support entailment regimes."
→ 规范明文允许「OWL 物化 → 把闭包交给 SHACL → 在闭包上做 `sh:closed` 校验」这条路。

### SHACL-AF 是前向规则，不是真值合并（§8.2，https://www.w3.org/TR/shacl-af/）
> "Note that, from a logical perspective, the data graph will be modified if triples get inferred. This means that **rules can trigger after other triples have been inferred**."
> "A rule may have values for the property **sh:condition** to specify shapes that the focus nodes must conform to before the rule gets executed."
→ SHACL-AF 是前向链生产规则（带 `sh:condition` 守卫与 `sh:order`），**它不解决** OWL 开放世界结论与 SHACL 封闭世界违规之间的真值冲突。**别指望它当合并层。**

### 既有组合方案
arXiv 2507.12286 "SHACL Validation in the Presence of Ontologies: Semantics and Rewriting Techniques"：
> "OWL, designed for inferring facts from incomplete data, makes the **open-world assumption**, whereas SHACL is a constraint language that **treats the data as complete** and must be validated under the **closed-world assumption**. The combination of both formalisms is very appealing and has been called for, but **their semantic gap is a major challenge, semantically and computationally**."
它给的是**重写（rewriting）语义**——把 ontology 的影响编译进 SHACL 校验，而非发明新的多值逻辑。

检索边界（三层）：① 有 SHACL-in-presence-of-ontologies 的重写语义；② 有 closed predicates 的 OMQ 语义（指定谓词封闭、其余开放）；③ 有 well-founded 三值语义。④ **本轮没查到**把 SHACL+OWL 合并成四值真值格（如 Belnap FDE T/F/Both/Neither）的 W3C 规范或成熟论文方案 —— 不下「不存在」的结论，只说没查到。

### 建议：不要做四值真值，做「二值真值 + 三值认知状态 + 来源标签」
OWL 2 的模型论是**二值**的（每个模型里 φ 要么真要么假）。「既不能证实也不能证伪」不是世界的第三个真值，而是**推理者知识的不完备**。编码成真值会污染语义（例如破坏 `C(a) ∨ ¬C(a)`）。
正交拆三轴：
```
axis1: 真值（由 DL 决定，二值）      ∈ { true, false }
axis2: 认知状态（由管线决定）        ∈ { ENTAILED, REFUTED, UNKNOWN }
axis3: 来源（provenance）           ∈ { OWL_INFERRED, SHACL_CLOSED_CHECK, ASSERTED, ABDUCTED }
```
`ENTAILED` + `SHACL_CLOSED_CHECK` 这种组合就自然表达「封闭假设下被否掉、但开放世界下未定」——不需要第四个真值。

## 5. 部分证明树：从 tableau / justification 到「已证实 + 缺口」

### 既有形式
| 形式 | 是什么 | 出处 |
|---|---|---|
| Tableau 证明树 | 要证 `KB ⊨ C(a)`，假设 `¬C(a)` 展开，所有分支 clash 即成立；证伪对称 | OWL 2 DL 标准判定过程 |
| **Justification** | 极小公理集 J ⊆ KB 使 J ⊨ η | Kalyanpur/Parsia/Horridge/Sirin, ISWC 2007, doi:10.1007/978-3-540-76298-0_20 |
| **Laconic justification** | 去掉逻辑上冗余公理后的 justification | Horridge/Parsia/Sattler, ISWC 2008, doi:10.1007/978-3-540-88564-1_21 |
（两篇只核验到书目/DOI 层，未读全文，不声称其内部复杂度结论。）

Kalyanpur 黑盒方法用 **Reiter 的 Hitting Set Tree (HST)** 枚举全部 justification：每个节点算一次 justification，子节点从父 justification 逐个删一条公理重算，用 superset 剪枝 + 语法局部性剪枝。**代价是指数级最坏情况 → 决定「不能在线算所有 justification」。**

**Laconic 的必要性**：交给 LLM 的证明子树若带 40 条冗余公理，LLM 会开始编故事。**截断必须以 laconic 化为前提。**

### 截断算法（设计，标为推断）
证明 DAG 节点是 `(结论, 规则, 前提集)`，边是「前提 → 结论」。给每个节点打标签：
```
enum ProofStatus { PROVED, CONDITIONAL, GAP, REFUTED }
```
1. **REFUTED**：clash 节点（不相交冲突 / 否定断言冲突 / 基数冲突 / 数据类型面冲突）。记录 **clashing pair** —— 这是反驳树的全部价值。
2. **PROVED（叶）**：断言本身在 assertional base（TBox 公理 ∪ ABox 断言）中。
3. **GAP（叶）**：断言不在 base 中，且**两个方向都不 clash**。gap 节点必须携带「我已检查过它不可驳」的标志，否则它只是「没查」而不是「查了没有」。
4. **PROVED（内点）**：所有前提是 PROVED。
5. **CONDITIONAL（内点）**：至少一个前提是 GAP/CONDITIONAL，其余 PROVED。

传播规则（三值 Kleene 的形状）：
```
AND 节点（一个分支 = 前提合取）: min(子节点值)   // GAP 吞掉整支
OR  节点（多分支择一）         : max(子节点值)   // 一支 PROVED 即整体 PROVED
```

**截断**：在 GAP 节点处停止向下展开，把该 GAP 的依赖集记为 `cutFrontier`。输出结构：
```
ProvedSubtree:  { nodes: [...], root: goalId, status: CONDITIONAL,
                  refutationNodes: [ {axiomA, axiomB, clashType} ] }
GapSet:         [ { gapId, missingPattern, cutFrontier: [goalId...],
                    polarity: wouldProve | wouldRefute,
                    consistencyEvidence: "KB ∪ {¬γ} satisfiable" } ]
```
→ **这一步是三态与证明树的接口**：`CONDITIONAL` 证明树 + `GapSet` 恰好就是第 ④ 步要的「一等召回产物」。

### 复杂度与延迟
可核验（SPARQL ER §6.4.2/§6.4.3）：OWL 2 EL 基本推理 polynomial；OWL 2 QL 的 CQ 回答对数据是 LOGSPACE。
**未核验**：SROIQ 完整片段一致性判定上界（不写具体复杂度类）。
**工程结论**：证明树不能现算。必须**写时**对 TBox 层做分类并缓存 justification；ABox 层只保留**单条 tracked derivation path**，要全部 justification 时才走 HST——且 HST 只允许离线/异步跑。

## 6. 缺口的表达

### 绝对禁止的三种写法
1. **写 `¬C(a)` 表示「没找到」** —— 是谎言，可能与 TBox 冲突导致 KB 不一致（进而让第 0 关拒答整个系统）。
2. **把缺口挂在域内命名空间** —— 若 `omw:Gap` 个体进入 reasoner 输入，会触发 `rdfs:domain`/`owl:disjointWith` 等公理，制造出真实但错误的推论。
3. **用「闭包里没有」当 false** —— NAF。

### 缺口节点 schema（设计）
放在**独立的 epistemic 图 / 独立 label 空间**，OWL reasoner 输入永远不包含它：
```
node label: omw:Gap
  omw:gapGoal              -> ref to 被 reify 的目标（ClassAssertion / RoleAssertion 结构节点）
  omw:gapMissingPattern    -> 需要的公理「形状」（模板，不是断言）
                              e.g. { kind: "ClassAssertion", cls: ex:WorksFor, ind: ex:alice }
  omw:gapPolarity          -> omw:wouldProve | omw:wouldRefute
  omw:gapCutFrontier       -> [goalId, ...]        // 依赖这个缺口的上层目标
  omw:gapProvedSubtree     -> ref to ProofDAG 根   // 已证实部分
  omw:gapRefutationEvidence-> { checked: "KB ∪ {¬γ}", result: "satisfiable" }
  omw:gapKind              -> omw:missingAssertion | omw:missingWitness | omw:missingDisjointness
  omw:gapStatus            -> omw:open | omw:answered | omw:superseded
  omw:gapCostEstimate      -> xsd:decimal          // abduction 排序用
  omw:gapCreatedAt / omw:gapKbVersion -> 失效键
edges:
  omw:gapBlocks  (Gap -> Goal)    label + bitmap 索引
  omw:gapDerivedFrom (Gap -> ProofNode)
```
四个设计要点：
- **`gapMissingPattern` 是模板不是断言** —— 描述「若存在这样一条公理就会闭合」，自身不参与推理。保住 OWA。
- **`gapKind` 区分三种缺口**：缺断言（ABox 事实）、缺见证（有 ∃ 但无具名个体）、**缺不相交性（TBox 太弱，连证伪通道都没有）**。第三种最易忽略，且只能靠改 TBox 解决 —— 是给上层的**元级建议**。
- **`gapRefutationEvidence` 是三态的证明** —— 明确记录「我试过证伪，失败了」。没有这个字段，gap 和「没查」无法区分。
- **`gapKbVersion` 支持失效** —— KB 一改缺口必须重算，避免陈旧缺口污染召回。

### Abduction 的形式位置
Klarman/Endriss/Schlobach, "ABox Abduction in the Description Logic ALC", JAR 2010, doi:10.1007/s10817-010-9168-z（书目已核验，全文与极小性定义、复杂度**未核验，不声称**）。
**第 ③ 步要做的最小 delta，正经的形式化名字就是 ABox abduction**（不是「反事实推理」，后者在 DL 里是另一个东西）。解是一个断言集 D，使 `KB ∪ D ⊨ γ` 且 `KB ∪ D` 一致，通常要求 D 在集合包含下（或 cardinality 下）最小。
**与本项目第 ③ 步对接**：`gapPolarity = wouldProve` 的每个 gap 就是一个 abduction 子问题。因为已记下 `gapMissingPattern`，搜索空间被**预先收窄到模板匹配**，而不是全 ABox 组合爆炸。**这是延迟预算内唯一可行的溯因路径。**

## 7. 对本项目的 14 条直接含义

1. **一致性检查是三态判定的第 0 关，不是三态之一**（规范 MUST raise error）。管线应在加载/写入时维护 `kbConsistent` 标志；为假时第 ② 步直接返回 `INCONSISTENT`，**禁止输出任何证明树**。
2. **三态判定 = 两次可满足性检查**（`ENTAILED ⟺ KB∪{¬γ}` 不可满足；`REFUTED ⟺ KB∪{γ}` 不可满足）。实现上是两次 tableau/饱和调用，不需新推理原语。缓存键 `(goal, kbVersion)`，命中即 O(1)。
3. **「查不到」永远不等于「证伪」。** 任何把缺失三元组映射成 false 的代码路径都是 bug。SHACL violation 只有在**已物化闭包**上才能提升为 REFUTED。要写进代码注释或测试用例。
4. **证伪能力由 TBox 决定，不是由数据量决定。** schema 必须显式承载 `owl:disjointWith` / `NegativeObjectPropertyAssertion` / `owl:AllDifferent` / 基数约束。建议加 schema 自检：若 TBox 不相交公理数为 0，则在整个召回结果上打 `lowRefutationPower` 标签 —— 因为此时三态退化为二态，宿主会误以为「没证伪 = 可能」。
5. **概念查询 BGP 变量必须带类型三元组**（规范硬要求）。模板固定为：
   ```turtle
   ?c rdf:type owl:Class ; rdfs:subClassOf* ex:Target .
   ?x rdf:type ?c .
   ```
   不要生成无类型变量的自由 BGP。
6. **三态拆成「二值真值 + 三值认知状态 + provenance」三轴，不要发明四值逻辑。**
7. **用 certain/possible 双界替代裸三态做查询结果**（CERTAIN / POSSIBLE / IMPOSSIBLE / OUT-OF-SCOPE）。天然对应两张物化表，索引友好。POSSIBLE 是第 ④ 步的原材料。
8. **证明树必须 laconic 化再交给 LLM**，否则 40 条冗余公理诱发幻觉。截断用 min/max 三值传播：AND 取 min、OR 取 max，GAP 吞掉整支，内点为 CONDITIONAL。
9. **缺口是一等节点，放独立 label 空间，绝不进 reasoner 输入。** `gapKind` 必须区分三种；`gapRefutationEvidence` 是 gap 与「没查」的唯一区分依据。
10. **不要照抄 Grounded Circumscription 2011**（tableau 算法已知不正确）。若需 LCWA 走修正后的语义，且把推理转移到标准 DL。
11. **LCWA 只能写时物化，不能查询时算**（关闭谓词把 DL-Lite 从 FO-rewritable、EL 从 PTime 推到 coNP-complete）。250ms 预算内不做任何 closed-predicate 推理。closed scope 应作为**数据**存在（`omw:ClosureScope` 节点 + 成员谓词表），而非全局语义开关。
12. **运行时推理路径限制在 OWL 2 EL 或 RL。** 完整 DL 只在离线/异步算 TBox 分类与 justification。注意取舍：EL 缺 universal restriction 与基数约束，因此「函数性属性 + 两个不同填充者」这条证伪通道在 EL 里**不可用** —— 若证伪能力是产品刚需，就得在 EL 里显式补 `disjointWith` 或上 RL。
13. **SHACL 校验位置固定为「物化闭包之后」**，用 `sh:entailment` 声明所需蕴涵制式。SHACL-AF 只做闭包上的前向补充推导，不参与三态合并。violation 在 provenance 里标 `SHACL_CLOSED_CHECK`，与 `OWL_INFERRED` 分开存。
14. **第 ③ 步溯因的正确名字是 ABox abduction**，目标是「最小 D 使 KB∪D ⊨ γ 且一致」。gap 已记 `gapMissingPattern`，搜索空间被模板收窄。

## 来源（12 条）
1. SPARQL 1.1 Entailment Regimes, W3C REC 2013-03-21 — https://www.w3.org/TR/sparql11-entailment/
2. OWL 2 Direct Semantics (2nd ed.), W3C REC 2012-12-11 — https://www.w3.org/TR/owl2-direct-semantics/
3. Shapes Constraint Language (SHACL), W3C REC 2017-07-20 — https://www.w3.org/TR/shacl/
4. SHACL Advanced Features, W3C WG Note 2017-06-08 — https://www.w3.org/TR/shacl-af/
5. Krisnadhi/Sengupta/Hitzler, Local Closed World Semantics: Grounded Circumscription for DLs, RR 2011 — https://doi.org/10.1007/978-3-642-23580-1_22
6. Delivorias/Rudolph, Revisiting Grounded Circumscription in DLs, RR 2016 — https://doi.org/10.1007/978-3-319-45276-0_5
7. Knorr/Alferes/Hitzler, Local closed world reasoning with DLs under the well-founded semantics, AIJ 2011 — https://doi.org/10.1016/j.artint.2011.01.007
8. Lutz/Seylan/Wolter, The Data Complexity of OMQs with Closed Predicates, LMCS 15(3:23) 2019 — https://doi.org/10.23638/LMCS-15(3:23)2019
9. Kalyanpur/Parsia/Horridge/Sirin, Finding All Justifications of OWL DL Entailments, ISWC 2007 — https://doi.org/10.1007/978-3-540-76298-0_20
10. Horridge/Parsia/Sattler, Laconic and Precise Justifications in OWL, ISWC 2008 — https://doi.org/10.1007/978-3-540-88564-1_21
11. SHACL Validation in the Presence of Ontologies, arXiv 2025 — https://arxiv.org/abs/2507.12286
12. Klarman/Endriss/Schlobach, ABox Abduction in the Description Logic ALC, JAR 2010 — https://doi.org/10.1007/s10817-010-9168-z

## 检索过程说明
- 子代理侧 `web_search`/`web_fetch` 全部超时（各 60s×2），改用 PowerShell `Invoke-WebRequest` 直连：W3C 四份规范全文下载到 `.research-tmp/` 后本地 grep 取原文；DOI/书目用 CrossRef API 核验；论文摘要走 arXiv API + Springer 页面。
- DBLP 被 Anubis 反爬拦截；Semantic Scholar 返回 429。
- 明确未核验项：Knorr AIJ 2011 具体定义（付费墙）、Kalyanpur/Horridge 两篇算法内部复杂度（未读全文）、Klarman 2010 极小性定义与复杂度、SROIQ 一致性判定上界、OWL 2 Profiles 中 EL/RL 具体公理集、以及「不存在四值逻辑合并方案」这一否定命题。
