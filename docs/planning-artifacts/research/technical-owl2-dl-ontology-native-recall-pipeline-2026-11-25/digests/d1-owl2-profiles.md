# d1 — OWL 2 四 profile 的能力边界与契约层选型

source: W3C 规范全文（本地抽取纯文本后逐条 grep）+ IJCAI/JAR/ISWC/ESWC 论文 PDF
publisher: W3C / AAAI(IJCAI) / Springer(JAR, ESWC) / Oxford / arXiv
pub_date: 规范 2009–2017；论文 2004–2022
accessed: 2026-11-25
confidence: high（规范条款逐句核对并附行号；论文取 PDF 原文）
class: profile 复杂度 + 构造子矩阵 + 契约层选型

---

## 1.1 复杂度总表（Table 10 原文数字，本轮复核）

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

## 1.2 构造子支持矩阵（逐条核对规范）

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

## 1.3 为什么「要 cardinality + disjunction + inverse 就必须 DL」只有一半对

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

## 1.4 OWL 2 RL 规则集：78 条，6 张表

| Table | 主题 | 条数 | 规则名 |
|---|---|---|---|
| 4 | 相等性 | 9 | eq-ref, eq-sym, eq-trans, eq-rep-s, eq-rep-p, eq-rep-o, eq-diff1, eq-diff2, eq-diff3 |
| 5 | 属性 | 20 | prp-ap, prp-dom, prp-rng, prp-fp, prp-ifp, prp-irp, prp-symp, prp-asyp, prp-trp, prp-spo1, prp-spo2, prp-eqp1, prp-eqp2, prp-pdw, prp-adp, prp-inv1, prp-inv2, prp-key, prp-npa1, prp-npa2 |
| 6 | 类 | 19 | cls-thing, cls-nothing1, cls-nothing2, cls-int1, cls-int2, cls-uni, cls-com, cls-svf1, cls-svf2, cls-avf, cls-hv1, cls-hv2, cls-maxc1, cls-maxc2, cls-maxqc1..4, cls-oo |
| 7 | 类公理 | 5 | cax-sco, cax-eqc1, cax-eqc2, cax-dw, cax-adc |
| 8 | 数据类型 | 5 | dt-type1, dt-type2, dt-eq, dt-diff, dt-not-type |
| 9 | schema 词汇 | 20 | scm-cls, scm-sco, scm-eqc1, scm-eqc2, scm-op, scm-dp, scm-spo, scm-eqp1, scm-eqp2, scm-dom1, scm-dom2, scm-rng1, scm-rng2, scm-hv, scm-svf1, scm-svf2, scm-avf1, scm-avf2, scm-int, scm-uni |

**决定性事实：对规则区 grep `naf|negation.as.failure|stratified|stratification` 返回 0 命中。** RL 规则集是**纯 Horn 一阶蕴含式 + 一个 false 常量**，不含任何否定即失败。→ **Datalog 内核不需要实现分层否定就能跑 RL。**

## 1.5 RL 的五个明确不覆盖

1. **不做完整析取**。cls-uni 只从成员向上推类型。
2. **不做完整否定**。cls-com 的互补**只用来报冲突**，不产生新类属。
3. **基数只有 0/1**。文法 `zeroOrOne := 0 | 1`；没有 min、没有 exact、没有 ≥2。
   - **cls-maxc2（max 1）是靠推 `owl:sameAs` 实现，不是靠失败**——这是极容易误解的一点。
4. **不推「不存在个体」**：设计目标明写「avoid the need to infer the existence of individuals not explicitly present in the knowledge base, and to avoid the need for nondeterministic reasoning」。
5. **不含 RDF/RDFS 公理三元组**：规范明说为避免性能问题不包含，且只含「most, but not all」RDFS 蕴含规则；实现 MAY 自行加入。

**Theorem PR1 三条件**（完备性前提）：①无 punning（同一 IRI 不兼作多类实体）②O1 不含 SubAnnotationPropertyOf / AnnotationPropertyDomain / AnnotationPropertyRange ③O2 每条公理都是 ClassAssertion / ObjectPropertyAssertion / DataPropertyAssertion / SameIndividual。
→ **完备性只对断言成立，不覆盖 TBox 公理蕴含，不覆盖 CQ。** 超出句法约束的图上 sound but incomplete。

## 1.6 RL 的一致性检查：78 条规则中恰好 17 条 false 头（已逐行复核定稿）

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

## 1.7 混合策略的文献支持：DL 离线，轻量在线

**TrOWL（ESWC 2010）是最直接的证据，但准确说法不是「DL 做 schema 校验」**：
- 动机：「OWL-DL 最坏 NExpTime，OWL 2 是 2NExpTime；三 profile are PTIME-complete or better; however, these profiles all greatly restrict the expressiveness」
- QL 方向（Quill）：对无 non-distinguished 变量的 CQ **结果也是 complete**
- EL 方向（REL）：近似线性时间，「overall complexity for OWL2-DL ontologies can be reduced to PTime. Although known to be incomplete, our evaluation shows that REL can classify existing benchmarks very efficiently with high recall (over 95%)」
- 查询重写爆炸量化：「Using the standard query rewriting algorithm PerfectRef over a deep class or property hierarchy can result in a set of hundreds or thousands of conjunctive queries, where our method will only ever result in a single query」

→ **文献支持的是「DL 建模 → 近似 → 轻量推理」，不是「DL 做运行时校验」**：TrOWL 是**离线**做 DL 一致性检查、**在线**只用近似后的轻量语言。把 DL 放在校验路径上等于把系统挂在一个 open problem 上。

## 1.8 DL-safe rules 与 Abduction 的可判定性（直接约束第 ③ 步）

**SWRL W3C 自认不可判定**：「It is easy to see that OWL DL becomes undecidable when extended in this way as rules can be used to simulate role value maps」。safety 条件「only variables that occur in the antecedent of a rule may occur in the consequent」；且 safety「does not, in fact, restrict the expressive power of the language」。

**DL-safe 的正确定义**（Motik/Sattler/Studer, ISWC 2004）：「A rule r is called DL-safe if each variable in r occurs in a non-DL-atom in the rule body.」直觉：每个变量只能绑定到 **ABox 中显式出现的个体**。

**决定性的一条（对第 ③ 步）**：一阶语义 vs 最小模型语义「对**正** ground atom 两者等价；对负 atom 或概念包含则不同」。原文「equivalence of general programs under minimal model semantics is undecidable [27] whereas, under first-order semantics, it is decidable and can be reduced to satisfiability checking」。
→ **「最小 delta」若定义为「在一阶语义下使查询被蕴含的最小事实集」则可判定；若定义为「最小模型」则不可判定。设计文档必须写死一阶语义，否则 abduction 步骤没有终止保证。**

**EL abduction 的复杂度是 open**（arXiv:2205.08449 原文）：「The theoretical worst-case complexity of connection-minimal abduction is another open question. Our method only gives a very high upper bound ... double exponentially many clauses in the worst case, which would give us a 2ExpTime upper bound ... We have not looked yet at lower bounds.」
→ **不能承诺「找到最小 delta」**。必须三限：限定 delta 大小 |Δ| ≤ k、限定谓词签名（arXiv:2007.00757）、限定深度。工程实现建议 = 「在已物化闭包上找最短未满足子目标链」，即把 RL 规则 body 当缺口模式做反向查询（magic-set / SLD），PTIME。

## 1.9 【最关键】RL 的开放世界缺口：契约层必须补三态

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

## 1.10 契约层选型的最终判决

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

## 1.11 相对「OWL 覆盖全库」省掉的钱（带数字）与照旧的成本

**省掉（7 项）**：SROIQ 全局限制检查（simple role 定义 + regularity 偏序 + typing constraints）；N2EXPTIME 推理降为 PTIME；punning 处理反向变「禁 punning」更简单；DL-safe rules 的 nominals NExpTime 跳变；PerfectRef 查询重写爆炸（「hundreds or thousands」条 CQ）；启动时间（**ELK 分类 SNOMED CT 约 300,000 概念仅 5 秒** → 我们几十到几百条公理是微秒级）；重型工具链（不需要 OWL API / HermiT / Pellet / ELK，不需要第二进程）。

**照旧（5 项）**：
1. **ABox 规模仍是瓶颈**：RL data 复杂度 PTIME 但 join 代价随记忆量增长。10 万条边全量物化在单进程是**秒级不是毫秒级** → 必须增量物化。
2. **eq-rep-* + prp-spo2 的组合爆炸**：稠密图上产生大量冗余推导 → 必须并查集 + 去重。**eq-rep-* 必须建在 sameAs 并查集上，不能当普通 join。**
3. **开放世界的证伪缺口仍在**：OWL 语义本质，不是实现问题；三态设计是唯一出路。
4. **abduction 理论复杂度 open**：只能有界近似。
5. **RL 完备性只覆盖断言**：TBox 蕴含与 CQ 不在保证内；类可满足性/包含检查需另行实现，且 combined 是 co-NP-complete。

## 1.12 诚实标注（查不到 / 存疑）

1. **SHACL 与 OWL 语义冲突的裁决规则**——规范中查不到。只规定 sh:entailment 的失败语义，不规定与 OWL 蕴含冲突时谁赢。
2. **OWL 2 DL 的 CQ 回答复杂度**——Table 10 标为 **Decidability open**，不是某个复杂度类。
3. **EL abduction 的下界**——论文自称「We have not looked yet at lower bounds」。
4. **RL 规则集是否覆盖全部 RL 语义**——规范自称 partial axiomatization，且明说不保证完备。
5. **OWL-Time 成熟度**——取到的是 Candidate Recommendation Draft 2022-11-15，**非 REC**；生产用需自行评估。
6. **「RL 需要分层否定」这一说法规范不支持**（已 grep 0 命中）。**若任何既有文档里写了这条，应改掉。**
7. ~~false 头规则第 17 条到底是 dt-diff 还是 dt-not-type~~ → **已复核定稿为 `dt-not-type`**（见 §1.6 复核方法）。d1 首版记错、已完成更正，d8 与 research.md 原本正确。
8. **DL 下「记忆库 schema」的可行性论证查不到**——没有任何文献把完整 OWL 2 DL 用于运行时记忆/召回；所有分层证据都是「DL 离线、轻量在线」。
