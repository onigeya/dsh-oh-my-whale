# d6 — 几何嵌入 × 本体语义 × 不确定性承载（研究子代理 embeddings 报告，已核验版）

source: 见文末来源清单（arXiv 论文摘要/表格 + W3C 规范原文 + 工作区实测）
publisher: 多方（arXiv / W3C / 本地类型声明）
pub_date: 论文 2019–2025；规范 2009–2017
accessed: 2026-11-25
confidence: high（论文数字取自已核验表格；规范条文取原文）
class: 理论选型 + 工程边界

## 三条最影响架构的结论

1. **几何嵌入的 subsumption 准确率太低，只能排序不能证明。** Box²EL（SOTA）在 Anatomy 上 H@1=0.16、GALEN 上 0.05；BoxEL 在 GALEN 上 **H@1=0.00 / MRR 0.01**、GO 上 AUC 0.68≈随机。→ 嵌入只能做 top-K 候选**排序**，K 至少要 100（H@100 才有 0.35–0.70）。
2. **OWL 2 的 annotation 在语义上等于不存在**（规范原文）。所以「给公理挂 confidence」不可能破坏可判定性 —— model theory 根本看不到它。这是置信度承载的唯一合规做法。
3. **项目的 `single` 基数在 OWL 2 EL 里写不出来。** `FunctionalObjectProperty` 被 OWL 2 EL 明确列为不支持。→ 基数必须是**存储层不变量**（唯一索引），不能是本体公理。

## EL++ 嵌入四代方法（ELEm → ELBE → BoxEL → Box²EL）

- **ELEm** arXiv:1902.10499：概念=n-ball（中心 `f(c)` + 半径 `r(c)`）；给出 EL++ 范式归约为 4 种形状：`C ⊑ D`、`C ⊓ D ⊑ E`、`∃R.C ⊑ D`、`C ⊑ ∃R.D`；ABox 消去 `C(a)` → `{a} ⊑ C`、`r(a,b)` → `{a} ⊑ ∃r.{b}`；打分 `sim(c,r,d) = -max(0, ‖f(c)+f(r)−f(d)‖ − r(c) − r(d) − γ)`；最优超参 `embedding_size=50`、`γ=-0.1`。
- **ELBE** arXiv:2202.14018：n-ball 的**交不是球** → intersectional closure 不成立 → 本体同时含 `Parent⊓Male⊑Father` 与 `Father⊑Male⊓Parent` 时方程无解，优化器退化为重合。改用**轴对齐盒**，盒的交仍是盒。
- **BoxEL** arXiv:2201.09919：盒 + 仿射变换；**Soundness 定理：loss 收敛到 0 ⇒ 嵌入是 KB 的一个模型**。
- **Box²EL** arXiv:2301.11118 / DOI 10.1145/3589334.3645648 / code github.com/KRR-Oxford/BoxSquaredEL：核心论断「现有全部 ontology embedding 都失败于忠实建模 one-to-many / role inclusion」；解法=概念和角色都表示为盒 + **bumping**（实体最终嵌入依赖具体 fact：`e_i^{r(e_1..e_n)} = (e_i − b_i) + Σ b_j`）。损失可直接抄：`L5(C,D)=‖max{0, −(d(Box(C),Box(D))+γ)}‖`、`L6(r,s)=½(L⊆(Head(r),Head(s)) + L⊆(Tail(r),Tail(s)))`、`L7(r1,r2,s)=½(L⊆(Head(r1),Head(s)) + L⊆(Tail(r2),Tail(s)))`。

### 准确率表（Box²EL Table 1，overall subsumption，H@1/H@10/H@100/MedRank/MRR/MeanRank/AUC）

| 本体 | ELEm | ELBE | BoxEL | Box²EL |
|---|---|---|---|---|
| GALEN | 0.01/0.12/0.29/1662/0.05/5153/0.78 | 0.02/0.14/0.27/1865/0.06/5303/0.77 | **0.00/0.03/0.16/4785/0.01/7163/0.69** | 0.05/0.20/0.35/669/0.10/4375/0.81 |
| GO | 0.03/0.24/0.43/272/0.09/6204/0.86 | — | **0.01/0.06/0.08/8443/0.03/14905/0.68** | 0.04/0.23/0.59/48/0.10/3248/0.93 |
| Anatomy | 0.10/0.40/0.64/22/0.19/6464/0.94 | 0.04/0.36/0.63/29/0.15/5400/0.95 | 0.03/0.12/0.28/1151/0.06/10916/0.90 | 0.16/0.47/0.70/13/0.26/2675/0.97 |

**读法**：BoxEL 有 soundness 定理，但 GALEN 上 H@1=0.00、MeanRank=7163。**理论保证 ≠ 实用准确率。**

### 表达力限制（逻辑本身，非实现缺陷）
EL++ 无：disjunction `ObjectUnionOf`、cardinality、inverse `ObjectInverseOf`、universal `ObjectAllValuesFrom`、negation `ObjectComplementOf`。只需几何化 `⊓`/`∃`/`⊑`/`⊥`。

### 实现陷阱（综述 arXiv:2406.10964 / TKDE 2025 DOI 10.1109/TKDE.2025.3559023）
> "EmEL++ 无法 faithful 捕获 role hierarchy，因为 `r ⊑ s` 的 loss 对 r、s 对称，导致 `r ⊑ s` 必然蕴含 `s ⊑ r`。"
→ 自己实现包含损失必须加**反向铰链**，否则角色层级塌成等价类。

## 近似与严格的边界（最关键的一节）

BoxEL/Box²EL 的定理是「**完美嵌入 ⇒ 存在模型**」（充分条件），**不是**「`d(Box(C),Box(D)) < 0` ⇒ `C ⊑ D`」。理由：① loss 是 max 松弛，0 只保证约束不违反、不保证严格嵌套；② 即使成立也是几何巧合而非语义蕴含；③ 反之真包含关系也常没被捕捉（MeanRank 上千）。

### 解法：类型系统级隔离（nominal typing）
```ts
declare const CAND: unique symbol
export type Candidate = { readonly axiomId: string; readonly score: number; readonly [CAND]: 'candidate' }
declare const PROOF: unique symbol
export type Proof = { readonly conclusion: AxiomId; readonly premises: readonly AxiomId[]; readonly rule: RuleName; readonly depth: number; readonly [PROOF]: 'proof' }
```
`Candidate` 只能进 `rank()/sort()/topK()`；`Proof` 只能进 `assemble()/render()`。编译期保证，非代码评审约定。

### 正确用法：嵌入排序，reasoner 判定
查询概念 Q → ①盒包含/重叠排序取 top-K（K=100）→ ②对每个候选跑严格 subsumption → ③得证进 Proof 集、未得证进 gap 集。
复杂度：朴素 `|C| × Poly(|KB|)`（|C|=45,000 GO 量级）vs 排序后 `K × Poly(|KB|)`（K=100）→ **450× 加速**。

### 反直觉补充：概念层应该暴力精确
| 层 | 规模 | 暴力搜索成本 | 内存 |
|---|---|---|---|
| 概念 | 10³ | 10³×1024 ≈ 10⁶ 次乘加 ≈ **1ms** | 4 MB |
| 概念+box | 10³ | 同上 | 8 MB |
| 实例 | 10⁵ | 10⁵×1024 ≈ 10⁸ ≈ 100ms+ | 400 MB |
→ **① 步粗召在概念层应用 `exact: true` 暴力搜索而非 ANN**：1ms、零近似误差、不需要 HNSW、不受删改导致图退化影响。近似性被限制在实例层（输出只是候选证据，不承担证明义务）。

### 版本冻结
嵌入分数依赖本体快照，本体一改分数即陈旧。复用 projects payload 的 `vec_state: 'fresh' | 'stale'`；任何 TBox 写入必须把受影响的类标 `stale`。

## BoxE 与 DL 语义的对应（arXiv:2007.06267，NeurIPS 2020）
- 实体=点，关系=n 个 hyper-rectangle（按 arity）；**Theorem 5.1**：fully expressive 当 `d = |E|^{n−1}|R|`。实用中 `|E|=10⁴/|R|=10²` 时 `d≈10⁸` 不可训练 → 实际永远是部分表达。
- 推理模式（capture/inject）：Symmetry ✓/✓、Anti-symmetry ✓/✓、Inversion ✓/✓、**Composition ✗/✗**、Hierarchy ✓/✓、Intersection ✓/✓、Mutual exclusion ✓/✓。

### 关键错配（防止「用 BoxE 一把梭」）
| BoxE 能力 | OWL 2 构造子 | 在 EL 里？ |
|---|---|---|
| Hierarchy | `SubObjectPropertyOf` | ✅ |
| Composition | 属性链 | ✅ 但 **BoxE ✗** |
| Inversion | `InverseObjectProperties` | ❌ EL 不支持 |
| Symmetry | `SymmetricObjectProperty` | ❌ EL 不支持 |
| Anti-symmetry | `AsymmetricObjectProperty` | ❌ EL 不支持 |
| Intersection | `ObjectIntersectionOf` | ✅ |
| Mutual exclusion | `DisjointClasses` | ✅ |
→ **BoxE 支持的构造子恰是 EL 禁用的那批，而它在 EL 唯一的角色构造子（property chain）上失败。BoxE 不是 EL 的即插即用几何编码。** EL 片段应走 ELEm/ELBE/Box²EL 系。

## 不确定性 DL：可判定性全景

| 家族 | 语义 | 可判定性 | 复杂度 | 可用？ |
|---|---|---|---|---|
| Fuzzy DL（Łukasiewicz/Product + GCI） | 真值∈[0,1] | **不可判定** | — | ❌ |
| Probabilistic DL（公理级 EL++） | 概率挂 GCI | 可判定 | consistency **NP-complete** | ⚠️ 仅离线 |
| Probabilistic DL（interpretation-based） | 分布 over interpretations | 可判定 | **PEXP-complete** | ❌ |
| **Defeasible DL（KLM preferential）** | 偏好序，非数值 | 可判定 | **≤ ALC** | ✅ **推荐** |

### Fuzzy DL 明确出局（原文）
arXiv:1107.4212（Cerami & Straccia）："the DL ALC with GCIs does not have the finite model property under Lukasiewicz Logic or Product Logic and, specifically, knowledge base satisfiability is an undecidable problem for Product Logic … also an undecidable problem for Lukasiewicz Logic."
arXiv:1003.1588（Bobillo/Bou/Straccia）："the fuzzy DLs ALC under Lukasiewicz and Product fuzzy logics do not verify the FMP even if we restrict to witnessed models … it affects several algorithms published in the literature for reasoning under fuzzy ALC."（**已发表的若干算法是错的**）
→ 只要有 GCI（TBox 必然有），fuzzy DL 就**没有判定过程**。不是「难」，是「不存在」。

### Probabilistic DL 必须挂在公理上
arXiv:1908.10405（Finger, LNCS 11560, pp.286–300）："We instead concentrate on assigning probabilities to **Axioms (GCIs)**. We show that the consistency detection problem … is **NP-complete**, and present a linear algebraic deterministic algorithm … using the **column generation** technique."
arXiv:1205.2652（Cozman & Polastro, UAI 2009）："… featuring Boolean operators, quantification, qualified number restrictions, nominals, inverse roles and role hierarchies. Inference is shown to be **PEXP-complete**"
→ 对 250ms 预算只能离线（dream 周期）。BUNDLE 框架（arXiv:2010.01087）用多个现成经典 reasoner 黑盒组合，是唯一可能落地方式，代价指数级重复调用。

### Defeasible DL 是唯一实用答案（最重要引文）
arXiv:1904.07559 = ACM TOCL 10.1145/3420258（Britz, Casini, Meyer, Moodley, Sattler, Varzinczak）"Theoretical Foundations of Defeasible Description Logics"：
> "We start by investigating a notion of **defeasible subsumption** in the spirit of defeasible conditionals as studied by Kraus, Lehmann and Magidor … we also analyse the problem of non-monotonic reasoning in DLs at the level of entailment and present an algorithm for the computation of **rational closure** of a defeasible ontology. **Importantly, our algorithm relies completely on classical entailment and shows that the computational complexity of reasoning over defeasible ontologies is no worse than that of reasoning in the underlying classical DL ALC.**"
→ 不确定性打包成对经典蕴含的**偏好序**，不引入新逻辑；`Complexity(defeasible) ≤ Complexity(classical)`，**渐近零成本**。语义装置 `C ⊑~ D` 读作「典型情况下 C 都是 D」。KLM 性质成立：Reflexivity / Left Logical Equivalence / Right Weakening / And / Or / Cautious Monotonicity / Rational Monotonicity。
→ **这正是「上海是用户常驻城市」比「用户去过上海」更可信、但两者都需可推理**所需要的机制。

## 置信度承载：annotation 是规范级正确答案

### 规范原文
OWL 2 Structural Specification §1 https://www.w3.org/TR/owl2-syntax/ ：
> "Annotations have no effect on the logical aspects of an ontology — that is, for the purposes of the OWL 2 semantics, annotations are treated as not being present. Instead, the use of annotations is left to the applications that use OWL 2."
OWL 2 Direct Semantics §1 https://www.w3.org/TR/owl2-direct-semantics/ ：
> "OWL 2 allows ontologies, anonymous individuals, and axioms to be annotated; furthermore, annotations themselves can contain additional annotations. All these types of annotations, however, have no semantic meaning in OWL 2 and are ignored in this document."

### 严格论证（这是定理不是希望）
1. 可判定性是**蕴含关系**的性质：`KB ⊨ α` 是否可判定。
2. 蕴含由 **model 集合**定义：`KB ⊨ α` ⟺ 所有 `KB` 的 model 都是 `α` 的 model。
3. annotation 在 model 构造前被丢弃 → `Models(KB ⊕ annotations) = Models(KB)`。
4. 因此 `KB ⊕ annotations ⊨ α` ⟺ `KB ⊨ α`，判定过程完全不变。∎

### 反过来会破坏的做法
只要把 confidence **翻译进逻辑**就进灾难区：当概率公理 → NP-complete 起；当模糊真值 → 不可判定；编码成 `SubClassOf(C,D) ⊔ …` → 离开 EL 且语义错误。
**界线**：confidence 只能是 annotation，只能用于 ①排序 ②阈值准入 ③计算 defeasible 偏好序。**永远不能用于 derive。**

### RDF reification 与 RDF-star 裁决
- **RDF 经典 reification 明确反对**：每条三元组引入 `rdf:Statement` + 3 个新三元组 → 图规模 ×4；且它**没有**把元数据挂到原三元组上，而是创建了描述该三元组的独立资源，两者无形式化连接 —— 语义空转的经典反模式。
- **RDF 1.2 triple terms（原 RDF-star）**：https://www.w3.org/TR/rdf12-concepts/ 当前状态是 **W3C Candidate Recommendation Draft, 16 November 2026**，**不是** Recommendation。原文 "Compared to RDF 1.1, RDF 1.2 introduces the ability to use an RDF triple as a **triple term**, in the object position of another triple." → 方向对但**不适合现在依赖**，且项目不走 RDF。
- **OWL 2 axiom annotations 是正确选择**：在 Recommendation 里（2009/2012）稳定。语法层每个公理产生式都带 `axiomAnnotations`：`SubClassOf := 'SubClassOf' '(' axiomAnnotations subClassExpression superClassExpression ')'`、`Declaration := 'Declaration' '(' axiomAnnotations Entity ')'`。

### 落地到 triviumdb（无 RDF 层时的结构同构）
```
Node kind: axiom
  mem_key:  axiom:<sha1(canonical_form)>        // 内容寻址：同一条公理只有一个节点
  payload:
    // ── 逻辑层（reasoner 唯一可见）──
    type:     'SubClassOf' | 'SubClassOfSome' | 'SubClassOfIntersection'
            | 'ClassAssertion' | 'ObjectPropertyAssertion' | 'DisjointClasses' | ...
    sub:      ClassExpr
    sup:      ClassExpr
    // ── 标注层（reasoner 不可见）──
    confidence:    number      // [0,1]
    evidenceCount: number
    source:        'observed' | 'inference' | 'dream'
    validFrom:     number      // epoch ms
    validTo?:      number
    supersededAt?: number
    // ── 溯源层 ──
    derivationId?: string      // 由推理产生时指向 proof 节点
```
**关键隔离**：`toOwl2El(axiom)` 是只返回 `{type, sub, sup}` 的纯函数，返回类型里**没有** confidence 字段。不仅类型不同，**数据流也不同** —— confidence 在 `toOwl2El` 处被物理丢弃。

### confidence 喂给谁：KLM 偏好序
```ts
function toPreferenceOrder(axioms: Axiom[]): PreferenceOrder {
  return axioms.filter(a => a.payload.type === 'SubClassOf')
               .sort((x, y) => y.payload.confidence - x.payload.confidence)  // 只按 confidence 降序，不改逻辑内容
}
```
再跑 rational closure（纯经典蕴含）得 `C ⊑~ D`。纯 annotation 只能**排序**；KLM 偏好序让你**推理**。这是唯一同时满足「confidence 逻辑上有意义」和「不破坏可判定性」的方案。

## 工程：向量索引与本体层级共用存储

### 硬约束（实测 triviumdb.d.ts:916–925）
`createIndex(field)` / `createNgramIndex(field)` / `createUniqueCompositeIndex(fields)` / `createOrderedIndex(field)` / `createCompositeIndex(fields)` / `createBitmapIndex(field)` —— **全部是 payload 字段索引。没有 edge label 索引，没有 edge metadata 索引。**
`GraphIntegrityReport.labelIndexMismatches`（:157）说明内部有 label 索引但未暴露。`JsSearchConfig.expandLabels`（:272）和 `minEdgeWeight`（:276）只能在图扩散时**过滤** label，不是索引查找。
→ **TBox 的 subsumption 闭包不能只靠边遍历。** 解法：在 `class` 节点 payload 里物化传递闭包：
```
Node kind: class
  mem_key: class:<iri-or-name>
  payload:
    label: string
    ancestors: string[]     // 物化的传递闭包（写时算好）
    descendants: string[]
    box_center?: number[]   // 1024 维，检索用
    box_min?: number[]      // 若需几何 subsumption 分数
    box_max?: number[]
    vec_state: 'fresh' | 'stale'
```
配 `createBitmapIndex('ancestors')` —— 数组包含查询走 bitmap 索引。「C 的所有子类」变成一次 bitmap 查找。TBox 与 ABox 仍在同一 node 表、同一 edge 表、同一文件。

### 两级锚点
- **概念锚（class-level）**：|C|≈10²–10³，1024 维（项目 G0-2 闸门实测 bge-m3 维度 1024），**暴力精确** `exact:true`。
- **实例锚（instance-level）**：|I| 可达 10⁵+，**必须 ANN**。

### 完整两级检索流程
```
Query q
 ├─ (1) 概念层：暴力精确 top-K_c over |C|        [1ms, 精确]   K_c = 8~16
 ├─ (2) 实例层：ANN top-K_i over |I|, filter by class ∈ K_c   [~50ms, 近似]  K_i = 200~500
 ├─ (3) 转成 OWL 概念查询，逐条证实/证伪          [② 步]
 ├─ (4) 未定 → Abduction 求最小 delta             [③ 步]
 ├─ (5) 仍不齐 → 信息缺口 + 部分证明子树           [④ 步]
 └─ (6) 证明 + 已有信息 + 缺口 → 合并              [⑤ 步]
```
(2) 用 `JsSearchConfig.payloadFilter`（:253，注释明确「在**向量召回阶段**生效」，即过滤在 ANN 内部而非事后）。

### 盒 vs 点
检索用点（center，余弦便宜）；排序用盒（min/max，`d(Box(C),Box(D))`）。存储代价 2×1024 floats/class = 8KB × 10³ = **8MB**，可忽略。**两者用途不同，不要混。**

## 对本项目的 17 条直接含义

### 会改动现有设计（必须处理）
1. **`single` 基数不能写成 OWL 公理**（`FunctionalObjectProperty` 在 EL 不支持清单里）。保持现状：由 `createUniqueCompositeIndex(['mem_key','active_slot'])` 强制，**不**翻译成公理。若要逻辑层基数语义必须升级 OWL 2 DL（ExpTime），代价要先算。
2. **`contradicts` 边映射为 `DisjointClasses`**（EL 支持），**不能**写 `C ⊑ ¬D`（EL 无 `ObjectComplementOf`）。单值谓词冲突形如 `DisjointClasses(∃p.{x}, ∃p.{y})`。
3. **置信度必须统一**：现状散落在 `scene.confidence`/`pref.confidence`（`docs/specs/spec-DSH哦鲸鲸/data-model.md` §3）无统一模型 → 统一为 `axiom` 节点 annotation 层。

### 新增结构
4. **新增 `axiom` 节点 kind**（第 15 个），`mem_key = axiom:<sha1(canonical)>`，payload 分逻辑/标注/溯源三层，**reasoner 只读逻辑层**。
5. **`class` 节点 payload 增 `ancestors[]`/`descendants[]`** + `createBitmapIndex`。
6. **`class` 节点增 `box_center`/`box_min`/`box_max`**（1024 维）+ `vec_state`。
7. **EL++ 四范式直接作为 `axiom.type` 枚举**：`SubClassOf`/`SubClassOfIntersection`/`SubClassOfSome`/`SubClassOfSomeReversed`。ABox 按 ELEm 消去：`C(a)` → `{a} ⊑ C`（单个体的 `ObjectOneOf` 在 EL 里合法）。

### 算法
8. 概念层 `exact:true` 暴力，不用 ANN。
9. 实例层 `searchAdvanced` + `payloadFilter`（限定候选概念）+ `expandLabels`（限定 11 个边 label）+ `minEdgeWeight`。
10. subsumption 排序用盒距离，**输出类型是 `Candidate` 不是 `Proof`**。
11. 置信度 → KLM rational closure，不引入新逻辑，复杂度 ≤ 经典 ALC。

### 明确不要做
12. ❌ fuzzy DL 承载置信度 —— 有 GCI 就不可判定（arXiv:1107.4212）。
13. ❌ RDF 经典 reification —— 图规模 ×4 且语义空转。
14. ❌ 现在依赖 RDF 1.2 triple terms —— 只是 Candidate Recommendation Draft（2026-11-16）。
15. ❌ BoxE 做 EL TBox 推理 —— 支持的构造子恰是 EL 禁用的，EL 唯一的角色构造子它不支持。
16. ❌ 在线跑 probabilistic DL —— 最好 NP-complete，实际 PEXP。只能离线。
17. ❌ 几何包含当蕴含 —— soundness 定理说的是 loss=0 ⇒ 有模型。

### 待补
18. PR-OWL / MEBN 可判定性**未核实**。
19. Box²EL bumping 在单文件嵌入式存储的落地代价未评估（实体嵌入依赖具体 fact → 实体向量不能是单一存储值，影响 `vec_state` 语义）。

## 来源
论文：ELEm arxiv:1902.10499 · ELBE arxiv:2202.14018 · BoxEL arxiv:2201.09919 · Box²EL arxiv:2301.11118 · BoxE arxiv:2007.06267 · 综述 arxiv:2406.10964 · Fuzzy 不可判定 arxiv:1107.4212 · Fuzzy 无 FMP arxiv:1003.1588 · Probabilistic EL++ arxiv:1908.10405 · PDL PEXP arxiv:1205.2652 · BUNDLE arxiv:2010.01087 · Defeasible DL arxiv:1904.07559
规范：owl2-syntax §1 · owl2-direct-semantics §1 · owl2-profiles · rdf12-concepts
实测：`D:\src\dsh-oh-my-whale\node_modules\.pnpm\triviumdb@0.9.3\node_modules\triviumdb\triviumdb.d.ts`（:916–925 索引 API、:253 payloadFilter、:272 expandLabels、:157 labelIndexMismatches、:219–279 JsSearchConfig）；`docs/specs/spec-DSH哦鲸鲸/data-model.md`（14 kind、11 edge label、mem_key 格式、active_slot 唯一索引、开放谓词集）
