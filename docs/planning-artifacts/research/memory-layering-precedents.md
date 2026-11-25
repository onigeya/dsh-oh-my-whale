# Agent 记忆的分层结构与提炼管线——真实先例（交付）

## 0. 方法与检索预算

- 检索 11 次（预算 15），独立来源 12 个（预算 12）。
- **web_search 实测不可用**：一次调用即 SEARCH_FAIL: tool call timed out after 60000ms。全程改 pwsh + Invoke-WebRequest 直连 arXiv API / ar5iv 全文 / W3C / 官方文档页。
- Crossref API 返回 429；doi.org/api/handles SSL 失败；CLS 原始论文改用 PubMed E-utilities 核实成功。
- 被拒/无正文来源（列出以免重复踩坑）：SweetTools/SWEET wiki（空正文）、gocardless.com/blog/data-contracts/（404）、confluence.ihtsdotools.org（SSL 失败）、docs.snomed.org/specifications/SNOMED-CT-OWL（空正文）。
- HippoRAG 2405.14831 只核实到元数据（v3, 2024-05-23, updated 2025-01-14），未取到可支撑分层的正文，**未计入 12 个来源**。

统一标注：claim | source | publisher | pub_date | accessed=2026-11-25 | confidence | class

---

## 1. 真实系统里的记忆分层

### 1.1 认知架构侧：CLS（分层动机，非工程先例）

- 大脑有两个互补学习系统：海马体快速学单个情景，新皮层慢速学统计结构，避免新知识覆写旧结构 | 10.1037/0033-295X.102.3.419 (PMID 7624455) | American Psychological Association / Psychological Review 102(3):419-457 | 1995-07 | 2026-11-25 | high | 论文
- 摘要原文：“memories are first stored via synaptic changes in the hippocampal system, that these changes support reinstatement of recent memories in the neocortex, that neocortical synapses change a little on each reinstatement, and that remote memory is based on accumulated neocortical changes” | 同上 | 同上 | 同上 | 2026-11-25 | high | 论文
- 摘要原文：“The hippocampal system permits rapid learning of new items without disrupting this structure, and reinstatement of new memories interleaves them with others to integrate them into structured neocortical memory systems” | 同上 | 同上 | 同上 | 2026-11-25 | high | 论文
- CLS 给的层间流转机制是 **reinstatement（重放/复现）**：新记忆被反复重放，每次重放只在皮层留下微小变化，累积成结构。它**没有**给出「什么条件下一条记忆升级到语义层」的判据 | 同上 | 同上 | 同上 | 2026-11-25 | high | 论文

我推断（标推断，非原文）：CLS 对我们的真正价值不是「分层」这个结论，而是它把**两层分开的理由**说清楚了——单层统一学习率必然二选一：要么学得慢（保结构、丢近期），要么学得快（保近期、毁结构）。这正好是 DSH 的事实层（高频写、高频改）与契约层（极少改动）必须分开的理由，而不是审美理由。

### 1.2 Agent 侧

**Generative Agents（两层）**
- 分层为 memory stream（全部观察、计划、反思的平铺流）+ reflection（反思节点，本身也是 memory，参与后续检索）| https://arxiv.org/abs/2304.03442 | arXiv（Stanford/Google） | v2 2023-08-06（v1 2023-04-07） | 2026-11-25 | high | 论文
- 写入规则：每条 observation/plan/reflection 在**创建时同步**打 importance（LLM 按 poignancy 提示词给 1-10 整数）| 同上 | 同上 | 同上 | 2026-11-25 | high | 论文
- 层间流转：反思由 memory stream 生成，生成后**回写 memory stream**，与普通记忆同层竞争检索 | 同上 | 同上 | 同上 | 2026-11-25 | high | 论文
- **升级条件写得很明确**（原文）：“Reflections are generated periodically; in our implementation, we generate reflections when the sum of the importance scores for the latest events perceived by the agents exceeds a threshold (150 in our implementation). In practice, our agents reflected roughly two or three times a day.” | 同上 | 同上 | 同上 | 2026-11-25 | high | 论文
- 反思输入窗口 = 最近 100 条记录；检索打分 score = α_recency·recency + α_importance·importance + α_relevance·relevance，recency 指数衰减 decay=0.995，三项 min-max 归一化 | 同上 | 同上 | 同上 | 2026-11-25 | high | 论文

**MemGPT / Letta（两层，OS 隐喻）**
- 分层：main context（system instructions + working context + FIFO queue）vs external context（archival storage + recall storage）| https://arxiv.org/abs/2310.08560 | arXiv（UC Berkeley Sky Computing） | v2 2024-02-12（v1 2023-10-12） | 2026-11-25 | high | 论文
- **升级/降级条件 = token 压力**（原文）：“When the prompt tokens exceed the 'warning token count' of the underlying LLM's context window (e.g., 70% of the context window), the queue manager inserts a system message into the queue warning the LLM of an impending queue eviction (a 'memory pressure' warning)” | 同上 | 同上 | 同上 | 2026-11-25 | high | 论文
- 超过 'flush token count'（e.g. 100%）时 flush 队列、驱逐约 50% 上下文，用旧 recursive summary 生成新 summary | 同上 | 同上 | 同上 | 2026-11-25 | high | 论文
- 层间迁移通过 LLM function call 完成（request_heartbeat=true 支持链式调用）| 同上 | 同上 | 同上 | 2026-11-25 | high | 论文

**Zep / Graphiti（三层子图）**
- 原文：“This graph comprises three hierarchical tiers of subgraphs: an episode subgraph, a semantic entity subgraph, and a community subgraph.” | https://arxiv.org/abs/2501.13956 | arXiv（Zep AI） | v1 2025-01-20 | 2026-11-25 | high | 论文
- Episode 层写入规则原文：“raw input data in the form of messages, text, or JSON. Episodes serve as a non-lossy data store from which semantic entities and relations are extracted.”（**无损**，只追加）| 同上 | 同上 | 同上 | 2026-11-25 | high | 论文
- Community 层原文：“clusters of strongly connected entities... high-level summarizations”（**有损**，聚合）| 同上 | 同上 | 同上 | 2026-11-25 | high | 论文
- 双时间轴：timeline T（事件时间）与 T'（摄入事务时间）；边失效由 2.2.3 “Temporal Extraction and Edge Invalidation” 用 t_ref 抽绝对/相对时间戳实现 | 同上 | 同上 | 同上 | 2026-11-25 | high | 论文
- 写入期的去重约束原文：“The hybrid search for relevant edges is constrained to edges existing between the same entity pairs as the proposed new edge”（把 O(n²) 降为按实体对局部搜索——**这是控制管线成本的工程手段**）| 同上 | 同上 | 同上 | 2026-11-25 | high | 论文
- 血统自述：“from episodes to facts to entities to communities”，社区层明确借鉴 GraphRAG | 同上 | 同上 | 同上 | 2026-11-25 | high | 论文

**GraphRAG（社区摘要层，多级但单一轴）**
- 索引期管线：源文档→文本块（3197 个 600-token chunk，100-token overlap，约 170 万 token）→LLM 抽实体/关系/claims→Leiden 社区检测→逐层社区摘要（C0 root → C1/C2/C3）| https://arxiv.org/abs/2404.16130 | arXiv（Microsoft Research） | v2 2025-02-19（v1 2024-04-24） | 2026-11-25 | high | 论文
- Level 0 = 最大模块度的层次划分；查询期对社区摘要做 map-reduce | 同上 | 同上 | 同上 | 2026-11-25 | high | 论文
- **分层依据 = 图的模块度结构**（结构驱动），原文：“recursively creates increasingly global summaries by using the LLM”。**不是**按消费者数量、不是按定义分歧次数 | 同上 | 同上 | 同上 | 2026-11-25 | high | 论文

**Mem0（两阶段，最接近我们要的「管线」）**
- 原文：“the complete pipeline architecture consists of two phases: extraction and update” | https://arxiv.org/abs/2504.19413 | arXiv（Mem0 / UCSD 等） | v1 2025-04-28 | 2026-11-25 | high | 论文
- extraction 在新消息对 (m_{t-1}, m_t) 摄入时触发——**同步、每轮都跑** | 同上 | 同上 | 同上 | 2026-11-25 | high | 论文
- update 由 LLM tool call 四选一（原文）：“ADD for creation of new memories when no semantically equivalent memory exists; UPDATE for augmentation of existing memories with complementary information; DELETE for removal of memories contradicted by new information; and NOOP when the candidate fact requires no modification to the knowledge base.” | 同上 | 同上 | 同上 | 2026-11-25 | high | 论文
- → 有显式 supersede / contradict 语义，但**完全没有「提升到契约层」的概念**。记忆是平的，所有记忆同等对待 | 同上 | 同上 | 同上 | 2026-11-25 | high | 论文

**Letta 后台巩固（只取到片段）**
- 原文（片段）：“Dreaming uses background subagents to review recent conversations, consolidate useful lessons, and update memory without interrupting your active work”；触发条件 “after a set number of completed agent steps or when the context window is compacted” | https://docs.letta.com | Letta | 无固定 pub_date（living doc） | 2026-11-25 | med | 工程文档
- 可选开启 “Agent reviews before applying”——即二次后台审阅，代价是更耗 token 且不询问用户 | 同上 | 同上 | 同上 | 2026-11-25 | med | 工程文档

### 1.3 数据库侧：medallion architecture

- 原文：“The terms bronze (raw), silver (validated), and gold (enriched) describe the quality of the data in each of these layers.” | https://docs.databricks.com/aws/en/lakehouse/medallion | Databricks | 无固定 pub_date（living doc） | 2026-11-25 | high | 工程文档
- 原文：“Its goal is to incrementally and progressively improve the structure and quality of data as it flows through each layer” | 同上 | 同上 | 同上 | 2026-11-25 | high | 工程文档
- 层职责（表格原文）：Bronze = Raw data ingestion；Silver = Data cleaned, filtered, validated；Gold = Business-level aggregates | 同上 | 同上 | 同上 | 2026-11-25 | high | 工程文档
- 原文：“Following the medallion architecture is a recommended best practice but not a requirement.” | 同上 | 同上 | 同上 | 2026-11-25 | high | 工程文档
- **关键负面事实**：medallion 是三层，但**通篇没有任何量化升级门槛**——“数据够干净了”由人判断，不由规则判定。它给的是层职责约定，不是提升判据 | 同上 | 同上 | 同上 | 2026-11-25 | high | 工程文档

### 1.4 语义侧：schema registry（唯一有机器可判定门槛的先例）

- 原文：“Schema Registry enforces compatibility by comparing new schema versions against previous versions using configurable compatibility types” | https://docs.confluent.io/platform/current/schema-registry/fundamentals/avro.html | Confluent | 无固定 pub_date（living doc） | 2026-11-25 | high | 工程文档
- 四类兼容级别：Backward / Forward / Full / Transitive；Transitive 原文 “compatibility checked against all previous versions, not just the last one” | 同上 | 同上 | 同上 | 2026-11-25 | high | 工程文档
- 原文：“The default compatibility mode is BACKWARD” | 同上 | 同上 | 同上 | 2026-11-25 | high | 工程文档
- 原文：“When a schema is updated, Schema Registry checks compatibility before accepting the new version”——**同步门禁，机器可判定，拒绝即发布失败** | 同上 | 同上 | 同上 | 2026-11-25 | high | 工程文档

这是我在全部检索里找到的**唯一一个「契约变更的形式化门槛」真实工程先例**。注意它的门槛是：*兼容性可判定性*，不是「被几个消费者用了」。

### 1.5 规范侧的两条自我约束（用于第 4 节）

- OWL 2 RL 定位原文：“OWL 2 RL is aimed at applications that require scalable reasoning without sacrificing too much expressive power... OWL 2 RL reasoning systems can be implemented using rule-based reasoning engines.” | https://www.w3.org/TR/owl2-profiles/ | W3C (Recommendation) | 2012-12（OWL 2 系列 REC；本次抓取正文片段未含日期行，日期取自 REC 属性） | 2026-11-25 | high（文本）/ med（日期） | 规范
- RL 缩写原文：“The RL acronym reflects the fact that reasoning in this profile can be implemented using a standard Rule Language.” | 同上 | 同上 | 同上 | 2026-11-25 | high | 规范
- 复杂度实测文本：“OWL 2 RL Ontology Consistency PTIME-complete”；Class Expression Satisfiability / Subsumption / Instance Checking 均 PTIME-complete；相对地完整 OWL 2 Direct Semantics 一致性为 N2EXPTIME-complete | 同上 | 同上 | 同上 | 2026-11-25 | high | 规范
- schema.org 自我限定原文：“The type hierarchy presented on this site is not intended to be a 'global ontology' of the world.” | https://schema.org/docs/datamodel.html | schema.org | 无固定 pub_date（living doc） | 2026-11-25 | high | 规范
- schema.org 放宽严格性的理由原文：“The decision to allow multiple domains and ranges was purely pragmatic. While the computational properties of systems with a single domain and range are easier to understand, in practice, this forces the creation of a lot of artificial types” | 同上 | 同上 | 同上 | 2026-11-25 | high | 规范

---

## 2. 提升（promotion）的触发条件——核心负面结论

### 2.1 直接回答

**没找到。**

我在 12 个一手来源里逐字检索，**没有任何一个系统或规范写出过**以下三类触发条件中的任何一类：

- 「某概念被第 N 个消费者引用」→ 没找到
- 「同一概念出现第 M 次定义分歧」→ 没找到
- 「发生过一次生产事故后补上契约」→ 没找到（Confluent 的兼容性门禁是**事前**强制，没有「事故驱动」的措辞）

这个负面结论很重要：**这条规则要我们自己定，没有先例可抄。** 而且找不到不是检索不足——从机制上说得通：上述三类条件都需要「多个独立写入方 + 可统计的分歧计数」这项能力，而我们检索到的系统里，**没有一个具备这个概念**（Graphiti 有 dedup 但没有分歧计数；Mem0 有 ADD/UPDATE/DELETE 但没有版本化定义；medallion 靠人工判断）。

### 2.2 真实系统里实际存在的、可类比的「升级触发条件」（4 类，全部可引用）

| 触发机制 | 原文措辞 | 系统 | 性质 |
|---|---|---|---|
| **累积重要性阈值** | “when the sum of the importance scores for the latest events perceived by the agents exceeds a threshold (150 in our implementation)” | Generative Agents | 单调累加计数器，写入时递增，触发后清零 |
| **容量压力阈值** | “When the prompt tokens exceed the 'warning token count'... (e.g., 70% of the context window)” | MemGPT | 资源水位，与语义无关 |
| **图结构（模块度）** | Leiden 社区检测，Level 0 = 最大模块度划分 | GraphRAG / Zep | 结构涌现，非计数 |
| **契约兼容性门禁** | “checks compatibility before accepting the new version”；默认 BACKWARD | Confluent Schema Registry | 机器可判定的准入检查 |

**这四种有一个共同点，我认为是本次研究最重要的发现**：它们全部是**在写入时或离线批处理时可由机器单调判定的量**——一个累加分数、一个字节水位、一个图划分、一次 schema 兼容比较。没有一个是「依赖历史分歧统计」或「依赖人工事故复盘」的。

我推断：提升触发条件之所以在工业界长成这样，是因为**只有单调、可增量维护的量才能放进写入热路径**；「第 M 次分歧」需要全量扫描定义历史，「事故后补」需要人的判断——二者都无法自动化，所以成熟系统干脆不做自动提升，改为人工评审（Confluent 的 schema change review 是流程，不是算法）。

### 2.3 我们的三条件规则（多消费者 + 定义不一致 + 已致故障）在真实世界的定位

我判断：**这是一条多租户/企业数据平台规则，不是单用户 Agent 规则。** 依据：

- 「被多个系统争用」的前提是存在多个独立写入方。DSH 是单进程单用户，写入方是**代码模块**（技能、工具适配器、插件），不是组织。数量级是个位数到十几个，且随代码发布离散变化——「第 N 个消费者」在这里可以静态查出来，不需要运行时计数。
- 「定义不一致导致生产故障」的前提是有生产。单用户场景下故障形态是「助手记错了」，代价低、可当场纠正，不构成契约化的经济理由。
- 因此：**如果照搬三条件规则，在 DSH 里它几乎永不触发**；如果据此建一整层 OWL，就是在为零次提升建基础设施。

---

## 3. 提炼管线（refinement pipeline）

### 3.1 阶段划分（真实系统）

| 系统 | 同步（写入时） | 异步（后台/离线） | 二者如何共处 |
|---|---|---|---|
| Mem0 | extraction（每轮新消息对触发）、update 的 ADD/UPDATE/DELETE/NOOP 判定 | 无明确异步阶段 | —— |
| Generative Agents | importance 打分（创建时） | reflection（阈值 150 触发，实际每天 2-3 次）；planning 亦为周期性 | 异步产物**回写同一 memory stream**，与同步产物同层同构，不分表 |
| MemGPT | LLM function call 触发的显式迁移 | 队列 flush / recursive summary（token 压力触发） | 同一存储，靠容量水位切换 |
| GraphRAG | 无（纯离线索引） | 全流程离线：分块→抽取→Leiden→摘要 | 索引与查询彻底分离（map-reduce 在查询期） |
| Zep/Graphiti | episode 追加（无损） | 实体/边抽取、社区摘要 | 双时间轴 T/T' 让异步滞后可被解释 |
| Letta | 正常对话 | background subagents 巩固；可开二次审阅 | 后台不阻塞前台 |

### 3.2 有没有系统在同一管线里既做统计式提炼又做符号式验证？

**部分有，但都不是我们想的那种「同层共存」。**

- GraphRAG 是**统计式**（LLM 抽 + 社区聚类 + 摘要），无符号验证，无校验环节——抽取质量靠 LLM 自评，不靠规则。
- Confluent Schema Registry 是**符号式**（兼容性算法），但它是**旁路门禁**，不在提炼管线里，只拦 schema 变更。
- GraphDB 是**符号式**（前向链规则），但它不做统计提炼。
- **没找到任何系统在一条管线里同时做「LLM 摘要/聚类」和「规则校验/推理」并记录二者如何共处。** 这是第二个负面结论。

我推断（非原文）：这正是我们要自创的部分。可行分工是——统计式提炼**产出候选**，符号式校验**只做否决、不做生成**（它是 assert 之前的 guard，不是 assert 的同级步骤）。理由：符号校验器的强项是「可判定、可解释、快」，弱项是没有生成能力；让它只回答 yes/no 就不必承担它做不到的事。

### 3.3 管线过长而失败的公开教训

**没找到可引用的「管线过长导致失败」的一手复盘。** 只有间接但方向一致的证据：

- GraphDB 自述 total materialization 的代价：“the repository uses configured rulesets to compute all inferred statements at load time. To some extent, this process increases the processing cost and time taken to load a repository with a large amount of data.” | https://graphdb.ontotext.com/documentation/11.0/reasoning.html | Ontotext | 无固定 pub_date（living doc） | 2026-11-25 | high | 工程文档
- GraphDB **主动裁掉**不划算的规则（这是最接近「教训」的原文）：全称类展开 “Not supported. Even if this infinite expansion were possible in a forward chaining rule-based implementation, the resulting statements are of no use during query evaluation.”；由 disjoint 推 owl:differentFrom “Impractical for knowledge bases with many members of pairs of disjoint classes such as Wordnet. Instead, this is implemented as a consistency check” | 同上 | 同上 | 同上 | 2026-11-25 | high | 工程文档
- GraphDB 文档把 “Retraction of assertions”、“Provenance”、“Reinferring” 列为正式章节 → 成熟 RDF 引擎把撤销/重推/溯源当一等公民，而非事后补救 | 同上 | 同上 | 同上 | 2026-11-25 | high | 工程文档

**推断**：GraphDB 那两条「主动放弃」是本次最可直接借用的工程判断——**连专门做推理的商业引擎都认为「把闭包全算出来」有两类规则不值得跑**。如果 DSH 的契约层要做推理，必须预设「哪些规则我们不跑」并写进文档，否则性能预算必然破。

---

## 4. 反例：过度分层与过度本体化

**没找到可引用的「整层本体化后失败并公开复盘」的一手事例。** 检索到的只有规范方与产品方的**事前自我约束**，不是事后复盘：

- schema.org 明确否认自己是全局本体：“The type hierarchy presented on this site is not intended to be a 'global ontology' of the world.” | https://schema.org/docs/datamodel.html | schema.org | living doc | 2026-11-25 | high | 规范
- schema.org 承认为了实用性放弃了更严约束（单一 domain/range 让计算性质更好懂，但会逼出大量人造类型）| 同上 | 同上 | 同上 | 2026-11-25 | high | 规范
- GraphDB 主动裁规则（见 3.3）| 同上 | 同上 | 同上 | 2026-11-25 | high | 工程文档
- medallion 明确标注「推荐实践而非要求」，即**允许不分层** | 同上 | 同上 | 同上 | 2026-11-25 | high | 工程文档

我必须诚实说明：我想找的是「某团队把整个领域建成 OWL 本体，维护成本失控，最终回退」这类复盘帖，**没找到**。用规范的自我克制当反例是**间接证据、强度弱**——它证明「专家不主张全局本体」，不证明「全局本体必然失败」。这个证据缺口需要 lead 决策时知情。

---

## 5. 结论：DSH 应该分几层

### 5.1 判断：**三层，但只有两层承重，第三层是「封顶的、可选的窄契约」**

先给可引用的层数分布作为校准：GenAgents 2 层、MemGPT 2 层、Zep 3 层、medallion 3 层、GraphRAG 多级但**单一轴**（只有模块度一条分层维度）、Mem0 实际 1 层（平的，只有 supersede）。**没有任何一个单进程/单体系统做到 4 层以上。** 层数与「语义丰富度」无关，与「写规则有几种」强相关。

我建议：

**L0 情景日志（episode / append-only）**
- 内容：原始会话、工具调用、观察。不可变、无损、可重放。
- 写入规则：只追加，永不修改。这是唯一能回答「当时到底发生了什么」的层。
- 依据：Zep “Episodes serve as a non-lossy data store”；medallion Bronze=Raw ingestion。
- DSH 成本：**接近零**——现有 session log 已经是这一层，不需要新建存储。这条很重要：不要为 L0 造新库。

**L1 事实与推导（Datalog 事实基 + 规则）**
- 内容：断言的事实（带 provenance、supersede 链、有效时间）、规则推导出的结论。
- 写入规则：所有信念修订在这里发生——ADD / UPDATE / SUPERSEDE / RETRACT；每次修订记录依据。
- 依据：Mem0 的四操作（ADD/UPDATE/DELETE/NOOP）证明工业界认可的最小修订语义就是这套；GraphDB 把 Retraction / Provenance / Reinferring 当正式章节，证明「撤销+溯源+重推」必须是一等公民而非补丁。
- 这一层承载任务里「这条结论依据哪些事实」「去掉哪条就不成立」——这是 why-provenance 查询，Datalog 语义天然支持（**此条为推断**，我没有引用到直接论证 provenance semiring 的一手来源）。

**L2 语义契约（SHACL 式封闭约束，不用 OWL 完整层）**
- 内容：**极少数**概念的形状约束与不变量（例：supersede 链必须无环、事实必须有 source、时间区间必须有序）。
- 写入规则：**只做否决，不生成**。在 L1 assert 之前同步执行一遍。
- 依据：OWL 2 RL 是 PTIME-complete 且明文说可用规则引擎实现（规范原文），所以「可内嵌」这一段**不需要外推**；但复杂度说的是「一致性检查」，**没有说**「十万条记忆上每轮重算闭包 <600ms」——后半句是我不该给保证的。

### 5.2 为什么第三层不能用 OWL 全量推理——三条硬理由

1. **GraphDB 的教训直接适用**：连专门的商业推理引擎都要主动裁规则（全称类展开不算、disjoint 不推 differentFrom），因为 total materialization “increases the processing cost and time taken to load a repository with a large amount of data”。DSH 没有 GraphDB 的优化预算，却有更严的 1000ms 上限。
2. **schema.org 的先例**：连需要服务全网的系统都明确拒绝做 “a 'global ontology' of the world”，并为了实用性放弃更严约束。单用户 Agent 没有理由比 schema.org 更严格。
3. **RL 的复杂度保证是「可算」，不是「够快」**：PTIME-complete 在十万条事实、递归规则、每轮热路径下是否满足 250ms 候选生成，规范**没有回答**。任何声称「OWL 2 RL 一定满足 1000ms」的结论都是外推，不该写进设计文档。

### 5.3 层数边界判据（可落地的、可测的）

一个概念**才有资格**进 L2，需同时满足（这就是我建议 DSH 自己定的规则，因为没有先例）：

- **C1 双写方**：至少 2 个**独立代码路径**断言它（如「技能写记忆」与「工具适配器写记忆」各一份）。判据从「N 个消费者」改为「≥2 个独立写方」——单用户场景下可静态枚举，不需要运行时计数。
- **C2 可判定不变量**：存在一个**能在 <5ms 内算完的确定性检查**（不是「语义正确」，而是「结构合法」）。这一条直接来自 Confluent：能机器判定的才进门禁，判不了的就别放进去。
- **C3 失败代价 > 检查代价**：写错会让召回给出错误结论（而非仅仅少召回一条）。若代价只是「少记一条」，留在 L1。

**不满足 C2 的概念，一律不允许进 L2。** 这是防止 L2 膨胀成「第二套业务逻辑」的唯一硬闸。

另加两条运维纪律：
- **L2 变更必须版本化 + 兼容性检查**（照抄 Confluent 的 BACKWARD 默认），不能用「改一下约束文件」的方式热改。
- **提升是人工动作，不是自动动作。** 因为第 2 节证明没有系统自动化过它；自动提升等于把未验证的判据放到写入热路径上。

### 5.4 过多分层的代价（具体，不是套话）

1. **失效传播成本按层数乘**：supersede 一条 L1 事实，必须让所有 L2 摘要/契约相关缓存失效。GraphRAG/Zep 都因此必须做社区重建（一次编辑触发一个社区重算）。层越多，每次写入的摊还成本越高——而 DSH 写入是高频的。
2. **闭包重算超线性**：递归规则下加一条事实可能触发大量新推导；GraphDB 因此把代价挪到 load time。我们没有 load time，只有热路径。
3. **契约漂移（dead schema）**：没有任何写入方真的被它约束的契约层会退化成注释文档——这是最可能的失败形态，且**静默失败**。
4. **同一概念两份定义**：L1 的规则和 L2 的约束如果对同一概念各说一套，就制造了我们本来想消灭的那个 bug。这是 4 层以上系统最典型的自伤。

### 5.5 一句话结论

**两层承重（L0 无损日志 + L1 带溯源的事实基与规则），第三层只作为「≤10 个概念的封闭不变量检查」存在，且升级判据必须自己写、自己审、不自动化。** 依据是：所有被验证的单进程系统都没有超过 3 层；所有真实存在的提升触发条件都是单调可判定量（没有一个依赖分歧计数）；连专业推理引擎都在主动裁规则。

---

## 6. 诚实标注：查不到的、不确定的、外推的

**明确没查到（负面结论，均已尽力检索，请勿视为遗漏）**
1. 没有任何一手来源记录「被 N 个消费者引用」「第 M 次定义分歧」「事故后补契约」这三类提升触发条件。第 2 节给出的是最接近的替代机制，不是等价物。
2. 没有找到「整层本体化后失败并公开复盘」的一手事例（技术博客复盘 / 论文 lessons learned / issue 讨论）。第 4 节用 schema.org 与 GraphDB 的**事前自我约束**充当间接证据，强度弱于复盘。
3. 没有找到「管线过长导致失败」的一手复盘。第 3.3 节只有 GraphDB 对加载成本的量化自述与主动裁规则两条间接证据。
4. 没有找到任何系统在一条管线里**同时**做统计式提炼与符号式验证并记录二者如何共处。第 3.2 节的「统计产出候选、符号只做否决」是我推断的分工，无先例。
5. HippoRAG（2405.14831）只核实到元数据，未取到支撑分层的正文，**未作为证据使用**。

**不确定 / 需 lead 注意的证据强度问题**
6. OWL 2 Profiles 的 REC 日期 2012-12 标注为 med：抓取到的正文片段未包含日期行，日期来自 REC 属性的既有知识，未在本次抓取中直接验证。
7. schema.org / Databricks / Confluent / GraphDB / Letta 均为 living doc，**无固定 pub_date**，只能标 accessed=2026-11-25。若交付需要「发布日期」，这几个必须标「无」而不是编日期。
8. Letta 只取到片段（正文被截断），关于 “Dreaming” 的完整机制与 “Agent reviews before applying” 的具体行为，我只有两句原文，其余为片段外推，标 med。
9. GraphRAG 的索引成本**没有量化数字**：论文与官方 index/overview 页（正文仅 2503 字符）都未给出成本论述。任何「GraphRAG 索引太贵」的说法我都无法在此引证。

**外推（标 class=推断，不得当作规范/论文结论引用）**
10. 「Datalog 的 why-provenance 能直接回答『去掉哪条事实结论就不成立』」——这是我对 Datalog 语义的判断，本次未引到 provenance semiring 的一手来源。
11. 「符号校验器应只做否决不做生成」——我的分工建议，无先例（见第 4 条）。
12. 「OWL 2 RL 在十万条记忆、1000ms 预算内可行」——**我没有证据支持，也不主张**。规范只给 PTIME-complete，不给常数因子。设计文档不应写「已验证可行」。
13. 第 5.3 节的 C1/C2/C3 判据是我**为 DSH 新拟**的，不是从任何来源抄来的。C2 的 <5ms 阈值是我按写入热路径的常识给的，未经实测。

**方法学**
14. web_search 在本 session 不可用（60s 超时，一次即失败）。所有证据来自 pwsh + Invoke-WebRequest 直连一手页面（arXiv API / ar5iv 全文 / W3C / 官方文档），因此**未经过搜索引擎的二手摘要**，这一点对可信度是正向的。
15. Crossref 429、doi.org SSL 失败，故 CLS 论文元数据经 PubMed E-utilities 核实（PMID 7624455），DOI 与页码以 PubMed 记录为准。
