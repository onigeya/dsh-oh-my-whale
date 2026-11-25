---
source: 一手 PDF 原文（Reiter 经 DynamicHS 转述、QuickXplain、Klarman JAR、Koopmann KR2020/IJCAI21、ASP-Core-2、OWL 2 Profiles W3C REC、OWL API 源码、lemmalog 源码）+ Crossref 书目核验
publisher: AAAI / Springer / ACM / IOS Press / W3C / arXiv / 仓库源码
pub_date: 1987–2024（规范 2009–2012）
accessed: 2026-11-25
confidence: medium-high（Reiter 1987、Gupta 1993、Kakas 1992 全文未取得，仅到书目层或二手精确转述，文内逐处标注）
class: 算法选型 + 复杂度边界 + 工程落点
---

# d4 — Abduction（溯因）、最小 delta、justification / axiom pinpointing

> 标注约定：**【原文】** = 规范或论文里逐字可查；**【推断】** = 我基于原文的工程推论，未见于文献；**【未核实】** = 只到书目层，未读到全文。

## 0. 一页结论（先给结论，后面才是依据）

1. **推理的证实/证伪是便宜的，溯因是唯一昂贵环节**——但在 EL/RL 片段里「昂贵」是 **P-complete**，不是不可判定。Koopmann IJCAI-21 Theorem 3：Flat L ABox abduction 对 L = EL 是 **P-complete**，对 EL++ 是 **EXPTIME-complete**，对 ALCI 是 **coNEXPTIME-complete**，对 ALCF **不可判定**。
2. **通用 ALC 上的 abduction 是「半可判定」，不是「可判定」也不是「不可判定」**——这个区分很重要。Klarman/Endriss/Schlobach 原文：「minimality checking remains in the worst case a **semi-decidable** procedure, guaranteed to output the answer in finite time **only if the answer is negative**」。也就是说：**找不到极小解时能停机（输出「没有」），找到了也无法停机确认它极小**。所以把缺失证据形式化为 ABox abduction 在 ALC 及以上必须先做**有限化**。他们的工程解法是 **local minimality（深度 n 截断）**，Prop.5 证明 n→∞ 时收敛。（Koopmann IJCAI-21 的 ALCF **不可判定**是另一件事：那是 Flat L ABox abduction 在特定片段上的判定性问题，比 Klarman 的一般情形更强。）
3. **最小 delta 不是最小 hitting set，也不是 MCS**。准确形式是：`最小 delta = 「B ∪ {¬G} ∪ A 的 MUS」里属于 A 的那部分`（定义级，一行可证）。它**是**一个横截（`min F = MHS(MCS 族)`，对合关系），但**不是** `MHS(极小冲突集)`，也**不是** `MHS(极大非解释族)`（后一种常见写法我用 600 组随机反链验过，只约四成成立——可复跑 `scripts/verify-mhs-duality.js`）；而且 **delta 与 MCS 数值上就不相等**——反例：`B={goal:-p,q}`、`A={p,q}`、`G=goal` 时 delta=`{p,q}` 而 MCS=`{p}`/`{q}`，方向相反（补证据 vs 删证据）。Reiter 的 minimal diagnosis 也只是「某族（极小冲突）的 MHS」，同型不同族。详见 §8.2.1。
4. **分层之后本维度的主战场从 DL 换到 Datalog/ASP，代价断崖式下降**：definite Datalog 上蕴含是单调的，abduction 的搜索空间由**失败证明树的叶子**决定，而不是由 KB 或几百条粗召候选决定；QuickXplain 在 n=1e6、冲突含 8 个元素时只要 **33–270 次一致性检查**【原文】。
5. **Lemmalog 现有的 `hypothetical()` / `scoped_recompute()` 只提供「变化量小」，不提供「结果极小」**——它保证结果等于从零重算（recompute-equivalence），不保证收缩是 AGM 极小的。要做第③步的「最小 delta」，缺的不是机制，是**搜索层**（命中集/QuickXplain）。这是本报告最有工程价值的一条判断，证据在 §8.2。
6. **证明树不要全量物化**。Calautti/Livshits/Pieris/Schneider PACMMOD 2024：递归 Datalog 的 why-provenance 不可处理，非递归则高度可处理【原文】。Lemmalog 已经做了正确取舍：`SUPPORT_CAP = 4`（每事实最多 4 条见证），`why()` 每规则只展开一条。缺口的表示法直接复用它的 `[unknown fact]` 分支。
7. **不要在运行时层引入 TGD/EGD（chase）**。chase 是半判定过程、可能**不终止**（arXiv:2403.16712v2 原文「merely a semi-decision procedure」；all-instances termination 对 oblivious/standard chase **不可判定**，Gogacz & Marcinkowski ICDT 2014）。在实时召回里放一个可能不停机的不动点，比 abduction 慢更严重。EGD 类约束（功能性属性）改走 **OWL 2 RL 的前向规则**：`prp-fp` 推出 `owl:sameAs`、`eq-diff1..3` 头部是 `false`——失败点落成一对具体事实，直接当 justification 处理，不需要 chase 诊断。详见 §8.3.3。

---

## 1. DL abduction 的严格形式与可判定性边界

### 1.1 定义（Klarman, Endriss, Schlobach, JAR 2011，ABox abduction in ALC）

> **【原文】** ABox abduction is 「finding minimal sets of ABox axioms, which when added to the knowledge base enforce entailment of a requested set of assertions」。
> Definition 2：solution A 满足 `K ∪ A ⊨ O`；三个筛选条件——**consistent** iff `K ∪ A ⊭ ⊥`；**relevant** iff `A ⊭ O`（不能脱离背景知识自己蕴含目标）；**minimal** 相对于 A 的 renaming 偏序（NI(B)/NI(A) 为新个体名）。
> https://staff.science.uva.nl/~ulle/pubs/files/KlarmanEtAlJAR2011.pdf ｜ DOI 10.1007/s10817-010-9168-z

三条筛选条件的工程含义【推断】：
- **consistent** → 对应本项目第②步的「一致性检查是第 0 关」（与 d5 digest 的结论合流）。不一致的 KB 上任何证明都是假的，所以 delta 必须保持一致性。
- **relevant** → 这是**防作弊条款**：不许把目标本身当假设加进去。工程上必须显式实现，否则「最小 delta」会退化成「把答案抄进去」。
- **minimal** → 这是唯一有实现难度的条件，见下。

### 1.2 关键的可判定性结论

> **【原文】** 「relevance 与 consistency 可对任意解无条件判定；但 **minimality checking remains in the worst case a semi-decidable procedure, guaranteed to output the answer in finite time only if the answer is negative**」——原因是解空间可能无限（新个体名可无限引入）。

这句话要读准：**不是「abduction 不可判定」，而是「最小性判定」半可判定**——单向可判，不是双向可判。也就是说：解可以被枚举出来，但「这个解是否已经极小」这个问题只在**否定**方向保证停机。原因很物理：ABox abduction 允许引入**新个体名**（如 ∃hasPart.Foo 里凭空造一个人），新名字可以无限嵌套，所以「更小的解」可能藏在无限深处。

### 1.3 论文自己的有限化方案：local minimality（可直接借用的停止条件）

> **【原文】** Definition 9：A 是 **n-locally minimal**，当存在 MU set S under A，使 S 中每个项 tₖ 都能由 K 中已有个体 t₀ ∈ NI 经 **≤ n 步正角色链**到达，且不存在满足同条件的更小解 B。等价于「只在深度 n 内考察 K 的可能模型」。
> Proposition 5：局部极小解集在 n → ∞ 时收敛到极小解集。

**【推断】工程含义**：把「无限深的新个体名」换成「有限跳数」，最小性判定立刻变成可判定的有界搜索。对本项目这个截断是天然的——记忆图谱本来就是有限跳数的（一个会话摘要到工具调用结果不过 2–3 跳），**深度 3 的 local minimality 就是这个系统真实需要的最小性概念**，不是妥协。

### 1.4 各逻辑片段的复杂度谱（这是选型的硬边界）

| 逻辑 | ABox abduction 复杂度 | 来源 |
|---|---|---|
| **EL**（Flat L） | **P-complete** | Koopmann IJCAI-21 Thm 3【原文】 |
| **EL++** | **EXPTIME-complete** | 同上【原文】 |
| **ALCI** | **coNEXPTIME-complete** | 同上【原文】 |
| **ALCF** | **undecidable** | 同上【原文】 |
| **ALC**（一般，非 Flat） | 解的存在性可判，但**最小性半可判定**（§1.2）；首个 complete 的 signature-based 方法见 KR 2020 | Klarman JAR 2011 + Koopmann et al. KR 2020【原文】 |
| **命题理论**（最基础） | 判定问题 **Σ₂ᴾ / NP^NP 完备**；用 prioritization 时某些情形升到**第三层** | Eiter & Gottlob JACM 1995【原文】 |

> **【原文】** Eiter & Gottlob： 「abduction is harder than deduction ... the relevant decision problems are complete for complexity classes at the second level of the polynomial hierarchy, while the use of prioritization raises the complexity to the third level in certain cases」。DOI 10.1145/200836.200838
> **【原文】** Koopmann et al. KR 2020 定义 signature-based abduction 为「building hypotheses over a specified set of names (the signature) that explain an observation relative to some background knowledge」，用于「观测词汇 ≠ 解释词汇」的诊断场景。DOI 10.24963/kr.2020/59

**【推断】选型结论**：想让第③步在 250ms 量级内跑完，**唯一出路是 EL 或 definite Datalog**。ALC 及以上不是「慢」，是复杂度类别错了（coNEXPTIME 意味着即使小规模也可能跑不完）。这与 d8 digest（OWL 2 RL as Datalog）的结论一致。按 W3C OWL 2 Profiles Table 10 逐格：**OWL 2 EL** 的 CQ answering 是 taxonomic `EXPTIME` / data `PTIME-complete` / query `NP-complete` / combined `EXPTIME`（属性层级可转多项式 NFA 时 combined 降为 `PSPACE-complete`）；**OWL 2 RL** 的 CQ 是 `PTIME-complete` / `PTIME-complete` / `NP-complete` / `NP-complete`。→ **data 复杂度在两者中都是 PTIME，只有 query/combined 才是指数级**。这是把 abduction 限制在「小 signature + 大事实」上的规范级依据。

### 1.5 signature-based abduction 为什么是工程上正确的提法

Koopmann 的提法（只允许在**指定 signature** 上造假设）解决了一个纯工程问题：**假设池必须是有限且预先声明的**。若允许任意谓词/角色参与，搜索空间爆炸且结果对 LLM 无意义（LLM 读不懂一个凭空出现的谓词）。

> **【原文】** KR 2020 的 Ebola 例子（可整段照搬到本项目的记忆场景）：
> `EbolaPatient ⊑ Patient ⊓ infectedBy.Ebola`；`contactWith.EbolaBat ⊑ EbolaPatient`；`EbolaPatient ⊑ infected.EbolaPatient`；`EbolaPatient(p1)`；观察 `Ebola(p2)`。
> → 缺的证据是「p2 曾接触蝙蝠」或「p2 被 p1 感染」，**而不是**「p2 是 EbolaPatient」（那违反 relevance）。

**【推断】映射到本项目的 schema**：signature = 记忆 schema 里**已声明的谓词集合**（如 `observedDuring`、`producedBy`、`supersedes`、`belongsToSession`），假设池 = 这些谓词在**已有个体**上的组合。个体不许新造 → 直接消掉 §1.2 那个半可判定性的**成因**（NI 可无限扩展），最小性判定变为双向可判定。这是**用 schema 换可判定性**，是本项目能做而通用 abduction 系统不能做的关键优势。

---

## 2. Justification / axiom pinpointing / hitting set duality

### 2.1 术语的准确分层（三者不是同义词）

| 术语 | 精确定义 | 出处 |
|---|---|---|
| **justification** | `J ⊆ KB` 使 `J ⊨ η` 且对所有 `J' ⊂ J` 有 `J' ⊭ η`（**极小蕴含子集**）。注意它**就是** `KB ∪ {¬η}` 的一个 MUS，不是「对偶概念」——同一个结构，换了个免费词的视角 | Horridge/Parsia/Sattler ISWC 2008；Kalyanpur et al. ISWC 2007 |
| **axiom pinpointing** | 找出**哪些公理**对该结论负责的**整个任务**（含所有极小集、含排序、含诊断） | Baader & Peñaloza 2020 章节 |
| **black-box vs glass-box** | 黑盒 = 只把 reasoner 当 `⊨` 布尔 oracle；玻璃盒 = 改 tableau 内部传播以追踪公理依赖 | Schlobach/Huang/Cornet/van Harmelen JAR 2007 |
| **laconic justification** | 去掉「可从其余公理推出」的冗余公理的 justification（**更短、可读**） | Horridge/Parsia/Sattler ISWC 2008 |

> **【原文】** Baader & Peñaloza：「Axiom pinpointing refers to the task of finding the specific axioms in an ontology which are responsible for a consequence to follow. This task has been studied, under different names, in many research areas, leading to a reformulation and reinvention of techniques.」DOI 10.3233/ssw200042
> **【原文】** Schlobach et al. JAR 2007：对「计算 minimal unsatisfiability preserving subterminologies」给出两种算法，「one implementing a bottom-up approach using support of an external description logic reasoner, the other implementing a specialized tableau-based calculus」——即黑盒与玻璃盒。DOI 10.1007/s10817-007-9076-z

**【推断】laconic 对本项目是刚需而不是优化**：第⑤步要把证明树喂给 LLM。一条 20 公理的 justification 里有 12 条是「从其余 8 条可推出」的冗余，LLM 会被噪声淹没。laconic 化是**交付格式要求**，不是性能优化。

### 2.2 黑盒法的源码级实现（OWL API，可直接照抄算法骨架）

`BlackBoxExplanation.java`（https://raw.githubusercontent.com/owlcs/owlapi/version5/tools/src/main/java/com/clarkparsia/owlapi/explanation/BlackBoxExplanation.java）：

```java
public static final int DEFAULT_INITIAL_EXPANSION_LIMIT = 50;           // :58
private static final int DEFAULT_FAST_PRUNING_WINDOW_SIZE = 10;        // :64
// 构造函数 :120 —— 窗口 = 逻辑公理数的 1%，下限 10
this(ontology, reasonerFactory, reasoner,
     Math.max(ontology.getLogicalAxiomCount() / 100, DEFAULT_FAST_PRUNING_WINDOW_SIZE));
```

三段式主流程（`getExplanation` :182）：`reset() → expandUntilUnsatisfiable() → pruneUntilMinimal() → removeDeclarations()`

- **expansion**（:202）：注释原文「We expand the axiom set using axioms that define entities that are already referenced in the existing set of axioms.」`expansionFactor = 1.25`（:212），每次触限就乘 1.25 重试。
- **contraction 快剪枝**（`performFastPruning` :305）：整窗移除后测可满足性，若变可满足就整窗加回——**把 O(n) 次检查压成 O(n/w) 次**。
- **contraction 慢剪枝**（`performSlowPruning` :342）：注释原文「Simply remove axioms one at a time. If the class being debugged turns satisfiable then we know we have an SOS axiom.」——**这正是 linear deletion-based MUS 抽取**。

**黑盒法的真实代价（源码证据）**：`isSatisfiable()`（:364）每次都 `createDebuggingOntology()`（:386）+ `createNonBufferingReasoner(...)` + `dispose()`。注释原文「The ontology is recreated before the test is performed.」→ **每次布尔 oracle 调用都重建本体 + 新建推理器**。

**【推断】对本项目的直接否定结论**：这套骨架的**算法**可以照抄，**实现**绝对不能。单进程内嵌 + 无 JVM + 250ms 预算，重建推理器的成本比推理本身高两个数量级。必须改成「增量维护闭包 + 局部重算」（即 Lemmalog 的 `scoped_recompute` 路线），把 oracle 调用从「重建推理器」降到「查一个已物化的关系」。

### 2.3 Reiter 1987 的 hitting set duality（本维度的理论地基）

**【未核实全文】** Reiter 原文（Artificial Intelligence 32(1):57–95, 1987, DOI 10.1016/0004-3702(87)90062-2）全文本轮未取得（ScienceDirect 403、常见镜像全 404、AAAI-87 会议版按编号逐一探测 AAAI87-030～AAAI87-042 的每篇首页标题，Reiter 的 diagnosis 论文不在该区间）。以下定义取自 Rodler arXiv:1907.12130 对 Reiter 框架的**精确转述**（该文本身可核验，且完整给出定义）：

> **【原文，经 Rodler 转述】** Diagnosis：`D ⊆ K` 是 DPI `⟨K, B, P, N⟩` 的 diagnosis，iff `(K \ D) ∪ B ∪ P ⊨ x` 对所有 `x ∈ N ∪ {}`。minimal diagnosis：不存在真子集仍是 diagnosis。
> **【原文，经 Rodler 转述】** Conflict：`C ⊆ K` 是 conflict，iff `C ∪ B ∪ P ⊨ x` 对某个 `x ∈ N ∪ {}`。minimal conflict：不存在真子集仍是 conflict。
> **【原文】** 「A (minimal) diagnosis for dpi is then a (minimal) **hitting set** of all minimal conflicts for dpi [15], where X is a hitting set of a collection of sets 𝒮 iff `X ⊆ ⋃_{Sᵢ∈𝒮} Sᵢ` and `X ∩ Sᵢ ≠ ∅` for all `Sᵢ ∈ 𝒮`.」
> https://arxiv.org/pdf/1907.12130

**Reiter 框架的三条硬要求（对本项目是判决性的）**：
1. 「a system description in some **monotonic** knowledge representation language for which a sound and complete inference method exists」【原文】
2. 存在 sound & complete 的推理器
3. 有「健康假设」这一层可增删的句子

**【推断】第 1 条就是分层架构的判决依据**：Reiter 的 hitting set duality 建立在**单调性**上。任意 Datalog 加了 stratified negation-as-failure 之后，加一条事实可能**摧毁**已有推导（`not q(x)` 因 q 出现而变假），单调性丧失，**duality 不再成立**。Lemmalog 的 `ast.rs:18-19` 明确写着 negation 是「negation-as-absence，engine 限制在严格更低 stratum」。所以：**第③步的溯因只能在「无否定的 strata」上做严格意义上的极小 delta；跨 strata 的 delta 只能是启发式的**。这是必须写进 schema 约束的一条。

### 2.4 三个可实现的算法（按工程适配度排序）

**(a) QuickXplain（Junker, AAAI-04）——首选**

> **【原文】** 「a generic method which works for **arbitrary CP, SAT, or DL solvers**」「We significantly accelerate the basic method by a **divide-and-conquer** strategy」
> **【原文，Table 4「Number of Consistency Checks」】**（原表为图片式排版，逐格如下；`n` = 候选约束数，`k` = 目标冲突的大小）
> · `split(n) := n/2`（方法 1，二分）：Best `log(n/k) + 2k`，Worst `2k·log(n/k) + 2k`
> · `split(n) := n−1`（方法 2）：Best `2k`，Worst `2n`
> · `split(n) := 1`（方法 3）：Best `k`，Worst `n+k`
> 印证原文一句：「the shortest path has length 1, but the longest one has length n」（指方法 2、3 的调用树深度）。
> **【原文】** 「For problems with one million of constraints, QUICKXPLAIN thus needs between **33 and 270 checks** if the conflict contains 8 elements.」
> **【原文，Theorem 1】** 「The algorithm QUICKXPLAIN(B, C, ≺) always terminates. If B ∪ C has a solution then it returns 'no conflict'. Otherwise, it returns a **preferred conflict** of (B, C, ≺).」
> https://www.aaai.org/Papers/AAAI/2004/AAAI04-027.pdf

**【推断】为什么这是本项目的正确答案**：QuickXplain 只要一个**单调的**布尔谓词 `consistent(·)`，不需要 reasoner 内部结构，不需要 SAT 编码，不需要 JVM。而 Lemmalog 已经有一个现成的、便宜的、**单调的**谓词：`hypothetical(extra, goal)`（`eval.rs:637-677`，注释原文「assert extra base facts, run to fixpoint, answer goal, then restore the store byte-identically」）。把 `hypothetical` 当 oracle 塞进 QuickXplain，检查次数按上表是 `2k·log(n/k)+2k`。

代入本项目的实际数字【推断】：k（冲突大小）≈ 3–8，n（假设池）≈ 失败证明树前沿的叶子数（通常 < 30，见 §8.1）→ 检查次数 **< 40 次**，每次是一次 `hypothetical`。若每次 `hypothetical` 是全库深拷贝，40 × 深拷贝 = 不可接受；若是增量重算，40 × 几十微秒 = 毫秒级。**所以瓶颈不在算法，在 `hypothetical` 的全库深拷贝实现**（见 §8.2）。

**(b) Reiter HS-Tree / HS-DAG（Reiter 1987 + Greiner/Smith/Wilkerson 1989 修正）**

用途不同：HS-Tree 求**所有**极小诊断（枚举），QuickXplain 求**一个**优先极小冲突。第③步要的是「一个最小 delta 去补证明」，不是「所有可能 delta」→ **QuickXplain 够用，HS-Tree 过量**。只有当第④步要「列出所有可能的调查方向」时才需要枚举。

HS-Tree 的正确剪枝（OWL API 源码实证，`HSTExplanationGenerator.java`）：
```java
// 早停条件：当前路径是某条已记录 SAT 路径的超集
private static boolean checkEarlyTermination(Set<Set<OWLAxiom>> satPaths, Set<OWLAxiom> currentPathContents)
// 注释原文："Early path termination. If our path contents are the superset of the contents of a path
//            then we can terminate here."
// 关键警告注释原文："Note that getting a previous justification does not mean we can stop.
//                   stopping here causes some justifications to be missed"
```
**【推断】这条警告是 HS-Tree 实现最常见的 bug**：剪枝必须在「路径是已记录 SAT 路径的超集」处，不能在「已见过同一 justification」处。照抄这条注释能省掉一轮调试。

HS-Tree 的实际性能问题与修复：
> **【原文，Rodler arXiv:1907.12130】** 「HS-Tree is used in a **stateless fashion**. That is, the existing search tree is **discarded** when new knowledge is obtained, albeit often large parts of the tree are still relevant and have to be rebuilt in the next iteration, involving **redundant operations and costly reasoner calls**.」→ DynamicHS 维护单一树、跨轮复用。
> **【原文，Rodler/Herold SoCS'18 StaticHS】** 「Hitting set algorithms are often used by such methods to **precompute a set of diagnoses** serving as a decision basis for iterative measurement selection」「Like Reiter's algorithm, StaticHS is **logics- and reasoner-independent**」。DOI 10.1609/socs.v9i1.18449

**【推断】对本项目极重要的对应**：本项目第③步——粗召 → 溯因 → 二次查询 → 补证明——**结构上就是 sequential diagnosis**（每轮获得新证据后重算）。而 Lemmalog 现在每轮从零开始（`scoped_recompute` 后 `why()` 重走）。DynamicHS 处理的正是「新知识到达后如何复用旧树」，是第③步跨轮复用的**现成答案**。

**(c) MARCO（Liffiton et al. Constraints 21(2), 2015）——只在需要枚举时用**

MARCO 是 MUS/MCS **枚举**的骨架算法（DOI 10.1007/s10601-015-9183-0）。**【推断】** 本项目第④步如果要「列出所有可能的信息缺口」，MCS 枚举就是 delta 枚举，MARCO 是正确骨架。但这一步不是延迟敏感路径。

---

## 3. 最小性准则的工程取舍（这是 lead 追问 ③ 的核心）

### 3.1 三种准则的准确定义与出处

> **【原文，Bienvenu KR 2008】** 研究 EL 家族中 logic-based abduction 的复杂度，考虑多种最小性准则：「**set inclusion**、**cardinality**、**prioritization**、**weight**」，并对三个判定问题（是否存在解释 / 给定假设是否∈某个可接受解释 / 给定假设是否∈所有可接受解释）分别给出 general TBox 与 EL/EL+ terminologies 的复杂度。
> **【原文，Eiter & Gottlob JACM 1995】** 「Candidates for abductive explanations are usually subjected to minimality criteria such as **subset-minimality, minimal cardinality, minimal weight, or minimality under prioritization** of individual hypotheses」。DOI 10.1145/200836.200838

| 准则 | 定义 | 复杂度归属 | 工程性质 |
|---|---|---|---|
| **subset-minimal（子集极小）** | 不存在真子集仍是解 | 标准；= 「`B∪{¬G}∪A` 的 MUS」的 A 部分 | **向上封闭族的极小元，唯一确定、构成反链**；不与权重耦合；可由 QuickXplain 直接求出 |
| **cardinality-minimal（基数极小）** | 不存在更小基数的解 | 更难（需比较所有解的大小） | **不唯一**（多个同基数解）；求一个需 MaxSAT/优化 |
| **weight-minimal（带权极小）** | 不存在总权重更小的解 | 更难 | 可编码用户偏好；权重变了结果就变 |
| **prioritization（分层）** | 按优先级层逐层最小化 | 某些情形升到多项式层级**第三层** | 表达力最强、最贵 |

### 3.2 取舍：本项目应当用哪一种

**【推断，带论证】结论：主用 subset-minimal，用 #minimize 的分层作为**次级 tie-break**，不用纯基数极小。理由三条：**

**(1) subset-minimal 是唯一与「证明树」同构的准则。** 第⑤步交付物是「路径证明 + 待调查方向」。一个 delta 若不是子集极小的，就意味着其中某条证据对证明**毫无贡献**——这条证据在证明树上没有位置，LLM 无法把它画进树里。基数极小则不保证这点：它可能选一个「数量少但每条都夹带私货」的解。**证明树的节点数 = delta 的基数，只有当 delta 子集极小时这个等式才成立。**

**(2) 分层优先级表达的是「先查什么」，不是「要几个」。** ASP-Core-2 给了精确语义：
> **【原文，ASP-CORE-2 §2.6】** 「For any integer l, let P_I_l denote the sum of integers w over tuples with w@l in weak(P, I). Then, an answer set I ∈ AS(P) is **dominated** by I′ ∈ AS(P) if there is some integer l such that `P_{I′}_l < P_I_l` and `P_{I′}_l = P_I_l` for all integers `l′ > l`. An answer set I is **optimal** if there is no I′ such that I is dominated by I′.」
> https://www.mat.unical.it/aspcomp2013/files/ASP-CORE-2.03c.pdf

**关键**：`#minimize` 是**按 level 字典序逐层**最小化的——先最小化最高 level 的总和，再依次往下。**这正是「硬约束 + 软偏好」的正确语义**，且是被 W3C 级别的标准文档固定的语义，不是我编的。

映射到本项目【推断】：把「低风险证据」（如可从已有日志再查一次的事实）放高 level（优先补），把「需用户确认的证据」放低 level（最后补）。**注意 level 高 = 优先最小化 = 越不想用**，所以**不想要的放高 level**。这是很容易搞反的一点。

**(3) 基数极小在实践中会诱导错误的调查方向。** 举例【推断】：一个「会议时间冲突」的推论，可能由 3 条低置信度的记忆（同一天、同一人、同一地点）或者 1 条高置信度的日历记忆支撑。基数极小会选后者（更短），但如果那条日历记忆是错的，整条链就崩了。子集极小不会做这个选择，它把所有 3 条都列为候选，让 LLM 判断。**第⑤步的目的是「告诉 LLM 去查什么」，不是「替 LLM 决定」——所以不该用基数极小。**

### 3.3 「最小性」在多解时的不唯一性——必须处理

**【推断】** 三种准则里只有 subset-minimal 能保证「所有极小解构成一个反链（antichain）」，这在工程上是硬需求：如果两个 delta 互相包含，则较大那个是冗余的，输出给 LLM 是噪声。基数极小与带权极小都没有这个性质。

**所以正确的处理顺序是：在 subset-minimal 反链上做权重排序，而不是「先按权重取 k 个再检查极小」。** 这个顺序不能反——反过来会得到互相包含的解。

**但要立刻加一条限定，否则会与 §6.2/§9.4 冲突**：「求全部 subset-minimal delta」的可行性**完全取决于池大小**：
- **分层设定（本项目）**：池 = 失败证明树前沿的叶子数，通常 **3–15**（§6.3）→ 全部枚举的规模上界是 `2^15` 的**上界**但实际反链远小于此，**可枚举**；且理论上撞上的 dualization 开放问题在这个 n 下**不可达**（§7.1 #6）。
- **OWL 全库设定**：池 = `O(个体数 × 角色数)`（几十万）→ **不可枚举**，此时只能求一个（QuickXplain）。

**一句话**：`subset-minimal + 权重 tie-break` 是准则；**「求几个」是规模问题，不是准则问题**。第③步求一个，第④步在池小时枚举全部、池大时求前 k。

---

## 4. 已知工具与实现清单（可核验）

| 工具 | 做什么 | 可核验出处 | 对本项目的可复用度 |
|---|---|---|---|
| **Protégé explanation**（OWL API） | justification（黑盒 expansion+contraction、HST 枚举、laconic 排序） | `tools/src/main/java/com/clarkparsia/owlapi/explanation/` 九个类 + `uk/ac/manchester/cs/owl/explanation/ordering/` | **算法可抄，实现不可用**（JVM + 每次重建推理器） |
| **Evee** | 解释**缺失**的蕴含（counterexample + abduction），ALCH 以内；有 DL 专家/本体工程师/学生三项用户研究 | KR 2024 DOI 10.24963/kr.2024/67；arXiv:2308.07294 | **唯一有软件实证的「第③④步」对标物**；输出格式可参考 |
| **ELK / EL+SAT / CEL** | EL 上的 MUS 抽取基准 | Arif/Mencía/Marques-Silva arXiv:1505.04365 §6 | 4 个医学本体 × 100 query，EL+SAT 胜率 100.0%、CEL 98.09% |
| **JuDial**（Datalog 上的 juice） | Datalog 调试 / 溯因 | 【未核实】本轮未取得原文，报告不引用其结论 | 待 d8 补充 |
| **EAX**（Explanation Annotation eXtension） | 解释标注 | 【未核实】同 d5/d7 未覆盖 | 待补 |
| **xclingo** | ASP 推导树 + 文本解释，**可选择哪些 atom/rule 进解释** | DOI 10.4204/eptcs.325.19 / 10.4204/eptcs.385.52 | **「部分证明树 + 缺口」最直接的可实现先例**（见 §8.3） |
| **NedExplain** | 单调关系查询（含聚合）的 **why-not provenance** | EDBT 2014 DOI 10.5441/002/edbt.2014.14 | 第④步「缺口」的查询级对标 |
| **DLV + weak constraints** | 带惩罚的溯因，sound & complete 编译 | TPLP 2005 DOI 10.1017/s1471068404002224 | **带权最小性的现成编译路径** |

关于「本体修补 = 溯因」的权威对应：
> **【原文】** Klaus 等，ACM JDIQ 2023：「we discuss the state-of-the-art regarding the **repairing** step. We do this by **formalizing the repairing step as an abductive reasoning problem** and situating the state-of-the-art with respect to this framework.」DOI 10.1145/3597304

**【推断】** 这句话给了本项目一个重要的**允许**：把「补全记忆」当作「修补本体」是文献里成立的做法，不是我的发明。同时也给了一个**警告**：修补文献里的成功案例都是「小规模、人工审阅」的（本体调试），没有「250ms 实时」的先例。所以本项目在这个维度上是**工程前沿，不是成熟复用**。

---

## 5. 与 KG completion / 链接预测的关系

### 5.1 本质差别（这是两个不同的问题，不是同一个问题的两种解法）

| | Abduction（本维度） | KG completion / link prediction |
|---|---|---|
| 输出 | **可证的最小假设集**：`H` 使 `KB ∪ H ⊨ O` | **候选三元组排序**：`(h, r, t)` 的分数 |
| 保证 | 若 `H` 成立则目标**必**成立（演绎有效） | 无保证；分数高 ≠ 真 |
| 失败模式 | 找不到解 → 输出「信息缺口」（第④步） | **总会**输出一个 top-k（哪怕是噪声） |
| 需要 | TBox / 规则 / signature 声明 | 只要三元组 + 嵌入空间 |
| 可解释性 | 天然（假设集 = 要查的证据清单） | 弱（需要额外归因） |
| 复杂度 | P-complete（EL）～coNEXPTIME（ALCI） | 训练 O(n)，推理 O(1) 内积 |

**【推断】最关键的一条差别**：KG completion 的**不可反驳性**是它在审计场景下的致命缺陷。本项目第⑤步要把结果交给 LLM 做决策，LLM 需要知道「这条推论**凭什么**成立、**还缺什么**」。一个 softmax 分数无法回答这个问题，而且**永远不会说「我不知道」**——而第④步「把信息缺口作为一等产物」恰恰要求系统能说「我不知道」。

**这条判断有一个外部印证，不是我一个人的怀疑**：
> **【原文，Sun/Vashishth/Sanyal/Talon/Wang, ACL 2020】** 「we notice that several recent papers report **very high performance**, which largely outperforms previous state-of-the-art methods. In this paper, we find that this can be attributed to the **inappropriate evaluation protocol** used by them and propose a simple evaluation protocol to address this problem. The proposed protocol is **robust to handle bias in the model**, which can substantially affect the final results.」DOI 10.18653/v1/2020.acl-main.489
> https://aclanthology.org/2020.acl-main.489/

**【推断】** 也就是说：KGC 领域自己的论文承认，**已发表的高分里有一部分是评测协议（测试集泄漏 / 偏置）造成的，而不是模型真能预测**。这从外部支持了 §5.1 的判断——KGC 的分数**不能当作证据**用于审计链路。对本项目的直接含义：**即使要用嵌入排序候选（§5.2），也绝不能让嵌入分数出现在交付给 LLM 的证明树里**，它只能作为「内部候选生成器」。

### 5.2 能否组合？能，但顺序与接口必须固定

**【推断，具体方案】** 三层流水线：

```
① abduction 定结构：产出 subset-minimal delta 的集合 {H₁, H₂, ...}（符号层，可证）
② 嵌入排序候选：对每个 Hᵢ 里的假设，用向量检索在候选池里找「最可能的实例化」
③ 回到符号层验证：把②选出的实例化放回 hypothetical() 验证，通过则入证明树
```

**为什么必须这个顺序**：abduction 的第一层决定了**搜索空间的结构**（要找几条证据、每条证据的谓词是什么），嵌入只在这一层**内部**做实例排序。反过来（先嵌入后结构）会退化成普通 RAG，失去可证性。

**为什么第③步不能省**：嵌入的输出是概率性的，必须回到符号层验证才能入证明树。这一步把「概率候选」升级为「已证实节点」——**这是整个组合方案的价值所在**：嵌入负责「提出」，符号负责「裁决」。

**文献依据的诚实说明**【未核实】：本轮检索（Crossref，三组不同措辞：`abduction knowledge graph embedding link prediction`、`abductive reasoning knowledge graph completion`、`explanation missing link knowledge graph abduction`）**没有**找到把「DL/Datalog abduction + KG embedding」组合的权威论文。返回的全是纯嵌入侧（KGC 方法、GNN 解释子图）或纯符号侧（abductive causal reasoning 教科书章节），**没有一篇同时做两件事**。

已知最接近的两条：
- Bertossi & Salimi, IJAR 90:226–252, 2017（「Causes for query answers from databases: **Datalog abduction**, view-updates, and integrity constraints」，DOI 10.1016/j.ijar.2017.07.010）——把 query answer 的 cause 等同于 Datalog abduction，**没有嵌入层**。
- Mihindukulasooriya, Rico, Santana-Pérez, *Repairing Hidden Links in Linked Data*, K-CAP 2017, DOI 10.1145/3148011.3148020（**仅书目层，摘要未取得**：ACM DL 被 Cloudflare 拦，返回「Just a moment...」）——标题方向对（补隐藏链接），但**无法确认其方法是否是最小修正集**，故本报告不引用其结论。

所以上面这个三层组合是**我的推断**，不是文献结论。这一点必须写清楚。

---

## 6. 规模与代价：求 subset-minimal delta 在真实规模下要多少钱

### 6.1 三种实现的代价谱

| 实现 | 何时用 | 每次 oracle 调用的代价 | 调用次数 | 备注 |
|---|---|---|---|---|
| **直接搜索（QuickXplain，单调 oracle）** | 求**一个**极小解 | 一次 `hypothetical()` | `2k·log(n/k)+2k`【原文】 | **首选**：零依赖、无编码、无需 SAT |
| **SAT 编码（MUS/MCS）** | 求**全部**极小解、或需基数约束 | 一次 SAT 求解（毫秒级） | 每轮 1–2 次 | **本项目不需要**：求一个极小 delta 用 QuickXplain 即可；引入求解器是无收益的依赖 |
| **MaxSAT / #minimize** | 基数极小 / 带权极小 | 一次 MaxSAT 求解 | 每轮 1 次 + 迭代 | 需 MaxSAT；比 SAT 贵一个量级 |
| **HS-Tree / MARCO** | **枚举**全部极小解 | 每次节点一次 oracle | 指数级节点数 | 只在第④步枚举缺口时用 |

### 6.2 关键的复杂度事实（决定能不能做）

> **【原文，Eiter & Makino JACM 54(5):24, 2007】** 「either tractability results in terms of **polynomial total-time algorithms**, intractability results ..., or semi-tractability results in terms of **solvability in quasi-polynomial time**, established by **polynomial-time equivalence to the problem of dualizing a monotone CNF expression**」「refute a longstanding conjecture by Selman and Levesque」。DOI 10.1145/1284320.1284323

**这条是本维度的理论核心**：从 Horn 理论**枚举全部**溯因解释，**多项式等价于单调 CNF 对偶化**（= 求全部极小横截）。即：`枚举全部解释 ≡ dualization`。**注意「全部」二字**：求**一个**极小解释不需要对偶化（§8.2.1 第三步，QuickXplain 一步到位），只有**枚举全部**才撞上对偶化。

> **【原文】** Eiter & Makino, LNCS 2003, 标题即结论：《Abduction and the Dualization Problem》DOI 10.1007/978-3-540-39644-4_1
> **【原文，Eiter/Gottlob/Makino, SIAM J. Comput. 32(3):514–537, 2003】** 「We consider the problem of dualizing a monotone CNF (equivalently, computing **all minimal transversals of a hypergraph**) whose associated **decision problem is a prominent open problem in NP-completeness**.」——**仍未定，不是已知 NP-hard**。DOI 10.1137/s009753970240639x
> （注：此前版本把该文误记为 Kavvadias & Stavropoulos；Crossref 按 DOI 反查显示作者是 **Eiter, Gottlob, Makino**，标题为 *New Results on Monotone Dualization and Generating Hypergraph Transversals*。已更正。）

**【推断】这三个事实合起来给出的工程判断**：
- 「全部极小 delta」的最坏情况没有已知的多项式算法，但**也没有被证明做不到**——它是那个著名的开放问题。
- 「一个极小 delta」是**便宜的**（QuickXplain，`2k·log(n/k)+2k` 次单调检查）。
- **所以本项目必须只求「一个（或前 k 个）极小 delta」，不能求「全部」**。求全部会撞上开放问题。

### 6.3 本项目的真实规模代入

**【推断，逐个数字给依据】**

| 量 | 本项目实际值 | 依据 |
|---|---|---|
| 粗召候选 n（作为 delta 池） | **几百条**——**但这不是 delta 池** | 见下 |
| **delta 池的真实大小** | **失败证明树前沿的叶子数，通常 3–15** | §8.1 的推导 |
| 冲突大小 k | 3–8 | 典型 DL 例子的 justification 规模；QuickXplain 原文举例也用 k=8 |
| TBox 公理数 | 几百条（若走契约层则 < 100） | m00481 新设定 |
| QuickXplain 检查次数 | `2·8·log₂(15/8)+2·8 ≈ 30` 次（上界；实际常更少） | 代入 §2.4 公式，k=8, n=15 |
| 每次检查的代价 | **取决于 `hypothetical()` 实现** | 现为全库深拷贝 → 需改增量 |

**结论【推断】**：在「只求一个极小 delta」+「delta 池 = 证明树前沿」+「用 QuickXplain」这三个条件下，**第③步的搜索层开销可以忽略**（几十次单调检查）。真正的成本在 oracle 实现（`hypothetical` 的深拷贝）与证明树的物化策略上，**不在命中集计算上**。这与「abduction 是 bottleneck」的直觉相反——那个直觉来自 DL 的全 KB abduction，不是 Datalog 的局部 abduction。

---

## 7. 【新设定】双引擎分层下：哪些结论失效、哪些更重要、哪些代价消失

> 这一节回答 m00481 的三问。前提：运行时层 = Datalog（含扩展），契约层 = OWL 2 RL/SHACL，只覆盖少数核心概念；禁止对整层情景记忆施加完整 OWL。

### 7.1 只在「OWL 覆盖全库」时成立、在契约层设定下**失效或大幅简化**的结论

| # | 旧结论 | 在新设定下 | 依据 |
|---|---|---|---|
| 1 | **ABox abduction 的最小性判定半可判定**，必须做 local minimality 深度截断 | **失效（问题消失）**。Datalog 上不存在「无限新个体名」问题——个体来自有限事实集，`hypothetical()` 只接受 `(&str, &[Value])` 已有的值。最小性变成**有限搜索**，可完全判定。**半可判定这个障碍整个消失**。 | Klarman「minimality checking … semi-decidable」的成因是 NI（新个体名）可无限扩展；Datalog 无此自由 |
| 2 | **ALC/ALCI 上 abduction 是 coNEXPTIME-complete / ALCF 不可判定**，必须收紧到 EL | **失效（问题消失）**。delta 池不再是 DL 公理，是 Datalog 事实；复杂度从「逻辑片段」问题变成「规则层」问题。EL 的 P-complete 保证**不再需要**，因为 workload 根本不在 EL 上。 | Koopmann IJCAI-21 Thm 3 |
| 3 | 需要 **signature-based abduction** 来限制假设池（Koopmann KR 2020） | **大幅简化**。signature 由 schema 直接给定（谓词白名单存表），不需要从本体里推导 signature；假设池 = `(谓词白名单) × (已有个体)` 的**可枚举有限集**。 | KR 2020 的 signature 是为「观测词汇 ≠ 解释词汇」的本体场景设计的；Datalog 谓词天然分层 |
| 4 | **laconic justification** 是刚需 | **大幅降级为「可选」**。Datalog 的规则触发树天然没有「公理间互相蕴含」的冗余（规则是单向的），laconic 化处理的「公理 A 可从其余公理推出」情形在 Datalog 里对应「规则 A 的头部可由其他规则导出」——可以用 `uninstall(id) + ask + 重装` 直接测，不需要 laconic 的专门算法。 | Horridge ISWC 2008；lemmalog `eval.rs:1429 uninstall` |
| 5 | **黑盒 justification 需 expansion/contraction 两阶段 + 1.25 倍扩张因子** | **失效**。expansion 阶段是为了「从全本体里捞出相关公理」（因为 OWL 本体是全库、无边界）；Datalog 里相关性由规则体的可达性直接给出，一次反向可达分析即可，不需要猜测式扩张。 | OWL API `BlackBoxExplanation.java:202-247` |
| 6 | **「枚举全部」极小 delta 在最坏情况下撞上单调对偶化的开放问题**（Eiter–Makino） | **仍成立但不可达**。注意是「枚举全部」才撞上；求**一个**极小 delta 只用 `2k·log(n/k)+2k` 次单调检查，与对偶化无关。分层后 n 从「几百条粗召」缩到「证明树前沿的 3–15」，**即使枚举也变可行**。 | Eiter & Makino JACM 2007；Eiter/Gottlob/Makino SIAM 2003 |
| 7 | 需要 **HS-Tree / DynamicHS** 做跨轮复用 | **大幅简化**。HS-Tree 的存在理由是「reasoner 调用昂贵，必须复用搜索树」（Rodler 原文：costly reasoner calls）。Datalog 的 oracle 是 `hypothetical()`，比 DL reasoner 便宜 2–3 个数量级，**跨轮复用的收益下降**；真正需要复用的是**证明树**（交付物），不是**搜索树**（内部状态）。 | Rodler arXiv:1907.12130 原文 |

### 7.2 仍然成立、而且在新设定下**更重要**的结论

| # | 结论 | 为什么更重要 | 依据 |
|---|---|---|---|
| 1 | **relevance 条件（`A ⊭ O`）必须显式实现** | 分层后 delta 是「往 Datalog 里加事实」，不加 relevance 检查会退化成「把目标本身当假设」。而且 Datalog 里这更危险：一条 `goal(x) :- ...` 的事实就是直接抄答案。 | Klarman Def.2【原文】 |
| 2 | **一致性检查是第 0 关**（与 d5 合流） | 契约层用 RL 时，一致性是 PTIME-complete（OWL 2 Profiles Table 10）；但**分层后一部分约束跑到了 Datalog 层**（否定即缺席），意味着「不一致」可能表现为「查询结果异常」而非「KB 不一致」——**更隐蔽，更需要显式检查**。 | W3C OWL 2 Profiles Table 10 |
| 3 | **subset-minimal 是唯一与证明树同构的最小性准则**（§3.2） | 分层后证明树是**规则触发树**，比 tableau 树简单得多，于是「delta 基数 = 证明树新增节点数」这个等式**变得精确可算**，而不是近似。 | 本报告 §3.2 + §8.3 |
| 4 | **QuickXplain 是最优选择** | 分层后 oracle 变便宜且**天然单调**（definite Datalog 上 `hypothetical` 对 extra 单调），QuickXplain 的前提**被满足得更彻底**。旧设定下 ALC 的蕴含不单调（加公理可能破坏一致性），QuickXplain 其实有隐患；新设定下隐患消失。 | Junker AAAI-04【原文】+ lemmalog `hypothetical` |
| 5 | **证明树不要全量物化**（Calautti 2024） | 分层后 Datalog **一定**有递归（记忆提炼管线就是递归的），而递归 Datalog 的 why-provenance 不可处理是**已知定理**。分层**没有**消除这个代价，反而让它成为主约束。 | PACMMOD 2(2) 2024 DOI 10.1145/3651146【原文】 |
| 6 | **带权/分层最小性用 `#minimize` 语义** | 分层后「哪些证据优先补」成为核心 UX 问题（第④步要输出「待调查方向」，顺序就是价值）。ASP-Core-2 的逐层字典序语义是规范级依据。 | ASP-Core-2 §2.6【原文】 |
| 7 | **Reiter 框架要求单调 KR 语言** | 分层后这条从「理论脚注」变成**架构约束**：`ast.rs:18-19` 的 negation-as-absence 使 strata 之间非单调，所以 delta 只在**单 stratum 内**严格成立。这是必须写进 schema 的第二条约束。 | Rodler 转述 Reiter【原文】+ lemmalog 源码 |

### 7.3 代价：从「几十万三元组」降到「少数核心概念」——哪些消失、哪些照旧

| 代价项 | OWL 覆盖全库 | 契约层（少数核心概念） | 判据 |
|---|---|---|---|
| **TBox 上的 abduction 搜索空间** | 假设池 = O(个体数 × 角色数)，几十万量级；且受 signature 限制才可行 | 假设池 = O(核心概念数²)，**几十到几百** | 【推断】基于 §1.5 |
| **一致性检查** | N2EXPTIME-complete（OWL 2 DL Direct Semantics）→ **不可行** | RL：PTIME-complete；EL：PTIME-complete | OWL 2 Profiles Table 10【原文】 |
| **justification 抽取** | 需黑盒 expansion/contraction，每次检查重建推理器 | 附着在契约层上，公理数 < 100 → 穷举删除法（O(n) 检查）直接可行 | §2.2 源码证据【原文】 |
| **推理器内存** | 完整 OWL 2 DL reasoner（HermiT/ELK）常驻，几十 MB 起 | 若走 RL→Datalog 编译，**不需要独立推理器**——与运行时层共用同一个引擎 | d8 digest（OWL 2 RL as Datalog） |
| **启动时间** | reasoner 冷启动（分类整个本体）秒级 | 物化闭包增量维护，无冷启动 | d7 digest（embedded reasoner cost） |
| **工具链** | 需 OWL API / Protégé 生态（JVM） | **消失**——单进程、无 JVM、无子进程（符合工程约束） | OWL API 源码的 `dispose()`/重建模式 |
| **证明树的物化代价** | 依附于 justification，规模小 | **照旧存在，而且更突出**——递归 Datalog 的 why-provenance 不可处理 | Calautti et al. PACMMOD 2024【原文】 |
| **单调性假设（Reiter 前提）** | 由 OWL 的单调语义天然满足 | **照旧存在，而且更危险**——negation-as-absence 破坏单调性 | `ast.rs:18-19` |
| **最小性判定的半可判定性** | **半可判定**（Klarman：只在否定方向保证停机） | **消失**——个体集有限，双向可判定 | §1.2 vs §7.1#1 |
| **枚举全部极小 delta 的开放问题** | 撞上开放问题 | **只影响第④步「列出所有缺口」**，不影响第③步。撞上概率随 n 变小而**大幅降低**，但理论上照旧存在 | Eiter/Gottlob/Makino SIAM 2003【原文】 |
| **TGD/EGD 冲突的诊断机制** | 需 chase：TGD 可能**不终止**（半判定过程），EGD 冲突需专门的冲突解释 | **消失**——RL 把功能性属性编译成 `prp-fp`/`prp-ifp` 前向规则、把矛盾编译成 `eq-diff1..3` 的 `false` 头，失败点是一对具体事实 → **退化成 justification（§2.3）** | OWL 2 Profiles §4.3 规则表【原文】；§8.3.3 |

**一句话总结这一节**：分层把「本维度 6 项代价」清零——**最小性的半可判定性**（Klarman 的 NI 无限扩张问题）、**N2EXPTIME 一致性检查**（Direct Semantics 表 10）、**signature 推导**、**expansion 阶段**（OWL API 1.25 倍扩张）、**JVM 工具链**、**TGD/EGD 冲突诊断机制**（chase）；把 3 项从「次要」升为「主约束」——**proof-tree 物化**（Calautti 2024 递归不可处理）、**跨 stratum 单调性**（`ast.rs:18-19`）、**优先级最小化**（`#minimize`）；剩下 **dualization 开放问题**在理论上照旧，但在 n=3–15 的实际规模下不可达。

---

## 8. 三个追问

### 8.1 Datalog / ASP 上的溯因 vs OWL ABox 溯因

#### 8.1.1 ALP 的正确定义（奠基文献）

> **【未核实全文】** Kakas, Kowalski, Toni《Abductive Logic Programming》JLC 2(6):719–770, 1992, DOI 10.1093/logcom/2.6.719。ALP 的奠基综述。
> **【未核实全文】** Kakas, Kowalski, Toni《Abduction in Logic Programming》LNCS 2002, DOI 10.1007/3-540-45628-7_16。

ALP 的标准框架（教科书定义，三家一致）：abductive framework `⟨P, A, IC⟩`——`P` 逻辑程序、`A` **abducible 谓词集合**、`IC` 完整性约束。解释 `E ⊆ A`（ground 实例化）满足：`P ∪ E ⊨ IC`（**一致性**）且 `P ∪ E ⊨ G`（**覆盖目标**）。最小性同样是子集极小。

**【推断】注意它与 DL ABox abduction 的**结构同形**：`⟨T, A, ⊥⟩` vs `⟨P, A, IC⟩`。三要素一一对应（背景知识 / 假设池 / 一致性条件）。**所以 §1–§3 的算法结论可以直接搬过来**，变的是 oracle 的实现与复杂度，不是算法的形状。这是本报告最重要的一条结构洞察。

#### 8.1.2 两者的实质差别（要逐条比）

| 维度 | OWL ABox abduction | Datalog/ASP abduction | 出处 |
|---|---|---|---|
| 假设的形式 | ABox 公理（`C(a)`、`r(a,b)`），**可引入新个体名** | ground 事实 `p(c̄)`，**个体来自有限域** | Klarman Def.2【原文】 |
| 最小性判定 | **半可判定**（解空间可能无限） | **可判定**（有限域） | 同上 |
| 复杂度（小片段） | EL: P-complete；EL++: EXPTIME-complete | definite Datalog: 见下【推断】 | Koopmann IJCAI-21 Thm 3【原文】 |
| 蕴含判定 | tableau / 自动机（贵） | 最小不动点迭代（便宜，PTIME data 复杂度） | OWL 2 Profiles Table 10；Datalog 语义 |
| 非单调性 | OWL 单调（无 NAF） | **stratified NAF 是非单调的** | `ast.rs:18-19`【源码】 |
| 一致性条件 | `K ∪ A ⊭ ⊥`（本体一致性） | `P ∪ E ⊨ IC`（完整性约束） | ALP 标准框架 |
| 可用的成熟工具 | Protégé/Evee/OWL API（JVM 重） | DLV / clingo（子进程，**违反工程约束**） | §4 |

#### 8.1.3 「溯因作用在规则上」的直接先例

> **【原文】** Gavanelli, Lamma, Riguzzi, Bellodi, Zese, Cota, Fundamenta Informaticae 2018：「**Datalog±** ... is able to express the **DL-Lite** version defined in OWL」「we show that **Abductive Logic Programming (ALP) can be used to represent Datalog± ontologies**, supporting query answering through an abductive proof procedure」；用名为 **SCIFF/IFF** 的 ALP 框架，前后向推理都支持，实验证明与 DL reasoner 竞争。DOI 10.3233/fi-2018-1658

**【推断】这是文献里「契约层 = DL-Lite/RL，运行时层 = Datalog，溯因在 Datalog 上做」这个架构的**唯一直接先例**。它证明该架构成立，且性能可与 DL reasoner 竞争。本项目可以引用它作为架构合理性依据，同时它**不提供** 250ms 实时性的证据（它的评测是 query answering 而非交互延迟）。

另外两条：
> **【原文】** 《Modeling Variations of First-Order Horn Abduction in Answer Set Programming》Fundamenta Informaticae 2016：「we are looking for preferred solutions with respect to three objective functions: **cardinality minimality, coherence, and weighted abduction**. We represent this reasoning problem in Answer Set Programming」「it requires **value invention** and equivalence between certain constants, because the **Unique Names Assumption does not hold in general**」「We identify **term equivalence as a main instantiation bottleneck**」。DOI 10.3233/fi-2016-1446
> **【原文】** 《Abductive logic programs with penalization》TPLP 2005：「we implement a system supporting the proposed abductive framework on top of the **DLV** engine ... we design a translation from abduction problems with penalties into logic programs with **weak constraints**. We prove that this approach is **sound and complete**」。DOI 10.1017/s1471068404002224

**【推断】第一条给了本项目一个必须避开的坑**：一阶 Horn 溯因的「value invention」（造新常量）+ UNA 不成立 → term equivalence 成为实例化瓶颈。**本项目的对策已经在架构里了**：个体不许新造（signature 限制在已有值域），UNA 由 `Value` 类型天然成立。所以这个瓶颈不适用。但它警告：**一旦允许 abduction 创造新实体（如 `∃hasPart.Foo`），实例化开销会爆炸**——这应该被写成 schema 禁止项。

#### 8.1.4 ASP 的 `#minimize` 与 `#show`

`#minimize` 语义见 §3.2（ASP-Core-2 §2.6 原文）。`#show` 的作用是**限制输出**，不是「解释」。

**【原文，ASP-Core-2 §2.7】** 「query answering corresponds to **cautious (or skeptical) reasoning**」——查询答案是所有 answer set 的交。

**【推断】** `#show` 本身**不是**「部分证明树 + 缺口」的表示法，它只是输出过滤。真正做解释的是 **xclingo**（§8.3）。这一条要明确否掉——lead 的追问里把 `#show` 列为候选，但查证后它不是。

### 8.2 「最小 delta」与「最小 hitting set」是不是同一件事？（准确对应 + DRed + 核收缩）

#### 8.2.1 准确的对应关系（**含一个可自行验证的反例**）

设 `A` = 可溯因假设池（abducibles），背景 `B`（规则 + 基事实）、目标 `G`。

**第一步：把「加假设」改写成「不可满足」，这一步是整个对应关系的钥匙。**

```
B ∪ H ⊨ G   ⟺   B ∪ H ∪ {¬G} 不可满足
```

于是定义：

```
成功族   F  = { H ⊆ A : B ∪ H ∪ {¬G} 不可满足 }        —— 对含入向上封闭
最小 delta = min(F)                                    —— 子集极小的那些 H
```

**第二步：`min(F)` 就是「把 `A` 当软约束、`B ∪ {¬G}` 当硬约束」时 MUS 的 `A` 部分。**

```
H ∈ min(F)  ⟺  H 是 A 中极小的「使 B ∪ H ∪ {¬G} 不可满足」的子集
            ⟺  B ∪ H ∪ {¬G} 含有一个以 H 为 A-部分的极小不可满足集
```

这个等式是**定义级**的，一行可证：`H` 极小子集使 `B ∪ H ∪ {¬G}` 不可满足，正是「以 `B ∪ {¬G}` 为硬核、`H` 为 A-部分的极小不可满足集」的定义。**这是本项目应当直接使用的形式**（见第三步）。

> **一个必须说准的措辞**：严格说 `B ∪ H ∪ {¬G}` 本身**不必**是整族 `B ∪ A ∪ {¬G}` 的 MUS——极小性是**只对 `A` 元素**说的。若删掉 `B` 里某个元素后仍不可满足，那它才是更小的 MUS，此时 `H` 仍属于 `min(F)`。所以正确的说法是「以 `H` 为 A-部分的极小不可满足集」，**不能说成「`B ∪ H ∪ {¬G}` 是一个 MUS」**。（实现上无所谓：QuickXplain 只在 `C = A` 上做切分，`B` 不动，所以它返回的正是 `min(F)` 的元素。）

**第三步：这就是为什么 QuickXplain 能直接算它。**

QuickXplain 的输入要求是「`B ∪ C` 不一致」，输出是「`C` 的极小子集 `C'` 使 `B ∪ C'` 不一致」【原文，Junker AAAI-04】。代入：

```
QuickXplain(B := B ∪ {¬G},  C := A)  →  返回极小 C' ⊆ A 使 B ∪ C' ∪ {¬G} 不可满足
                                       = 一个最小 delta
```

**注意这条路径完全不经过「先枚举冲突、再求横截」**——它直接产出极小 delta。这是工程上唯一该走的路（见第五步）。

**第四步：正确的横截刻画，以及一个证明「最小 delta ≠ MCS」的反例。**

记号：`MHS(𝒮)` = 族 `𝒮` 的**全部极小横截**（minimal hitting sets：与每个成员相交，且自身子集极小）。

```
MUS 族  = min(F)  = 最小 delta 族                       （第二步已证）
MCS 族  = MHS( min(F) )  = 对 (B ∪ {¬G}, A) 的全部极小修正集
min(F)  = MHS( MCS 族 )                                 （对合，反向）
```

后两条合起来就是 **MHS 在反链上的对合性（involution）**：`MHS(MHS(S)) = S`。这正是 MARCO / MUS–MCS 枚举算法能「双向交替推进」的原因（Liffiton & Sakallah, JAR 40(1):1–33, 2007, DOI 10.1007/s10817-007-9084-z；MARCO, Constraints 21(2), 2015, DOI 10.1007/s10601-015-9183-0）。

> **【自验，非文献结论】** 我用 600 组随机生成的反链（A 的大小 3–4）暴力枚举全部子集验证了这三条：`MCS = MHS(min F)` 与 `min F = MHS(MCS)` 各 **600/600** 成立。
> 复跑方式：`node scripts/verify-mhs-duality.js`（固定随机种子，可复现；实测输出 `C1=600 C2=600 C3=259 C4=0`）。
> 同一次自验还**推翻了我自己先前写的一个公式**：`min(F) = MHS(max(2^A \\ F))`（即「对极大非解释族求横截」）只在 **259/600** 成立（随采样在四成附近浮动），而同样对「极大非解释族」求横截去算 MCS 是 **0/600**——两个都错。**这个常见写法是错的**，反例极简：`A = {p, q}`、`min(F) = {{p}}` → `max(2^A \\ F) = {{q}}`、`MHS = {{q}}`，而正确结果是 `{{p}}`。所以横截必须对 **MCS 族**求，不能对「极大非解释族」求——尽管 MCS 的补恰好就是极大非解释族（`A \\ D` 对 `D ∈ MCS`），两个族的**方向相反**，求横截的结果就完全不同。

**反例（证明「最小 delta ≠ MCS」，三步可验）**：

```
B = { goal :- p, q }        A = { p, q }        G = goal
F = { {p,q} }               min(F) = { {p,q} }              ← 最小 delta 是 {p,q}

MCS（极小修正集）：
  去掉 p → B ∪ {q} ∪ {¬goal} 可满足  ⟹  {p} 是 MCS
  去掉 q → B ∪ {p} ∪ {¬goal} 可满足  ⟹  {q} 是 MCS
  MCS = { {p}, {q} }
```

**所以：最小 delta = `{p,q}`，而 MCS = `{p}` 或 `{q}`。二者不相等，而且方向相反**——MCS 是「去掉哪几条就不需要证明了」，delta 是「补上哪几条就能证明」。对合给出的是反解：

```
min(F) = MHS(MCS) = MHS( {{p},{q}} ) = { {p,q} }   ✓
```

**第五步：与 Reiter 的`minimal diagnosis` 的关系——同一定理，不同族，反向处置。**

| | 被求横截的族 | 命中一个元素意味着 | 单调前提 |
|---|---|---|---|
| **Reiter minimal diagnosis** | 极小冲突集（每个冲突已能推出坏观测） | **移除 / 判定为故障**（`ab(c)` 成立） | 系统描述须为「monotonic KR language」【原文，经 Rodler 转述】 |
| **本项目最小 delta** | **MCS 族**（= `MHS(min F)`） | **添加 / 断言为证据**（`h` 加入 KB） | definite Datalog（无 NAF 时）单调 |

两者都是「对某个族求极小横截（MHS）」——**这就是 Reiter 1987 hitting set duality 的通用形式**；但**族不同、处置方向相反**，所以不能把两者的结果互相套用。

**【推断】对 lead 追问的准确回答**：

> **不是同一件事，但同源。** 精确说法三条：
> 1. **最小 delta = 「`B ∪ {¬G} ∪ A` 的 MUS」的 `A` 部分**（定义级，一行可证，**这是该用的形式**）。
> 2. **最小 delta = MHS(MCS 族)**（对合刻画；等价但需要先算出全部 MCS，工程上不划算，只用于正确性证明与第④步的缺口枚举）。**注意不能写成 `MHS(max(2^A \ F))`**——方向相反；我的 600 组自验里这个错写法只有 259/600 成立（用它去算 MCS 则是 0/600）。
> 3. **最小 delta ≠ MCS**。上一步的反例给出 `delta={p,q}` vs `MCS={p}`/`{q}`——把这两者混为一谈会让实现方向整个反掉（去删证据而不是补证据）。Reiter 的 minimal diagnosis 也只是「某族（极小冲突）的 MHS」，与 delta 同型不同族。
>
> **工程结论**：既然第 1 条成立，**第③步不要走横截路线**。「枚举冲突 → 求 MHS」是把一个 `2k·log(n/k)+2k` 的问题变成一个指数枚举问题。**QuickXplain 一步到位**（第三步），横截只作为**正确性证明**与**第④步枚举缺口**时的骨架。

#### 8.2.2 DRed 的原始出处与复杂度

> **【原文，Crossref 已核实书目】** Gupta, Mumick, Subrahmanian《Maintaining views incrementally》SIGMOD 1993, pp.157–166, **会议版 DOI 10.1145/170035.170066**（期刊版 10.1145/170036.170066，ACM SIGMOD Record 1993-6；MIT Press 重印版 10.7551/mitpress/4472.003.0019）。
> **【未核实全文】** DRed 的**精确复杂度定理**本轮未取得原文（Gupta 1993 全文多次尝试失败）。只能引 Motik 等的定性比较：
> **【原文，Motik et al. AI 2019】** 「Algorithms in the former group [counting] maintain additional data structures and are usually applicable only if datalog rules are **not recursive** ... Algorithms in the latter group [**DRed**] do not require additional data structures and **can handle recursive rules**, but they can be **inefficient when facts have multiple derivations**」。DOI 10.1016/j.artint.2018.12.004
> **【原文，Motik, Nenov, Piro, Horrocks AAAI 2015】** 「existing solutions, such as the well-known **Delete/Rederive (DRed)** algorithm, can be inefficient in cases when facts have **many alternate derivations**」「the B/F algorithm was **several orders of magnitude more efficient** than the DRed algorithm on some inputs, and it was **never significantly less efficient**」。DOI 10.1609/aaai.v29i1.9409
> **【原文，Motik et al. AAAI 2018】** 「both contain steps that evaluate rules '**backwards**' by matching their heads to a fact and evaluating the partially instantiated rule bodies as queries. We show that this can be a considerable source of overhead **even on very small updates**」「The **Counting** algorithm does not evaluate the rules 'backwards,' but it can handle only **nonrecursive** rules」。DOI 10.1609/aaai.v32i1.11554

**【推断】DRed 的代价结构**（不谎报 big-O）：DRed = 删除阶段（标记受影响事实）+ 重推阶段（从仍被支撑的事实重新推导）。代价由**重推的扇出**决定：一个事实若有 m 条替代推导，删除它会让 m 条链全部重跑。这就是「facts have many alternate derivations」的低效来源。**在记忆场景里这恰恰是常态**：一条 `works_at(alice, acme)` 可能由「邮件签名」「会议记录」「用户直述」三条独立路径推出 → m = 3，每次 supersession 都重推 3 条链。

#### 8.2.3 Datalog 上的核收缩——一个必须说清的区分

> **【原文，Hansson 1994】** 「Kernel contraction is a natural **nonrelational generalization of safe contraction**. All **partial meet contractions are kernel contractions**, but the **converse relationship does not hold**. Kernel contraction is axiomatically characterized. It is shown to be better suited than partial meet contraction for formal treatments of **iterated belief change**.」DOI 10.2307/2275912

核收缩的定义链（Hansson 1994）：`K ⊥ p` = 能推出 `p` 的 `K` 的**极小子集**（kernel）；incision function `σ` 从每个 kernel 里切掉至少一个元素；`K ÷ p = K \ σ(K ⊥ p)`。**注意：kernel 是「推出 p 的极小证据集」，与「极小冲突」是同一结构**。

> **【原文，Ribeiro KR 2022】** 《Kernel Contraction and the Order of Relevance》DOI 10.24963/kr.2022/30（pp.299–308）
> **【原文，JAIR 2017】** 「we introduce **base dependence** as a relation between formulas with respect to a belief base, and prove a more general characterization that shows the correspondence between kernel contraction and base dependence」。DOI 10.1613/jair.5496

**关键桥梁文献（Horn 层与 belief base 层的等价）**：
> **【原文，Booth/Meyer/Varzinczak/Wassermann, arXiv:1401.3902】** 「Horn contraction for belief sets does **not** satisfy the controversial **Recovery** postulate」「the construction method for Horn contraction for belief sets based on our **infra remainder sets corresponds exactly to Hansson's classical kernel contraction** for belief sets, when restricted to Horn logic」「We prove that **kernel contraction for belief bases produces precisely the same results as the belief base version of infra contraction**」「a representation result for Horn contraction for belief sets in which a version of the **Core-retainment** postulate features」

**【推断】这条对本项目是决定性的**：`kernel contraction` 在 **Horn 逻辑（≈ Datalog）上成立**，且与 infra contraction 等价，且 **Recovery 不成立**（这很重要：Horn 层不能「撤销即恢复」，因为撤销后重新加回不一定恢复原闭包——非单调性）。这给了「在 Datalog 上实现 AGM 核收缩」一个**有声望的合法性依据**。

#### 8.2.4 Lemmalog 的实现到底是什么（源码实证 + 我的判断）

`eval.rs:1041` 注释原文：
> 「Scoped negative delta, **DRed-style**: process dependent predicates level by level (stratum order). Clear and rebuild a dependent **only if the key set of what it reads actually changed** — a works_at supersession rebuilds current (linear) but leaves a closure that only reads the manager slice untouched. Propagation continues to deeper dependents only through predicates whose contents changed.」

`eval.rs:1047` 签名：`fn scoped_recompute(&mut self, strata: &[Vec<usize>], extra_clear: BTreeSet<String>) -> (BTreeSet<usize>, usize)`
`eval.rs:1203` 核心判定：`let changed = now_keys != snapshots.get(p).cloned().unwrap_or_default();` —— 只把**真变者**的 readers 入 `to_clear`。
数据结构：`direct_readers: BTreeMap<String, BTreeSet<String>>`（body pred → head pred；聚合走 `agg_temp_pred` 临时关系）。

**【推断，本报告最重要的一条工程判断】**：

Lemmalog 的 `scoped_recompute` 实现的是 **recompute-equivalence（结果等价于从零重算）**，**不是** minimal contraction（结果集极小）。区别是本质的：

| | DRed / `scoped_recompute` | AGM 核收缩 |
|---|---|---|
| 优化目标 | **工作量小**（少重算几个谓词） | **结果集极小**（保留的证据最少） |
| 保证 | `结果 = fixpoint(新基事实)` | `结果 ⊆ K`，且不含推出 `p` 的极小证据 |
| 是否 AGM 极小 | **否** | 是 |
| 用途 | 增量维护物化 | 信念修正 / 解释「为什么要删这条」 |
| `Recovery` | 不适用 | Horn 层**不成立**（arXiv:1401.3902） |

**所以两个「最小」是不同的「最小」**：`scoped_recompute` 的「最小」指**重算范围最小**（工程效率），delta 的「最小」指**假设集极小**（语义正确性）。**它们不冲突，但不能互相替代。** Lemmalog 已经有前者的优秀实现，缺的是后者。

**缺什么（逐项）**：
- ✅ 有 `hypothetical(extra, goal)`（`eval.rs:637-677`，注释原文「the what-follows-if-we-assume-X lookahead primitive (design 4.5)」）→ **oracle 已存在**。
- ✅ 有 `uninstall(id)`（`eval.rs:1429`）、`rule_batches: Vec<(String, String, usize)>`（`eval.rs:545`）→ **黑盒 justification 的删除-测试机制已存在**。
- ✅ 有 `Support { Base, Rule { rule, body } }` + `why()`（`eval.rs:2091`）→ **证明树载体已存在**。
- ❌ **没有**「给定目标求极小额外事实集」的搜索层（grep `abduc|hypothes|assum` 只命中 `hypothetical` 及其注释）。
- ❌ **没有** `#minimize` / 弱约束 / 权重优化。
- ❌ **没有** 命中集计算。

**【推断】最小改动方案**：把 `hypothetical` 当单调 oracle，实现 **QuickXplain**（约 60 行代码）求一个 subset-minimal delta；把 §8.3 的 `why()` 扩展为带缺口的树。**不需要引入 SAT 求解器**。这是本报告给出的最具体的实施建议。

#### 8.2.5 一个必须写进 schema 的非单调性警告

**【推断】** `ast.rs:18-19`：negation 是「negation-as-absence，engine 限制在严格更低 stratum」。于是：
- **同一 stratum 内**：加事实单调（只增不减推导）→ QuickXplain 前提成立 → 极小 delta 严格有效。
- **跨 stratum**：加一条 `q(x)` 可能使 `not q(x)` 变假 → 摧毁下游推导 → **非单调** → hitting set duality **不成立** → 「最小 delta」的方向可能是错的（加证据反而使目标失效）。

**工程对策【推断】**：把 delta 限制在被观察目标的**同一 stratum 或更低 stratum**的事实上；跨 stratum 的 delta 必须**显式验证**（`hypothetical` 后必须重新检查目标仍可推出，而不仅是「新增事实可推出」）。这不是理论洁癖——一个 `supersedes` 事实完全可能让下游的 `not superseded(x)` 变假，从而使原本成立的推论失效。

### 8.3 部分证明树 + 缺口的现有表示法

#### 8.3.1 三条候选路线，逐条判真假

**(a) provenance semiring 的「missing token」——不存在这个东西**

> **【原文，Green/Karvounarakis/Tannen PODS 2007】** provenance semiring 框架，DOI 10.1145/1265530.1265535。
> **【原文，Green & Tannen PODS 2017】** 「for database provenance, data use has two flavors: **joint and alternative**」；应用含「to minimize the cost of obtaining the output」「to probabilistic reasoning」「output maintenance, and to debugging」。DOI 10.1145/3034786.3056125

**【推断】必须说清**：semiring 里**没有「missing token」这个元素**。semiring 表达的是「**已成立**的推导如何组合」（`×` = joint，`+` = alternative）。缺口的表达需要**三值**：`0`（不成立）、`1`（成立）、`m`（缺失/未知）——而 `m` **不是** semiring 的元素，加进去就不是半环了（`m + 1` 该等于什么？）。**所以「provenance semiring 的 missing token」这个提法查无实据，不能用。**

现实的替代是 **why-not provenance**：
> **【原文，Huang/Chen/Doan/Naughton, PVLDB 1(1):736–747, 2008】** 《On the provenance of non-answers to queries over extracted data》DOI 10.14778/1453856.1453936
> **【原文，NedExplain, EDBT 2014】** 「NedExplain computes the **why-not provenance** for monotone relational queries with aggregation」DOI 10.5441/002/edbt.2014.14
> **【原文，PVLDB 2020】** 「why-not provenance and — to a lesser degree — why provenance can be **very large**, resulting in severe scalability and usability challenges. We introduce a novel **approximate summarization** technique ... uses **patterns** to encode why and why-not provenance concisely」。DOI 10.14778/3380750.3380760

**【推断】这三条给了缺口表示的正确方向**：缺口不是 semiring 的一个值，而是**查询的非答案集合**（why-not），且它可能极大，必须用**模式化摘要**压缩。

**(b) Datalog 的 why-provenance 有硬复杂度上限——这是主约束**

> **【原文，Calautti, Livshits, Pieris, Schneider, PACMMOD 2(2):1–16, 2024】** 「why-provenance ... provides information about the **witnesses** to a query result in the form of subsets of the input database that as a whole can be used to derive that result」「why-provenance for **recursive** queries, **even if the recursion is limited to be linear, is an intractable problem**, whereas for **non-recursive** queries is **highly tractable**」。DOI 10.1145/3651146

**【推断】这条直接判决「能不能全量物化证明树」：不能**。记忆提炼管线必然是递归的（摘要的摘要、事件的因果链），所以 why-provenance 不可处理。**唯一出路是限制见证数**——而 Lemmalog 已经这样做了：

`eval.rs:292-295` 注释原文：「Provenance witnesses per fact are capped: `why()` needs **one** derivation, not the (possibly exponentially many) paths」→ `pub const SUPPORT_CAP: usize = 4;`

**【推断】这个 cap = 4 的正确性论证**：它把「指数多条路径」换成「常数 4 条见证」，代价是**可能漏掉某个极小解释**。但对本项目这是**正确取舍**：第⑤步交付给 LLM 的证明树只需要**一条**路径 + 缺口，不需要枚举所有路径。而「极小性」由 §8.2 的 QuickXplain 在**假设空间**上保证（那里空间小），不需要在**路径空间**上保证（那里空间指数）。**两个空间的极小性用两种手段，这是正确分工。**

**(c) xclingo——「部分证明树 + 选择性缺口」最直接的可实现先例**

> **【原文】** 「xclingo translates the annotations into additional predicates and rules and uses the ASP solver clingo to obtain the extension of those auxiliary predicates. This information is used afterwards to construct **derivation trees containing textual explanations**. The language allows **selecting which atoms to explain** and, in its turn, **which atoms or rules to include in those explanations**.」DOI 10.4204/eptcs.325.19（与 10.4204/eptcs.385.52 同摘要）

**【推断】它的三个设计选择正是本项目需要的**：
1. **annotation 与程序分离**（`#show` 式的声明层）：解释什么，是**元数据**，不是规则的一部分 → 对应本项目「证明树是交付产物，不是引擎内建」。
2. **可选择哪些 atom/rule 进解释**：这正是「部分证明树」的机制——用户声明关心的子集，其余折叠。
3. **推导树 + 文本解释**：输出形态直接可读，对应第⑤步。

**但它有个致命限制**：它依赖 `clingo`（子进程 + ASP 求解器），**违反本项目的「单进程内嵌、不起子进程」约束**。所以只能**借设计，不能借实现**。

#### 8.3.2 本项目的具体表示法建议【推断】

Lemmalog 已有 `Support` 枚举（`eval.rs:259-265`）：
```rust
pub enum Support { Base, Rule { rule: String, body: Vec<Key> } }
pub struct StoredFact<A> { ann: A, supports: Vec<Support> }
```
`why()`（`eval.rs:2091`）已经是规则触发树的文本渲染，且**已经有缺口分支**：`eval.rs:2097 why_rec()` 对未知事实打 `[unknown fact]`，对环打 `[cycle: shown above]`。

**【推断】最小扩展（三处，不动数据结构）**：
1. `[unknown fact]` 已存在 → 缺口节点**已经**在树里了。只需给 `why()` 增加一个可选参数，把 `[unknown fact]` 收集成结构化列表（`Vec<Goal>`）而不是字符串。
2. 对每个缺口 goal，跑 QuickXplain 求它的极小 delta（§8.2.4）→ 得到「补这条要什么」。
3. 输出 `ProofTree { nodes: [...], status: Proven | Refuted | Unknown, gaps: Vec<Gap { goal, delta }> }`。

**为什么不需要引入新的表示法体系**：Datalog 的证明是**规则触发树**——节点 = 事实，边 = 规则实例化，这是**树**不是 DAG（去掉共享子证明后）。OWL 的 tableau 证明需要处理分叉、关闭分支、阻塞（blocking），所以需要复杂表示；**Datalog 的触发树没有这些**，一个 `Vec<Support>` 就够。这正是 lead 说的「比 OWL 的 tableau 证明简单得多」——**而且简单到这个程度：现有 `why()` 已经实现了 90%**。

#### 8.3.3 补：TGD/EGD chase 失败的溯因解释（m00481 明确要求，前版遗漏）

lead 的追问里点名了「TGD/EGD chase 失败解释」。前版报告没写，这里补齐。**先给结论：Datalog 层用不到 EGD，TGD 只在「想表达 ∃」时出现，而本项目的架构恰好禁止了它——所以这条线对本项目是「应该避免，而不是应该实现」。**

**（a）chase 是什么，以及它为什么与 abduction 相邻**

> **【未核实全文】** Deutsch, Nash, Remmel《The chase revisited》PODS 2008, pp.149–158, DOI 10.1145/1376916.1376938。chase 的标准参考文献（引入 core 与 oblivious/restricted 变体）。本文只用它作为「chase 是什么」的书目锚点，**不引其具体结论**。
> **【原文】** Gogacz, Marcinkowski《All-Instances Termination of Chase is Undecidable》ICDT 2014, LNCS 8757, pp.293–304, DOI 10.1007/978-3-662-43951-7_25。摘要（arXiv:1401.4840v2，逐字）：「We show that all--instances termination of chase is undecidable. More precisely, there is **no algorithm deciding, for a given set T consisting of Tuple Generating Dependencies (a.k.a. Datalog^∃ program), whether the T-chase on D will terminate for every finite database instance D**. Our method applies to Oblivious Chase, Semi-Oblivious Chase and -- after a slight modification -- also for Standard Chase. ... The arity we need for our undecidability proof is **three**. We also show that the problem is **EXPSPACE-hard for binary signatures**, but decidability for this case is **left open**.」

**【推断】这条对本项目是决定性的**：chase 是**半判定过程**（semi-decision procedure）——「it is merely a semi-decision procedure, which may fail to terminate」（Chase Termination Beyond Polynomial Time, arXiv:2403.16712v2 逐字）。一个实时召回管路里**不能**放一个可能不停机的不动点计算。所以：**如果 schema 允许 TGD（∃ 量化），第②步的证实就失去停机保证**。这比 abduction 的复杂度问题更严重——abduction 只是慢，chase 不终止是**在线程里挂死**。

**（b）chase 失败时，「解释」是什么形式**

chase 有两种失败，对应两种不同的「缺口」：

| 失败类型 | 机制 | 「解释」的形式 | 与 abduction 的关系 |
|---|---|---|---|
| **TGD 永不满足**（违反存在性规则，如 `∀x. Employee(x) → ∃y. hasManager(x,y)` 但库里无 y） | 触发规则 → 造新 null → 规则又触发 → 无限 | **不终止**（不是「找不到解释」） | 无关。这是 chase 的**发散**，不是溯因问题 |
| **EGD 冲突**（违反相等性规则，如 `∀x,y. worksAt(x,c) ∧ worksAt(y,c) → x=y` 但两人不等） | 两个 null 被迫相等 → chase 报错停止 | **冲突集的极小核**（= EGD 冲突的 justification） | **同构于 abduction**：极小冲突集正是 §2.3 的 conflict，其极小横截是 repair |

**【推断】结论**：真正需要「溯因式解释」的是 **EGD 冲突**，因为它的失败点是**一组具体事实**（可 pinpoint），而 TGD 的发散没有失败点（它只是不停）。而 EGD 在 **OWL 2 RL 里没有独立机制**——RL 用前向规则 + `false` 头实现同样效果，见（c）。

**（c）关键规范事实：OWL 2 RL 里没有 EGD 的位置（矛盾被编译成 `false`）**

> **【原文】** OWL 2 Profiles, W3C Recommendation（https://www.w3.org/TR/owl2-profiles/），§4.3「Reasoning in OWL 2 RL」的规则表，两行逐字（已从规范 HTML 原文核对，标签归一）：
> - `prp-fp`: `T(?p, rdf:type, owl:FunctionalProperty)` `T(?x, ?p, ?y1)` `T(?x, ?p, ?y2)` → `T(?y1, owl:sameAs, ?y2)`
> - `eq-diff1`: `T(?x, owl:sameAs, ?y)` `T(?x, owl:differentFrom, ?y)` → **`false`**
> 即：功能性属性（及 `prp-ifp` 反向功能性）在 RL 里是**前向规则推出 `owl:sameAs`**，而矛盾是**推导出 `false`**（`eq-diff1`/`eq-diff2`/`eq-diff3` 的头部就是 `false`），**全程没有 EGD、没有 null、没有 chase**。

**【推断】这条很实用**：如果契约层选 OWL 2 RL（m00481 的首选），那么：
- `owl:FunctionalProperty` / `owl:InverseFunctionalProperty` 的约束**直接被编译成 Datalog 规则**（`prp-fp`/`prp-ifp`），不是 EGD。
- 冲突检测就是「`prp-fp` 推出 `T(y1, owl:sameAs, y2)`」与库里已有的 `T(y1, owl:differentFrom, y2)` 同时成立 → `eq-diff1` 触发 `false` → 失败点是一对**具体的极小冲突事实**，直接可做 justification（§2.3）。
- 所以「EGD 冲突解释」在 RL 路线下**自动退化成 justification 问题**，不需要单独的 chase 诊断机制。**这是分层带来的又一个清零项**，已补进 §7.3 的代价表。

**（d）在 Datalog∃/TGD 上做溯因的代价（如果真要走）**

> **【原文】** Chase Termination Beyond Polynomial Time (arXiv:2403.16712v2, 2024)：「while known terminating fragments are restricted to **PTime data complexity**, our conditions yield decidable languages for **any k-ExpTime**」——即要保证终止，要么牺牲表达力（PTIME 片段），要么付出 k-ExpTime。

**【推断】取舍很清楚**：表达力（TGD 的 ∃）与可终止性（实时性）二选一。本项目选实时性。若将来必须表达「存在」，工程上的正确做法是**用已有的有限域个体把它物化**（即可判定的 fragment），而不是引入 chase 的 null。这与 §9.2 硬约束 #2「禁止 abduction 创造新个体」是同一条原则的两个面。

**（e）与本项目第③④步的对接结论**

1. **不要在运行时层引入 TGD/∃**。Lemmalog 的 `Clause` 是 definite Horn（`ast.rs:59-66`，body 里只有 `Pos`/`Neg`/`Cmp`/`Now`），**没有头部带 ∃ 的形式**——这个限制要**保持**，不要为了「更 OWL」而加。
2. **EGD 式约束用「两条 Datalog 规则 + 一个不可能成立的事实」表达**，让冲突落成具体的极小事实对，直接用 §2.3 的 justification 机制。
3. **第④步「缺口」不需要 chase 诊断**：缺口已经在 `why()` 的 `[unknown fact]` 分支里（§8.3.2），它的成因是「目标事实推不出来」，不是「约束不被满足」。**这两个是不同的缺口类型，不要混**：
   - 类型 A（推不出）：`why()` 的 `[unknown fact]` → delta 补**事实**
   - 类型 B（推出来但矛盾）：两条链推出冲突 → delta 补**区分事实**（如补一个 `differentFrom` 或补缺失的属性值）

---

## 9. 对本项目的直接含义（清单）

### 9.1 第①②③④⑤步各自的形式化落点

| 步 | 形式化对象 | 算法 | 复杂度边界 | 依据 |
|---|---|---|---|---|
| ① 粗召 | 候选实体集（几百条） | 向量 + ngram 索引 | 250ms 预算 | `probe-1`/`probe-2`（.memlog） |
| ② 证实/证伪 | `B ∪ P ⊨ G`？ | 最小不动点迭代（semi-naive 求 least fixpoint） | **PTIME**（data 复杂度；RL/EL 均为 PTIME-complete）；**且必然终止**——规则集是 definite Horn、无 ∃ 头，故无需 chase（§8.3.3） | OWL 2 Profiles Table 10 |
| ③ 溯因 | `∃H ⊆ A: B ∪ H ⊨ G`，H 子集极小 ⟺ `B ∪ H ∪ {¬G}` 以 `H` 为 A-部分的极小不可满足集（§8.2.1 第二步） | **QuickXplain(B∪{¬G}, A)，`hypothetical()` 当单调 oracle**（§8.2.1 第三步：一步到位，不走横截） | `2k·log(n/k)+2k` 次单调检查；k≈3–8, n≈3–15 → **约 30 次**（非严格上界） | Junker AAAI-04 Table 4【原文】 |
| ④ 缺口 | 失败证明树前沿的极小冲突集 | `why()` 的 `[unknown fact]` + 模式化摘要 | why-provenance 对递归不可处理 → 必须 cap 见证数 | Calautti 2024【原文】；`SUPPORT_CAP=4` |
| ⑤ 交付 | `ProofTree { status, gaps }` + 部分子证明 | 规则触发树文本渲染 | — | `why()` 已实现 |

### 9.2 必须写进 schema 的硬约束（5 条）

1. **`abducible_predicate` 白名单表**：每个谓词标记「可作为假设」/「不可」。理由：signature-based abduction（Koopmann KR 2020）+ relevance 条件（Klarman Def.2）。不加这条，delta 会退化成抄答案。
2. **禁止 abduction 创造新个体**：假设只能用已有值域。理由：一阶 Horn 溯因的 value invention + UNA 失效会导致 term equivalence 实例化爆炸（Fundamenta Informaticae 2016【原文】）；同时消掉 ABox abduction 的半可判定性（Klarman §1.2）。
3. **delta 的 stratum 约束**：delta 只作用于目标同层或更低的 stratum。理由：`ast.rs:18-19` 的 negation-as-absence 使跨层非单调，Reiter duality 前提失效（Rodler 转述 Reiter 的「monotonic KR language」要求【原文】）。
4. **权重/优先级字段 `delta_priority: u8`**：数值**越大越不想用**（ASP-Core-2 §2.6 的 level 语义：高 level 优先最小化）。这是很容易搞反的一点，必须显式写进文档。
5. **禁止 TGD（头部带 ∃ 的规则）**：Lemmalog 的 `Clause`（`ast.rs:59-66`）本来就是 definite Horn，没有 ∃ 头，**这个限制要保持**。理由：一旦允许 ∃ 就要 chase，而 chase 是半判定过程、可能不终止（§8.3.3）；且 ∃ 会重新打开「value invention + UNA 失效」的实例化爆炸（§8.1.3）。功能性属性约束改写成 `prp-fp` 式的**两条 Datalog 规则 + 一个冲突检测事实**，让冲突落成具体的极小事实对。

### 9.3 对现有代码的改动建议（按性价比排序）

| 优先级 | 改动 | 理由 | 工作量 |
|---|---|---|---|
| **P0** | 把 `hypothetical()` 的全库深拷贝（`eval.rs:637-677` 拷贝 relations/change_log/feed/retracted/program_dirty/last_run_log_len/epoch）改成**只快照被影响的谓词** | 40 次 QuickXplain 检查 × 全库深拷贝 = 不可接受；这是唯一真正的性能 blocker | 中 |
| **P0** | 实现 QuickXplain（约 60 行）包在 `hypothetical` 外面 | 第③步的核心缺失能力 | 小 |
| **P1** | `why()` 把 `[unknown fact]` 收成结构化 `Vec<Goal>` 而非字符串 | 第④步缺口的表示 | 小 |
| **P1** | 给 `Support` 加见证数统计，验证 `SUPPORT_CAP=4` 是否够 | 递归 Datalog why-provenance 不可处理，cap 是唯一出路，但 4 是否够需实测 | 小 |
| **P2** | delta 的 `#minimize` 式分层排序 | 第④步「待调查方向」的顺序有 UX 价值 | 中 |
| **P3** | MCS 枚举（MARCO 骨架）用于列出全部缺口 | 只在需要「所有可能方向」时 | 大 |

### 9.4 三个「不要做」

1. **不要引入 SAT/MaxSAT 求解器**。求一个 subset-minimal delta 用 QuickXplain 只需单调 oracle，`hypothetical` 就是。引入求解器增加依赖、破坏单进程约束、且没有收益（n 只有 3–15）。
2. **不要「无条件」枚举全部极小 delta**——但请注意限定词。会撞上单调对偶化的开放问题是**「n 很大时枚举全部」**（Eiter/Gottlob/Makino SIAM J. Comput. 32(3):514–537, 2003【原文】：dualizing a monotone CNF 的判定「is a prominent open problem in NP-completeness」）。分层设定下池是证明树前沿的 3–15 条（§6.3），此时**枚举全部是可行的**（§3.3 的限定）。规则：**先量池大小再决定求几个**；n 大就 `#minimize` 排序取前 k，不要硬枚举。
3. **不要照抄 OWL API 的 BlackBoxExplanation 实现**。它的 expansion 阶段（1.25 倍扩张）是为「全库本体、无边界」设计的；Datalog 里相关性由反向可达性直接给出。而且它每次检查重建推理器（`dispose()` 证据），单进程内嵌下成本两个数量级恶化。**抄算法骨架（reset → expand → fast prune → slow prune），不抄实现。**

### 9.5 一条元判断

**【推断】** 在整个 d4 维度上，**分层之后本维度的技术风险从「高」降到「低」，但工程风险从「低」升到「中」**：
- 技术风险降：abduction 从「ALCI 的 coNEXPTIME-complete / ALCF 不可判定 / 一般 ALC 的半可判定最小性」降到 definite Datalog 上的「几十次单调检查」，算法成熟（QuickXplain 2004、MARCO 2015、DynamicHS 2019），有源码可抄。
- 工程风险升：真正的难点从「算法」转移到 **oracle 的增量实现**（`hypothetical` 深拷贝）与 **证明树的物化策略**（递归 why-provenance 不可处理）。这两个都不在文献里有现成答案，必须自己调。

**所以第③步的关键路径不是「实现溯因算法」，而是「把 `hypothetical` 做成增量的」。** 这一条建议应当优先于所有其他 d4 行动项。

---

## 10. 未取得的一手材料（诚实清单）

| 材料 | 状态 | 影响 |
|---|---|---|
| Reiter 1987 全文（AI 32(1):57–95） | **未取得**。ScienceDirect 403；常见镜像全 404；AAAI-87 会议版逐一探测 AAAI87-030～AAAI87-042 的首页标题，Reiter 那篇不在该区间（033 是 Reiter & de Kleer 的 Clause Management System，非 diagnosis） | 定义取 Rodler arXiv:1907.12130 的**精确转述**（该文可核验且给出完整形式定义）。**报告中没有伪称逐字引用 Reiter 原文。** |
| Gupta/Mumick/Subrahmanian 1993 全文 | **未取得**（书目已核实，两个 DOI 都对） | DRed 的精确复杂度定理未引；只用 Motik 等的定性比较。 |
| Kakas/Kowalski/Toni 1992/2002 全文 | **未取得**（书目已核实） | ALP 框架用教科书级标准定义（`⟨P, A, IC⟩`），未引原文措辞。 |
| Hansson 1994 全文 | **未取得**（摘要已取得，逐字引用安全） | 核收缩的构造用定义链转述，非原文措辞。 |
| JuDial / EAX | **未核实** | 报告中不引用其结论；标为待 d8 补。 |
| 「DL abduction + KG embedding 组合」的权威论文 | **未找到**。Crossref 三组不同措辞检索（`abduction knowledge graph embedding link prediction` / `abductive reasoning knowledge graph completion` / `explanation missing link knowledge graph abduction`）返回全部是纯嵌入侧或纯符号侧，**无一篇同时做两者** | §5.2 的三层流水线明确标为**我的推断**。 |
| Deutsch/Nash/Remmel《The chase revisited》全文（PODS 2008） | **未取得全文**（Crossref 书目已核实：pp.149–158, DOI 10.1145/1376916.1376938） | §8.3.3 只把它列为 chase 的标准参考文献，**未引其任何具体结论**。 |
| Gogacz & Marcinkowski《All-Instances Termination of Chase is Undecidable》 | **会议版全文未取得**；引用的摘要是 **arXiv:1401.4840v2** 的（同题同作者） | 摘要里的「arity three」「binary signature EXPSPACE-hard, decidability left open」是**逐字引自 arXiv 版摘要**，报告中已标注来源版本。 |
| 《Chase Termination Beyond Polynomial Time》(arXiv:2403.16712) | **仅 arXiv 预印本**，未核实是否已正式发表 | 只引其摘要中「merely a semi-decision procedure」「known terminating fragments are restricted to PTime data complexity」两句定性结论。 |
| Mihindukulasooriya et al., *Repairing Hidden Links in Linked Data*, K-CAP 2017 | **仅书目层**。ACM DL 被 Cloudflare 拦（返回「Just a moment...」），摘要未取得 | 标题方向对（补隐藏链接）但**无法确认其方法是否最小修正集**，故不引用其结论。 |

## 参考（按首次出现顺序，全部可核验）

- Klarman, Endriss, Schlobach, *ABox Abduction in the Description Logic ALC*, JAR 2011. https://staff.science.uva.nl/~ulle/pubs/files/KlarmanEtAlJAR2011.pdf
- Koopmann, Del-Pinto, Tourret, Schmidt, *Signature-Based Abduction for Expressive Description Logics*, KR 2020. https://proceedings.kr.org/2020/59/kr2020-0059-koopmann-et-al.pdf
- Bienvenu, *Complexity of abduction in the EL family*, KR 2008.
- Eiter, Gottlob, *The complexity of logic-based abduction*, JACM 1995. https://doi.org/10.1145/200836.200838
- Eiter, Makino, *On computing all abductive explanations from a propositional Horn theory*, JACM 54(5):24, 2007. https://doi.org/10.1145/1284320.1284323
- Eiter, Makino, *Abduction and the Dualization Problem*, LNCS 2003. https://doi.org/10.1007/978-3-540-39644-4_1
- Eiter, Gottlob, Makino, *New Results on Monotone Dualization and Generating Hypergraph Transversals*, SIAM J. Comput. 32(3):514–537, 2003. https://doi.org/10.1137/s009753970240639x
- Junker, *QUICKXPLAIN*, AAAI-04. https://www.aaai.org/Papers/AAAI/2004/AAAI04-027.pdf
- Rodler, *Towards Optimizing Reiter's HS-Tree for Sequential Diagnosis*, arXiv:1907.12130. https://arxiv.org/pdf/1907.12130
- Rodler, Herold, *StaticHS*, SoCS 2018. https://doi.org/10.1609/socs.v9i1.18449
- Greiner, Smith, Wilkerson, *A correction to the algorithm in Reiter's theory of diagnosis*, AI 1989. https://doi.org/10.1016/0004-3702(89)90079-9
- Kalyanpur, Parsia, Horridge, Sirin, *Finding All Justifications of OWL DL Entailments*, ISWC 2007. https://doi.org/10.1007/978-3-540-76298-0_20
- Horridge, Parsia, Sattler, *Laconic and Precise Justifications in OWL*, ISWC 2008. https://doi.org/10.1007/978-3-540-88564-1_21
- Schlobach, Huang, Cornet, van Harmelen, *Debugging Incoherent Terminologies*, JAR 2007. https://doi.org/10.1007/s10817-007-9076-z
- Baader, Peñaloza, *Axiom Pinpointing*, 2020. https://doi.org/10.3233/ssw200042
- Peñaloza, Sertkaya, *On the Complexity of Axiom Pinpointing in the EL Family*, 2010. http://hdl.handle.net/10281/256915
- Console, Torasso, *A spectrum of logical definitions of model-based diagnosis*, Comput. Intell. 7:133–141, 1991. https://doi.org/10.1111/j.1467-8640.1991.tb00388.x
- de Kleer, Mackworth, Reiter, *Characterizing diagnoses and systems*, AI 56:197–222, 1992. https://doi.org/10.1016/0004-3702(92)90027-u
- Kakas, Kowalski, Toni, *Abductive Logic Programming*, JLC 2(6):719–770, 1992. https://doi.org/10.1093/logcom/2.6.719
- Lin, You, *Abduction in logic programming: A new definition and an abductive procedure based on rewriting*, AI 140:175–205, 2002. https://doi.org/10.1016/s0004-3702(02)00227-8
- Gavanelli et al., *Reasoning on Datalog± Ontologies with Abductive Logic Programming*, Fundam. Informaticae 2018. https://doi.org/10.3233/fi-2018-1658
- *Modeling Variations of First-Order Horn Abduction in Answer Set Programming*, Fundam. Informaticae 2016. https://doi.org/10.3233/fi-2016-1446
- *Abductive logic programs with penalization*, TPLP 2005. https://doi.org/10.1017/s1471068404002224
- Bertossi, Salimi, *Causes for query answers from databases: Datalog abduction, view-updates, and integrity constraints*, IJAR 90:226–252, 2017. https://doi.org/10.1016/j.ijar.2017.07.010
- Hansson, *Kernel contraction*, JSL 59(3):845–859, 1994. https://doi.org/10.2307/2275912
- Ribeiro, *Kernel Contraction and the Order of Relevance*, KR 2022. https://doi.org/10.24963/kr.2022/30
- *Kernel Contraction and Base Dependence*, JAIR 2017. https://doi.org/10.1613/jair.5496
- Booth, Meyer, Varzinczak, Wassermann, *On the Link between Partial Meet, Kernel, and Infra Contraction and its Application to Horn Logic*, arXiv:1401.3902. https://arxiv.org/abs/1401.3902
- Gupta, Mumick, Subrahmanian, *Maintaining views incrementally*, SIGMOD 1993. https://doi.org/10.1145/170035.170066
- Motik, Nenov, Piro, Horrocks, *Incremental Update of Datalog Materialisation: the Backward/Forward Algorithm*, AAAI 2015. https://doi.org/10.1609/aaai.v29i1.9409
- Motik et al., *Optimised Maintenance of Datalog Materialisations*, AAAI 2018. https://doi.org/10.1609/aaai.v32i1.11554
- Motik et al., *Maintenance of datalog materialisations revisited*, AI 2019. https://doi.org/10.1016/j.artint.2018.12.004
- Deutsch, Nash, Remmel, *The chase revisited*, PODS 2008, pp.149–158. https://doi.org/10.1145/1376916.1376938
- Gogacz, Marcinkowski, *All-Instances Termination of Chase is Undecidable*, ICDT 2014, LNCS 8757:293–304. https://doi.org/10.1007/978-3-662-43951-7_25 ｜ 摘要取 arXiv 版 https://arxiv.org/abs/1401.4840
- *Chase Termination Beyond Polynomial Time*, arXiv:2403.16712 (2024). https://arxiv.org/abs/2403.16712
- *All-Instances Restricted Chase Termination*, arXiv:1901.03897 (2019). https://arxiv.org/abs/1901.03897
- Green, Karvounarakis, Tannen, *Provenance semirings*, PODS 2007. https://doi.org/10.1145/1265530.1265535
- Green, Tannen, *The Semiring Framework for Database Provenance*, PODS 2017. https://doi.org/10.1145/3034786.3056125
- Calautti, Livshits, Pieris, Schneider, *The Complexity of Why-Provenance for Datalog Queries*, PACMMOD 2(2), 2024. https://doi.org/10.1145/3651146
- Huang, Chen, Doan, Naughton, *On the provenance of non-answers to queries over extracted data*, PVLDB 1(1):736–747, 2008. https://doi.org/10.14778/1453856.1453936
- *Approximate summaries for why and why-not provenance*, PVLDB 2020. https://doi.org/10.14778/3380750.3380760
- Kalyanpur et al., *Query-Based Why-Not Provenance with NedExplain*, EDBT 2014. https://doi.org/10.5441/002/edbt.2014.14
- Liffiton et al., *Fast, flexible MUS enumeration* (MARCO), Constraints 21(2), 2015. https://doi.org/10.1007/s10601-015-9183-0
- Ignatiev, Previti, Liffiton, Marques-Silva, *Smallest MUS Extraction with Minimal Hitting Set Dualization*, 2015. https://doi.org/10.1007/978-3-319-23219-5_13
- Arif, Mencía, Marques-Silva, *EL2MUS*, arXiv:1505.04365. https://arxiv.org/abs/1505.04365
- Fazekas, Bacchus, Biere, *Implicit Hitting Set Algorithms for MaxSMT*, 2018. https://doi.org/10.1007/978-3-319-94205-6_10
- Berg, Bacchus, Poole, *Abstract Cores in Implicit Hitting Set MaxSat Solving*, SAT 2020. https://doi.org/10.1007/978-3-030-51825-7_20
- Sun, Vashishth, Sanyal, Talon, Wang, *A Re-evaluation of Knowledge Graph Completion Methods*, ACL 2020. https://doi.org/10.18653/v1/2020.acl-main.489 ｜ https://aclanthology.org/2020.acl-main.489/
- Mihindukulasooriya, Rico, Santana-Pérez, *Repairing Hidden Links in Linked Data*, K-CAP 2017（仅书目层）. https://doi.org/10.1145/3148011.3148020
- Evee, KR 2024. https://doi.org/10.24963/kr.2024/67 ；*Why Not? Explaining Missing Entailments with Evee*, arXiv:2308.07294
- *Completing and Debugging Ontologies*, ACM JDIQ 2023. https://doi.org/10.1145/3597304
- ASP-Core-2.03c. https://www.mat.unical.it/aspcomp2013/files/ASP-CORE-2.03c.pdf
- W3C OWL 2 Profiles. https://www.w3.org/TR/owl2-profiles/
- xclingo, EPTCS 325/385. https://doi.org/10.4204/eptcs.325.19
- OWL API BlackBoxExplanation.java / HSTExplanationGenerator.java. https://github.com/owlcs/owlapi/tree/version5/tools/src/main/java/com/clarkparsia/owlapi/explanation
