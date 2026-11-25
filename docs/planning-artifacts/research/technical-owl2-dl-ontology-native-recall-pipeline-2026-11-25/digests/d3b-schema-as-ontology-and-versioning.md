# d3b — 「Schema 即本体」的工程先例、SHACL/OWL 分工、TBox 版本化与 ABox 迁移

source: 各产品官方文档原文（逐页抓取后 grep 原文）+ W3C 规范全文 + arXiv/Crossref 书目核验
publisher: W3C / Stardog / Ontotext / Apache / Oxford Semantic / Oracle / Franz / TerminusDB / OBO Foundry
pub_date: 规范 2004–2017；产品文档 2023–2026
accessed: 2026-11-25
confidence: high（规范与产品文档均取原文逐句核对；TerminusDB 无同行评议论文，只有官方文档，文中已标注）
class: 工程先例 + 规范边界 + 版本化机制

> 标记约定：**【规范】**＝W3C 规范明文；**【文档】**＝厂商官方文档明文；**【论文】**＝同行评议或 arXiv 摘要明文；**【推断】**＝我的推理，无直接出处。

---

## 0. 判决速览（先给结论，细节在后文）

| 问题 | 判决 | 依据 |
|---|---|---|
| 有没有系统真的「schema 就是 TBox、ABox 同存储」？ | **有，但无一例外都放弃了 query-time OWL DL**。真实存在的只有四种形态：查询重写（Stardog）、前向链物化（GraphDB/Oracle/AllegroGraph/RDFox）、纯存储无推理（Jena TDB2/Oxigraph/MillenniumDB）、文档型同 commit（TerminusDB）。 | 见 §1 |
| OWL 2 DL 有没有在生产里跑起来？ | **没有找到任何一个是 query-time OWL 2 DL 的**。Jena 自认只到 OWL Lite 且不完整；GraphDB 最高 OWL 2 RL；Stardog 的 SL 是 QL∪EL∪RL 超集；Oracle 最高 OWL 2 RL/EL；AllegroGraph 最高 OWL 2 RL；RDFox 的规则不支持析取。 | 见 §5 |
| SHACL 能否替代 OWL 推理？ | **不能，但能承担「封闭世界否定」这一半**。SHACL-AF 的 rules 是一个**单轮、不可自迭代**的前向规则引擎，规范自己说多轮行为「left to future work」。 | 见 §2 |
| owl:versionIRI / priorVersion / backwardCompatibleWith 够不够？ | **完全不够**。它们全部是 annotation，规范明说「has no meaning in the model-theoretic semantics」。本体序列（ontology series）在 OWL 2 结构规范里**根本没有显式表示**。 | 见 §3 |
| schema 改动要不要全量重推？ | **要**。Oracle 的增量推理「supports only the addition of triples. With updates or deletions, the inferred graph will be completely rebuilt」；GraphDB 说删 schema 语句代价可能极差。所有工程先例的答案是「schema 变更 = 全量重建」。 | 见 §4 |
| TerminusDB 的 schema 演进值得抄吗？ | **值得抄的是判据，不是实现**。它的判据是一句话：「The most useful question about a schema change is: can it make data that is valid today invalid?」配套两阶段（先 weakening 后 strengthening）+ 有序迁移操作列表。 | 见 §6 |

---

## 1. 「Schema 即本体」的七家实测：它们各自把 TBox 放在哪、ABox 放在哪、推理在哪一步发生

### 1.1 Stardog —— 查询重写（query rewriting），反物化

**TBox 存放位置【文档】**：TBox 不是"schema 文件"，而是一个**命名的图（named graph，Stardog 叫 reasoning schema）**，默认 IRI 是 `tag:stardog:api:context:schema`。公理与用户自定义规则（Datalog）都存在这里。7.0 起支持多 schema 并存（`reasoning.schemas` 配置 + CLI `--schema`），动机原文之一就是「两个版本的本体并存，老应用用旧版」。
（https://docs.stardog.com/inference-engine/）

**推理时机【文档】**：「it does not materialize inferences; rather, reasoning is performed at query time」。机制是 **QUERY REWRITING**：schema 被译成内部 Datalog 程序，查询被改写后再执行。文档给的例子是
`?person a :Person` → `{?person a :Person} UNION {?person a :Customer} UNION {?person a :Employee}`
并明说「RDFS and OWL axioms along with user-defined rules are (basically) Datalog rules over a graph」。
（https://docs.stardog.com/inference-engine/）

**为什么反物化（四条理由，原文）【文档】**：data freshness（数据/schema 一变就要重做，不适合高频变更与虚拟化数据）、data size（膨胀成本摊到每次查询 I/O）、fixed schema（无法按应用切规则集）、resources（真值维护昂贵，删除后尤甚）。
（https://docs.stardog.com/inference-engine/）

**两个 reasoner 的能力边界**：
- **Blackout**（成熟）：`reasoning.type` ∈ RDFS|QL|RL|EL|SL，默认 SL = RDFS+QL+RL+EL+SWRL 的并集。硬约束原文：「Any axiom outside the selected type will be ignored by the reasoner」；递归规则仅限能译成 SPARQL property path 者；坏规则只记日志，**仍继续推理**。
- **Stride**（9.0 起 beta）：支持否定与聚合，但**只支持七种公理**——`rdfs:subClassOf`、`owl:equivalentClass`、`rdfs:subPropertyOf`、`owl:equivalentProperty`、`owl:inverseOf`、`owl:SymmetricProperty`、`owl:TransitiveProperty`，其余一律忽略；有坏规则则**拒绝任何推理**。11.2 起支持谓词位变量，但要求类与属性均显式声明。
（https://docs.stardog.com/inference-engine/）

**Blackout 的 SL 到底支持哪些公理【文档】**（https://docs.stardog.com/inference-engine/blackout-owl-support）：
- 可推理：SubClassOf、EquivalentClasses、SubObjectPropertyOf、EquivalentObjectProperties、InverseObjectProperties、ObjectPropertyDomain、ObjectPropertyRange、ReflexiveObjectProperty、SymmetricObjectProperty、TransitiveObjectProperty、SubDataPropertyOf、EquivalentDataProperties、DataPropertyDomain、DataPropertyRange。
- **不在推理里**：`owl:hasKey`、`owl:propertyChainAxiom`、`owl:DisjointClasses`。DisjointClasses 只在一致性检查阶段用。
- 一致性专用（不进 inference）：DisjointClasses、DisjointObjectProperties、DisjointDataProperties、AsymmetricObjectProperty、IrreflexiveObjectProperty、FunctionalDataProperty、DataPropertyRange。
- 递归限制原文：「these restrictions are recursive ... the axiom `SubClassOf(ObjectSomeValuesFrom(p, ObjectAllValuesFrom(q, C)))` is not supported.」
- 有"部分采纳公理"开关：`reasoning.approximate=true` 时把 EquivalentClasses 拆成两条 SubClassOf，只用满足条件的那些。

**Proof Trees（工业界的证明树先例）【文档】**（https://docs.stardog.com/inference-engine/advanced-reasoning-features）：
「An explanation of an inference is the minimum set of statements explicitly stored in the database that, together with the schema and any valid inferences, logically justify the inference.」输出形如
```
INFERRED :Alice rdf:type :Employee
  ASSERTED :Manager rdfs:subClassOf :Employee
  INFERRED :Alice rdf:type :Manager
```
多解释可 merge 成带编号分支（1.1 / 1.2 / 2.1 …）的单棵 proof tree。命令 `stardog reasoning explain myDB inference_to_explain.ttl`。
**重要警告【文档】**：该页开头写「The advanced reasoning features explained in this chapter are deprecated as they are not supported by the new Stride reasoner.」——**证明树是被放弃的方向**。

**Schema 版本化【文档】**：对 reasoning schema graph 的内容算 64 位哈希，经 `SERVICE stardog:schema:service { [] stardog:schema:schema ?schema ; stardog:schema:version ?version }` 暴露；用途原文是「an optimization used by the reasoner to avoid reloading and reprocessing the schema unless the schema graphs have been updated」。需 `reasoning.schema.versioning.enabled=true` 且 `reasoning.precompute.non_empty.predicates=false`。文档自承百万三元组量级频繁更新时哈希开销明显。

**Virtual Graph【文档】**（https://docs.stardog.com/virtual-graphs/）：「Stardog intelligently rewrites (parts of) SPARQL queries ... into native query syntaxes like SQL, issues the native queries to remote datasources, and then translates the native results into SPARQL results」。四要素：名字、数据源、properties 文件、mapping 文件（多数源可自动生成）。→ **这条对本项目有直接含义：查询重写不必发生在自己的存储内部，可以把「概念查询」改写成宿主 TQL。**

### 1.2 Ontotext GraphDB —— 前向链、全物化

**机制【文档】**（https://graphdb.ontotext.com/documentation/11.0/reasoning.html）：「inference rules are applied repeatedly to the asserted (explicit) statements until no further inferred (implicit) statements are produced」。推论在 **LOAD 时算完**，以装载成本换查询速度。形式化基础是 R-entailment（Herman ter Horst）。

**规则集是文件【文档】**：`.pie` 格式，三节 Prefixes / Axioms / Rules；规则编译成 Java 源码，需 JDK ≥ 1.6，经自定义 bytecode class loader 装入。默认 RDFS-Plus（优化版）。每规则每前提生成 variant 作 leading premise（Cut 注解则跳过），入站三元组先匹配 leading premise，再按未绑定变量最少的前提展开。

**方言与完备性取舍【文档】**（https://graphdb.ontotext.com/documentation/11.0/owl-compliance.html）：支持 OWL-Horst、OWL-Max（「covers most of OWL Lite and RDFS」+ 全部 OWL DLP）、OWL2-QL、OWL2-RL。三条明确取舍：
- 「GraphDB does not provide the extended support for typed literals ... it is our understanding that the performance penalty is too high for most applications」
- 「There are no inconsistency rules by default」
- 「There is extended support for schema-level (T-Box) reasoning in GraphDB」

**主动砍语义完备性【文档】**（https://graphdb.ontotext.com/documentation/11.5/rdfs-plus-optimization.html）：被优化掉的推论包括「每个 URI 节点推 `X rdf:type rdfs:Resource`」「`owl:sameAs` 自反」「所有个体 `rdf:type owl:Thing`」等。原文理由：「Although the above inferences are important for formal semantics completeness, users rarely execute queries that seek such statements. Moreover, these inferences generate so many inferred statements that performance and scalability can be significantly degraded.」→ **这是「为性能主动牺牲语义完备性」的一手承认。**

**RETRACTION 的代价【文档】**：旧版重算全闭包（正确但不 scale），现只失效不再可导出者。两条实现路线对比：
- 为每条语句维护 track information —— 缺点原文「track information inflates more rapidly than the inferred closure - in the case of large datasets up to 90% of the storage is required just to store the track information」
- 反向链 + visited 标志 + `isSupported()`（用规则前提建查询、以该语句绑定变量）

**对 schema 变更的明确警告【文档】**：「deletion can still have poor performance when deleting schema statements, due to the (probably) large number of implicit statements inferred from them」。缓解手段是把 schema 语句设**只读**（`imports` 参数导入本体/词表）。schema 更新事务用 `[] <http://www.ontotext.com/owlim/system#schemaTransaction> []` 触发 smooth-delete，可穿越只读语句，但「likely to be much more computationally expensive ... intended for the occasional, offline update」。**换规则集必须导出全部显式语句并重建 repository。**

### 1.3 Apache Jena TDB2 + Fuseki —— 存储不管推理

**TDB2 是什么【文档】**（https://jena.apache.org/documentation/tdb2/）：只是 RDF 存储与查询组件，**无内建推理**。与 TDB1 的差异：事务无大小限制（可向在线 Fuseki 批量导入上亿三元组）、支持跨事务传递 Model/Graph、仅事务模式（无 autocommit）、「Writer pays」读者不付费、保留数值 datatype。TDB2 与 TDB1 不兼容。

**推理在 Graph SPI 层【文档】**（https://jena.apache.org/documentation/inference/）：`ModelFactory` 把数据集与 reasoner 关联成 `InfModel`。关键一句：「In RDF there is no strong separation between schema (aka Ontology AKA tbox) data and instance (AKA abox) data and so any data ... can be included in either the bind or bindSchema calls - the names are suggestive rather than restrictive」——**Jena 明确不做 TBox/ABox 分离，schema 只是一个术语建议**。

**Jena 的 OWL reasoner 自述（第 5 问最硬的一条证据）【文档】**：「a rule-based implementation of the OWL/lite subset of OWL/full ... Each of the configurations is intended to be a sound implementation of a subset of OWL/full semantics but **none of them is complete (in the technical sense)**. For complete OWL DL reasoning use an external DL reasoner such as Pellet, Racer or FaCT.」
不支持 `owl:complementOf` 与 `owl:oneOf`（原文：「The critical constructs which go beyond OWL/lite and are not supported in the Jena OWL reasoner are complementOf and oneOf」）；`owl:unionOf` 只支持正向；`owl:allValuesFrom` 只正向；基数限制限 0/1。
Incompleteness 节原文：「The rule based approach cannot offer a complete solution for OWL/Lite, let alone the OWL/Full fragment ... We intend that the reasoner should be sound ... but not complete.」
方法是 instance-based：为每个声明类造原型实例再推导——文档自己说这是与 DL reasoner 的对照取舍（擅长实例推理与简单规整本体，不擅长大型丰富本体）。性能提示：显式 import `owl.owl` 会导致规则重复使用与明显变慢。

**→ Jena 的定位是「推理是可选插件，DL 请外挂」。这是「不做 query-time OWL DL」的第一手退让声明。**

### 1.4 Oxigraph —— 只有存储和 SPARQL

**官方自述【文档】**（https://raw.githubusercontent.com/oxigraph/oxigraph/main/README.md）：「a graph database and a RDF and SPARQL toolkit」，基于 RocksDB；实现 SPARQL Query/Update/Federated、Turtle/TriG/N-Triples/N-Quads/RDF-XML/JSON-LD、RDF Dataset Canonicalization。自承「Oxigraph is in heavy development and SPARQL query evaluation has not been optimized yet」。**README 全文无任何 reasoning/OWL 字样。**

**OWL 2 RL 是 open issue**【文档】（https://github.com/oxigraph/oxigraph/issues/130）：「Support OWL 2 RL reasoning?」2021-08-14 开出，至今 OPEN，标记 help wanted，里程碑 after 1.0。维护者 Tpt：「I would love to get a rule-based reasoning system with truth maintenance integrated into Oxigraph. But it's not a priority for me right now」。

### 1.5 MillenniumDB —— 三种图模型，无本体层

**官方自述【文档】**（https://raw.githubusercontent.com/MillenniumDB/MillenniumDB/main/README.md）：支持三种模型——RDF（「fairly complete support for the SPARQL 1.1 standard」）、Quad Model（单边标签有向边的 property graph，Cypher 类语言）、GQL 标准 property graph（「early implementation of GQL, still missing a lot of functionality and optimizations」）。自述「still in active development and is not production ready yet」。
**论文**【论文】（https://arxiv.org/abs/2111.01540，Vrgoc/Rojas/Angles/Arenas/Arroyuelo/Buil-Aranda/Hogan/Navarro/Riveros/Romero, 2021-11-02）：基于 domain graphs 抽象、源自关系数据管理的技术 + worst-case-optimal joins + 图专用路径查询算法。
**README 与论文摘要均无任何 OWL/推理/SHACL 内容。【推断】MillenniumDB 无本体层，它是查询引擎不是本体库。**

### 1.6 Oracle Database 23ai RDF Semantic Graph —— 最完整的工业先例

**四种规则库，表达力递增【文档】**（https://docs.oracle.com/en/database/oracle/oracle-database/23/rdfrm/ontologies.html）：
| 规则库 | 覆盖 |
|---|---|
| RDFS++ | RDFS + `owl:sameAs` + `owl:InverseFunctionalProperty` |
| OWLSIF | pD* 语义（Horst, JWS 3(2), 2005, 79–115） |
| OWLPrime | class/subclass/property/subproperty/domain/range/type + transitive/symmetric/functional/inverseFunctional/inverse + equivalence/disjointness + same/different + complement + hasValue/someValuesFrom/allValuesFrom |
| OWL2RL | 「supports all the standard production rules defined for OWL 2 RL」 |
| OWL2EL | 「supports the EL syntax」，明确用于 SNOMED |

规则**内置、用户不可见**：「these rulebases do not need to be populated because the underlying inference rules of these three vocabularies are internally implemented.」
OWLPrime 的 value restriction 是 intensional：「As with pD*, the supported semantics for these value restrictions are only intensional (IF semantics).」
OWL2EL 明确砍自反属性：「the OWL2EL rulebase support does not include reflexive object properties (ReflexiveObjectProperty) simply because a reflexive object property will link every individual with itself, which would probably cause an unnecessary and costly expansion of the inference graph.」

**Proof 生成（本项目第 ⑤ 步的第二个工业先例，且是持久化的）【文档】**（https://docs.oracle.com/en/database/oracle/oracle-database/23/rdfrm/using-owl-inferencing.html）：
- 「To generate the information required for proof, specify `PROOF=T` in the call to the `SEM_APIS.CREATE_INFERRED_GRAPH` procedure」，代价「Proof generation does require additional CPU time and disk resources.」
- 「Specifying `PROOF=T` causes a view to be created containing proof for each inferred triple.」视图名 = 推断图名加前缀 `RDFUSER.NET1#SEMI_`，两列 `LINK_ID` 与 `EXPLAIN`。
- 编码格式原文：「A proof consists of one or more triple (link) ID values and the name of the rule that is applied on those triples: `link-id1 [ link-id2 … link-idn ] : rule-name`」，实测输出 `8_5_5_4 generated by 4_D_5_5 : SYMM_SAMH_SYMM`。
- **强约束**：「If the inference status is INCOMPLETE and if the last inference was generated without proof information, you cannot invoke `SEM_APIS.CREATE_INFERRED_GRAPH` with `PROOF=T`. In this case, you must first drop the inferred graph and create it again specifying `PROOF=T`.」→ **proof 必须从建图时开启，不能事后补。**

**一致性校验【文档】**：`SEM_APIS.VALIDATE_RDF_GRAPH` / `VALIDATE_INFERRED_GRAPH`，「returns a null value if no errors are detected or a VARRAY of strings if any errors are detected」，检查「unsatisfiable classes, instances belonging to unsatisfiable classes, and two individuals asserted to be same and different at the same time」。

**命名图推理【文档】**：默认「takes all asserted triples from all the source RDF graph or RDF graphs ... until an inference closure is reached」，完全 global。可改用 NGGI（全部命名图当一个统一图）或 NGLI（每个命名图独立推理）。**关键限制**：「NGLI currently does not work together with proof generation, user-defined rules, optimized owl:sameAs handling, or incremental inference.」→ **多公理集/多版本并存 与 证明生成、增量推理 三者互斥。**

### 1.7 AllegroGraph —— 两个引擎二选一

**原文【文档】**（https://franz.com/agraph/support/documentation/current/materializer.html）：「AllegroGraph has two different inference engines: one supports a superset of RDFS inference rules and the other supports OWL 2 RL. The first is called the dynamic RDFS++ reasoner because it generates inferred triples on-the-fly and does not save them in the triple-store. The second is an OWL 2 RL materializer: it uses a set of inference rules to generate new triples and adds them to the triple-store.」
**变更代价**【文档】：「If the triple store is changed via additions or deletions then materialization may have to be run again so that the triple store contains the correct set of materialized triples.」
**官方选型建议（把「数据在变」与「要物化」定义为互斥）**【文档】：「The dynamic reasoner is best when: you do not need OWL 2 RL inference rules and the store you are using is changing. The materializer is best when: OWL 2 RL inference is required or the store is relatively static.」
规则集可裁剪：`--rule all|class|property|restriction|same-as|values-from`；`--bulk` 模式约快 30%（「approximately 30% faster materialization」）但事务不持久不写日志；默认 delete-first，即每次物化先删旧推论；推论写入专门图。

### 1.8 TerminusDB —— 文档型同 commit（详见 §6）

一句话对照：TerminusDB 是**唯一一个把「schema 与实例数据放进同一个 commit」当核心设计的系统**。原文（https://terminusdb.com/docs/ontology-versioning/）：「In TerminusDB, the schema is a graph of its own, next to the instance data, and both are in the same commit. The schema is enforced: each write is checked against it, and a write that does not fit is refused.」

### 1.9 汇总对照表

| 系统 | TBox 存在哪 | ABox 存在哪 | 推理时机 | 最高表达力 | 有没有证明 |
|---|---|---|---|---|---|
| Stardog | reasoning schema（named graph，默认 `tag:stardog:api:context:schema`） | 普通 named graph | **query-time 重写** | SL（QL∪EL∪RL 超集 + 非标准扩展） | 有（Proof Trees），但已 deprecated |
| GraphDB | `.pie` 规则集 + imports 图 | 同库 | **LOAD 时全物化** | OWL 2 RL（含 OWL-Horst/OWL-Max 方言） | 无原生 |
| Jena TDB2 | 就是普通三元组（不分离） | 同库 | 外挂 reasoner，SPI 层 | OWL Lite 子集，**明确不完整** | 无 |
| Oxigraph | 无概念 | 无概念 | **无推理** | 无 | 无 |
| MillenniumDB | 无概念 | 无概念 | **无推理** | 无 | 无 |
| Oracle 23ai | 规则库内置（不可见）+ 命名图 | 同库 | **建推断图时物化** | OWL 2 RL / OWL 2 EL | **有，持久化到视图** |
| AllegroGraph | 规则集（六种可裁剪） | 同库 | **二选一**：动态 on-the-fly 或物化 | OWL 2 RL（规则表裁掉约 1/3） | 无 |
| TerminusDB | **schema 图（JSON 语法）** | 同 commit 的实例图 | 写时校验（无 OWL 推理） | JSON Schema + 类层级 | 无 |

---

## 2. SHACL 与 OWL 的分工：封闭世界校验 vs 开放世界推理

### 2.1 SHACL 规范本身对「与推理的关系」只有一条挂钩【规范】

**§1.5 Relationship between SHACL and RDFS inferencing**（https://www.w3.org/TR/shacl/）：
- 「SHACL uses the RDF and RDFS vocabularies, but **full RDFS inferencing is not required**.」
- SHACL 处理器 MAY operate on graphs that include entailments ——「either pre-computed before being submitted to a SHACL processor or performed on the fly as part of SHACL processing (without modifying either data graph or shapes graph)」；为此规范引入 `sh:entailment` 指出该 shapes graph 要求何种推理。
- **强制条款原文**：「SHACL implementations MAY, but are not required to, support entailment regimes. If a shapes graph contains any triple with the predicate `sh:entailment` and object E and the SHACL processor does not support E as an entailment regime for the given data graph then the processor **MUST signal a failure**. Otherwise, the SHACL processor MUST provide the entailments for all of the values of `sh:entailment` in the shapes graph, and any inferred triples MUST be returned by all queries against the data graph during the validation process.」
- §1.6 明说该节 non-normative；SPARQL 不是 SHACL Core 实现的必需。`sh:entailment` 的值域是 IRI，常见值见 SPARQL 1.1 Entailment Regimes（https://www.w3.org/TR/sparql11-entailment/）。
- SHACL 主规范对 `owl:imports` 有明确要求：shapes graph 可通过 `owl:imports` 互相引用，处理器 SHOULD 传递闭包导入。

→ **【规范】SHACL 规范不定义 OWL 与 SHACL 的组合语义，只提供一个可选的 entailment regime 挂钩。**

### 2.2 SHACL-AF 的 rules 是不是推理？—— 是，但是一个单轮的引擎【规范】

来源：https://www.w3.org/TR/shacl-af/（**W3C Working Group Note，2017-06-08，不是 Recommendation**；文档自己写「inappropriate to cite this document as other than work in progress」）。

**§8.3 sh:Rules Entailment Regime**：shapes graph 用 `sh:entailment` 关联 regime，IRI `sh:Rules` 即 SHACL rules regime；支持者验证前先跑规则，不支持者「MUST signal a failure if this triple is present」。

**§8.4 执行算法**：rules engine 输入 data graph + shapes graph，可向 data graph 加 inferred triples，也可放进独立 inferences graph。伪码按 shape 的 `execution order`、非 deactivated 的 rule、符合 `sh:condition` 的 target node T，以 T 为 focus node 执行。

**三个致命限制（原文）**：
1. **不可自迭代**：「this algorithm only covers a single 'iteration' over all rules, without prescribing the behavior if the same rule needs to be applied multiple times after other rules have fired. **The latter is left to future work.**」
2. **可见性隔离**：同 execution order 的 shape/rule 互不可见；同一 rule 跨 target node 亦互不可见。
3. **规则不能改规则**：「At no time are inferred triples visible to the shapes graph, i.e., it is impossible for rules to modify the definitions of rules or shapes.」

**两类规则**：`sh:TripleRule`（`sh:subject`/`sh:predicate`/`sh:object` 三个 node expression 取笛卡尔积）与 `sh:SPARQLRule`（`sh:construct` + `sh:prefixes`，把 `$this` 预绑定到 focus node）。

→ **【规范】SHACL-AF rules 能表达「一次前向推导」，但表达不了递归闭包，也表达不了「规则互相触发」的定点计算。这与 OWL 2 RL 的定点闭包语义有本质差。**

### 2.3 工业界怎么组合：Stardog ICV 是最完整的范例

**Stardog 把 SHACL 用作 Integrity Constraint Validation（ICV）**【文档】（https://docs.stardog.com/data-quality-constraints）：
- 把 SHACL 当普通 RDF 数据存进 named graph：「Best practice is to store SHACL definitions in one or more named graphs to make managing them easier」；配置 `icv.active.graphs` 限定从哪些图取约束。
- **推理与校验的显式开关（本项目最该抄的一条）**：「An integrity constraint may be satisfied or violated in either of two ways: by an explicit statement in a Stardog database or by a statement that's been validly inferred by Stardog. For this reason, **the validation results will change if reasoning is enabled or disabled**. By default, reasoning is disabled for validation but can be enabled just like in any other SPARQL query.」CLI：`stardog query --reasoning testdb "VALIDATE ALL"`。
- **写时校验**：ICV Guard Mode 开启 `icv.enabled=true` 后「modifications of the database ... that violate the integrity constraints will cause the transaction to fail」。
- **SHACL 支持边界（原文）**：「Stardog supports all the features in the core SHACL Language with the following exceptions: Stardog supports SPARQL-based constraints but does not support prebinding the `$shapesGraph` or `$currentShape` variables in SPARQL. Stardog does not support property validators. **Stardog does not support the Advanced Features or the JavaScript Extensions.**」→ **Stardog 明确不支持 SHACL-AF。**

**GraphDB 的 SHACL 实现**【文档】（https://graphdb.ontotext.com/documentation/11.0/shacl-validation.html）：
- 通过 RDF4J 的 `ShaclSail` 存储层实现；「SHACL support in a given repository must be enabled when that repository is created. You cannot modify an already existing repository by enabling the validation afterwards.」→ **启用即重建仓库。**
- shapes 存在保留图 `http://rdf4j.org/schema/rdf4j#SHACLShapeGraph`，也可用 `sh:shapesGraph` 指定；可用命名图把 shapes 与不可信数据分开（原文动机：「You can store shapes in one graph and untrusted data in another without the untrusted data overriding the constraints provided by the shapes」）。
- **语义限制（原文）**：「When using named graphs for SHACL shapes each data graph is evaluated separately by default ... the data in the two example graphs will not be joined before being validated. It is not possible to split a single object across multiple graphs in order to validate it with SHACL.」
- `sh:path` 限 predicate/sequence/alternative/inverse 四类，zero-or-more/one-or-more/zero-or-one「will be added in the near future」。
- 已知限制：「`sh:or` is limited to statement-based restrictions such as `sh:datatype`, or aggregate-based restrictions such as `sh:minCount`, but not both at the same time.」
- 与推理的耦合点：隐式 `sh:targetClass` 对 `rdfs:Class` 且是 `sh:PropertyShape`/`sh:NodeShape` 的节点生效；「For all nodes that are equivalent to `owl:Thing` in an environment with a reasoner, you can enable validation by setting `setUndefinedTargetValidatesAllSubjects(true)`」——**SHACL 与 reasoner 是两个可叠加但需显式开关的层。**

### 2.4 学术上的组合代价：即使最简本体也让校验 EXPTIME-complete【论文】

**Oudshoorn et al., "SHACL Validation in the Presence of Ontologies: Semantics and Rewriting Techniques"**（arXiv:2507.12286；Artificial Intelligence Vol 352, 2026, 104483, DOI 10.1016/j.artint.2026.104483）
摘要核心原文：「OWL, designed for inferring facts from incomplete data, makes the open-world assumption, whereas SHACL is a constraint language that treats the data as complete and must be validated under the closed-world assumption. The combination of both formalisms is very appealing and has been called for, but **their semantic gap is a major challenge, semantically and computationally**.」
方法：core universal models + Horn-ALCHIQ 构造 + 有限表示 + rewriting 归约到标准 SHACL 校验。
**复杂度结论**：「even very simple ontologies make the problem **EXPTIME-complete**, and PTIME-complete in data complexity」。

**Arndt/Oudshoorn et al., "Rewrite Once, Validate Anywhere: Producing OWL-Aware SHACL Constraints"**（arXiv:2608.14104，ISWC'26 technical report）：
「we construct a rewriting which takes as input both shapes and an OWL EL^- ontology ... and produces SHACL constraints. This output can then be evaluated by any validator supporting SHACL core regardless of its reasoning support」；实验结论「our approach is in general more efficient in finding violations compared to the sequential approach」（对照 sequential = 先推理再校验）。

**Bogaerts/Jakubowski/Van den Bussche, "SHACL: A Description Logic in Disguise"**（arXiv:2108.06096，LPNMR 2022）：主张「SHACL is in fact a description logic」，把 DL 确立为 SHACL 的形式基础。→ **把 SHACL shape 视作 DL 概念来表达「封闭世界下的完整性」，与 OWL 概念共享同一套模型论语言，理论上是可行的。**

### 2.5 组合模式总结

| 模式 | 做法 | 谁在用 | 代价 |
|---|---|---|---|
| **顺序式**：先推理后校验 | 物化/重写得到完整图，再对图跑 SHACL | GraphDB（`setUndefinedTargetValidatesAllSubjects`）、Stardog `--reasoning VALIDATE ALL` | 校验结果随「推理开/关」变化（Stardog 明文承认）；封闭世界假设被推理结果污染 |
| **重写式**：把本体编译进 shape | 把 OWL 公理重写成等价的 SHACL 约束，交给任意 SHACL core 引擎 | Arndt et al.（arXiv:2608.14104） | 只对 OWL EL^- 成立；生成物爆炸 |
| **规则式**：SHACL-AF 做前向推导 | `sh:SPARQLRule` 产 inferred triples | 支持者极少（Stardog 明确不支持） | 单轮、无定点、规则改不了规则 |
| **并行式**：OWL 管推理、SHACL 管数据质量 | 两套独立引擎，各自跑，结果在应用层合 | Stardog ICV（推荐做法） | 语义上有裂隙：同一事实可能「被推理蕴含」但「被 SHACL 判违规」 |

---

## 3. TBox 版本化：规范给了什么、行业怎么补

### 3.1 OWL 的版本化词汇全部是 annotation，语义上完全无约束【规范】

**OWL 1 Reference §7.4 Version information**（https://www.w3.org/TR/owl-ref/）：

| 词汇 | 原文定义 | 有没有语义后果 |
|---|---|---|
| `owl:versionInfo` | 「generally has as its object a string giving information about this version, for example RCS/CVS keywords. This statement **does not contribute to the logical meaning of the ontology** other than that given by the RDF(S) model theory.」 | **无** |
| `owl:priorVersion` | 「identifies the specified ontology as a prior version of the containing ontology. This **has no meaning in the model-theoretic semantics** other than that given by the RDF(S) model theory. However, it **may be used by software to organize ontologies by versions**.」 | **无**，只是给工具的标签 |
| `owl:backwardCompatibleWith` | 「... and further indicates that it is backward compatible with it. In particular, this indicates that **all identifiers from the previous version have the same intended interpretations in the new version**. Thus, it is a **hint to document authors** that they can safely change their documents to commit to the new version (by simply updating namespace declarations and owl:imports statements ...). **If owl:backwardCompatibleWith is not declared for two versions, then compatibility should not be assumed.**」然后明说「has no meaning in the model theoretic semantics」 | **无**。规范没有给出「什么叫 same intended interpretation」的判定算法 |
| `owl:incompatibleWith` | 「This indicates that the containing ontology is a later version of the referenced ontology, but is not backward compatible with it. Essentially, this is **for use by ontology authors who want to be explicit** that documents cannot upgrade to use the new version without checking whether changes are required.」 | **无** |
| `owl:DeprecatedClass` / `owl:DeprecatedProperty` | 「Deprecation is a feature commonly used in versioning software (for example, see the Java programming language) to indicate that a particular feature is preserved for backward-compatibility purposes, but may be phased out in the future. ... By deprecating a term, it means that the term should not be used in new documents that commit to the ontology. This allows an ontology to maintain backward-compatibility while phasing out an old vocabulary (thus, it only makes sense to use deprecation in combination with backward compatibility).」 | **无**（但 OWL 2 的 `owl:deprecated` 是个布尔注解，可机器读） |

OWL 1 官方给的一个陷阱例子（原文注释）：「note that `equivalentClass` only means that the classes have the same extension, so this **DOES NOT lead to the entailment** that `Automobile` is of type `DeprecatedClass` too」。

### 3.2 OWL 2 结构规范：只有命名约定 + 三条 SHOULD【规范】

来源：https://www.w3.org/TR/owl2-syntax/ §3.1–3.5

- **§3.1 硬约束**：「Each ontology MAY have an ontology IRI ... the ontology MAY additionally have a version IRI ... An ontology without an ontology IRI **MUST NOT** contain a version IRI.」
- **三条 SHOULD，且自承强制力**：「This specification **provides no mechanism for enforcing these constraints across the entire Web**; however, OWL 2 tools SHOULD use them to detect problems in ontologies they process.」
  - (a) 有 ontology IRI 无 version IRI 者，同 IRI 无 version IRI 的另一本体 SHOULD NOT 存在
  - (b) 同 ontology IRI + 同 version IRI 组合 SHOULD NOT 重复
  - (c) 其他组合不要求唯一
- **ontology series 的核心定义（本问的判决性引文）**：「The ontology IRI and the version IRI together identify a particular version from an ontology series -- the set of all the versions of a particular ontology identified using a common ontology IRI. In each ontology series, exactly one ontology version is regarded as the current one. ... **Ontology series are not represented explicitly in the structural specification of OWL 2: they exist only as a side effect of the naming conventions** described in this and the following sections.」
- **§3.2 一句对本项目直接相关的话**：OWL 2 工具「could also devise a scheme for storing OWL 2 ontologies in a relational database. In such a case, each subset of the database representing the information about one ontology corresponds to one ontology document」——**规范显式允许把本体存进数据库，只要每个本体子集可被一个 IRI 访问。**
- **§3.3 版本化规则**：当前版本的文档 SHALL 经 ontology IRI（及 version IRI）可达；**旧版本的文档 SHOULD 只经各自的 version IRI 可达**。
- **§3.4 唯一有「冲突检测」味道的条款**：「The import closure of an ontology O SHOULD NOT contain ontologies O1 and O2 such that O1 and O2 are different ontology versions from the same ontology series, or O1 contains an ontology annotation `owl:incompatibleWith` with the value equal to either the ontology IRI or the version IRI of O2.」→ **只用 SHOULD NOT 禁止「同一 import 闭包里混装两个版本」，没有规定混装后怎么修。**

**判决（规范明确写的）**：OWL 2 给了**命名约定 + 三条 SHOULD**，没给迁移语义、没给兼容性判定算法、没给「什么叫 compatible」。**「旧 ABox 按新 TBox 需要迁移」这件事，规范一个字都没说。**

### 3.3 实践 1：OBO Foundry —— 「IRI 永久不变 + 快照不可改 + 版本只增不改」

来源：https://obofoundry.org/principles/fp-004-versioning.html、https://obofoundry.org/principles/fp-019-term-stability.html

**版本化（Principle 4）【规范级行业标准】**：
- 「each official release **MUST** have a unique version IRI that resolves to the specific ontology artifact indicated. ... A version IRI is a full path that **MUST** resolve to the particular version of the ontology artifact. Both the version IRI and the corresponding artifact **MUST** contain an identical version identifier string.」
- 版本标识：「**MUST** either be of the form "YYYY-MM-DD" (that is, a date) OR use a numbering system (such as semantic versioning, i.e, of the form "NN.n")」；日期必须 ISO-8601 四位数年份、连字符分隔。
- **不可变性（最关键一条）**：「the content of official release files **MUST NOT** be changed. For example, if a bug is found in some official released file for some ontology, the bug **MUST NOT** be fixed by changing the file(s) for that official release. Instead the bug fixes should be included in a new official release, with new files, and consumers can switch to the new release.」
- PURL：`http://purl.obolibrary.org/obo/idspace/YYYY-MM-DD/idspace.owl`（或加 `/releases/`）。

**术语稳定性（Principle 19）——「不迁移」的替代方案**：
- 「The definition of a term **MUST** always denote the same thing(s)–known as "referent(s)"–in reality. If a proposed change to the definition would substantially change its referents, then **a new term with new IRI and definition MUST instead be created**.」
- 废弃操作（MUST 部分）：加 `owl:deprecated "true"^^xsd:boolean`；给 label 与 editor preferred term 前置字符串 `"obsolete "`（精确小写带空格）；**移除该术语上的全部逻辑公理**；**移除或替换本体中其他地方对该术语的全部使用**（原文举例：若 `A part-of B` 且 `B` 已弃用并替换为 `C`，则须改写为 `A part-of C`；若 `B part-of C`，则须删掉涉及 B 的 part-of 公理）。
- 可选部分：用 `IAO:0100001`（`term replaced by`）给精确替代；用 `oboInOwl:consider` 给非精确替代；用 `IAO:0000231`（`has obsolescence reason`）+ `IAO:0000225` 的个体给废弃原因。

**→ 实践结论【推断】**：**OBO 生态的做法是把「迁移」问题完全消解掉**——它不做 ABox 迁移，靠三个机制：(1) IRI 永远指同一个指称物，指称变了就换新 IRI；(2) 每个版本是不可变快照，消费者显式钉住某个 version IRI；(3) 废弃术语的逻辑公理被移除、使用点被就地改写（这实际上是「迁移」被压缩到「本体内部的公理改写」这一最小范围）。**这是本项目「TBox 版本化」最省力的参照。**

### 3.4 实践 2：TerminusDB 的两阶段迁移（详见 §6）

原文（https://terminusdb.com/docs/ontology-versioning/）：「add a weakening operation first that enables the change first, then once all instances conform to the breaking change, apply the strengthened schema」。

### 3.5 学术定位：Noy & Klein 2004 —— 为什么本体演化和 schema 演化不同

**"Ontology Evolution: Not the Same as Schema Evolution"**, Knowledge and Information Systems 6(4):428–440, 2004-07, DOI 10.1007/s10115-003-0137-2【论文】

摘要原文：「The many similarities between database-schema evolution and ontology evolution will allow us to build on the extensive research in schema evolution. However, there are also **important differences** ... The differences stem from **different usage paradigms, the presence of explicit semantics and different knowledge models**. A lot of problems that existed only in theory in database research come to the forefront as practical problems in ontology evolution.」
四条结论原文：「The traditional distinction between versioning and evolution is not applicable to ontologies. There are several **dimensions** along which compatibility between versions must be considered. The set of change operations for ontologies is different. We must develop **automatic techniques for finding similarities and differences between versions**.」

**→【推断】「presence of explicit semantics」正是本项目可利用的差异点：数据库 schema 变更不需要考虑推论失效，本体变更必须。**

### 3.6 综述文献（书目已核，正文未取）

| 文献 | DOI | 定位 |
|---|---|---|
| Flouris/Harmanidis/Plexousakis/Antoniou, "Ontology change: classification and survey", KER 2008 | 10.1017/s0269888908001367 | change 操作分类 |
| Zablith et al., "Ontology evolution: a process-centric survey", KER 2013 | 10.1017/s0269888913000349 | 过程视角 |
| Hartung/Terwilliger/Rahm, "Recent Advances in Schema and Ontology Evolution", 2010 | 10.1007/978-3-642-16518-4_6 | schema+ontology 演化综述章 |

---

## 4. 「schema 一改，ABox 就得重推」的工程数据

### 4.1 唯一给出完整数字的一手材料：RDFox 官方性能报告【文档】

来源：https://docs.oxfordsemantic.tech/reasoning.html（§10.9 Profiling，数据集为 F1 赛车，约 470 万条）

RDFox 自述其推理范式为 **materialization-based**：「RDFox uses materialization-based reasoning to precompute and store all triples that logically follow from the input graph and rules in a query-independent way」；查询「simply evaluating the query directly over the materialization, thus avoiding the expensive reasoning at query time」。
核心难点原文：「whenever data triples and/or rules are added and/or deleted, the 'old' materialization must be replaced with the 'new' materialization」。删除只允许删**输入图里显式**的三元组，「one does not consider deletion of derived triples—a complex problem known in the literature as belief revision or view update」。

**阶段 1：首次导入 `2021-22.ttl`**

| 指标 | 值 |
|---|---|
| Reasoning time | **0.016 s** |
| DefaultTriples Entries | 26,881 → 29,441 |
| Explicit | 14,820 → 14,820 |
| All (inferred) | 0 → **15,759** |

**阶段 2：增量导入 `upTo2020.ttl`（约 470 万条）**

| 指标 | 值 |
|---|---|
| Reasoning time | **1.280 s** |
| DefaultTriples Entries | 4,720,641 → 4,748,801 |
| Explicit | 14,820 → **4,710,491** |
| All (inferred) | 15,759 → **4,740,705** |
| 新增非显式事实 | 约 **30,000** |

→ **【文档】推论放大比：显式 14,820 → 全量 4,740,705，膨胀约 320 倍。这正是 Stardog 反对物化的「data size」理由的量化形态。**

**阶段 3（对第 4 问最关键）：加入一条新规则的成本**

增量推理被 profiler 拆成五个阶段：**Addition / Deletion / BwdChain（反向链，负责重新证明被删事实）/ RuleAdd / rule deletion**。关键观察原文：「incremental reasoning has multiple phases (addition, deletion, backward chaining, ...). These take place **despite the fact that the operation that we are performing is that of data addition** ... the addition of facts could outdate facts derived directly or indirectly by rules with aggregation or negation」。

而**加一条规则**时，单条规则的 `RuleAdd` 阶段可产出 **514.5k 条新事实**、迭代器执行 **2.0M 次操作**，`Mat` 阶段产出 17 个样本、514.5k 次匹配。

→ **【文档】「改 schema（加规则）」与「加数据」在成本上不是同一个量级：加数据触发 1.28 s，加一条规则触发 51 万条新事实重算。这是「TBox 变更远比 ABox 变更昂贵」唯一有数字的一手证明。**
另有 `remat` 命令强制全量重物化。

### 4.2 增量推理的边界：几乎都只支持「纯新增」【文档】

**Oracle Database 23ai**（https://docs.oracle.com/en/database/oracle/oracle-database/23/rdfrm/using-owl-inferencing.html）的 `INC=T` 增量推理限制清单原文：
- 「It supports **only the addition of triples**. With **updates or deletions, the inferred graph will be completely rebuilt**.」
- 「It does not work with optimized `owl:sameAs` handling (OPT_SAMEAS), user-defined rules, VPD-enabled RDF graphs, or version-enabled RDF graphs.」
- 「It depends on triggers on application tables.」且 RAW8/NUMBER 列类型必须前后一致，否则重建。
- 回退机制：「if the last inferred graph was created 6 hours ago, the `UNDO_RETENTION` value should be set to greater than 6 hours ... `SEM_APIS.CREATE_INFERRED_GRAPH` procedure **falls back to regular (non-incremental) inference**.」

**GraphDB**（https://graphdb.ontotext.com/documentation/11.0/reasoning.html）：
- 旧版 retraction 重算全闭包（正确但不 scale），现只做**失效**而非重新导出。
- 为每条语句维护 track information 的路线被官方否掉：「track information inflates more rapidly than the inferred closure - in the case of large datasets **up to 90% of the storage is required just to store the track information**」。
- **删 schema 语句的代价，官方明文警告**：「deletion can still have poor performance when deleting **schema statements**, due to the (probably) large number of implicit statements inferred from them」；缓解手段 = 把 schema 语句设**只读**（`imports` 参数导入本体/词表）。
- schema 更新事务：插入 `[] <http://www.ontotext.com/owlim/system#schemaTransaction> []` 触发 smooth-delete，可穿越只读语句，但「**likely to be much more computationally expensive** ... intended for the **occasional, offline update**」。
- **换规则集 = 导出全部显式语句并重建 repository。**

→ **【推断】业界「增量推理」的普遍形态是：只支持显式三元组的纯新增；删除靠失效或重建；schema/规则变更是离线操作。** 三条独立证据（Oracle 限制清单、GraphDB 只读 schema + offline schema transaction + 换规则集重建、RDFox 分阶段但成本跳变）指向同一结论。

### 4.3 学术上的量级表述【论文】

**Motik / Nenov / Piro / Horrocks, "Combining Rewriting and Incremental Materialisation Maintenance for Datalog Programs with Equality"**（arXiv:1505.00212，2015-05-01）
摘要原文：「Materialisation precomputes all consequences of a set of facts and a datalog program so that queries can be evaluated directly ... Rewriting optimises materialisation for datalog programs with equality by replacing all equal constants with a single representative; and incremental maintenance algorithms can efficiently update a materialisation for small changes in the input facts. Both techniques are critical to practical applicability of datalog systems; however, we are unaware of an approach that combines rewriting and incremental maintenance. ... we show empirically that it can **speed up updates by several orders of magnitude** compared to using either rewriting or incremental maintenance in isolation.」
→ **【论文】唯一的定量表述是「几个数量级」（several orders of magnitude），具体倍数在正文表格（未取正文）。对工程的含义：等式（`owl:sameAs`）处理既是重写的对象也是增量维护的对象，两者不平庸——这直接关系到本项目要不要支持 `owl:sameAs`。**

### 4.4 其他可用的量级参照

- **AllegroGraph `--bulk` 模式**（https://franz.com/agraph/support/documentation/current/materializer.html）：约快 30%（原文「approximately 30% faster materialization」），但事务不持久、不写日志。默认 `delete-first? = true`——**每次物化先删旧推论**。
- **Jena RDFS reasoner 与 XSB 的对比表**（https://jena.apache.org/documentation/inference/，1.1 GHz Pentium 归一化秒数）：可作为「纯规则前向推理在单机上的规模—耗时曲线」参照。
- **GraphDB 规则编译**：`.pie` 规则集编译成 Java 源码后装入，自定义 bytecode class loader——即「规则集变更」在这类系统里是一个**编译期/部署期**事件，不是运行时事件。

### 4.5 第 4 问的结论

**【推断】** 没有任何一个生产系统给出「TBox 小改动 → ABox 增量重推」的可用工程路径。可用的只有三条：
1. **不改（OBO 式不可变快照）** —— 新版本 = 新 IRI，旧快照冻结，消费者钉住版本；
2. **只加不删（RDFox / Oracle 纯新增增量）** —— 把演化限制为「加类、加属性、加公理」，绝不做删除或收窄；
3. **离线全量重建（GraphDB schema transaction / Oracle rebuild / AllegroGraph delete-first）** —— 接受停机，把它当部署事件。

**对本项目的直接约束：triviumdb 的 schema 演化必须走 (1)+(2)，且必须在设计期就把「不做 (3)」写死，因为 250 ms 粗召预算容不下任何全量重推。**

---

## 5. 关键失败案例：谁想做 query-time OWL DL，最后退到了哪

### 5.1 逐家退让的原始证据

**Apache Jena —— 声明支持 OWL，实际只到 OWL Lite 子集且不完整**【文档】
来源：https://jena.apache.org/documentation/inference/
- 「a rule-based implementation of the OWL/lite subset of OWL/full ... Each of the configurations is intended to be a **sound** implementation of a subset of OWL/full semantics but **none of them is complete (in the technical sense)**. For complete OWL DL reasoning use an **external DL reasoner** such as Pellet, Racer or FaCT.」
- 「The rule based approach **cannot offer a complete solution for OWL/Lite, let alone the OWL/Full fragment** ... We intend that the reasoner should be sound ... but not complete.」
- 明确不支持的构造：「The critical constructs which go beyond OWL/lite and are not supported in the Jena OWL reasoner are **`complementOf` and `oneOf`**」；`owl:unionOf` 只支持正向（不处理「C 的实例必是 A 或 B 之一」）；`owl:allValuesFrom` 只正向；基数限制限 0/1。
- 方法是 instance-based：为每个声明类造原型实例再推导——文档自己把这写成与 DL reasoner 的**对照取舍**（擅长实例推理与简单规整本体，不擅长大型丰富本体）。
→ **退让路径：OWL DL → OWL Lite 子集 → sound-but-incomplete 规则 → 「要真的 DL 请用外部推理机」。**

**GraphDB —— 主动砍掉语义完备性以换性能**【文档】
来源：https://graphdb.ontotext.com/documentation/11.5/rdfs-plus-optimization.html
逐条列出的被优化掉的规范推论：每个 URI 节点推 `X rdf:type rdfs:Resource`；从 schema 定义语句反推 URI 是类/属性；`owl:sameAs` 自反；所有类是 `owl:Thing` 子类且所有个体 `rdf:type owl:Thing`；有 `I rdf:type C` 就推 `C rdfs:Class`。
**理由原文**：「Although the above inferences are important for formal semantics completeness, **users rarely execute queries that seek such statements**. Moreover, these inferences generate so many inferred statements that **performance and scalability can be significantly degraded**.」
优化版规则集名加 `-optimized` 后缀（如 `owl-horst-optimized`）。
另见 https://graphdb.ontotext.com/documentation/11.0/owl-compliance.html：「**There are no inconsistency rules by default**」；「GraphDB does not provide the extended support for typed literals ... it is our understanding that the **performance penalty is too high** for most applications」。
→ **退让路径：形式语义完备 → 「用户实际会查的那部分」+ 默认不做一致性检查。**

**RDFox —— 自认不是为 TBox 推理设计的**【文档】
来源：https://docs.oxfordsemantic.tech/reasoning.html
- §10.6.2：「Both languages share a common core」，`SubClassOf(:Scientist :Person)` ≡ `[?x, rdf:type, :Person] :- [?x, rdf:type, :Scientist]`；但「**RDFox rules, however, do not support disjunction**」（OWL 的 `ObjectUnionOf` 无法译成规则）。
- §10.6.3：加载 OWL 本体时公理存在「a separate container for axioms」，然后「the axioms are **translated into rules** in order to facilitate reasoning」；**翻不动的公理仍然加载并保留，只发 warning**；翻译是「on a **best-effort basis**」，可部分翻译（`SubClassOf(:Person ObjectIntersectionOf(:Human ObjectUnionOf(:Child :Adult)))` 只出一条 `[?x, rdf:type, :Human] :- [?x, rdf:type, :Person]`）。
- §10.6.6 自述：「**RDFox is a materialization-based query answering system, and it has not been designed for solving problems such as class subsumption**」；绕过办法是造一个 fresh URI 当实例再 ASK，或 `import <rdfox:TBoxReasoning>` 内置规则集。
→ **退让路径：「相信 OWL 公理」→「把 OWL 公理尽量译成规则，译不动的存着不用」。这是最诚实的工程姿态：公理不丢、但不假装能推。**
- 另附：RDFox 要求规则集**分层**（stratified）——「stratification conditions ensure that there are no cyclic dependencies in the rule set involving negation or aggregation」；`owl:sameAs` 是 special equality relation，因此「the use of the special equality relation `owl:sameAs` in rules **precludes the use of aggregation or negation-as-failure**」。→ **一旦要支持 `owl:sameAs`，就失去聚合与否定。**

**AllegroGraph —— 官方把两种引擎定义为互斥取舍**【文档】
来源：https://franz.com/agraph/support/documentation/current/materializer.html
- 「AllegroGraph has **two different inference engines**: one supports a superset of RDFS inference rules and the other supports OWL 2 RL. The first is called the **dynamic RDFS++ reasoner** because it generates inferred triples on-the-fly and does not save them in the triple-store. The second is an **OWL 2 RL materializer**: it uses a set of inference rules to generate new triples and adds them to the triple-store.」
- 变更代价：「If the triple store is changed via additions or deletions then **materialization may have to be run again** so that the triple store contains the correct set of materialized triples.」
- **选型建议原文**：「The dynamic reasoner is best when: you do **not** need OWL 2 RL inference rules and the store you are using **is changing**. The materializer is best when: OWL 2 RL inference is required **or** the store is **relatively static**.」
→ **「数据在变」与「要物化」被官方定义为互斥。本项目属于前者，「数据在变」是记忆的本质。**
- 规则表裁剪（见 §1.8 详表）：OWL 2 RL 规则表里约 **1/3 被跳过**，包括全部一致性检查规则、`prp-spo2`（propertyChainAxiom）、`prp-key`（hasKey）、`cls-oo`（oneOf）、`eq-ref`。

**Stardog —— query rewriting 路线走到了「自己给自己划边界」**【文档】
- Blackout 的两个 profile：`RDFS|QL|RL|EL|SL`，默认 SL（=RDFS+QL+RL+EL+SWRL）；「Any axiom outside the selected type will be **ignored by the reasoner**」；**坏规则只记日志仍继续推理**。
- Stride（9.0 起 beta）明确只支持七种公理：`rdfs:subClassOf`、`owl:equivalentClass`、`rdfs:subPropertyOf`、`owl:equivalentProperty`、`owl:inverseOf`、`owl:SymmetricProperty`、`owl:TransitiveProperty`，**其余一律忽略**；且**有坏规则则拒绝任何推理**。
- SL profile 的递归限制（对 schema 设计有直接约束）：「these restrictions are **recursive**. This means, for example, `ObjectAllValuesFrom` cannot appear inside a subclass expression that is otherwise supported ... Therefore the axiom `SubClassOf(ObjectSomeValuesFrom(p, ObjectAllValuesFrom(q, C)))` is **not supported**.」
- 有「部分采纳公理」的显式开关：`reasoning.approximate=true` 时「Blackout will **split each `EquivalentClasses` axiom into two** and will use the subclass axiom(s) that satisfy the above conditions and **ignore those that do not**」。
→ **退让路径：一次性诚实化——把「支持什么」写成一张有限表，表外的公理静默忽略，并提供 approximate 开关做部分采纳。**

**Oracle —— OWLPrime 的 value restriction 是 intensional（IF）语义**【文档】
来源：https://docs.oracle.com/en/database/oracle/oracle-database/23/rdfrm/ontologies.html
- 「As with pD*, the supported semantics for these value restrictions are only **intensional (IF semantics)**.」即 `someValuesFrom`/`allValuesFrom` 不引入新个体。
- OWL2EL 明确砍自反属性：「the OWL2EL rulebase support does **not include reflexive object properties** (`ReflexiveObjectProperty`) simply because a reflexive object property will link every individual with itself, which would **probably cause an unnecessary and costly expansion of the inference graph**」。
→ **退让：「避免引入不存在的个体」与「避免自反属性导致的图爆炸」，理由与 OWL 2 RL 的原始设计动机同源（见 OWL 2 Profiles §3「to avoid the need to infer the existence of individuals not explicitly present in the knowledge base」）。**

### 5.2 失败模式的统一解释

**规范层面的根因**【规范】（https://www.w3.org/TR/owl2-profiles/ Table 10）：
- OWL 2 **RDF-Based Semantics** → 一致性/SAT/subsumption/instance checking 与 CQ answering **全部 Undecidable**
- OWL 2 **Direct Semantics** → **N2EXPTIME-complete**；data complexity 为「Decidable, but complexity open (NP-Hard)」；CQ answering **Decidability open**
- OWL 2 RL → 一致性 PTIME-complete，class SAT/subsumption/instance checking combined co-NP-complete，CQ taxonomic/data **PTIME**
- **【推断】任何「query-time OWL DL」系统都必须在 DL 与 RL 的复杂度断层（N2EXPTIME vs PTIME）之间选一边。所有生产系统都选了 PTIME 这边，这不是工程能力的差异，是复杂度的必然。**

**第四条退让理由，是语义上的而非性能上的**【规范】（https://www.w3.org/TR/owl2-profiles/）
「Such an implementation can also be used with arbitrary RDF graphs. In this case, however, these properties no longer hold — in particular, it is **no longer possible to guarantee that all correct answers can be returned**」——RL 引擎套在任意 RDF 图上只保 **sound**，不保 **complete**。
→ **【推断】记忆系统的 ABox 天然是「任意 RDF 图」（LLM 抽出来的断言不会遵守 RL 语法限制）。所以「用 RL 引擎跑记忆」在规范意义上就只能是 sound 侧，不能承诺完整召回。这一点必须写进设计假设。**

### 5.3 一个正面的反例：Stardog 的四条「反物化」理由，与一条「反 query-time」理由

Stardog 是唯一把「为什么不物化」写成四条工程理由的厂商（https://docs.stardog.com/inference-engine/）：
1. **data freshness** ——「数据/schema 一变就得重做，不适合高频变更与虚拟化数据」
2. **data size** ——「膨胀成本摊到每次查询 I/O」
3. **fixed schema** ——「无法按应用切规则集」
4. **resources** ——「真值维护昂贵，删除后尤甚」

但 Stardog 自己也有 query-time 的例外：`owl:sameAs` **不**懒算——「The sameAs inferences are computed and indexed **eagerly** so that these materialized inferences can be used directly at query rewriting time」；`reasoning.sameas` ∈ `OFF|ON|FULL`。并做了「canonical individual」取舍：「Stardog designates **one canonical individual** for each sameAs equivalence set and only returns the canonical individual. This avoids the **combinatorial explosion** in query results」。
→ **【推断】等价闭包（`sameAs`）是唯一被普遍物化的推理类型，因为它的查询改写代价最高。这为双引擎设计给了一个明确的「哪些进契约层、哪些进物化层」的判据。**

---

## 6. TerminusDB：唯一把「schema 与数据同版本」做成存储原语的系统

### 6.1 schema 是 JSON 语法，且「文档即图」【文档】

来源：https://terminusdb.com/docs/schema-reference-guide/
- schema 语言是 JSON 语法：「**This syntax makes it as easy as possible to specify a JSON object to automatically convert to a graph**」——即写一个 JSON 文档，就得到一个图。
- 类定义：`{'@type':'Class','@id':'Person','name':'xsd:string'}`。`@type` 取值四种：**Class / Enum / TaggedUnion / Unit**。
- `context` 对象（`@type=@context`）含 `@schema`（类名默认 URI 展开前缀）、`@base`（实例数据默认 URI 展开）、`xsd` 等前缀、`@documentation`、`@metadata`（任意 JSON 元数据，可存配置）。

**关键关键字**：

| 关键字 | 语义（原文要点） |
|---|---|
| `@id` | 类名 |
| `@key` | 实例 `@id` 生成策略，四种：**Lexical**（`@fields` 顺序拼接，如 `Person_Hasdrupal_Barca`）／**Hash**（同字段先 SHA-256，如 `Person_5dd7004081e437b3e684075fa3132542f5cd06c1`）／**ValueHash**（取文档 DAG 的向下传递闭包，即整份文档内容做键；对象必须是有向无环图，「cannot be cyclic」）／**Random** |
| `@subdocument` | 值为 `[]`，被父文档**完全拥有**，不可直接更新删除，必须经父文档；当前要求 key 为 Random 或 ValueHash |
| `@abstract` | 值为 `[]`，无具体指称，作共享超类 |
| `@inherits` | 继承属性与 `@subdocument` 标记，「**does not inherit key strategies**」；可多重继承但同名继承属性必须同 range 否则 schema check 失败；继承树同时作为 WOQL 的 **subsumption** 关系暴露，并为 schema API 的 frames 提供语义 |
| `@unfoldable` | 值为 `[]`，让被链接的顶层文档在检索时像子文档一样完全展开，只能用于不直接/间接自引用的类 |
| `@oneOf` | 互斥属性集合，**TaggedUnion 是其语法糖** |
| `@documentation` | `@comment` + `@properties` 或 `@values` |

- `TaggedUnion` 示例：`BinaryTree` 定义 `leaf: sys:Unit` 与 `node: Node` 两个互斥分支。`Unit` 类型只有单一扩展 `[]`，用于「只关心属性是否存在」。
- `Enum` 实例是简单 URI，`Blue` 展开成 `http://s#PrimaryColour/Blue`。

→ **【推断】这套设计的要害：`@key` 决定「什么是同一个实体」，`@subdocument` 决定「什么是被拥有的复合值」，`@inherits` 决定「什么是类层级」。三者合起来就是一张 OWL 的 `hasKey` / 聚集 / `subClassOf`——但没有 OWL 的开放世界语义，全部是封闭世界下的文档约束。这与 §2 的「SHACL 做封闭世界」是同一条思路的另一种表达。**

### 6.2 判据：「这个变更会不会让今天合法的数据变非法」【文档】

来源：https://terminusdb.com/docs/ontology-versioning/
- 核心判据原文：「The most useful question about a schema change is: **can it make data that is valid today invalid?**」
- 术语：non-breaking 变更 = **weakening**「cannot make existing data invalid」；breaking 变更 = **strengthening**「can make existing data invalid. **The data must change with it, or the change must be refused**」。

**官方变更表（逐行）**：

| 变更 | 判定 | 理由（原文要点） |
|---|---|---|
| 加新类 | 非破坏 | 没有实例 |
| 加可选属性 | 非破坏 | — |
| 必填改可选 / 改 set | 非破坏 | — |
| 改文档或标签 | 非破坏 | — |
| **加必填属性** | **破坏** | 每条记录需值，如默认值 |
| **重命名类或属性** | **破坏** | 每条记录须用新名 |
| **属性改成更窄类型** | **破坏** | 每个值须 cast 或失败 |
| **删除类或属性** | **破坏** | 对应数据被删 |

- 破坏性变更的落地策略原文：「**add a weakening operation first that enables the change first, then once all instances conform to the breaking change, apply the strengthened schema**」——即**两阶段：先 weakening 让旧数据合法，再 strengthening**。
- **为什么 schema 与数据必须同版本**：分开存「leaves a gap. The file history tells you how the schema changed. **It does not tell you which data was valid under which version**」。同一 commit「you get the data together with the schema that was valid then」。
- **强制机制**：「In TerminusDB, the schema is a graph of its own, **next to** the instance data, and **both are in the same commit**. The schema is **enforced**: each write is checked against it, and a write that does not fit is refused.」

### 6.3 迁移是一等对象：有序操作列表 + 一个 commit【文档】

来源：https://terminusdb.com/docs/ontology-versioning/
- 端点 `POST /api/migration/{path}`，提交**有序**操作列表。操作类型（原文列举）：`CreateClass`、`MoveClass`、`ExpandEnum`、`CreateClassProperty`、`MoveClassProperty`、`UpcastClassProperty`、`CastClassProperty`、`DeleteClassProperty`。
- 机制：「TerminusDB changes the schema and the data **together in one commit**, and **stores the migration with that commit**」→ 迁移可**重放（replayable）**。
- 支持 `dry_run:true`（只校验不提交，返回「how many schema and instance operations the migration would make」）。
- 支持 `target` 指向另一分支，让本分支迁移到目标 schema；若两边各有对方没有的迁移则请求失败（「the two histories no longer agree on the order of the changes」）。
- **弃用五步法（原文顺序）**：① 先加替代品（非破坏或带默认值）② 标记旧术语 deprecated（如 `ReplaceClassDocumentation`，只改描述）③ 放松旧术语（`UpcastClassProperty` 把必填改可选）④ 必要时搬数据（`MoveClassProperty` 等）⑤ 最后才删（`DeleteClassProperty` / `DeleteClass`；删类要先删指向它的属性）。

### 6.4 自动迁移（11.0.6，2023-05-03）【文档】

来源：https://terminusdb.com/docs/releases/11-0-6-automatic-schema-migrations/
通过 document 接口改类时「TerminusDB now **infers a migration where possible** — renames, retypes, weakening constraints — and applies it to the instance data already in the database. **No separate migration script.**」
两个选项：`allow_destructive_migration`（允许改已有实例数据）、`require_migration`（推断不出迁移时报错，而不是「**silently accepting a schema change that leaves data behind**」）。

### 6.5 版本化四法：TerminusDB 选 commit graph + delta rollup【文档】

来源：https://terminusdb.com/docs/knowledge-graph-versioning/

| 方法 | 存 | 读 | 分支 | 记谁改 | 缺点（原文） |
|---|---|---|---|---|---|
| Full snapshots | 高 | 快 | 无 | 无 | — |
| Change logs / deltas | 低 | 可能慢 | 无 | 需自记 | — |
| Timestamps on facts / named graphs | 中 | 过滤在查询里 | 无 | 需建模 | 「every query must filter on time, and the data model gets more complex. **It is also easy to forget the filter and mix versions by mistake**」 |
| **Commit graph**（选定） | 低 | 若存储为此设计则快 | 有 | 按 commit | — |

机制：「Each commit adds a **delta layer** with the triples it added and removed. A **delta rollup** combines many layers into fewer cached layers」——delta + 周期 rollup 的混合。

### 6.6 学术状态：TerminusDB 没有同行评议论文【事实】

arXiv title 检索 "TerminusDB" 返回 **0 条**。一手材料只有官方文档。**这一事实本身要写进报告：它的设计没有任何独立复现或第三方评估，采用时只能以文档为唯一依据。**

### 6.7 TerminusDB 值得抄的与不该抄的

**值得抄（三条，都是机制不是实现）**【推断】：
1. **「can it make data that is valid today invalid?」作为唯一变更判据** —— 这是一个可自动判定的谓词，比 OWL 的 `backwardCompatibleWith`（纯注解、无判定算法）可操作得多。
2. **weakening → strengthening 两阶段** —— 把「迁移」拆成「先放松让旧数据过，再收紧让新数据齐」，避开了「一次性破坏性迁移」的停机。
3. **迁移作为有序操作列表 + 与数据同 commit + 可重放 + dry_run** —— 这是 schema 版本化的**审计友好**形态，与本项目「可追源」的诉求直接对齐。

**不该抄（两条）**【推断】：
1. **不做推理**。TerminusDB 的 schema 是**约束**不是**公理**：`@inherits` 只给 subsumption 用于查询展开，不产生蕴含。本项目需要「未断言但可推出」的推断（第 ② 步的证实），这超出 TerminusDB 的能力。
2. **schema 与数据同 commit 的代价**。这个设计假设「schema 变更稀疏」。若本项目 schema 随记忆演化频繁变动，每个 commit 带 schema 检查会在 250 ms 预算里吃掉时间。**要抄的是判据与两阶段策略，不是每写必检的实现。**

---

## 7. 双引擎分层下的重估（追加节，2026-11-25 用户改向）

> **前提变更**：OWL 2 不再是全库 schema。新架构为双引擎分层：运行时记忆推理引擎 = **Datalog 或其扩展**（基事实断言为 Datalog 事实；递归查询、聚合、增量更新都在此层；保证可终止性与运行时效率）；跨边界语义契约层 = **OWL 2 RL 子集或 SHACL**，只覆盖「被多个系统争用 + 定义不一致 + 会导致生产故障」三条同时满足的少数核心概念。明确禁止对整层情景记忆施加完整 OWL 层次。
>
> **检索说明（诚实交代）**：本节所需的三个追问，我用的是**直连权威文档**而非搜索引擎——html.duckduckgo.com 与 lite.duckduckgo.com 返回被判定为 bot 的空壳，Mojeek 返回 403，Brave 返回 429，Bing 返回中文词典噪声。所有下列引文均来自实测拉取的原始文档。

### 7.1 真实先例：把「运行时事实层」与「语义契约层」分开的系统

**这是我要回答的第一个追问。结论：这类系统不但存在，而且是主流形态；反而「把整层数据本体化」的系统几乎都失败了。**

#### (a) Ontop / R2RML —— 最纯粹的形态：事实留在关系库，本体只做查询重写

来源：https://ontop-vkg.org/guide/ 、https://www.w3.org/TR/r2rml/

- Ontop 自述：「Ontop is a **Virtual Knowledge Graph** system. It exposes the content of arbitrary relational databases as knowledge graphs. **These graphs are virtual, which means that data remains in the data sources instead of being moved to another database.** Ontop translates SPARQL queries expressed over the knowledge graphs into **SQL queries executed by the relational data sources**.」
- **能力边界（这是本节最关键的一句）**：「Supports **RDFS and OWL 2 QL** ontologies」——**注意不是 DL，不是 RL，是 QL**。理由见 §5.2：QL 是唯一「一阶可重写」的 profile，即 SPARQL 能**逐条**改写成 SQL，不需要闭包。
- **契约层的载体是映射，不是公理**：OBDA 映射文件的每个 `MappingDeclaration` 有三个字段 `mappingId` / `source` / `target`：`source` 是「an arbitrary SQL query over the database」，`target` 是「a triple template that contains placeholders that reference column names mentioned in the source query」。例：
  ```
  [MappingDeclaration] @collection [[
  mappingId Book collection
  target :BID_{id} a :Book .
  source SELECT id FROM books
  ]]```
- **R2RML（W3C Recommendation，https://www.w3.org/TR/r2rml/）是同一件事的标准化**：核心概念是 `TriplesMap` = 一个 `logical table` + 一个 `subject map` + 若干 `predicate-object map`；「A logical table can be one of the following:」一个 SQL 查询、一张基表、或一张视图。R2RML 还定义了 `rr:parentTriplesMap` + `rr:joinCondition` + `rr:child`/`rr:parent` 表达**外键关系**（§8）。
- **映射的代价，官方明说**：「The Ontop SQL parser **only parses simple SQL queries without unions, aggregations, order by, etc.** Non-parsed queries are treated as **black-box views** and sent directly to the database so the **optimizations that Ontop can apply are limited**.」

→ **【推断】这是对双引擎分层最强的支持证据：一个成熟系统（Ontop，5.5.0 / 2026-02-14）把「事实在 SQL 层、语义在 mapping 层、推理靠查询重写」做成了产品，并且把契约层刻意限制在 OWL 2 QL——不是因为做不到 RL，而是因为只有 QL 能保「查询重写不改数据」这个性质。**
→ **对本项目的直接含义：契约层的公理形态应当被限制到「可翻译成 Datalog 规则」或「可翻译成一次 SPARQL 模式改写」两者之一。凡是不能的，归事实层用显式事实承载，不写进契约。**

#### (b) Confluent Schema Registry —— 契约层与数据层完全分离，且契约只描述结构不做推理

来源：https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html

- 「Schema evolution is the practice of safely changing schemas over time while maintaining compatibility with existing producers and consumers. **Schema Registry enforces compatibility by comparing new schema versions against previous versions** using configurable compatibility types.」
- 四种兼容类型（原文）：
  | 类型 | 定义 | 允许的变更 |
  |---|---|---|
  | **Backward**（默认） | 「consumers using new schema can read data written with old schema」 | add optional fields, remove fields |
  | **Forward** | 「consumers using old schema can read data written with new schema」 | remove optional fields, add fields |
  | **Full** | 两者皆可 | add/remove optional fields only |
  | **Transitive** | 「compatibility checked against **all** previous versions, not just the last one」 | — |
- 版本标识：「Each schema version gets a **unique ID** and an **incremented version number**. When a schema is updated, Schema Registry **checks compatibility before accepting the new version**.」
- 关键限制（原文）：以「删除字段仍保持兼容」为例，「the ability to delete a field and keep the schema compatible **requires that the field was either specified as optional or provided a default value in the original version**」。

→ **【推断】Schema Registry 给出的是「可自动判定的兼容性谓词 + 每次变更前强制检查」这一套形态，而不是 OWL 那种「写个注释说明兼容」的行为。这正是 §3.1 判定 OWL 版本化词汇无用的地方——它有可判定性，OWL 没有。**
→ **对本项目的直接含义：契约层应当为每次变更计算一个**方向性**兼容谓词（我们只需要一个方向：旧事实在新契约下是否仍然合法），而不是照抄 OWL 的 `backwardCompatibleWith` 注解。这与 TerminusDB 的 weakening 判据是同一个东西。**

#### (c) OMOP CDM —— 唯一记录了「事实 → 契约」显式提升通道的领域标准

来源：https://ohdsi.github.io/CommonDataModel/cdm54.html

这是我在整个检索里找到的**最贴近本项目需求的先例**：它把「原始事实」与「标准化概念」放在**同一张表的相邻两列**里，并给出显式的映射表。

- **双列模式（dual-column pattern）**，以 CONDITION_OCCURRENCE 为例：
  - `condition_source_value`：「This field houses the **verbatim value from the source data** representing the condition that occurred. For example, this could be an ICD10 or Read code.」（类型 `varchar(50)`）
  - `condition_concept_id`：「This code is mapped to a **Standard Condition Concept in the Standardized Vocabularies** and **the original code is stored here for reference**。」
  - 同一模式在 DRUG（`drug_source_value` / `drug_concept_id`）、PROCEDURE、DEVICE、MEASUREMENT、UNIT、VISIT、GENDER、RACE、ETHNICITY 上重复出现。
- **提升通道是一张显式的表**：`SOURCE_TO_CONCEPT_MAP`（第 6898 行）：「The source to concept map table is recommended for use in ETL processes to **maintain local source codes which are not available as Concepts in the Standardized Vocabularies**, and to **establish mappings for each source code into a Standard Concept as `target_concept_ids`** that can be used to populate the Common Data Model tables.」
- **提升不是自动的**：「The SOURCE_TO_CONCEPT_MAP table is **no longer populated with content within the Standardized Vocabularies** published to the OMOP community. There are OHDSI tools to help you populate this table; **Usagi and Perseus**.」
- **契约层是集中的、被治理的**：`*_concept_id` 必须指向「Standardized Vocabularies」中的 Standard Concept；文档反复强调 source value「is **discouraged from use in analysis** because it is **not required to contain Standard Concepts that are used across the OHDSI community**」（CONDITION/DRUG/PROCEDURE/DEVICE/UNIT 各表同文）。
- **层级用于聚合**（原文）：「This table will contain standard concepts in the Visit domain. **These concepts are arranged in a hierarchical structure to facilitate cohort definitions by rolling up**」——这正是本项目第 ② 步「把召回转成 OWL 概念查询」所需要的 subsumption 用途。

→ **【推断】OMOP 的做法可以完整映射到本项目：**
| OMOP | 本项目 |
|---|---|
| `*_source_value`（verbatim，不可分析） | 事实层的原始观察/工具调用结果 |
| `*_concept_id`（Standard Concept） | 契约层概念（少数核心概念） |
| `SOURCE_TO_CONCEPT_MAP` | 提升通道：事实 → 契约的显式映射记录 |
| Usagi / Perseus（人工辅助映射工具） | 提升决策不是自动的，需要工具 + 人 |
| Standardized Vocabularies（集中发布） | 契约层本体，单一版本源 |
| hierarchical structure for rollup | subsumption 用于粗召扩展 |
→ **最重要的一条：OMOP 明确容忍「大量事实没有被提升」——`*_source_value` 有值而 `*_concept_id` 为 0/空是常态，且文档只说 source value "discouraged from use in analysis"，没有说「必须提升」。这是「不被提升的事实仍然合法存在」的制度化先例，正是本项目想要的「不是所有记忆都要进契约层」。**

#### (d) Freebase —— 有明确的「提升闸门」，也有明确的「为什么 schema 必须冻结」

来源：https://en.wikipedia.org/wiki/Freebase_(database)（**二手来源，非官方文档，需标注**）

- 「Freebase's types are themselves **user-editable**.」
- **提升闸门（原文，这是我要找的「触发条件」的唯一书面记录）**：「User-created types **were not adopted in the "public commons" until promoted by a Metaweb employee**.」
- **为什么 schema 不能随便开放（原文，这是「契约层必须受控」的最佳论证）**：「The reason Freebase **could not open up permissions of schemas** is that **external applications relied on them**; thus, **changing a type's schema – for instance by deleting a property or changing a simple property – might have broken queries for API users and even within Freebase itself**, for example in saved views.」
- 定位：「unlike the W3C approach to the semantic web, which starts with **controlled ontologies**, Metaweb adopts a **folksonomy** approach, in which people can add new categories (much like tags), **in a messy sprawl of potentially overlapping assertions**.」
- 规模：截至 2014-01，约 **4400 万 topics、24 亿 facts**。

→ **【推断】Freebase 是本项目双引擎分层的历史原型：(1) 用户可以自由加类型（事实层宽松）；(2) 但类型进「公共域」需要**一个内部人**批准（契约层有闸门）；(3) 一旦进契约，就冻结，因为下游依赖它（契约层的价值恰恰来自它的不可轻易变更）。**
→ **注意：Freebase 的闸门是「人工批准」，不是「第 N 个消费者引用」或「第 M 次定义分歧」。见 7.2。**

#### (e) dbt model contracts —— 唯一明文说「治理要晚不要早」的官方文档

来源：https://docs.getdbt.com/docs/collaborate/govern/model-contracts

- 为什么要契约（原文）：「constantly changing the shape of its returned dataset poses a risk when other people and processes are querying that model. It's better to define a set of **upfront "guarantees"** that define the shape of your model. We call this set of guarantees a "contract."」
- **反面警告（本节最重要的一段引文）**：「Model governance features like model access, contracts, and versions **strengthen trust and stability** in your dbt project. **Because they add structure, they can make rollbacks harder (for example, removing model access) and increase maintenance if adopted too early.** Before adding governance features, **consider whether your dbt project is ready to benefit from them. Introducing governance while models are still changing can complicate future changes.**」
- **治理特性的适用范围被刻意限制**（原文）：「Governance features are **model-specific. They don't apply to other resource types, including snapshots, seeds, or sources.** This is because **these objects can change structure over time** (for example, snapshots capture evolving historical data) and **aren't suited to guarantees like contracts, access, or versioning**.」
- 强制方式：「dbt will **verify that your model's transformation will produce a dataset matching up with its contract, or it will fail to build**.」

→ **【推断】dbt 的这份文档是「契约层只覆盖少数核心概念」这一设计决策的**直接官方背书**：它把「可演进、结构会变」的对象（snapshots/sources）**明确排除在契约之外**。本项目的情景记忆正是这类对象。**
→ **对本项目的直接含义：契约层的准入判据应当写成「这个概念的形状在未来 N 个月内不会变」，而不是「这个概念很重要」。dbt 的逻辑是「会变的别加契约」，不是「重要的都加契约」。**

#### (f) Martin Fowler / ODCS —— 契约层已经成为跨组织标准

来源：https://martinfowler.com/articles/data-contracts.html

- 「In its simplest form, a data contract is **a description of the shape of the data that a data provider is offering, e.g., a schema**.」
- 标准：「**Open Data Contract Standard (ODCS)** as it is the **de facto industry standard** governed by the **Bitol project at the Linux Foundation**（rated **Adopt** in the Thoughtworks Technology Radar）」；示例 `apiVersion: "v3.2.0"`，`kind: "DataContract"`，`version: "1.0.0"`，`status: "active"`。
- 契约里除了 schema 还放什么：`quality` 规则（示例是 SQL 聚合断言：「Expect less than 1% empty name fields」）与 `serviceLevels`（「specify runtime behavior over time」），以及 `classification: "restricted"` 之类的治理标签。

→ **【推断】ODCS 的字段设计可以照抄到本项目契约层的表结构：`id` / `name` / `version` / `status` / `schema` / `quality` / `serviceLevels` / `classification`。其中 `status: active|deprecated` 与 `quality`（可判定断言）正是契约层需要的，而 OWL 的 `owl:deprecated` 只给了前一半。**

#### (g) 反面：RDFox 的「公理单独存、尽量翻译成规则」其实是同一个架构

回到 §5.1 引过的 RDFox §10.6.3：「the axioms are translated into rules in order to facilitate reasoning」，翻不动的公理「**仍然加载并保留**」，翻译是「on a **best-effort basis**」。
→ **【推断】这不是缺陷，这就是双引擎分层的原型：契约（OWL 公理，完整保留、可被人读、可被工具校验）与可执行内核（翻译出的规则子集）是两份东西，不允许后者回写前者。RDFox 只是没把它叫「双引擎」。**

**本节小结：真实系统的分层形态有五种（虚拟映射 / 注册中心 / 双列+映射表 / 人工闸门 / 声明式契约），但没有任何一个把「整层数据本体化」作为成功形态。**

### 7.2 「事实如何提升为契约」的触发条件：没找到任何定量标准

我按 lead 的要求逐项找「第 N 个消费者引用」「第 M 次定义分歧」「发生过一次生产事故」这三类触发条件。**结论：没有找到。这类判据在所有一手文档里都是定性表述或人工判断。**

| 系统 | 提升机制 | 触发条件是否可判定 |
|---|---|---|
| Freebase | 「promoted by a Metaweb employee」 | **否**，人为决定（二手来源） |
| OMOP | `SOURCE_TO_CONCEPT_MAP` + Usagi/Perseus 工具 | **否**，工具辅助的人工映射 |
| dbt | 「consider whether your dbt project is ready to benefit」 | **否**，整段是「请自行判断」 |
| Confluent Schema Registry | 每次提交时检查兼容性 | **是，但只检查结构兼容**，不涉及「该不该有这个概念」 |
| TerminusDB | 「can it make data that is valid today invalid?」 | **是，但只对已存在的概念判定合法性**，不判定准入 |
| Stardog / GraphDB / Oracle / AllegroGraph / Jena / Oxigraph | **无此概念** | — |

→ **【推断】这个空白不是检索不充分，而是这个判据本身不存在：现有系统都把「哪些概念值得形式化」留给组织决策，只把「形式化之后如何校验变更」做成机制。**
→ **对本项目的直接含义（重要）：不要把「自动提升判据」当成可以从文献里抄来的东西。要么 (a) 把它定义成人工策略（照 Freebase/OMOP 的做法），要么 (b) 自己发明一个可判定的近邻指标——而这将是本项目的原创贡献，不是既有实践。** 我的建议是 (b) 但只作为**建议**信号而非自动触发：例如「同一概念在事实层出现 ≥ K 个互不相同的定义，且每个定义都有 ≥ N 次被检索引用」，把 K/N 做成配置项，命中时只产出「待评审」条目。

### 7.3 反例：把整层数据本体化之后失败/回退的公开记录

**这一节的证据质量低于其他节，必须明说。**

#### (a) Cyc —— 最重的公开判决

来源：https://en.wikipedia.org/wiki/Cyc（二手来源）
「The Cyc project has been described as 'one of the most controversial endeavors of the artificial intelligence history'. ... Machine-learning scientist **Pedro Domingos** refers to the project as a **'catastrophic failure'** for **the unending amount of data required to produce any viable results** and **the inability for Cyc to evolve on its own**.」

→ **【推断】两条指控恰好对应本项目的两个风险：(1)「unending amount of data required」= 手工构建 TBox 的成本无底；(2)「inability to evolve on its own」= TBox 无法自我演化。这两条正是双引擎分层要避开的。**

#### (b) Clay Shirky, "Ontology is Overrated" (2005) —— 经典论证，一手散文

来源：https://shirky.com/writings/ontology_overrated.html
- 对「预先设计类别以覆盖所有可能」的直接批评：「That strategy of **designing categories to cover possible cases in advance** is what I'm primarily concerned with, because it is **both widely used and badly overrated** in terms of its value in the digital world.」
- 对「完美方案」的批评：「In working classification systems, success is not 'Did we get the ideal arrangement?' but rather 'How close did we come, and on what measures?' The idea of a perfect scheme is simply a Platonic ideal. However, I want to argue that **even the ontological ideal is a mistake. Even using theoretical perfection as a measure of practical success leads to misapplication of resources.**」
- 为什么在数字世界不成立：「You can't ask a cataloguer in advance to say 'Well, that's going to be a useful category, we should encode that in advance.'」以及 Yahoo vs Google 的对照：Yahoo 目录式分类在同时提供搜索后「fewer and fewer people were using categorization to find things」。

→ **【推断】Shirky 的论证成立的条件是「查询空间开放且长尾」。本项目的召回管路正是这种场景（LLM 提出任意概念查询）。这是对「不要对整层情景记忆施加 OWL」的最强理论支持，但它**不**否定「对少数高频、争用、会导致故障的概念做形式化」——恰恰相反，Shirky 自己承认「Ontological classification works well in some places」。**

#### (c) Jena / Oxigraph / MillenniumDB —— 沉默的回退

不是「失败声明」，而是「从未尝试」：Jena 把 DL 推给外部推理机（§5.1）、Oxigraph 的 OWL 2 RL issue #130 自 2021-08-14 至今 **OPEN**、MillenniumDB README 全无 OWL 字样。
→ **【推断】「从未尝试」本身就是证据：这四个项目都是在各自生态里被大量使用的存储，它们**都**判断本体层不值得进核心。这个判断的一致性（4/4）比任何单篇批评更有说服力。**

#### (d) 我没找到的

- 没有找到任何厂商或团队发布的「我们试过把整层数据本体化，然后回退了」的公开复盘/事故报告。搜索引擎通道全断（DDG/Mojeek/Brave/Bing 均不可用），无法做发现式检索；我只能对已知候选做定向拉取。**这一项应视为「未证实」而非「不存在」。**

### 7.4 追问 1：哪些结论只在「OWL 覆盖全库」时成立，在契约层设定下失效或大幅简化

| 原结论（节号） | 在全库设定下的形态 | 契约层设定下的状态 | 依据 |
|---|---|---|---|
| 「没有生产系统做 query-time OWL DL」（§0/§5） | 因为 ABox 巨大，DL 不可行 | **不再构成约束**：契约层只有几十个概念，DL 的 data complexity 才是问题，TBox 规模不是。可考虑在**设计期**用 DL 推理机做契约层的概念可满足性检查（离线、不在 250ms 路径上） | OWL 2 Profiles Table 10：DL 的 combined 是 N2EXPTIME，但 data complexity「Decidable, but complexity open (NP-Hard)」——**概念数量小的时候，combined 才可支付** |
| 「物化膨胀 320 倍」（§4.1） | 14,820 显式 → 4,740,705 全量 | **大幅缩小但不会消失**。缩小的是 schema 侧：公理只剩 k 个概念，规则数从上百降到几十。**不缩小的是数据侧**：若这 k 个概念恰好是「被多个系统争用」的高频概念，它们的实例数最多，闭包仍可能很大 | RDFox 报告：膨胀由「规则宽 × 事实多」共同决定；Oracle OWL2EL 砍自反属性的原话「a reflexive object property will link every individual with itself, which would probably cause an **unnecessary and costly expansion of the inference graph**」说明**单条公理就能造成膨胀** |
| 「SHACL+OWL 组合校验 EXPTIME-complete」（§2.4） | 对整库数据 | **降为 PTIME**。Oudshoorn et al. 的结论原文是「even very simple ontologies make the problem EXPTIME-complete, and **PTIME-complete in data complexity**」——即组合的爆炸来自**本体侧**。契约层本体小，PTIME 的 data complexity 可用 | arXiv:2507.12286 |
| 「RL 引擎套在任意 RDF 图上只保 sound 不保 complete」（§5.2） | 严重：LLM 抽出的断言不遵守 RL 语法限制 | **大幅缓解**：若契约层下的事实只能经「提升通道」进入（OMOP 式），则进入契约层的事实**按构造**就是 conformant 的。sound 侧足够 | OWL 2 Profiles：「it is no longer possible to guarantee that all correct answers can be returned」——前提是「arbitrary RDF graphs」 |
| 「track information 占 90% 存储」（§4.2） | 全库维护删除支持 | **消失**。契约层可以放弃删除支持（GraphDB 的做法是把 schema 语句设只读），改为版本化快照 | GraphDB reasoning.html |
| 「换规则集需导出全部显式语句并重建 repository」（§4.2） | 大库 | **消失**。契约层重建是毫秒级；可直接照 Oracle 的「drop 推断图重建」 | Oracle / GraphDB |

### 7.5 追问 2：哪些结论仍然成立，且在新设定下更重要

**1. RDFox 的「公理单独存 + best-effort 翻译 + 翻不动仍保留」就是双引擎分层的标准形态。**（§5.1、§7.1g）
→ 在新设定下这从「退让」变成「设计」。可直接采用：契约层**存完整 OWL 2 公理**（供人读、供工具校验、供生成证明的规则名），**另存一份翻译后的 Datalog 规则**给运行时内核，两者用 `axiom_id → rule_ids` 关联。翻译失败的公理不丢，打标记 `non_executable`，只能出现在「信息缺口」产物里。

**2. Stardog 的四条反物化理由中，前两条在新设定下被绕开，第三、四条反而更锋利。**（§5.3）
- data freshness（理由 1）：契约层变更频率低 → 不再是问题。
- data size（理由 2）：契约层小 → 不再是问题。
- **fixed schema（理由 3）：「无法按应用切规则集」→ 在新设定下这是**必需特性**，不是缺陷。不同宿主/不同任务需要不同契约子集，Stardog 7.0 的 schema 多租户（`reasoning.schemas` + `--schema`）是直接可抄的机制，其原始动机原文就是「两个版本的本体并存，老应用用旧版」。**
- **resources（理由 4）：「真值维护昂贵，删除后尤甚」→ 这是唯一在新设定下**完全照旧**的代价，且正是 Datalog 层的责任。**

**3. Stardog 的 schema 版本哈希（§1.1）在契约层上是完美适配的，且现在真的便宜。**（§1.1）
原文用途：「an optimization used by the reasoner to **avoid reloading and reprocessing the schema unless the schema graphs have been updated**」；文档自承百万三元组量级频繁更新时哈希开销明显。**契约层只有几十个概念 → 哈希开销可忽略，可每次查询前都算。**

**4. Oracle 的 PROOF=T 持久化证明表，在契约层上是唯一可行的证明方案。**（§1.6）
格式：`link-id1 [ link-id2 … link-idn ] : rule-name`。在 474 万三元组上开证明不现实（原文「Proof generation does require additional CPU time and disk resources」）；在几十个概念的契约层上开证明，每条证明的前提列表是有界的。
**关键约束照旧成立**：「If the inference status is INCOMPLETE and if the last inference was generated without proof information, you cannot invoke ... with PROOF=T」——**证明必须从建契约层时就开，不能事后补。**

**5. 一致性检查与推导必须分成两张表，这条在新设定下更重要。**（§1.4/§1.7/§1.8）
三条独立证据：AllegroGraph 把规则编号 2（全部一致性规则）整体跳过「because rule is a consistency check and does not materializes triples」；GraphDB「There are no inconsistency rules by default」；Stardog 把 DisjointClasses/DisjointObjectProperties/Asymmetric/Irreflexive/FunctionalDataProperty 单列为 consistency-only 公理，「These do not enter the inference stage」。
→ 契约层的表结构应直接分两张：`contract_entailment_rule`（产出三元组）与 `contract_consistency_check`（产出布尔）。第二张只在「断言证实/证伪」（第 ② 步）被调用，不进 250ms 粗召路径。

**6. AllegroGraph 的「数据在变 ↔ 要物化」互斥，在双引擎下被精确化解为分工问题。**（§5.1）
原文：「The dynamic reasoner is best when: ... the store you are using is changing. The materializer is best when: OWL 2 RL inference is required or the store is relatively static.」
→ **事实层 = 永远在变 = dynamic（不物化）；契约层 = relatively static = materializer（可物化）。这是对 AllegroGraph 那句二选一的正面回答：不是二选一，是两层各选一个。**

**7. RDFox 的分层（stratified）要求与 `sameAs` 的冲突，在契约层上是硬约束。**（§5.1）
原文：「the use of the special equality relation `owl:sameAs` in rules **precludes the use of aggregation or negation-as-failure**」。
→ **【推断】若契约层需要做聚合（例如「这个概念有 3 个互斥定义」这种争用判定），则 `owl:sameAs` 必须**不能**进契约层，只能留在 Datalog 事实层当作一个显式的等价关系表来做。**这是一条会直接改变 schema 的硬约束，建议现在就定死。**

**8. Oracle 的 NGLI 互斥限制，直接命中「多版本契约并存」这个需求。**（§1.6）
原文：「NGLI currently does not work together with **proof generation, user-defined rules, optimized `owl:sameAs` handling, or incremental inference**」。
→ **【推断】「按版本隔离推理」与「生成证明」在工业实现里是互斥的。本项目若要做「旧事实按旧契约版本证明」，就必须自己实现版本隔离（把 version 作为每条规则/每条证明的字段），不能靠「每个版本一个图各自推理」。这是 §3 的 TerminusDB 式版本化必须落到 schema 字段层的理由。**

### 7.6 追问 3：哪些代价消失，哪些照旧

**消失的（逐条带依据）**

| 代价 | 原量级/依据 | 为什么消失 |
|---|---|---|
| DL 的 N2EXPTIME-complete 一致性检查 | OWL 2 Profiles Table 10，OWL 2 Direct Semantics | 契约层概念数是个位数到几十，combined 复杂度可支付；且可离线做 |
| 物化的 320 倍膨胀 | RDFox：14,820 → 4,740,705 | schema 侧规则数降一两个数量级；**但数据侧不保证缩小，见下** |
| SHACL+OWL 组合的 EXPTIME | arXiv:2507.12286 | 组合爆炸来自本体侧；本体小则回落到 PTIME 的 data complexity |
| track information 的 90% 存储 | GraphDB reasoning.html | 契约层不需要删除支持，改为版本快照 |
| 全库重建的停机 | GraphDB schema transaction「intended for the occasional, **offline** update」 | 契约层重建毫秒级，可在线 |
| 启动时加载全库本体 | Jena「显式 import `owl.owl` 会导致规则重复使用与明显变慢」 | 契约层没这么大 |
| 图爆炸式公理（自反属性等） | Oracle OWL2EL 砍 `ReflexiveObjectProperty` 的原话「would probably cause an unnecessary and costly expansion」 | 契约层可以**逐条**审每个公理的成本，因为数量少 |
| 工具链的「全 OWL 2 支持」需求 | Stardog Blackout 的 SL/Stride 两套边界表 | 只需支持被选中的那几十条公理，边界表可以手写维护 |

**照旧的（逐条带依据）**

| 代价 | 依据 | 为什么照旧 |
|---|---|---|
| **`owl:sameAs` 的等价闭包** | Stardog 是唯一 eager 物化的推理类型（「computed and indexed eagerly ... used directly at query rewriting time」），并需 canonical individual 避免「combinatorial explosion」 | 等价闭包的大小由**个体数**决定，不由概念数决定。契约层若含 `sameAs`，它管的是事实层的个体，规模仍是全库级。**这是唯一一个「留在契约层但规模由事实层决定」的东西，必须单独评估。** |
| **证明的存储与生成成本** | Oracle「Proof generation does require additional CPU time and disk resources」 | 单条证明的前提列表长度由**规则深度 × 每规则前提数**决定，与概念数无关。深规则链照样长。 |
| **契约层版本与事实的对应关系** | TerminusDB「The file history tells you how the schema changed. **It does not tell you which data was valid under which version**」；其解法是「both are in the same commit」 | 本项目**做不到 same commit**——事实在 triviumdb，契约是另一层。必须显式存 `promoted_under_contract_version`。**这是一个 TerminusDB 解法不可抄的地方，必须自己补。** |
| **提升决策的不可自动化** | §7.2：无任何系统有定量触发条件；Freebase 是人工、OMOP 是工具辅助人工、dbt 说「请自行判断」 | 这是组织问题不是技术问题，双引擎分层不解决它，只是把它隔离到一个小面上。 |
| **契约层需要独立的 OWL 解析/校验工具** | RDFox 的 best-effort 翻译需要 OWL 语法解析；Stardog/Jena 都自带解析器 | 只要存 OWL 文本就需要解析器，这是单进程内嵌可以接受的（纯库，无子进程）。 |
| **翻译失败的诊断** | Stardog「坏规则只记日志仍继续推理」vs Stride「有坏规则则拒绝任何推理」；RDFox「只发 warning」 | 这是一个必须做的取舍，无法回避。**建议学 Stride 的严格模式**（拒绝而不是静默忽略），因为契约层小，作者有义务让每条公理可执行或显式标记为不可执行。 |

### 7.7 这一节对 schema 的直接含义（追加清单）

1. **contract 层单独存，且分三张表**：`contract_axiom`（原文 OWL，含 `version_iri`、`owl_deprecated`）、`contract_rule`（翻译后的 Datalog 规则，含 `axiom_id` FK、`executable` 布尔）、`contract_consistency_check`（布尔型，独立于规则）。
2. **`promoted_under_contract_version` 必须是事实层的字段**，不能靠「读的时候查一下当前版本」。这是 TerminusDB「同 commit」在本架构下唯一可行的替代。
3. **提升通道照 OMOP 的双列 + 映射表建模**：事实层保留 verbatim 值，另设 `concept_id` 可空列 + `source_to_concept_map` 表。**`concept_id` 为空是合法常态**，不触发任何「缺信息」告警。
4. **`owl:sameAs` 不进契约层**，在事实层做显式等价表（因为 RDFox 的分层冲突：`sameAs` 排除聚合与否定）。
5. **契约层准入判据照 dbt 的逻辑反转**：不是「重要就加」，而是「形状在未来 N 个月不变才加」。可判定形式：该概念的断言形状在最近 K 次提升中零变更。
6. **每条公理的执行成本必须可审计**（契约层够小，可以逐条算），照 Oracle 砍自反属性的先例：逐条记录「这条公理在此概念上的闭包规模」。
7. **翻译失败必须严格报错**（学 Stride 不学 Blackout），并保留公理原文供「信息缺口」产物引用。

## 8. 对本项目的直接含义（汇总清单）

> 本节是全报告的落点。**§7 的双引擎分层设定覆盖 §0–§6 中「OWL 覆盖全库」的隐含前提**；下面每条都标注它在两种设定下的状态：`[全库]` = 只在 OWL 覆盖全库时成立；`[契约]` = 双引擎分层下成立；`[两者]` = 与设定无关。

### A. 架构判决

**A1 `[契约]` 契约层只放「形状稳定」的概念，判据抄 dbt 的反向逻辑，不抄「重要性」排序。**
dbt 官方原文：「Governance features are model-specific. They **don't apply to other resource types, including snapshots, seeds, or sources**. This is because **these objects can change structure over time** ... and **aren't suited to guarantees like contracts, access, or versioning**」；以及「**increase maintenance if adopted too early** ... Introducing governance while models are still changing can complicate future changes.」
→ 可判定形式：**某概念的断言形状在最近 K 次提升中零变更 → 才允许进契约层。** K 做成配置项。
URL: https://docs.getdbt.com/docs/collaborate/govern/model-contracts

**A2 `[两者]` 不要做 OWL 2 DL 全覆盖，先定「支持哪些公理」的有限表，表外严格报错。**
六家实测的公理白名单长度：Stride 只 7 种（`subClassOf`/`equivalentClass`/`subPropertyOf`/`equivalentProperty`/`inverseOf`/`SymmetricProperty`/`TransitiveProperty`）；AllegroGraph 跳过 OWL 2 RL 表约 1/3；GraphDB 明说「There are no inconsistency rules by default」；Oracle OWL2EL 砍 `ReflexiveObjectProperty`。**没有一家做全覆盖。**
→ **取 Stride 的严格模式**（「有坏规则则拒绝任何推理」）而不是 Blackout 的宽松模式（「坏规则只记日志仍继续推理」），因为契约层小，作者有义务让每条公理可执行或显式标记。
URL: https://docs.stardog.com/inference-engine/blackout-owl-support

**A3 `[两者]` 一致性检查与推导分两张表，独立调用。**
三条独立工业证据：AllegroGraph 把规则编号 2 全部跳过「Not done because rule is a consistency check and **does not materializes triples**」；GraphDB「**There are no inconsistency rules by default**」；Stardog 把 `DisjointClasses`/`DisjointObjectProperties`/`AsymmetricObjectProperty`/`IrreflexiveObjectProperty`/`FunctionalDataProperty`/`DataPropertyRange` 单列为 consistency-only 公理。
→ 表结构：`rule`（产出三元组）与 `constraint`（产出布尔）。**第二张只在第 ② 步「断言证实/证伪」被调用，不进 250ms 粗召路径。**
URL: https://www.w3.org/TR/owl2-profiles/（Table 4–6 中产出为 `false` 的即一致性规则）

### B. 存储 schema

**B1 `[契约]` 契约层三张表：`contract_axiom` / `contract_rule` / `contract_consistency`。**
`contract_axiom`：OWL 原文（Turtle 或 Functional Syntax）+ `version_iri` + `owl_deprecated` + `non_executable` 标记。
`contract_rule`：翻译后的 Datalog 规则 + `axiom_id` FK + `executable` 布尔。
依据：RDFox 的做法「the axioms are **translated into rules** in order to facilitate reasoning」，翻不动的公理「**仍然加载并保留**」，只发 warning（§5.1）。
→ **翻不动不丢，打 `non_executable` 标记，只能出现在「信息缺口」产物里。**
URL: https://docs.oxfordsemantic.tech/reasoning.html

**B2 `[两者]` 证明表必须是「(前提 ID 列表) : 规则名」，且必须在写入时就开，不能事后补。**
Oracle 的一手表结构：视图两列 `LINK_ID` 与 `EXPLAIN`，内容格式 `link-id1 [ link-id2 … link-idn ] : rule-name`，实测输出如 `8_5_5_4 generated by 4_D_5_5 : SYMM_SAMH_SYMM`。
硬约束原文：「If the inference status is INCOMPLETE and if the last inference was generated **without proof information, you cannot invoke `SEM_APIS.CREATE_INFERRED_GRAPH` with PROOF=T**. In this case, you must first drop the inferred graph and create it again specifying PROOF=T.」
→ 这正是第 ⑤ 步「证明子树」所需的全部结构。**代价照旧**：「Proof generation does require additional CPU time and disk resources」，但在契约层（几十个概念）上可支付。
URL: https://docs.oracle.com/en/database/oracle/oracle-database/23/rdfrm/using-owl-inferencing.html

**B3 `[契约]` `promoted_under_contract_version` 必须是事实层的字段。**
TerminusDB 的解法是「schema 与数据 both are in the same commit」，理由是「The file history tells you how the schema changed. **It does not tell you which data was valid under which version**」。**本项目做不到 same commit**（事实在 triviumdb、契约在别处），所以必须显式存版本号到每条事实/每条提升记录上。
URL: https://terminusdb.com/docs/ontology-versioning/

**B4 `[契约]` 提升通道照 OMOP 的双列 + 映射表建模，且「未提升」是合法常态。**
`condition_source_value`（verbatim，`varchar(50)`）与 `condition_concept_id`（指向 Standard Concept）并存；`SOURCE_TO_CONCEPT_MAP` 是显式映射表。文档对 source value 的原话只是「**discouraged from use in analysis**」，**从未要求必须提升**。
→ 事实层：`raw_value`（必有）+ `concept_id`（可空）+ `source_to_concept_map` 表。**`concept_id` 为空不触发任何告警。**
URL: https://ohdsi.github.io/CommonDataModel/cdm54.html

**B5 `[两者]` 版本化用 OBO 式「不可变快照 + versionIRI」，不要用 OWL 的版本化注解做迁移。**
OWL 2 的三条版本化词汇全是 annotation：`backwardCompatibleWith` 原文只有「**a hint to document authors**」，且「has **no meaning in the model theoretic semantics**」；ontology series「**not represented explicitly** ... exist only as a side effect of the naming conventions」。
OBO 的做法是可执行的：「the content of official release files **MUST NOT be changed**」，bug 只能在新版本修；`versionIRI` **MUST** resolve 到具体文件且含相同版本串。
→ **本项目：契约层每次变更生成新 `version_iri` + 冻结旧快照，不修改旧快照。**
URL: https://www.w3.org/TR/owl2-syntax/ §3.1–3.3；https://obofoundry.org/principles/fp-004-versioning.html

**B6 `[契约]` `owl:sameAs` 不进契约层。**
RDFox 硬约束原文：「the use of the special equality relation `owl:sameAs` in rules **precludes the use of aggregation or negation-as-failure**」。而契约层的「争用判定」需要聚合。
另一面：Stardog 是唯一 eager 物化 sameAs 的系统（「computed and indexed **eagerly**」），且需 canonical individual 避免「**combinatorial explosion**」——**等价闭包规模由个体数决定，与概念数无关**，放进契约层等于把全库规模塞进契约层。
→ 在事实层做显式等价表（`equiv_class_id`），契约层只引用 `equiv_class_id`。
URL: https://docs.oxfordsemantic.tech/reasoning.html；https://docs.stardog.com/inference-engine/advanced-reasoning-features

### C. 召回管路的五步映射

| 步骤 | 用本报告哪条证据 | 落成什么 |
|---|---|---|
| ① 粗召（250ms） | AllegroGraph：「dynamic reasoner is best when ... the store you are using **is changing**」 | **纯 triviumdb 索引检索，零推理。**契约层不参与。 |
| ② 转 OWL 概念查询 + 证实/证伪 | GraphDB 的 `subsumption` 用于 rollup（OMOP「hierarchical structure to facilitate cohort definitions by **rolling up**」）+ 两张规则表分离 | 类查询走 `contract_rule` 的 `subClassOf` 闭包；证实/证伪走 `contract_consistency` 的布尔判定 |
| ③ Abduction 求最小 delta | 见 §5 的 ABox abduction 文献（arXiv:2007.00757 / 2105.00274 / 1811.05420 / 2205.08449） | 未在本维度展开，交给 abduction 维度的报告 |
| ④ 信息缺口作为一等产物 | RDFox 的 `non_executable` 公理 + Evee 系列的 missing entailment explanation（arXiv:2308.07294 / 2206.07711） | 表 `information_gap`：`{gap_type, concept_id, missing_axiom_ids, partial_proof_ids}` |
| ⑤ 合并提交宿主 | Oracle 的 proof 表结构 | `{proof: [(premise_ids, rule_name)], asserted: [...], gap: [...]}` |

### D. 明确不做的事（每条都有反向证据）

1. **不做全库 OWL 物化。** RDFox 实测膨胀 320 倍（14,820 → 4,740,705）；AllegroGraph 官方定义「数据在变」与「要物化」互斥。
2. **不做 query-time OWL DL。** 六家无一实现；Jena 自认只到 Lite 且「none of them is complete」；RDFox 自述「has not been designed for solving problems such as class subsumption」。
3. **不依赖 SHACL-AF rules 做定点推理。** 规范自己说多轮行为「**left to future work**」，且「it is impossible for rules to modify the definitions of rules or shapes」。
4. **不用 OWL 的 versionIRI/priorVersion/backwardCompatibleWith 做迁移语义。** 全是 annotation。
5. **不做「自动判定该不该提升」的机制。** §7.2：无任何系统有定量触发条件（Freebase 人工、OMOP 工具辅助人工、dbt「请自行判断」）。这个判据要么是人工策略，要么是本项目的原创贡献——**不要写成「业界已有」**。
6. **不做「每写必检 schema」。** TerminusDB 的 same-commit 检查假设 schema 变更稀疏；在 250ms 预算下，每写必检不可行。抄判据与两阶段策略，不抄每写必检。

### E. 未解决 / 需要本项目自己发明的

| 问题 | 状态 |
|---|---|
| **事实 → 契约的自动提升判据** | **业界空白**（§7.2 逐系统核过）。建议：`(K 个互异定义) ∧ (每定义 ≥ N 次检索引用)` → 产出「待评审」条目，不自动提升。**这是我的建议，不是既有实践。** |
| **契约版本与既有事实的对应** | TerminusDB 用 same-commit 解决，本项目架构不允许。需自己设计 `promoted_under_contract_version` 字段 + 迁移时的重放策略。 |
| **`owl:sameAs` 在 Datalog 层与聚合共存** | RDFox 明确两者互斥。若事实层既要等价闭包又要聚合，需自己证明分层（stratification）成立。 |
| **证明表的存储增长** | Oracle 只说「requires additional CPU time and disk resources」，无数字。本项目需自己压测。 |
| **契约层变更触发的重推范围** | 无一手数据。RDFox 的「加一条规则产 51 万条新事实」是最接近的量级参照，但那是全库规模。契约层需自己实测。 |

### F. 一句话总结

**这个维度里所有成功的系统，都是「事实层松散 + 契约层收紧 + 两者之间有显式提升通道」，没有一个是「整层本体化」。最接近本项目需求的一手先例不是任何 RDF 数据库，而是 OMOP CDM 的双列模式——它把「verbatim 事实」和「标准化概念」放在同一张表的相邻两列，用一张映射表连接，并且明确容忍大量事实不被提升。TerminusDB 提供的是唯一可执行的变更判据（can it make valid data invalid?）与两阶段迁移，但它不做推理。OWL 的版本化词汇在两者中都没有位置。**
