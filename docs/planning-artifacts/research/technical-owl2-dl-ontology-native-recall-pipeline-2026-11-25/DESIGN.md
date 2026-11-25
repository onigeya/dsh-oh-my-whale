# 信念记忆的分层 Schema 与证明式召回管路

设计文档 · 2026-11-25 · 依据 research.md 与 poc/ 的可跑验证

---

## 0. 这份文档要解决什么

目标不是把 OWL 层叠到现有 schema 上，而是重新切分记忆的层次，让存储天然承载两件不同的事：**高频写入的事实**与**极少改动的语义契约**。判据不是审美，而是 CLS 记忆理论给的那一条：单层统一的学习率必然二选一——学得慢则保住结构、丢掉近期，学得快则保住近期、毁掉结构。事实每秒都在变，契约不该跟着变；把两者放进同一层，任何一种写入策略都会伤到另一半。

因此本设计交付三件事（对应验收 A1 的三项）：

1. **重新划分的记忆层次**，以及两层之间那条边界怎么切、切在哪、凭什么判；
2. **延长后的记忆提炼管线**，双引擎在哪些点上介入、介入失败怎么办；
3. **事实提升为契约的触发条件**，以及为什么它必须是人工动作。

同时要保住运行时的既有语义（约束 C1）：五步召回管路一步不少，只是每一步现在都有形式化的依据。

### 0.1 一句话结论

Datalog 作运行时内核，OWL 2 RL 作契约层的**语法来源**而不作运行时推理器；一致性检查落在内核上（RL 的 78 条规则里恰好 17 条以 `false` 为头，那条 `false` 一触发就是证伪）；证明链不是另建的对象，而是内核求值 trace 的规则名序列。

### 0.2 这个结论从哪来（可追溯）

| 结论 | 依据 | 落盘位置 |
| --- | --- | --- |
| RL 可直接用规则引擎实现，且 78 条规则中 17 条 `false` 头 | W3C OWL 2 Profiles 规范 Table 4–9 逐行解析 | `digests/d1-owl2-profiles.md` |
| RL 一致性检查 PTIME、组合复杂度 co-NP → 契约层类表达式必须限原子 | 规范 Table 10 复杂度表 | `digests/d1-owl2-profiles.md` |
| EL/RL 片段内溯因是 P-complete，非不可判定 | Koopmann IJCAI-21 Thm 3 等 | `digests/d4-abduction-and-minimal-delta.md` |
| 三值是两次可满足性检查，证伪有六种燃料，NAF 不得产生 REFUTED | SPARQL 1.1 ER §7.2、SHACL 规范 | `digests/d5-three-valued-and-proof-trees.md` |
| 无生产系统跑 query-time OWL 2 DL；OMOP 双列证明大量事实永停 verbatim 层是合法常态 | Stardog/GraphDB/Oracle/RDFox 文档、OMOP CDM v5.4 | `digests/d3b-schema-as-ontology-and-versioning.md` |
| 没有任何系统记录定量提升条件；真实触发条件全是单调可判定量 | Generative Agents 阈值 150、MemGPT 水位 70/100%、Confluent 兼容性门禁 | `digests/d10-memory-layering.md` |
| triviumdb 无 RDF/SPARQL/推理层；dim 是每文件全局；数组字段不可索引；边 metadata 无二级索引 | 0.9.3 d.ts + 十一组实测 | research.md 第 516 行起 d2b 节 |
| 内嵌 JS 生态无原生 OWL 推理器，JVM 系需 JNI | ELK/HermiT/Openllet/JFact 版本核实 | `digests/d7-embedded-reasoner-cost.md` |

---

## 1. 约束与它们逼出的设计形状

先把不可谈判的东西列清，因为它们直接决定了设计只能长成某种样子。

| 约束 | 内容 | 对设计的强制作用 |
| --- | --- | --- |
| 单进程 | Windows 单进程 Node 内嵌，不能起独立服务、不能依赖 JVM、不能要求用户装额外运行时 | 排除全部 JVM 推理器与 Konclude WASM 主路径；契约层不能靠外挂 DL reasoner 实现 |
| 热路径预算 | 召回三段：候选 250ms / 重排 600ms / 注入 20ms，硬上限 1000ms | 契约层检查必须能落进 250ms；全库物化不可行 |
| 写高频 | 观察、工具调用结果、会话摘要持续写入 | 事实层必须 append-friendly；契约层不能被写入路径触碰 |
| 信念会变 | supersede、证伪、收缩都要发生，且要能回答依据哪些事实、去掉哪条就不成立 | 必须存 provenance 与证明链；不能只存结论 |
| 注入有界 | topK 5、硬上限 8（AD-8） | 几百条粗召只能是内部工作集，最终提交必须剪枝（C3） |

存储形态由 triviumdb 的实测能力决定，其中四条是硬约束，写 schema 前必须认下来：

- **`dim` 是每个数据库文件的全局属性**，不是每节点的。同一 1536 维文件里放一个类节点，比 1 维文件贵 26.7 倍。
- **数组型 payload 字段不可索引、不可匹配**。`{ancestors: ["A","B"]}` 建索引后 `entry_count` 为 0，查询恒空。要索引就只能一值一标量字段。
- **边 metadata 没有二级索引**。索引只认节点 payload。
- **TQL 的边 label 不能含冒号**，`MATCH (a)-[:rdf:type]->(b)` 直接语法错误；且 `RETURN id` 语法通过但静默返回 null。

这四条合起来否掉了一种很自然的建模（把类层级与祖先集合塞进节点 payload 的数组字段），也否掉了万物一张表。见第 3 节的落地方案。

---

## 2. 记忆分层（验收 A1 ①）

### 2.1 三层，两层承重

层数不是拍出来的。真实系统的分布是：CLS 2 层、Generative Agents 2 层、MemGPT 2 层、Zep 3 层、medallion 3 层、Mem0 实际 1 层；没有单进程系统做到 4 层以上。分层代价按层数乘性地涨：失效传播要跨层、闭包重算超线性、契约漂移会静默失败、同一概念容易长出两份定义。

本设计取三层，其中第三层封顶可选：

```
L0  情景日志        append-only，无损，不新建存储（现有 session log 已是这一层）
      ↓ 提炼（触发式，非每轮）
L1  Datalog 事实基   基事实 + 规则 + 推导事实；所有修订都在这里发生
      ↑ 提升（人工评审，非自动）
L2  语义契约层       ≤10 个概念的封闭不变量检查，只做否决不生成
```

**L0 情景日志**：不新建存储。现有 session log 已经是 append-only、无损、可重放的一层，它承担原始记录不可篡改这个职责。设计上只需保证 L1 的每条事实都带指回 L0 的证据指针，任何时候都能回到原文。

**L1 Datalog 事实基**：这是运行时唯一会写的一层。基事实（观察、工具结果、摘要结论）与规则同住，正向链求值到不动点，推导事实带 `rule_id` 与前提列表。supersede、证伪、收缩全部在这一层以撤销加 DRed 重算的方式发生。

**L2 语义契约层**：不是第二套数据库，是一组**可判定的封闭不变量**。它只回答这个写入是否违反契约，不产生新事实。上限 10 个概念不是保守，而是为了让哪些东西有契约这件事本身可被完整审阅——超过 10 个，人类就不会再读了。

### 2.2 边界切在哪：一条可执行的判据

概念上分三层很容易，工程上难的是**这条线凭什么划**。本设计给一条能落到代码里的判据，它是 POC 里 `isTboxAtom()` 的直接依据：

> 一个原子属于 L2 当且仅当它的谓词是 schema 谓词（`rdfs:subClassOf` / `rdfs:domain` / `rdfs:range` / `owl:disjointWith` / `owl:equivalentClass` / `owl:inverseOf`），或它是 `rdf:type` 且宾语是元类（`owl:FunctionalProperty` 一类）。其余一律属 L1。

这条判据的价值不在于分类，而在于**它把两种完全不同的缺口分开了**：

| 缺口类型 | 含义 | 正确处置 | 错误处置（必须避免） |
| --- | --- | --- | --- |
| L1 缺观察 | dave 属于 Researcher 缺一条 `dave affiliatedWith lab_a` | 溯因求最小 delta，作为假设上报 | —— |
| L2 缺契约 | Researcher 的定义里没有这条属性约束 | 报为契约缺口，走人工评审（C4） | 当成 delta 凭空假设一条公理 |

**这是整个设计里最重要的一条分界。** 混同两者的后果在 POC 里实测可见：早期版本会让溯因搜索产出 `T(affiliatedWith owl:inverseOf rdf:type)` 这类假设内建谓词是域内逆属性的伪证据——它不是证据，是噪音，而且看起来像答案。修法不是加过滤规则，而是让 `isTboxAtom()` 在溯因入口就把 L2 原子分流，根本不进入假设池。

实测对比（`poc-five-stage.mjs`）：加分流后 `illSorted` rejection 从 11 降到 0；但 `tboxGapOnly` 一度高达 217，因为把所有缺的 schema 公理都算缺口仍然太多。最终判据再加一层闭合检查——只有**补上它就能闭合目标**的缺口才上报：

```js
const probe = kb.withExtra([{ rel: REL, args: g.axiom.split(" ") }]);
if (probe.has(REL, goalArgs)) closable.push({ ...g, closesGoal: true });
```

效果：`daveResearcher` 的契约缺口从 66 条噪音收敛到 1 条真缺口（`:bornIn rdfs:domain :Researcher`）；`bobTeacherOfCarol` 收敛到 2 条语义等价候选（`colleagueOf` 与 `teacherOf` 互逆，二者都对）。注释写进了代码：一个不会改变答案的缺失公理是偶然的，报出它只会埋掉唯一重要的那条缺口，而缺口报告正是这样变成没人读的噪音的。

### 2.3 为什么第三层不是四层，也不是两层

**不用两层（只有事实基加契约，把 L0 揉进事实基）**：会丢掉原始记录不可篡改。事实基是可修订的，一旦把原始观察也放进去，一次错误的收缩就会毁掉证据本身，之后再也无法回答当初到底看到了什么。L0 的不可变性是 L1 可修订性的前提。

**不用四层（再加一层 LLM 摘要或聚类）**：没有证据支持。查到的所有系统里，没有一个在一条管线里同时做 LLM 摘要或聚类与规则校验或推理并记录二者如何共处；也没有管线过长导致失败的一手复盘。在无证据的情况下加层，等于用猜测换复杂度。因此本设计让摘要与抽象仍留在 L1 的写入路径上——它们是事实的**来源**，不是独立的一层。

**L2 封顶可选**：如果 C1/C2/C3 判据（见第 5 节）长期不触发任何概念，L2 就应该是空的。空契约层不是失败，是设计在正常工作——它证明系统没有被过度形式化。
## 3. 存储 schema 落地

### 3.1 核心分界：边存断言，节点存物

现有 SOLUTION-DESIGN §2 让 `assertion` 是**节点**（带向量、带 `mem_key` 唯一索引、带双时间轴）。直接在这上面叠 OWL 会立刻撞墙：`rdfs:subClassOf`、`owl:disjointWith`、`rdf:type` 也是断言，如果每条都开一个 assertion 节点，类层级就会变成一堆「关于类的叙事记忆」，与「alice 喜欢咖啡」混在同一个命名空间里。

本设计把断言与物分开，理由不是美学，是两条不相交的物理需求：

| 需求 | 载体要求 | 只能选 |
| --- | --- | --- |
| 语义相似度粗召 | 必须有向量槽 | 节点（边没有向量槽，实测确认） |
| 被推理规则消费 | 必须能按 (s,p,o) 精确查找、按入度/出度遍历 | 边（`getEdges` / `getIncomingEdges`，节点间无此原语） |

一条记忆要么是叙事、要么是结构，**不存在「两者都要」**。从叙事抽取结构时，边带 `evidence_ref` 指回叙事节点，这是单向提升，不是双写同一内容。

于是：

```text
节点 = 物（术语 / 实体 / 情景 / 证据）—— 有 IRI 或 mem_key，可带向量
边   = 断言（三元组）—— label 是谓词，metadata 带时间与证明字段
```

这不是新发明的形态，它就是 RDF 图在 LPG 上的直接落地：`(alice)-[:rdf_type]->(Researcher)`、`(Researcher)-[:rdfs_subClassOf]->(Person)`、`(alice)-[:likes]->(coffee)` 三者结构完全同构。OWL 2 的 TBox 与 ABox 因此不需要任何额外容器——**它们的差别只是行的位置（哪条边），不是存储的形态**。这就是 G1 要的「存储天然承载 T/ABox」。

### 3.2 一条意外的红利：边天然给出 mem_key 的唯一性

现有设计用 `createUniqueCompositeIndex([mem_key, active_slot])` 保证「同一件事只有一条断言」，并在 supersede 时把 `active_slot` 从 1 改成毫秒数，靠撞键抛 `TDB_UNIQUE_CONSTRAINT` 触发写 `rejected`。

断言改走边之后，**这层机制由存储自身承担**：`upsertEdge(src, dst, label, ...)` 与 `getEdge(src, dst, label)` 都是按 (src, dst, label) 三元组定位的，同一个三元组不可能存成两条边。实测 `getEdge` 需要三个参数才找得到（写成两参会静默找不到），这从侧面确认了唯一性的键就是这三者。

`active_slot` 仍需要，但它从「唯一性键的一半」降级为「活动标记」：`metadata.active_slot` 为 1 表示当前有效，为毫秒数表示已失效。唯一索引依然要建，只是建在叙事节点上，不再建在结构断言上。

### 3.3 命名：为什么 label 必须扁平化

TQL 解析器拒绝 label 里的冒号，实测 `MATCH (a)-[:rdf:type]->(b)` 报 `Expected RBracket, got Colon`。所以边 label 一律把冒号换成下划线：`rdf_type`、`rdfs_subClassOf`、`owl_disjointWith`。

原本的谓词名不能就此丢掉——`rdfs_subClassOf` 与 `rdfs_subPropertyOf` 扁平化后仍可区分，但 `owl_inverseOf` 与某个恰好叫 `owl_inverseOf_` 的域内谓词会含糊。因此**谓词原名存在边 metadata 里**：`metadata.predicate` 存 `rdfs:subClassOf`。读回时优先取 metadata，取不到才反扁平化。POC 的 `store-triviumdb.mjs` 就是这么做的（`triplesFrom` 里 `e.metadata && e.metadata.predicate ? ... : unflattenPredicate(e.label)`），往返验证 23 条公理零分歧。

### 3.4 L2 契约层的节点与边

契约层规模按 C4 判决是「≤10 个概念的封闭不变量检查」，但类层级本身可能比 10 大——一个概念的祖先链平均 3–5 层。因此契约层节点数在几十量级，这也是为什么它可以不走向量、不需要粗召。

**节点**（`payload.kind` 取值决定角色，与 POC 实测一致）：

| kind | 含义 | payload 关键字段 |
| --- | --- | --- |
| `owl:class` | 一个类 | `iri, label?, contract_version, status`（active 或 deprecated） |
| `owl:property` | 一个对象属性或数据属性 | `iri, label?, prop_kind`（object 或 data）, `contract_version` |
| `owl:metaclass` | `owl:FunctionalProperty` 这类内建元类 | `iri` |

内建元类建成节点而不是字符串常量，是因为 POC 的排序检查必须能判断「`rdf:type` 的宾语是不是元类」——这需要一次查找，而不是一个硬编码数组。数组仍可作为缓存，但**事实来源必须是库**，否则库里加一个自定义元类就漏判。

**TBox 边**（全部出自契约层，`origin` 恒为 `asserted`）：

| 边 label | 对应公理 | 位置约束（POC 的 `sortOfPosition` 据此判定） |
| --- | --- | --- |
| `rdfs_subClassOf` | 子类 | 两位都是 class |
| `owl_equivalentClass` | 等价类 | 两位都是 class |
| `owl_disjointWith` | 不相交 | 两位都是 class |
| `rdfs_domain` | 定义域 | 主 property，宾 class |
| `rdfs_range` | 值域 | 主 property，宾 class |
| `owl_inverseOf` | 逆属性 | 两位都是 property |
| `rdf_type`（宾语为元类） | 属性特征 | 主 property，宾 metaclass |

### 3.5 L1 事实基的节点与边

**节点**：沿用 SOLUTION-DESIGN §2.1 的 `entity` / `episode` / `scene` / `evidence` / `assertion` 五类不变。`assertion` 仍然存在，但它现在只承载**叙事断言**（需要向量、需要粗召、需要 `falsifier` 与 `settle_state`），不再承载结构性三元组。

**schema 硬约束（实测得出，不是优化建议）**：Datalog 层的谓词必须**拆成三组关系**——`Ta` 只装断言（仅写入方 `add`/`retract`）、`Td` 只装推导（每次重算前整体清空）、`T = Ta ∪ Td` 供查询与规则体读取。理由见 §9.3 第 2 条：把断言与推导放进同一个关系后，「不清则陈旧、清则连断言一起删光」两条路都堵死。

**ABox 边**：

| 边 label | 语义 | 位置约束 |
| --- | --- | --- |
| `rdf_type` | 个体属某类 | 主 individual，宾 class |
| `owl_sameAs` | 两个体相同 | 两位都是 individual |
| `owl_differentFrom` | 两个体不同 | 两位都是 individual |
| `owl_derivedFact` | 由规则推出的事实 | 见 §3.6 |
| 域内谓词（`likes`、`works_at`、`affiliatedWith` 等） | 普通属性断言 | 主 individual，宾 individual 或字面量节点 |

**字面量怎么存**：`triviumdb` 的边不能挂字面量，每个节点必须有 u64 id。所以生日这类值是先建一个字面量节点，payload 为 `{kind: literal, value, datatype: xsd:date}`，再用 `createIndex(value)` 支持反查。这不是妥协——OWL 2 的 `dt-eq` / `dt-diff` / `dt-not-type` 三条规则需要在字面量之间判等与判值域，有节点反而好办。

### 3.6 决定成败的四个字段：证明四列

嵌入式推理器调研给出的硬结论是：**没有这四列，证明链在存储层就断了**，再好的推理机也补不回来。它们落在每条边的 `metadata` 上：

| 字段 | 取值 | 缺了会怎样 |
| --- | --- | --- |
| `origin` | `asserted` / `derived` / `external` | 分不清哪些是观察到的事实、哪些是推出来的，收缩时无法确定哪些该重算 |
| `rule_id` | RL 规则名（`prp-dom`、`cax-dw` 等），`asserted` 时为 null | 证明树只能显示「推出来的」，说不出「用哪条规则推的」 |
| `justification_id` | 前提集合的指纹（排序后拼接再 hash） | 无法回答「去掉哪条它就不成立」，核收缩失去入口 |
| `depth` | 推导层数，`asserted` 为 0 | 无法做深度截断，递归推导会爆 |

`justification_id` 的指纹算法必须**先排序再拼接**。Lemmalog 源码里有一条明确的警告：`derive` 的 body 按触发顺序到达，求值器不排序，同一逻辑推导会按 body 的排列各来一次；如果直接对 body 序列取指纹，就会把「同一个推导」算成多个不同的推导。POC 的 `factKey` 只处理单个事实，规则的 justification 指纹必须在写入前显式排序。

`origin = derived` 的边**必须持久化**，尽管它在进程内可以重算。判据见 §3.9。

### 3.7 索引清单

```text
createBitmapIndex(kind)                              // 按角色筛：所有 class、所有 individual
createIndex(iri)                                     // 术语精确查找（URI 到节点）
createUniqueCompositeIndex([mem_key, active_slot])   // 仅叙事节点，沿用现有
createCompositeIndex([kind, iri])                    // 角色内查找，避免全库扫
createIndex(contract_version)                        // 契约版本隔离（d3b 的 OOPS 快照判据）
createIndex(value)                                   // 字面量反查，供 dt-eq 用
```

三条实测得来的限制必须写进注释，否则下一个人会重犯：

1. **数组型 payload 字段建不了索引**：对数组字段建索引后 `entry_count` 为 0，`indexedLookup` 返回空。所以「类成员集合」不能存成数组字段。变通是「一值一标量字段」（`has_Researcher: 1`），但这会随类数增长而爆字段数——因此**成员集合不求物化**，走边遍历。
2. **边 metadata 没有二级索引**：对边字段建索引后 `indexInfo()` 的 `entry_count` 仍是 0，索引只认 payload。这意味着按 `origin` / `rule_id` / `depth` 过滤**只能靠遍历**。这是本设计最大的性能隐患，缓解手段见 §3.8。
3. **`indexedLookup` 返回 `number[]` 不是行**，取 payload 要再来一次 `getPayload`，天然 N+1。批量场景必须限制命中数。

### 3.8 边 metadata 无索引的缓解手段

既然不能按 `origin` 过滤，就把过滤条件**上移到节点**：每个 individual 节点带一个标量字段 `derived_count`（该个体有几条出边是 derived），`asserted_count` 同理。这样「哪些个体有推导事实」可以走索引筛出来，再只对筛出的个体做边遍历。

代价是每次写边要同步更新计数，而这会违反 AD-8 的「召回路径禁止写」。因此计数**只在写路径维护**，召回路径只读。这是可接受的：写路径已经在一个事务里，多一次 `patchPayload` 不增加竞态。

若这条仍不够（推导事实量大到遍历都慢），退路是把高频查询的推导事实**具化为节点**（`kind: owl:derivedAssertion`，payload 带 `subject` / `predicate` / `object` / `origin` / `rule_id` / `depth`），用 `createCompositeIndex([predicate, subject])` 支持索引查找。实测具化在 dim=1 下磁盘只贵 15%、写入贵 2.0 倍，对推导事实这种「写一次读多次」的形态是划算的。**但默认不这么做**，因为具化会引入双份维护。

### 3.9 物化判据：什么时候把闭包写进库

实测过的判据不是「闭包大不大」，而是**闭包是否要跨进程存活**：

| 情形 | 结论 | 理由 |
| --- | --- | --- |
| 进程内内核已算出 | 不必物化 | 内存里已有，物化就是双写双维护 |
| 进程重启后还要用 | 必须物化 | 内存闭包全丢，重算 10k 类要 2432ms |
| 删除频繁 | 不宜物化 | `unlink` 比 `deleteManyAtomic` 慢 3.8 倍（192ms vs 50ms），闭包边躺在删除热路径上 |

落到本项目：**TBox 传递闭包最该物化**（结果集大、几乎不变、删边近似为零），**ABox 推导事实最不该物化**（频繁增删、结果集小）。这两条方向相反，不能一刀切。

另一条独立证据：类层级实测显示 N=10000 时「取全部后代」单条遍历 232.77ms，**一条查询吃满整个 250ms 粗召预算**；物化后降到 20.60ms（11.3 倍）。而「取全部祖先」遍历只要 0.160ms，物化了也只快 3.2 倍、却要 11.5MiB——**祖先查询物化纯亏**。所以物化只做后代方向，且加一条自适应判据：结果集预计达类层级规模才走物化表，否则走遍历。

### 3.10 两个数据库文件，不是一个

`dim` 是**每个数据库文件**的全局属性，不是每节点的（实测：insert 强制校验维度，重开也强制，`dim:0` 被拒）。这意味着所有节点共享一个向量维度。

把 TBox 放进取 1536 维的文件里，会让每个类节点贵 26.7 倍（6379 B vs 239 B；5000 类 = 30.42MiB vs 1.14MiB），而类的向量根本没人查。因此分两个文件：

```text
facts.tdb   dim: 1      全部结构（TBox 节点 + ABox 边 + 叙事节点骨架）
emb.tdb     dim: 1536   纯向量（只有需要语义召回的叙事节点在此有镜像）
```

代价是跨文件的 id 不能互认，必须用 `mem_key` 或 `iri` 做关联键。这是可接受的：跨文件关联只在召回合并时发生一次，不在推理路径上。

POC 为简化只用了 `dim: 1` 的单一文件，这不影响语义验证，但**生产必须分开**。
## 4. 三值查询与证明树

### 4.1 一致性是第 0 关，不是三态之一

经典逻辑里，一旦知识库不一致，任何命题都「可推出」（爆炸原理）。所以在一个已不一致的库上返回 CERTAIN，无论推理链多正确，结论都是假的。

SPARQL 1.1 Entailment Regimes §7.2 把这条写成了规范义务：查询在蕴含不一致时必须报错，而不是返回结果。因此一致性检查**不能**混进三值里当作第三个值，它必须是所有查询之前的一道闸门。

POC 的实现（`consistencyGate`）：

```js
function consistencyGate(kb) {
  if (kb.violations.length === 0) return { status: "CONSISTENT" };
  return { status: "VIOLATED", conflicts: kb.violations.map(...) };
}
```

`violations` 来自 Datalog 求值过程中头为 `false` 的规则触发——这正是 §0 说的「17 条 false 头规则即证伪触发点」在运行时的样子。它不是另一套检查器，是同一次不动点求值的副产物。

闸门后接四态而非三态：

| 闸门 | 查询结果 | 含义 |
| --- | --- | --- |
| CONSISTENT | CERTAIN / REFUTED / POSSIBLE | 正常三值 |
| VIOLATED | **UNRELIABLE** | 库不一致，任何答案都不可信 |

`UNRELIABLE` 是第四态。它出现的唯一条件就是闸门 VIOLATED，因此它与三值不并列、不混淆——它表达的是「这个问题现在问不了」，不是「这个命题真假未知」。

### 4.2 CERTAIN / REFUTED / POSSIBLE 的判定方式

POC 的 `conceptQuery(kb, s, p, o)` 三步：

```js
const gate = consistencyGate(kb);
if (gate.status !== "CONSISTENT") return { status: "UNRELIABLE", gate };
if (kb.has(REL, [s, p, o])) return { status: "CERTAIN" };
const trial = kb.withExtra([{ rel: REL, args: [s, p, o] }]);
const fresh = trial.violations.slice(kb.violations.length);
if (fresh.length > 0) return { status: "REFUTED", via: [...], support: [...] };
return { status: "POSSIBLE" };
```

三步对应三个语义，值得逐条说清为什么这样判是对的：

**CERTAIN = 已蕴含**。`kb.has` 查的是求值后的完整体，包括推导出的事实，所以它是「在当前信念基下已成立」，不是「字面上写过」。

**REFUTED = 加上它会导致不一致**。这是「可满足性检查」的工程等价：标准定义是「KB 蕴含 ¬γ 当且仅当 KB ∪ {γ} 不可满足」。POC 不构造 ¬γ（OWL 的否定范式化在运行时是负担），而是**假定 γ 再加入，看是否触发 false 头**。两者等价，但后者不需要否定算子——这是把否定「推给规则」而非「推给查询」。

**POSSIBLE = 既不蕴含也不矛盾**。这就是开放世界的诚实答案：不知道，但允许。它不是「假」，也不能当假用。

### 4.3 证伪的燃料必须是显式否定，不能是「查不到」

这一条是整个设计最容易做错的地方。把「查不到 P」当成「P 为假」是封闭世界假设（CWA），而 OWL 是开放世界。混淆两者的后果是：用户说了一句「我住在杭州」，系统就因为没查到「住在北京」而断言「不住北京」——而事实上人可能有两处住处，只是没说过。

OWL 2 RL 里能产生真证伪的燃料只有六类，全部来自 17 条 false 头规则：

| 燃料 | 触发的规则 | 例子 |
| --- | --- | --- |
| 显式否定断言 | （域内规则） | `alice -[not_likes]-> coffee` |
| 类不相交 + 双成员 | `cax-dw` | `Researcher` 与 `Org` 不相交，`alice` 同时是两个 |
| 函数属性 + 两个不同填充者 | `prp-fp` 推 `sameAs`，再撞 `eq-diff1` | `affiliatedWith` 函数，`alice` 同时属 `lab_a` 与 `lab_b` |
| 定义域/值域冲突 | `prp-dom` / `prp-rng` 与 `cax-dw` 组合 | `alice` 是 `Org`，但 `affiliatedWith` 的定义域是 `Researcher` |
| 数据类型面冲突 | `dt-not-type` | 字面量声称是 `xsd:int` 但值不在值域 |
| 全体不同 | `eq-diff2` / `eq-diff3` | `AllDifferent` 里两个成员被推成 `sameAs` |

POC 的八条查询验证了其中三类真实生效：

```text
alice a Agent            → CERTAIN    （子类链推导）
alice a Place            → REFUTED    via cax-dw
lab_a a Researcher       → REFUTED    via cax-dw
dave a Person            → CERTAIN    （bornIn 定义域）
dave a Researcher        → POSSIBLE   （缺 affiliatedWith 观察）
bob teacherOf carol      → POSSIBLE   （缺 studentOf 观察）
alice knows carol        → CERTAIN    （knows 传递，alice→bob→carol）
```

注意 `dave a Researcher` 与 `lab_a a Researcher` 只差一个主语，结论完全不同：前者 POSSIBLE，后者 REFUTED。差别不在 dave 或 lab_a 本身，而在 `lab_a` 是 `Org` 而 `Researcher` 与 `Org` 不相交。**这就是「证伪需要燃料」的具体形态**——没有不相交公理，lab_a 也会是 POSSIBLE。

### 4.4 证明树不是另造的对象，就是求值 trace

OWL 2 RL 的 Theorem PR1 的证明本身就是对推导树做变换，因此证明树不需要独立的证明对象语汇——它就是「规则名序列 + 前提指针」。POC 的 `proofTree` 直接返回这个结构：

```text
叶子   { key, rel, args, depth, leaf: true }
非叶子 { key, rel, args, depth, rule, ruleName, children: [...] }
环     { key, cut: true, reason: "cycle" }
超深   { key: "?", cut: true, reason: "depth-cap" }
```

有两个实现细节是踩过才对的：

1. **`args` 必须是数组，不是拼好的字符串**。早期版本把 `c.args` 当拼好的键用，直接崩溃。键与参数是两个概念：键用于查重（`args.join(" ")`），参数用于继续展开。
2. **环必须显式标 cut**。`knows` 是传递属性，`alice→bob→carol` 再套传递会产生 `alice→bob`、`bob→alice` 这类自我维持的推导。不标 cut 的证明树在传递属性上会无限展开。

证明树**不全量物化**。Calautti/Livshits/Pieris/Schneider (PACMMOD 2024) 证明递归 Datalog 的 why-provenance 不可处理，非递归的高度可处理。工程对策是两条：非递归部分持久化，递归部分每次现算并设深度上限；Lemmalog 自己也取 `SUPPORT_CAP = 4`、`why()` 每规则只展开一条。POC 用的是同一策略（`maxDepth` 24，`partialProof` 默认 4）。

### 4.5 部分证明树：近失展开

第 ④ 步要的不是「证不出来」，而是「证到哪一步、差什么」。POC 的 `partialProof` 用近失展开（near-miss expansion）实现：

```text
1. 目标已蕴含              → 整棵 PROVED
2. 目标缺失且是 TBox 原子  → GAP{reason: contract-gap}（立刻停，不展开）
3. 已达深度上限            → GAP{reason: depth-cap}
4. 枚举能推出目标的规则实例，选缺失前提最少的那个展开
5. 子节点递归，已蕴含的成 PROVED，来自 delta 的成 ASSUMED
```

三个状态：`PROVED`（基里已有）、`CONDITIONAL`（补上 delta 就成立）、`GAP`（补不上）。整体状态取最坏：有 cutFrontier 就是 GAP，否则有 assumed 就是 CONDITIONAL，否则 PROVED。

第 2 步的「TBox 原子立刻停」是**上一轮修复的核心**。没有它，缺失的 `rdfs:domain` 公理会被当成普通缺口继续展开，于是 `owl:inverseOf` 的定义域又被要求、又被展开，产生 `:affiliatedWith owl:inverseOf owl:inverseOf` 这类无意义原子。修法不是加深度限制，而是**在语义上区分两类缺口**（见 §2.2 的对照表）：schema 公理缺失不是「观察不足」，它是契约不完整，补再多观察也没用。

第 4 步的评分函数同样关键：

```js
const fullyAssumed = missing.every(m => assumedSet.has(m.args.join(" ")));
const score = (fullyAssumed ? 0 : 1000) + missing.length;
```

`+1000` 的偏置让「Stage 3 已经定价过的那条分支」优先展示。否则 Stage 4 会挑一条缺失更少但与 delta 无关的路径展开，结果是**证明里显示的缺口与实际给出的 delta 不是同一个**——读者会以为 delta 补不上那个缺口。修完之后 `daveResearcher` 的证明里，`assumedLeaves` 恰好只有 `:dave :affiliatedWith :lab_a` 这一条，与 Stage 3 的最优 delta 完全一致。

### 4.6 缺口（GAP）的字段设计

缺口不是一个字符串，它必须能被下游消费。字段取自 d5 的三值研究报告，并已在 POC 落地：

| 字段 | 取值 | 作用 |
| --- | --- | --- |
| `goal` | 缺口处的原子 | 哪个子目标没闭合 |
| `reason` | `depth-cap` / `no-applicable-rule` / `contract-gap` | 为什么没闭合（三者处置完全不同） |
| `gapKind` | `missingAssertion` / `missingContractAxiom` | 缺的是观察还是契约 |
| `status` | `GAP` | 与 PROVED / CONDITIONAL 并列 |
| `provedSubtree` | 见 `provedLeaves` | 已证实的部分，永不丢弃 |
| `refutationEvidence` | 见 `contractGaps[].support` | 若缺口来自 contradicted 分支，附上反证前提 |

`reason` 的三分法是可操作的：`depth-cap` 意味着「加深还能算」（可以调参重试），`no-applicable-rule` 意味着「没有规则能推出它」（要么缺契约，要么问题问错了），`contract-gap` 意味着「缺的是公理」（必须人工评审，见 §6）。三者混成一个「证不出来」的字符串，下游就无法决定下一步该做什么。

### 4.7 缺口报告的收敛：闭合判据

一个只会报缺口的系统很快就被忽略，因为缺口太多。所以必须加一层**闭合判据**：只报「补上它就能闭合目标」的缺口。

```js
const probe = kb.withExtra([{ rel: REL, args: g.axiom.split(" ") }]);
if (probe.has(REL, goalArgs)) closable.push({ ...g, closesGoal: true });
```

实测收敛效果：

| 案例 | 收敛前候选 | 收敛后 | 剩下的是什么 |
| --- | --- | --- | --- |
| `dave a Researcher` | 66 | **1** | `bornIn rdfs:domain Researcher` |
| `bob teacherOf carol` | 18 | **2** | `colleagueOf` 与 `teacherOf` 互逆（语义等价，二者都对） |

这条判据的代价是每次缺口都多一次 `withExtra` 重算（POC 里可忽略；生产上要限流，因为缺口候选可能上百）。收益则是缺口报告从「噪音」变成「待办」。代码注释写的就是这个意思：一个不会改变答案的缺失公理是偶然的，报出它只会埋掉唯一重要的那条缺口，而缺口报告正是这样变成没人读的噪音的。
## 5. 延长后的记忆提炼管线（验收 A1 ②）

### 5.1 现有管线是什么（不是本设计发明的）

两端都有权威定义，本设计不改它们的顺序，只插检查点。

**写路径**（SOLUTION-DESIGN §3）：`agent/turn-stopping`（每轮一次，监听器不等待）→ 去抖（`ctx.timer` 每会话一个，默认 3s、max-wait 10s）→ 一次抽取 LLM 调用（补丁表 JSON）→ zod + TBox + 指针范围校验 → `accepted[]` / `rejected[]` → 单事务 `commitTransaction` → `vec_state: pending`，异步补向量。

**dream 8 步**（AD-10，顺序固定）：①确定性结算 ②重放抽样 ③模式提取(LLM) ④场景抽象(LLM) ⑤What-If(LLM, v1 关) ⑥剪枝归档 ⑦跨主题重组 ⑧策略提炼(LLM)。①②⑥⑦ 不得调 LLM。每步产出 diff 后独立提交一个 `dream_log` 节点，崩溃可从最后完成的阶段续跑。

### 5.2 插入点总览

六个检查点，全部是**只读校验或不变量维护**，没有一个改变现有步骤的顺序：

| 编号 | 位置 | 类型 | 做什么 | 耗时量级 |
| --- | --- | --- | --- | --- |
| **K1** | 抽取 LLM 之后、zod 校验之前 | 符号预筛 | 把补丁里的 (s,p,o) 按位置约束排序检查；不合法的直接进 `rejected`，不送 LLM 复核 | <1ms |
| **K2** | 事务提交之前 | 一致性关卡 | 在克隆基上加入 pending 补丁，跑一次 RL 求值；出现 false 头则整张补丁表拒收 | 单事务级 |
| **K3** | 事务提交之后 | 证明四列填充 | 给新边写 `origin/rule_id/justification_id/depth`；更新个体的 `derived_count` | 随边数线性 |
| **K4** | dream ① 确定性结算内 | 收缩执行 | 用 §4 的 justification 定位核，按 DRed-lite 逐层重算 | 见 §5.5 |
| **K5** | dream ③ 模式提取之后 | 概念候选生成 | 从重复出现的结构里提取「可能是契约候选」的类或属性，只标候选不建契约 | 见 §6 |
| **K6** | dream ⑥ 剪枝归档之后 | 契约漂移检测 | 检查已登记契约概念是否长期无实例（dead schema），报为缺口 | 每 cycle 一次 |

**为什么 K1 在 LLM 之前、K2 在提交之前**：这两处的错误代价不同。位置错误（拿属性当类用）是可以纯符号判定的，让 LLM 复核它是浪费；而不一致必须整批拒收，因为补丁表是原子的——半张表提交会产生一个在旧表上都不成立的状态。

### 5.3 K1：位置约束预筛

POC 的 `atomWellSorted` 就是这个检查。它按位置判定每个常量「该是类、个体、属性还是元类」，判定表见 §3.4/§3.5 的位置约束列。

实测价值：加这道预筛后，Stage 3 的 `illSorted` rejection 从 11 降到 0（0 意味着溯因搜索不再产出 `T(affiliatedWith owl:inverseOf rdf:type)` 这类伪证据）。同样的检查放在写路径，就是「模型把属性当类用」的第一道拦截。

关键设计：**排序检查不依赖模型判断，也不依赖硬编码白名单**。签名（哪个常量是类、哪个是个体）从本体自身推导（POC 的 `buildSignature`），所以新增概念不需要改代码。

### 5.4 K2：提交前一致性关卡

AD-9 已有「自动裁决只在 `cardinality=single` 上成立」的逻辑，K2 与它分工不同：AD-9 判的是**两条断言是否冲突**（同 subj/pred、区间重叠、`obj_norm` 不同），K2 判的是**这批补丁加入后整个基是否仍然一致**。前者是局部的、后者是全局的。

实现上必须用克隆基，不能用真基试插入——否则一次失败的补丁会污染真基。POC 的 `withExtra` 就是这个语义：

```js
withExtra(extra) { const c = this.clone(); extra.forEach(f => c.addFact(f.rel, f.args, f.derived)); c.run(); return c; }
```

代价是每次提交多一次全量求值。这是可接受的：写路径不在热路径上（去抖 3s），而 dream 本来就在后台。但**必须设预算**：若补丁表大到手算不划算，退化为「只检查新增边牵涉到的规则」——牺牲完备性换时间，并在 `dream_log` 里记 `partial_check`。

### 5.5 K4：核收缩——这是 AGM 的工程妥协点

G3 要的机制在这里落地。AGM 的核收缩（kernel contraction）要求：给定要移除的信念 φ，找出所有「蕴含 φ 的极小集合」（kernel），从每个核里至少移除一条，且移除量最小。

OWL 2 / Datalog 的单调性让这件事变得可算：**核就是证明树里那一条路径上的前提集合**。POC 的 `proofTree` 已经给出它，缺的只是逆向删除策略。

三种增量维护策略的取舍（来自 d2b 的实测与文献）：

| 策略 | 实现难度 | 对递归健全 | 代价 |
| --- | --- | --- | --- |
| counting（计数） | 最易（`patchPayload` 原生支持 `$inc`） | **不健全** | 最低 |
| DRed（删除重推） | 中（纯逻辑，无额外结构） | 健全 | 中 |
| FBF（前向/后向） | 最贵（要反向索引） | 健全且最快 | 最高 |

FBF 在本项目里不可行：它需要为每条推导事实存「它被谁用到」的反向索引，而 `triviumdb` 里这只能是 `derived_from` 边，边数会翻数倍，而删边恰恰是最慢的路径（实测 `unlink` 比 `deleteManyAtomic` 慢 3.8 倍）。

**结论：非递归谓词用 counting，递归谓词用 DRed。** 判据是谓词是否出现在规则的递归依赖环里——这个可以在契约层静态算出（`strata()` 的 SCC 分解），不需要运行时判断。

**落地的执行序列（实测确定，见 `digests/d9c-suss-retract-verified.md`）**：每次变更后固定执行 `retract/add(Ta) → retractAll(Td) → retractAll(T) → evaluate`。不能指望 `evaluate` 自己清理：@suss/datalog 只在规则集**含否定**时自动收回旧推导，而 RL 的 78 条规则全是正向 Horn，恰好落进不清理的那一支。也不能用「清 `T`」来省事——`T` 混装断言与推导，清它会把断言基事实一起删光。这要求 schema 层把 `Ta`/`Td`/`T` 拆开（§3.5 的硬约束）。

代价钉成倍数：400 边链全闭包单次 35.56ms，加上显式清理重建 79.75ms（约 2.2×）。**这套写法是「每次变更付一次全闭包」，不是增量**，所以只能放在 dream 与写路径（去抖 3s），不能进 250ms 召回热路径——与 §5.7 的预算结论一致。

DRed 的落地形态（d3a 从 Lemmalog 源码核实的 `scoped_recompute`，`eval.rs:1047`）：撤销不是逐条删事实，而是**按 stratum 逐层清空受影响的推导，只在输入 key set 真变时重建**。Lemmalog 的评测里 1000 轮对话、220 次 supersession，knowledge updates 30/30 全对，1.5ms/turn。

这里必须记一条与 AGM 的差别：DRed 保证「结果与全量重算相同」（recompute-equivalence），**不保证「移除量最小」**（AGM 的 minimal change）。Lemmalog 自己也只承诺前者。因此本设计的主张是「AGM 的工程妥协」，不是「实现了 AGM」——这个措辞差别必须保留，否则会被当成错误声明。

### 5.6 收缩与证伪是两条不同的路径

这两件事都会「移除信念」，但触发条件与后果不同，必须分开：

| | 收缩（contraction） | 证伪（refutation） |
| --- | --- | --- |
| 触发 | 收到与既有信念矛盾的新证据 | 查询时发现加上命题会导致不一致 |
| 方向 | 从核里移除至少一条 | 不改基，只报结论 |
| 持久后果 | 有（`superseded` + `flag(refuted)`） | 无（只影响本次查询结果） |
| 依据 | AD-9 的三级裁决 + K4 | §4.2 的可满足性检查 |

混同两者会造成两类错误：把查询时的证伪写成持久删除（问一次就毁一条记忆），或把收缩当成查询结果（该改的不改，矛盾永远悬空）。

### 5.7 时间预算怎么叠加

新增检查点全部落在**非热路径**上，这是本设计能同时满足 C1 与 C3 的前提：

| 路径 | 现有预算 | 新增 | 合计 |
| --- | --- | --- | --- |
| 召回（热） | ①250ms + ②600ms + ③20ms，硬上限 1000ms | **0**（K1–K6 全部不在此路径） | 不变 |
| 写（去抖后） | 一次 LLM 11–13s + 事务 | K1 <1ms + K2 一次求值 | 可忽略 |
| dream（后台） | 每步独立预算、日 token 上限 | K4 的 DRed + K5/K6 | 需单独预算 |

K2 的求值成本随基规模增长，所以它需要一条明确的上限：**基超过 5 万条边时，K2 退化为局部检查**（只跑新增边牵涉的规则），并在 `dream_log` 记 `partial_check`。这个阈值是估计值，不是实测值，必须标注为待验证。

### 5.8 现有步骤里哪些必须改、哪些不能改

**必须改的只有一处**：① 确定性结算。它现在只处理「过期断言、依赖失效传播、待决承诺」，没有「收缩核」的概念。K4 要加进这一步，且必须仍在 `{store, clock, config}` 签名内、不注入 `llm`——AD-10 的 `no-llm.test.ts` 会拦住任何试图在这一步调模型的改动。

**不能改的**：①②⑥⑦ 不调 LLM 的禁令；每步独立提交 `dream_log` 的断点续跑；`dream_cycle:<date>` 一天一次的唯一索引；段边界让路的规则。这些是 AD-10 的承重结构，加检查点不能动摇它们。

**③ 的输出要扩一个字段**：模式提取现在产出「模式候选」，K5 要求它同时产出「契约候选」——即哪些反复出现的结构可能是该提升为契约的。这两者不该混在同一个 diff 里，因为模式候选会进断言层，契约候选不会（它只进待评审队列）。

### 5.9 管线不能更长：为什么不再加阶段

memory-layering 维度的调研有一个负面结论值得写进设计：**没找到任何系统在一条管线里同时做 LLM 摘要/聚类与规则校验/推理，并记录二者如何共处**；也没找到「管线过长导致失败」的一手复盘。

在无证据的情况下加阶段等于用猜测换复杂度。因此本设计的做法是**插入检查点而非新增阶段**：六个 K 全部挂在既有步骤的内部边界上，不产生新的一步、不产生新的 `dream_log` 阶段、不改变断点续跑的粒度。

可行的分工判据（推断，非文献结论）：统计式提炼**产出候选**，符号式校验**只做否决不做生成**。K1/K2 都是否决器，它们永远不新增断言、不修改内容、不参与排序——一旦让校验步骤开始「生成」，它就会慢慢变成第二套业务逻辑，而这是 d10 总结的最典型自伤（同一概念两份定义）。
## 6. 事实提升为契约的触发条件（验收 A1 ③）

### 6.1 先说清楚这一节改了用户给的判据

C4 原文的条件是三条同时满足：被多个系统争用、定义不一致、会导致生产故障。这三条判据本身是对的，但**在本项目的部署形态下几乎永不触发**，照搬会得到一个永远空转的机制。

理由有三：

1. **「多个系统争用」的前提是多个独立写入方**。DSH 是单进程单用户，写入方是代码模块（技能、工具适配器、插件），数量是个位数到十几个，且随代码发布**离散变化**。这意味着「第 N 个消费者出现」是可以在提交时静态查出来的，不需要运行时计数。
2. **「会导致生产故障」在单用户场景下形态不同**。它不是一个服务宕机，而是助手记错了。代价低、可当场纠正、且用户看得见。
3. **两个条件都依赖无法在写入热路径上增量维护的量**。d10 调研的全部真实系统（Generative Agents 的 150 阈值、MemGPT 的 70%/100% 水位、GraphRAG 的模块度、Confluent 的兼容性门禁）用的都是**单调可增量维护的量**。依赖分歧计数或人工复盘的判据没有一个进入过生产写入路径。

因此本设计把 C4 的三条**保留为最终评审的依据**，另加三条**可执行的前置判据**作为机器能判的部分。机器只标候选，人做决定。

### 6.2 三条前置判据（机器可判）

| 编号 | 判据 | 怎么判 | 为什么是这条 |
| --- | --- | --- | --- |
| **P1** | 至少 2 个独立代码路径断言同一概念 | 静态枚举写入方（技能/适配器/插件），不是运行时计数 | 单写方的概念提升为契约，只是把一份定义搬了个位置，没有获得任何一致性收益 |
| **P2** | 存在一个 <5ms 内能算完的确定性不变量检查 | 试写校验器并实测；算不完就不是不变量 | 这是防止契约层膨胀成「第二套业务逻辑」的唯一硬闸 |
| **P3** | 写错的代价 > 检查的代价 | 估算：错误会让召回给出**错误结论**（而非仅少召回一条） | 只影响召回数目的概念不值得付契约维护成本 |

**P2 是一票否决。** 不满足 P2 的概念一律不许进契约层，无论 P1/P3 多满足。这条闸门的意义在于：契约层只允许承载「结构合法」的判断，不允许承载「语义正确」的判断。结构判断（这个个体的类型是否与该属性的定义域相容）能 O(1) 算完；语义判断（这个人的职业是不是真的写对了）永远算不完，也不该由规则来算。

### 6.3 候选是怎么产生的（K5）

机器侧的动作只有一个：**在 dream ③ 模式提取之后，把重复出现的结构标为候选**，写进待评审队列。它不做三件事——不建契约、不修改断言、不影响召回。

候选的形态是一个结构化记录，不是自然语言建议：

```text
{
  candidateKind: "class" | "property",
  name:          提议的契约名（可空，由人填）,
  evidence:      [ 触发它的具体事实或断言 mem_key ],
  distinctWriters: [ 断言过它的代码路径标识 ],
  observedPositions: { 该概念在各处被当作什么用 }, 
  positionConflicts: [ 位置不一致的具体证据 ],
  invariantSketch: { 提议的不变量与实测耗时 },
  status:        "candidate" | "approved" | "rejected"
}
```

`positionConflicts` 是关键字段：它记录「这个常量在某处被当类、在某处被当个体」这类实际发生的建模不一致。**这才是「定义不一致」在单进程系统里的真实形态**——不是两个服务吵架，是同一个库里的位置矛盾被 POC 的 `atomWellSorted` 抓到了。

### 6.4 提升是人工动作（不是自动动作）

用户裁定的 `ceremony = manual` 与业界一致：Freebase 靠员工主观判断、OMOP 靠 Usagi/Perseus 人工映射、Confluent 只有写前兼容检查、dbt 明确说「过早引入会增加维护成本」。**没有任何系统把「提升为契约」做成全自动。**

因此流程是：K5 标候选 → 队列 → 人工评审（用 P1/P2/P3 逐条过）→ 批准后才写 `contract_axiom` → 契约变更走版本化与兼容性检查（照抄 Confluent 默认 BACKWARD）。

一个必须写清的边界：**批准之前，候选对运行时零影响**。它不参与推理、不参与召回、不参与校验。否则「候选」就变成了「影子契约」，同一概念会出现两份定义——这正是 d10 指出的 4 层以上系统最典型的自伤。

### 6.5 契约规模上限：10 个概念

用户裁定的 L2 层是「≤10 个概念的封闭不变量检查」。这个数字需要解释，否则会被当成任意值。

它是从三个约束取交集得到的：

| 约束 | 推出的上限 | 来源 |
| --- | --- | --- |
| 契约层失败是静默的（dead schema） | 越少越可审计 | d10 的过长分层代价 |
| 每次契约变更需要全量重推 | 变更频率 ∝ 概念数 | Oracle 增量推理只支持增加三元组 |
| SROIQ 全局限制每次写入都要检查 | 概念越多越接近过度工程 | OWL 2 规范的 simple property 限制 |

10 不是硬上限，是**超过它就应该重新审视 P1/P2/P3 是否被放宽了**的警报线。

### 6.6 契约层不做什么（C5 的显式排除）

C5 要求设计里显式标注并排除过度工程化。具体排除四项：

1. **不物化全库闭包**。GraphDB 自己都砍掉了全称类展开，理由是「即使这种无限展开是可能的⋯⋯得到的语句在查询求值时也无用」。
2. **不从不相交推 differentFrom**。GraphDB 把这条改成了「一致性检查」而非推导，理由是成员多的库不实用。
3. **不在查询期做任意类表达式推理**。RL 的 combined complexity 是 co-NP-complete，只有原子类表达式才 PTIME。契约层查询必须是 `?x rdf:type :C` 形式的原子查询。
4. **不对整层情景记忆施加 OWL**。情景记忆的量级（数万条叙事）与变动频率（每轮对话）决定了它只能是 Datalog 事实，不是公理。

这四项不是能力不足的妥协，是**有先例支持的主动选择**：Stardog 的 Stride 只支持七种公理，其余忽略；GraphDB 主动放弃语义完备性并写明理由；schema.org 明文拒绝做「世界的全局本体」。

### 6.7 熔断：什么时候该把契约降级回事实

提升有门槛，降级也必须有，否则契约层只增不减。三个降级信号（K6 检测）：

| 信号 | 判据 | 动作 |
| --- | --- | --- |
| 长期无实例 | 一个契约概念连续 N 个 dream cycle 没有新实例 | 标 `dead_schema`，进评审 |
| 不变量从不触发 | 校验器连续 N 次运行全部通过 | 要么判据太松（该收紧），要么它不重要（该删） |
| 频繁需要绕过 | 同一不变量反复被人工豁免 | 判据错了，不是数据错了 |

第二条尤其重要：**一个从不失败的不变量检查是零信息量的**。它可能仍然值得保留（防止未来出错），但必须被识别出来，否则契约层会积累一堆永远为真的断言，看起来在治理，实际什么也没做。

## 7. 验证证据

### 7.1 两个可跑脚本

| 脚本 | 证明什么 | 运行方式 |
| --- | --- | --- |
| `poc/poc-five-stage.mjs` | 五步召回语义在纯内存 Datalog 上成立（含一致性关卡、三值查询、溯因、部分证明树） | `node poc-five-stage.mjs` |
| `poc/poc-store-roundtrip.mjs` | 同一 KB 写入 triviumdb 再读回重推，结论与内存基逐条一致 | `node poc-store-roundtrip.mjs` |

依赖：`poc/datalog.mjs`（最小 Datalog 求值器）、`poc/owl-rl.mjs`（RL 规则子集）、`poc/store-triviumdb.mjs`（存储适配器）。零 npm 依赖，只用 `triviumdb` 与 Node 内置模块。

### 7.2 基与推理（实测）

```text
TBox 13 条 + ABox 10 条 → 求值后 facts 35、violations 0、rounds 3、0.975ms
签名：classes 5（Researcher/Person/Agent/Org/Place）
      props   6（affiliatedWith/bornIn/colleagueOf/knows/studentOf/teacherOf）
      indiv   6（alice/lab_a/bob/carol/dave/city_x）
```

签名是从本体自身推导出来的（`buildSignature`），不是手写白名单——这是 §5.3 说的「新增概念不需要改代码」。

### 7.3 三值查询（8 条，全部符合预期）

| 查询 | 结果 | 依据 |
| --- | --- | --- |
| `alice rdf:type Agent` | CERTAIN | 子类链 Researcher ⊑ Person ⊑ Agent |
| `alice rdf:type Place` | REFUTED | `cax-dw`：Researcher 与 Place 不相交 |
| `lab_a rdf:type Researcher` | REFUTED | `cax-dw`：lab_a 是 Org，Org 与 Researcher 不相交 |
| `carol rdf:type Agent` | CERTAIN | Person ⊑ Agent |
| `dave rdf:type Person` | CERTAIN | `prp-dom`：bornIn 定义域是 Person |
| `dave rdf:type Researcher` | POSSIBLE | 缺 affiliatedWith 观察 |
| `bob teacherOf carol` | POSSIBLE | 缺 studentOf 观察（inverseOf 未触发） |
| `alice knows carol` | CERTAIN | `prp-trp`：knows 传递（alice→bob→carol） |

三种状态都出现过，且**证伪的两条都来自 `cax-dw`**（类不相交）。这验证了 §4.3 的论断：证伪需要燃料，没有不相交公理时 `lab_a rdf:type Researcher` 会退化成 POSSIBLE。

### 7.4 一致性关卡（实测）

```text
加入 :alice rdf:type :Org（与 Researcher 不相交）
→ gate: VIOLATED
   rule: cax-dw
   support: [:Researcher owl:disjointWith :Org]
            [:alice rdf:type :Researcher]
            [:alice rdf:type :Org]
→ queryOnInconsistent: UNRELIABLE
```

关键点：**闸门给出的 support 不是日志字符串，是可以直接用于核收缩的三条前提**。这正是 §5.5 说的「核就是证明树那条路径上的前提集合」的具体形态。

### 7.5 溯因（两个案例，含 rejection 明细）

**案例一：`dave rdf:type Researcher`**

```text
rejected: { irrelevant 0, inconsistent 3, tooLarge 0,
            noEffect 0, illSorted 0, tboxGapOnly 66 }
count: 3
最优 delta: [:dave :affiliatedWith :lab_a]  size 1  via prp-dom
次优:      [:dave :affiliatedWith :carol]
          [:dave :affiliatedWith :city_x]
contractGaps: [:bornIn rdfs:domain :Researcher]  closesGoal true
contractGapCandidates: 66 → 收敛后 1
```

**案例二：`bob teacherOf carol`**

```text
rejected: { irrelevant 0, inconsistent 0, tooLarge 0,
            noEffect 0, illSorted 0, tboxGapOnly 18 }
count: 1
最优 delta: [:carol :studentOf :bob]  size 1  via prp-inv1
contractGaps: [:colleagueOf owl:inverseOf :teacherOf]  (prp-inv1)
            [:teacherOf owl:inverseOf :colleagueOf]  (prp-inv2)
```

两条 delta 的语义都对：给学生加一条 studentOf 就等价于给老师加一条 teacherOf（`prp-inv1`）。

四个 rejection 计数器值得单独解释，因为它们是「为什么不产生垃圾假设」的证据：

| 计数器 | 拦的是什么 | 实测 |
| --- | --- | --- |
| `illSorted` | 位置错乱的假设（把属性当类） | 修好后为 0；修好前是 11 / 29 |
| `inconsistent` | 加上会导致不一致的假设 | 3（dave 案例） |
| `irrelevant` | 把目标本身当假设（Klarman 相关性条件禁止） | 0 |
| `tboxGapOnly` | 只因缺 TBox 公理才成立的假设 | 66 / 18 |

`irrelevant` 为 0 是修出来的，不是天生：早期版本无条件把目标本身放进 delta，等于用「假设 dave 是 Researcher」证明「dave 是 Researcher」。

### 7.6 部分证明树（三个案例，覆盖三态）

```text
CONDITIONAL  :dave rdf:type :Researcher
  proved :affiliatedWith rdfs:domain :Researcher
  assumed :dave :affiliatedWith :lab_a
  cutFrontier []

PROVED       :dave rdf:type :Person          frontier 0
PROVED       :alice rdf:type :Agent          frontier 0
PROVED       :alice :knows :carol            frontier 0

GAP          :dave rdf:type :Place
  frontier: [{ goal: :bornIn rdfs:domain :Place,
               reason: contract-gap }]
```

`CONDITIONAL` 那条是 §4.5 评分函数的直接结果：`assumed` 里恰好只有一条，且**就是 Stage 3 给出的最优 delta**。如果评分函数没有 `+1000` 偏置，这里会展开一条与 delta 无关的分支，读者会误以为 delta 补不上这个缺口。

`GAP` 那条更重要：它没有把「查不到」报成「假」，而是报成 `contract-gap`——缺的是 `bornIn rdfs:domain Place` 这条公理，补观察永远补不上。这就是 §2.2 的两类缺口在运行时的样子。

### 7.7 函数属性与 sameAs（实测）

```text
加入 :alice :affiliatedWith :lab_b（affiliatedWith 是 FunctionalProperty）
→ violations 0（未触发 eq-diff1，因为没声明 lab_a 与 lab_b 不同）
→ sameAs: true（lab_a owl:sameAs lab_b，由 prp-fp 推出）
→ lab_a rdf:type Researcher: REFUTED
```

这条验证了一个反直觉的机制：**RL 的 max-1 基数是通过推 `owl:sameAs` 实现的（`cls-maxc2`），不是靠失败**。函数属性不会直接产生矛盾，它产生等价；矛盾要等到 `eq-diff1` 撞上显式的 `differentFrom` 才出现。这决定了 §4.3 表里「函数属性 + 两个不同填充者」必须写成**两个条件**，缺一不可。

### 7.8 存储往返（C2 的直接证据）

```text
write      : axioms 23 → storeWrites 43 → 32.9ms → 6422 bytes
readBack   : nodes 20 → triples 23 (expected 23) → 15.6ms
divergence : 0
roles      : classes 5 / properties 6 / individuals 6 / metaclasses 3
```

读回后重推的八条查询答案与内存基**逐条相同**，gate 均 CONSISTENT，violations 均 0，签名完全一致。

这条证据的意义：23 条公理落盘 6.4KB，重开后**只用公共图 API 读回**（`indexedLookup` + `getEdges` + `metadata.predicate`），没有任何旁路或缓存，重推结果分歧为 0。这就是 G1 要的「存储天然承载 TBox/ABox」——不是「能存」，是「存进去再读出来，语义不变」。

### 7.9 五步合并（C3 的有界性）

```text
coarseCount      : 29      （粗召工作集）
injectionBudget  : 5       （AD-8 topK 默认）
hardCap          : 8       （AD-8 硬上限）
sampleFirst      : :alice rdf:type :Researcher
                   :alice :affiliatedWith :lab_a
                   :alice :knows :bob
                   :alice rdf:type :Person
```

29 条内部工作集 → 5 条注入。**粗召的「几百条」与 AD-8 的「topK 5」不冲突**：前者是推理层的工作集，后者是交给宿主的注入量，中间隔着第 ⑤ 步的合并与裁剪。C3 在 POC 里就是这个形态。

### 7.10 证据的边界（这些数字不能推到哪里）

| 已证明 | **未**证明 |
| --- | --- |
| 五步语义可在最小引擎上跑通 | 生产规模（10 万条边）下的延迟 |
| 存储往返零分歧 | 真实 triviumdb 事务并发下的表现 |
| 三值判定与一致性关卡正确 | 与真实 LLM 抽取产出的补丁表对接 |
| 溯因能收敛到 1 条真缺口 | 溯因在全部 78 条 RL 规则下（POC 只实现 15 条）的搜索成本 |
| 证明树三态可区分 | 递归谓词上的证明树规模（受 provenance 不可能性限制，见 §9.2） |

## 8. 对现有架构决策的修订建议

本设计不推翻现有 AD，只提出五条增量修订。每条都标出：改什么、为什么、不改的后果。

### 8.1 AD-8（召回有界）——不改预算，改「内部工作集」的表述

**现状**：topK 默认 5、硬上限 8、三段预算 250/600/20ms、硬上限 1000ms、召回路径禁止写。

**建议补充一句**：召回的第一段（250ms 候选）允许内部工作集远大于 8（实测 29，可到数百），因为它是推理层的输入，不是注入量。注入量仍由第三段裁剪到 ≤5。

**理由**：C3 已确认这个区分，但现有 AD-8 的措辞容易被读成「候选也不能超过 8」，从而错误地压缩粗召覆盖面，使第 ②–④ 步没有足够材料做证明。

### 8.2 AD-9（自动裁决）——补「提交前一致性关卡」

**现状**：自动裁决只在 `cardinality=single` 上成立，判两条断言是否冲突。

**建议补充**：新增 K2，在事务提交前于克隆基上跑一次 RL 求值，出现 false 头则整批拒收。AD-9 是局部判决，K2 是全局判决，两者不是替代关系。

**理由**：局部无冲突不等于全局一致。三条各自合法的断言合起来可能违反类不相交（POC 的 `cax-dw` 案例就是三条合法断言构成的矛盾）。

### 8.3 新增 AD：契约层准入

**内容**：把 §6 的 P1/P2/P3 与「人工评审 + 版本化 + 兼容性检查」写成一条架构决策。要点：

1. 契约层概念数上限 10（超线即复盘）。
2. **P2 一票否决**：没有 <5ms 可判定的结构性不变量，不许进契约层。
3. 提升是人工动作，机器只标候选；候选对运行时零影响。
4. 契约变更版本化，默认 BACKWARD 兼容（照 Confluent）。
5. 契约层只做否决，不做生成。

**理由**：这是 C4/C5 的可执行形态。没有这条 AD，「契约层」会成为一个谁都可以往里放东西的容器。

### 8.4 新增 AD：证明四列

**内容**：所有推导产生的边必须带 `origin` / `rule_id` / `justification_id` / `depth` 四列。

**理由**：缺任何一列，证明链就断（详见 §3.6）。这一条必须在写入路径实现时一次做对——事后补列意味着全部历史推导无法溯源，而推导事实是不存历史的。

**代价**：边 metadata 没有二级索引（§3.7），按这四列过滤只能遍历。缓解见 §3.8。

### 8.5 AD-10（dream 8 步）——插入六个检查点，不改顺序

**建议**：明确 K1–K6 的挂载位置（§5.2 的表），并确认三件不改的事：①①②⑥⑦ 不调 LLM 的禁令不变；②每步独立提交 `dream_log` 的断点续跑粒度不变；③不新增阶段。

**唯一需要实际改代码的**：①确定性结算里加入 K4（收缩核）。它必须仍在 `{store, clock, config}` 签名内，不注入 `llm`。

### 8.6 一条不建议现在做的（记录在案）

**不建议现在自研 Datalog 引擎**。d9b 的结论是：现成引擎（@suss/datalog）可用且有 absence 叶子这一关键能力，自研的现实成本不是「写一版能跑的」（1.5k–2.5k 行就够），而是「写一版能信任的」——终止性、聚合非单调、索引、DRed、provenance 不可能性，每项都能静默出错。

但必须同时记录 suss 的三个静默错误（§9.3），它们是使用约束而不是否决理由。

## 9. 未验证项与诚实标注

### 9.1 未做的实验

1. **Windows + napi-rs 编译验证未做**：本机无 Rust 工具链（`cargo`/`rustc`/`rustup` 全部不可用），「把 lemmalog 编译成 .node」这个关键实验无法在本机进行。
2. **@suss/datalog 未接入 POC**：POC 用的是自写的 200 行最小求值器（`datalog.mjs`），它够证明语义，但不具备 suss 的增量与 provenance 能力。生产实现要换成 suss 并重跑 §7 的全部断言。
3. **生产规模未测**：所有延迟数字都在 35 条事实的基上取得。类层级实测（232.77ms @ 10k 类）是单独探针的结果，不在 POC 内。
4. **与真实 LLM 抽取未对接**：POC 的补丁是手写的，没有验证过 LLM 产出的补丁表在 K1/K2 下的拒收率。这个数字对 K1/K2 的阈值设定至关重要，但目前是空的。
5. **POC 只实现了 78 条 RL 规则中的 15 条**：scm-sco、cax-sco、prp-dom、prp-rng、prp-inv1、prp-inv2、prp-symp、prp-trp、prp-fp、eq-sym、eq-trans、eq-diff1、cax-dw、prp-irp、prp-asyp。选的是「能演示五步语义」的最小集（含 3 条 false 头：eq-diff1、cax-dw、prp-irp）。未实现的 63 条里包括 `cls-int1`/`cls-uni`/`cls-svf1`（类表达式）、`prp-spo2`（属性链）、`prp-key`（hasKey）、`eq-rep-*`（等价替换）——**属性链与同一性替换是组合爆炸的主要来源，它们没被覆盖意味着性能结论不能外推到全规则集**。

### 9.2 已知的理论限制（不是实现不足）

| 限制 | 出处 | 后果 |
| --- | --- | --- |
| 有否定/差集时，完整 provenance 不可能 | `arXiv:1105.2255` | 只能承诺 first witness + 缺口，不能承诺「每条结论的完整依据」 |
| RL 的 combined complexity 是 co-NP-complete | W3C OWL 2 Profiles Table 10 | 契约层查询必须限定原子类表达式，禁止运行时构造任意类表达式 |
| DL 的 CQ 回答可判定性是 open | 同上 | 不能承诺用 DL 做查询期推理 |
| EL 的 abduction 复杂度是 open（下界未研究） | `arXiv:2205.08449` | 不能承诺「找到最小 delta」，只能三限（\|Δ\|≤k、signature 限定、深度限定） |
| 通用 ALC 上 ABox abduction 半可判定 | Klarman/Endriss/Schlobach JAR 2011 | 必须用 signature-based 约束换可判定性 |
| 递归 Datalog 的 why-provenance 不可处理 | Calautti et al. PACMMOD 2024 | 递归部分每次现算 + 深度上限，不全量物化 |
| SROIQ 的 simple property 是全局性质 | OWL 2 规范 | Max/Min/Exact 基数只能作用于 simple property；每次写入都要查 = 过度工程化 |

### 9.3 现成组件的已知缺陷（使用约束）

**@suss/datalog 0.40.1 的三个行为陷阱**（本人亲测复现，见 `digests/d9c-suss-retract-verified.md`；d9b 的原始措辞已在此更正）：

1. **自动纠错只在规则集含否定时发生。** 类型定义原文：「When a rule set uses negation, a new fact can invalidate an old conclusion, so evaluation calls this to remove what it derived last time.」实测：含 `notLit` 的规则集撤掉基事实后单次 `evaluate` 结果正确；**纯正向规则集则完全不清，旧推导原样留存，且无任何报错**。OWL 2 RL 的 78 条规则全是正向 Horn（d8），所以把 RL 直接交给它时**恰好落进不会纠错的那一支**。上游文档「With retract, the next run would start again from the base facts」描述的是含否定时的行为。
2. **RL 规范里那个单一三元谓词 `T` 无法安全清理。** 断言与推导混在同一关系里，两条路都堵死：不清则陈旧（撤掉 `Researcher⊑Person` 后 `Researcher⊑Agent` 仍留着），用 `retractAll("T")` 清则**连 3 条断言基事实一起删光**。必须拆成 `Ta`（断言）/ `Td`（推导）/ `T = Ta ∪ Td`——见 §3.5 的 schema 硬约束。拆开后实测与全量重建逐条一致。
3. **不开 `witnesses` 代数拿不到可用证明。** `proofOf` 返回 `{kind:"absence"}` 的真实语义是「该事实没有见证」，不是「该事实不存在」；而第 4、5 步正是靠 `absence` 叶子区分真缺口与查不到。所以 `evaluate` 必须带 `witnesses`。另注：证明子节点的字段名是 `premises` 不是 `body`。

**被否决的「聪明」写法**：给正向规则集塞一条永不命中的否定文字（negation tripwire）确实能换来自动纠错，但会给每条证明塞假 `ABSENCE` 叶子（实测纯正向 0 个、tripwire 2 个），并且只要有人误写一条 tripwire 事实就会让所有推导静默清空。**宁可多写一次 `retractAll`。** 性能上也不划算：400 边链三次中位数，纯正向 35.56ms vs tripwire 48.22ms（+35.6%）。

**Cozo 被排除的理由**：索引早于数据创建 + 查询在索引列外还绑定其它列 → 静默返回 0 行，100 条规模即可复现，re-put 不能修复；主仓 2024-12 停更。它返回的「没有匹配」与「真的没有匹配」在调用方看来完全相同。

### 9.4 与业界现状的偏离（需要知情的三个）

1. **没有生产系统在查询期跑 OWL 2 DL**（d3b 的核心结论）。本设计的契约层用 RL 而非 DL，与业界一致而非落后。
2. **没有任何系统记录过定量的提升触发条件**（d10）。§6 的 P1/P2/P3 是**自研判据**，无先例背书，必须在实现后按实际数据校准。
3. **没找到「整层本体化后失败并公开复盘」的一手事例**。Cyc 与 schema.org 的自我约束是事前声明，不是事后复盘。**这应视为「未证实」而非「不存在」**——不能因为找不到反例就认为风险为零。

### 9.5 一句话总结

这套设计把 OWL 2 从「推理引擎」降为「语法来源与一致性判据」，把推理交给 Datalog 内核，把证明交给求值 trace，把不确定性交给三值判定与缺口报告。**它不承诺 AGM 意义上的最小变更，只承诺可重算等价（DRed）与可解释的缺口**——这个措辞差别是本设计的诚实边界。
