# d8 — OWL 2 RL 的规则可实现性与复杂度（一手规范核实）

来源：W3C OWL 2 Web Ontology Language Profiles (Second Edition), W3C Recommendation 11 December 2012。
https://www.w3.org/TR/owl2-profiles/
accessed: 2026-11-25。本地副本：$env:TEMP/owl2pf.html（182,784 字节，去标签文本 87,814 字符）。

## 1. 决定性结论：RL 就是「正向 Datalog 规则 + 完整性约束」

规范原文（§4.3 OWL 2 RL Overview）：

> OWL 2 RL supports all axioms of OWL 2 apart from disjoint unions of classes (DisjointUnion) and reflexive object property axioms (ReflexiveObjectProperty).

> OWL 2 RL reasoning systems can be implemented using rule-based reasoning engines.

> This is achieved by defining a syntactic subset of OWL 2 which is amenable to implementation using rule-based technologies, and presenting a partial axiomatization of the OWL 2 RDF-Based Semantics in the form of first-order implications that can be used as the basis for such an implementation.

这些公理化的形式是「universally quantified first-order implications over a ternary predicate T」——即 T(?s, ?p, ?o)，本质就是三元组事实。

### 规则体全正、结论头可为 false

我逐表清点了 Table 4–9 的全部规则：**所有规则的 body 只含正向原子，没有一条含否定文字**。约 17 条规则的 head 是常量 false：

eq-diff1 / eq-diff2 / eq-diff3 / prp-irp / prp-asyp / prp-pdw / prp-adp / prp-npa1 / prp-npa2 / cls-nothing2 / cls-com / cls-maxc1 / cls-maxqc1 / cls-maxqc2 / cax-dw / cax-adc / dt-not-type

这 17 条正是 OWL 2 里所有**冲突型公理**的规则化：不同个体相等、非自反属性被自反填充、非对称属性被对称填充、不相交属性被同对填充、负属性断言被正断言满足、owl:Nothing 有个体、补类同时被填充、maxCardinality 0/1 被两个不同填充者违反、DisjointClasses 成员重叠、AllDisjointClasses 重叠、数据类型冲突。

**工程含义（本节是全篇最重要的一句）**：false 头被推导出来 = KB 不一致 = **该断言被证伪**，而且这条路给出的是**可追溯的具体触发规则与变量绑定**，不是黑箱的「不一致」。因此：

- 契约层**不需要第二个推理器**。同一个 Datalog 内核同时跑 RL 规则集与 IC 检查即可。
- 第 2 步「断言证实/证伪」的两侧由同一引擎给出：证实 = 目标原子进入不动点，证伪 = 某条 IC 规则在不动点上被触发。
- G3 要的核收缩（kernel contraction）所需的 kernel 就是「支撑该 false 推导的规则实例集合」——IC 触发本身就携带 kernel，不需要另建机制。

## 2. RL 的边界（决定契约层能覆盖多少）

- **只排除两个构造子**：DisjointUnion（不相交并）与 ReflexiveObjectProperty（自反对象属性公理）。
- **不支持预定义属性**：owl:topObjectProperty、owl:bottomObjectProperty、owl:topDataProperty、owl:bottomDataProperty。
- **数据类型禁项**：owl:real 与 owl:rational MUST NOT be used in OWL 2 RL。支持的含 xsd:decimal / integer 各长度 / float / double / string / dateTime / dateTimeStamp / boolean / hexBinary / base64Binary / anyURI 等。
- **SubClassOf 句法位置受限**：subclass 位置可以是 class、交、并、oneOf、someValuesFrom、hasValue、someDataValuesFrom、hasDataValue；superclass 位置限制更严。这些限制是保证多项式复杂度的关键。
- **RL 禁存在性与非确定性**：§4.1 原文 these restrictions are designed so as to avoid the need to infer the existence of individuals not explicitly present in the knowledge base, and to avoid the need for nondeterministic reasoning ——**无存在量词在规则头、无析取**。这两条正是 Datalog 可终止的充要条件。

## 3. Theorem PR1：部分公理化的代价是「可能不完备，但永不错误」

规范对 RDF-Based Semantics 的规则化只给出**部分**公理化。PR1 说：对满足 §4.2 句法约束、且其中 IRI 未被用作多种实体类型（如同时当类和个体）的 RL 本体，规则实现返回 all and only the correct answers。

但对**任意** RDF 图（不满足句法约束）——

> it is no longer possible to guarantee that all correct answers can be returned
> Such an implementation will, however, still produce only correct entailments.

**工程含义**：soundness 恒保、completeness 需守句法约束。这与此前在三值语义报告里得出的「未命中必须标 unknown 而非 false」是同一件事的两个侧面：规则引擎答不出不等于假。

## 4. 复杂度（Table 10 完整取值，此前未取到，现已补齐）

| Language | Reasoning Problem | Taxonomic | Data | Query | Combined |
|---|---|---|---|---|---|
| OWL 2 RDF-Based | Consistency / CE-Sat / CE-Subsumption / Instance / CQ | Undecidable | Undecidable | Undecidable | Undecidable |
| OWL 2 Direct | Consistency / CE-Sat / CE-Subsumption / Instance | N2EXPTIME-complete (NEXPTIME if poly NFA) | Decidable, complexity open (NP-Hard) | N/A | N2EXPTIME-complete |
| OWL 2 Direct | CQ Answering | Decidability open | Decidability open | Decidability open | Decidability open |
| OWL 2 EL | Consistency / CE-Sat / CE-Subsumption / Instance | PTIME-complete | PTIME-complete | N/A | PTIME-complete |
| OWL 2 EL | CQ Answering | in EXPTIME (PTIME if poly NFA) | PTIME-complete | NP-complete | in EXPTIME (PSPACE if poly NFA) |
| OWL 2 QL | Consistency / CE-Sat / CE-Subsumption / Instance | NLogSpace-complete | In AC0 | N/A | NLogSpace-complete |
| OWL 2 QL | CQ Answering | NLogSpace-complete | In AC0 | NP-complete | NP-complete |
| **OWL 2 RL** | **Consistency** | **PTIME-complete** | **PTIME-complete** | N/A | **PTIME-complete** |
| **OWL 2 RL** | **CE-Sat / CE-Subsumption / Instance** | **PTIME-complete** | **PTIME-complete** | N/A | **co-NP-complete**（原子类表达式为 PTIME-complete） |
| **OWL 2 RL** | **CQ Answering** | **PTIME-complete** | **PTIME-complete** | **NP-complete** | **NP-complete** |
| OWL 1 DL | Consistency / CE-Sat / CE-Subsumption / Instance | NEXPTIME-complete | Decidable, complexity open (NP-Hard) | N/A | NEXPTIME-complete |

### 这张表对设计的三个硬约束

1. **一致性检查（第 0 关）落在 PTIME-complete**，taxonomic / data / combined 三列都是 PTIME。这是 RL 相对 OWL DL（N2EXPTIME-complete）唯一能承受的落点，说明「先在 RL 上做一致性」是必须而非可选。
2. **组合复杂度 co-NP-complete 是硬墙**。CE-Sat / CE-Subsumption / Instance 在**组合**维度是 co-NP-complete：TBox 越大、查询越复杂，最坏情况指数爆炸。**但原子类表达式降到 PTIME-complete**——所以契约层必须把查询约束在「原子类 + 具名属性」上，禁止运行时构造任意类表达式。
3. **CQ Answering 的查询复杂度 NP-complete**。共轭查询求值是 NP-完全的（database theory 的经典结果）。**因此第 2 步的「概念查询」绝不能做成任意 CQ 求值**，必须限制成形如 ?x rdf:type :C 的原子查询（可归约成索引查找，PTIME），或把多原子 CQ 拆成多个原子查询后取交集。

## 5. 对双引擎设计的具体含义

| 决策点 | 规范证据 | 结论 |
|---|---|---|
| 契约层是否要第二个推理器 | §4.3 全部规则 body 为正、17 条 false 头 | **不需要**。Datalog 内核 + IC 即可覆盖 RL |
| 证伪怎么实现 | 17 条 false 头规则 | **证伪 = IC 触发**，且携带 kernel 供核收缩使用 |
| 能否保证不误判 | Theorem PR1：still produce only correct entailments | soundness 恒保；未命中标 unknown 而非 false |
| 查询能有多复杂 | Table 10 组合 co-NP / 查询 NP | 只允许**原子类查询**（PTIME）；CQ 必须拆成原子查询取交 |
| 一致性检查代价 | Table 10 三列全 PTIME | 可放热路径，但必须有 deadline |
| TBox 能否运行时改 | §4.1 禁存在量词头、禁析取 | 不能引入新存在个体；TBox 变更须全量重物化 |

## 6. 诚实标注

- Table 10 数值来自规范原文 HTML 解析，逐字核对过 td 内容；但 N2EXPTIME 的「2 的 2 的 n 次方」上标在纯文本里丢了格式，含义是 double exponential。
- 我没有独立验证 RL 规则集的**完备性证明**（规范只给部分公理化，PR1 的第三条约束在原文截断处未取全，以 O1 does not contain S... 开头）。若设计中依赖 completeness，需回去读完整 PR1。
- 复杂度表给的是**判定问题的理论界**，不是实现耗时。实测数据见 d7（内嵌推理器代价）与 d9（Datalog 引擎选型）。
- 复杂度表的 HTML 在 `$env:TEMP/owl2pf.html` 第 112501 字节起的 table.complexity 节点内；此前用 toc 锚点 complexity-table 定位失败是因为该锚点不存在于正文。
