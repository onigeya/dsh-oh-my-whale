# d10 — Agent 记忆的分层结构与提炼管线的真实先例

source: arXiv 全文（ar5iv）+ PubMed E-utilities + 各产品官方文档一手页面
publisher: APA/Psychological Review / Stanford+Google / UC Berkeley / Zep AI / Microsoft Research / Mem0+UCSD / Databricks / Confluent / Letta / W3C / schema.org
pub_date: 1995-07 至 2025-04；living doc 无固定日期
accessed: 2026-11-25
confidence: high（论文与文档均取原文）；负面结论已逐字检索确认
class: 分层先例 + 提炼管线 + 提升触发条件的空白证明
full_report: `D:/src/dsh-oh-my-whale/docs/research/memory-layering-precedents.md`（258 行）

---

## 10.1 层数与分层依据（六系统校准）

| 系统 | 层数 | 分层依据 | 出处 |
|---|---|---|---|
| CLS（互补学习系统） | 2 | 学习速率（海马快 / 皮层慢） | 10.1037/0033-295X.102.3.419（PMID 7624455），Psych. Review 102(3):419-457, 1995-07 |
| Generative Agents | 2 | memory stream（平铺流）+ reflection（反思节点） | arXiv:2304.03442 v2 2023-08-06 |
| MemGPT / Letta | 2 | OS 隐喻：main context vs external context | arXiv:2310.08560 v2 2024-02-12 |
| Zep / Graphiti | 3 | episode / semantic entity / community | arXiv:2501.13956 v1 2025-01-20 |
| GraphRAG | 多级但单一轴 | **图模块度**（Leiden），不是消费者数、不是定义分歧次数 | arXiv:2404.16130 v2 2025-02-19 |
| Mem0 | **实际 1 层（平的）** | 只有 ADD/UPDATE/DELETE/NOOP，无层 | arXiv:2504.19413 v1 2025-04-28 |
| medallion | 3 | bronze/silver/gold，按「质量」但**无量化门槛** | docs.databricks.com lakehouse/medallion（living doc） |

**没有任何一个单进程/单体系统做到 4 层以上。层数与语义丰富度无关，与「写规则有几种」强相关。**

### CLS 的价值不是「分层」这个结论，而是分层的理由

原文：「memories are first stored via synaptic changes in the hippocampal system, that these changes support reinstatement of recent memories in the neocortex, that neocortical synapses change a little on each reinstatement, and that remote memory is based on accumulated neocortical changes」；「The hippocampal system permits rapid learning of new items without disrupting this structure」。

→ 单层统一学习率必然二选一：学得慢（保结构、丢近期）或学得快（保近期、毁结构）。**这正是事实层（高频写改）与契约层（极少改动）必须分开的理由，而不是审美理由。** CLS 本身**没有**给出「什么条件下一条记忆升级到语义层」的判据。

## 10.2 真实存在的「升级触发条件」只有四类，全是单调可判定量

| 触发机制 | 原文措辞 | 系统 | 性质 |
|---|---|---|---|
| 累积重要性阈值 | 「when the sum of the importance scores for the latest events perceived by the agents exceeds a threshold (150 in our implementation)」 | Generative Agents | 单调累加计数器，写入时递增，触发后清零；实际每天反思 2-3 次 |
| 容量压力阈值 | 「When the prompt tokens exceed the warning token count ... (e.g., 70% of the context window)」；超 100% 时 flush 并驱逐约 50%，用旧 recursive summary 生成新 summary | MemGPT | 资源水位，与语义无关 |
| 图结构（模块度） | Leiden 社区检测，Level 0 = 最大模块度划分 | GraphRAG / Zep | 结构涌现，非计数 |
| 契约兼容性门禁 | 「checks compatibility before accepting the new version」；默认 BACKWARD；四类 Backward/Forward/Full/Transitive | Confluent Schema Registry | **唯一机器可判定、拒绝即发布失败的同步门禁** |

**这四类的共同点（本研究最重要的发现）**：全部是**写入时或离线批处理时可由机器单调判定的量**——一个累加分数、一个字节水位、一个图划分、一次 schema 兼容比较。**没有一个是「依赖历史分歧统计」或「依赖人工事故复盘」的。**

原因（推断）：只有单调、可增量维护的量才能放进写入热路径。「第 M 次分歧」需要全量扫描定义历史，「事故后补」需要人的判断——二者都无法自动化，所以成熟系统干脆不做自动提升，改为人工评审（Confluent 的 schema change review 是流程，不是算法）。

## 10.3 核心负面结论：提升触发条件在工业界根本不存在

在 12 个一手来源里逐字检索，**没有任何一个系统或规范写出过**以下三类触发条件中的任何一类：

- 「某概念被第 N 个消费者引用」→ 没找到
- 「同一概念出现第 M 次定义分歧」→ 没找到
- 「发生过一次生产事故后补上契约」→ 没找到（Confluent 是**事前**强制，无「事故驱动」措辞）

**找不到不是检索不足——从机制上说得通**：这三类条件都需要「多个独立写入方 + 可统计的分歧计数」这项能力，而检索到的系统里**没有一个具备这个概念**（Graphiti 有 dedup 但没有分歧计数；Mem0 有 ADD/UPDATE/DELETE 但没有版本化定义；medallion 靠人工判断）。

## 10.4 与本项目 C4 的直接冲突（必须由 lead 决策）

**C4 的三条件（被多个系统争用 / 定义不一致 / 会导致生产故障）在 DSH 里几乎永不触发：**

- 「被多个系统争用」的前提是存在多个**独立写入方**。DSH 是单进程单用户，写入方是**代码模块**（技能、工具适配器、插件），不是组织。数量级个位数到十几个，且随代码发布**离散变化**——「第 N 个消费者」在这里可以**静态查出来**，不需要运行时计数。
- 「定义不一致导致生产故障」的前提是有生产。单用户场景下故障形态是「助手记错了」，代价低、可当场纠正，不构成契约化的经济理由。
- **如果照搬三条件规则，在 DSH 里它几乎永不触发；如果据此建一整层 OWL，就是在为零次提升建基础设施。**

### 可替代的判据（memory-layering 自拟，无先例）

一个概念**才有资格**进契约层，需同时满足：

- **C1 双写方**：至少 2 个**独立代码路径**断言它（如「技能写记忆」与「工具适配器写记忆」各一份）。判据从「N 个消费者」改为「≥2 个独立写方」——单用户场景下可静态枚举。
- **C2 可判定不变量**：存在一个**能在 <5ms 内算完的确定性检查**（不是「语义正确」，而是「结构合法」）。直接来自 Confluent：能机器判定的才进门禁。
- **C3 失败代价 > 检查代价**：写错会让召回给出**错误**结论（而非仅仅少召回一条）。若代价只是「少记一条」，留在事实层。

**不满足 C2 的概念，一律不允许进契约层。这是防止契约层膨胀成「第二套业务逻辑」的唯一硬闸。**

另加两条运维纪律：**契约层变更必须版本化 + 兼容性检查**（照抄 Confluent 的 BACKWARD 默认），不能热改；**提升是人工动作，不是自动动作**。

## 10.5 提炼管线的真实阶段划分

| 系统 | 同步（写入时） | 异步（后台/离线） | 二者如何共处 |
|---|---|---|---|
| Mem0 | extraction（每轮新消息对触发）、update 的 ADD/UPDATE/DELETE/NOOP 判定 | 无明确异步阶段 | —— |
| Generative Agents | importance 打分（创建时同步，LLM 按 poignancy 给 1-10） | reflection（阈值 150 触发） | 异步产物**回写同一 memory stream**，与同步产物同层同构，**不分表** |
| MemGPT | LLM function call 触发的显式迁移 | 队列 flush / recursive summary（token 压力触发） | 同一存储，靠容量水位切换 |
| GraphRAG | 无（纯离线索引） | 全流程离线：分块→抽取→Leiden→摘要 | 索引与查询彻底分离 |
| Zep/Graphiti | episode 追加（无损） | 实体/边抽取、社区摘要 | 双时间轴 T/T-prime 让异步滞后可被解释 |
| Letta | 正常对话 | background subagents 巩固（Dreaming）；触发条件「after a set number of completed agent steps or when the context window is compacted」 | 后台不阻塞前台 |

**Zep 的成本控制手段值得抄**：写入期去重约束原文「The hybrid search for relevant edges is constrained to edges existing between the same entity pairs as the proposed new edge」——把 O(n^2) 降为按实体对局部搜索。

Mem0 的四操作原文：「ADD for creation of new memories when no semantically equivalent memory exists; UPDATE for augmentation of existing memories with complementary information; DELETE for removal of memories contradicted by new information; and NOOP when the candidate fact requires no modification to the knowledge base.」→ **有显式 supersede/contradict 语义，但完全没有「提升到契约层」的概念。**

**第二个负面结论：没找到任何系统在一条管线里同时做「LLM 摘要/聚类」和「规则校验/推理」并记录二者如何共处。** 这是要自创的部分。

可行分工（推断）：统计式提炼**产出候选**，符号式校验**只做否决、不做生成**（它是 assert 之前的 guard，不是同级步骤）。理由：符号校验器的强项是可判定、可解释、快，弱项是没有生成能力；让它只回答 yes/no 就不必承担它做不到的事。

## 10.6 GraphDB 主动裁规则：契约层必须预设「哪些规则不跑」

GraphDB 自述全量物化代价：「the repository uses configured rulesets to compute all inferred statements at load time. To some extent, this process increases the processing cost and time taken to load a repository with a large amount of data.」

**两条主动放弃（最可直接借用的工程判断）**：
- 全称类展开：「Not supported. Even if this infinite expansion were possible in a forward chaining rule-based implementation, the resulting statements are of no use during query evaluation.」
- 由 disjoint 推 owl:differentFrom：「Impractical for knowledge bases with many members of pairs of disjoint classes such as Wordnet. Instead, this is implemented as a consistency check」

→ **连专门做推理的商业引擎都认为「把闭包全算出来」有两类规则不值得跑。** 契约层要做推理，必须预设「哪些规则我们不跑」并写进文档，否则性能预算必然破。

GraphDB 还把「Retraction of assertions」「Provenance」「Reinferring」列为正式章节 → **成熟 RDF 引擎把撤销/重推/溯源当一等公民，而非事后补救。**

## 10.7 反例：只有事前自我约束，没有事后复盘

- **schema.org** 明确否认自己是全局本体：「The type hierarchy presented on this site is not intended to be a global ontology of the world.」并承认为实用性放弃更严约束：「The decision to allow multiple domains and ranges was purely pragmatic. While the computational properties of systems with a single domain and range are easier to understand, in practice, this forces the creation of a lot of artificial types」
- **GraphDB 主动裁规则**（见 10.6）。
- **medallion 明确标注**「Following the medallion architecture is a recommended best practice but not a requirement」——**即允许不分层**。

**诚实说明：想找的「某团队把整个领域建成 OWL 本体、维护成本失控、最终回退」这类复盘帖，没找到。** 用规范的自我克制当反例是**间接证据、强度弱**——它只证明「专家不主张全局本体」，不证明「全局本体必然失败」。这个证据缺口须在决策时知情。

## 10.8 过多分层的具体代价（不是套话）

1. **失效传播成本按层数乘**：supersede 一条事实必须让所有上层摘要/契约相关缓存失效。GraphRAG/Zep 都因此必须做社区重建（一次编辑触发一个社区重算）。层越多，每次写入的摊还成本越高——而 DSH 写入是高频的。
2. **闭包重算超线性**：递归规则下加一条事实可能触发大量新推导；GraphDB 因此把代价挪到 load time。**我们没有 load time，只有热路径。**
3. **契约漂移（dead schema）**：没有任何写入方真的被它约束的契约层会退化成注释文档——最可能的失败形态，且**静默失败**。
4. **同一概念两份定义**：事实层的规则和契约层的约束如果对同一概念各说一套，就制造了我们本来想消灭的那个 bug。这是 4 层以上系统最典型的自伤。

## 10.9 三条硬理由：第三层不能用 OWL 全量推理

1. **GraphDB 的教训直接适用**：连专门的商业推理引擎都要主动裁规则，因为 total materialization「increases the processing cost and time taken to load a repository with a large amount of data」。DSH 没有 GraphDB 的优化预算，却有更严的 1000ms 上限。
2. **schema.org 的先例**：连需要服务全网的系统都明确拒绝做「a global ontology of the world」。单用户 Agent 没有理由比 schema.org 更严格。
3. **RL 的复杂度保证是「可算」，不是「够快」**：PTIME-complete 在十万条事实、递归规则、每轮热路径下是否满足 250ms 候选生成，规范**没有回答**。任何声称「OWL 2 RL 一定满足 1000ms」的结论都是外推，不该写进设计文档。

## 10.10 诚实标注

**明确没查到（负面结论，已尽力检索，请勿视为遗漏）**
1. 没有任何一手来源记录「被 N 个消费者引用」「第 M 次定义分歧」「事故后补契约」这三类提升触发条件。10.2 给出的是最接近的替代机制，不是等价物。
2. 没有找到「整层本体化后失败并公开复盘」的一手事例。10.7 用 schema.org 与 GraphDB 的事前自我约束充当间接证据，强度弱于复盘。
3. 没有找到「管线过长导致失败」的一手复盘。只有 GraphDB 对加载成本的量化自述与主动裁规则两条间接证据。
4. 没有找到任何系统在一条管线里同时做统计式提炼与符号式验证并记录二者如何共处。10.5 的分工是推断，无先例。
5. HippoRAG（arXiv:2405.14831）只核实到元数据（v3, 2025-01-14），未取到支撑分层的正文，**未作为证据使用**。

**不确定 / 证据强度问题**
6. OWL 2 Profiles 的 REC 日期 2012-12 标注为 med：抓取到的正文片段未含日期行。
7. schema.org / Databricks / Confluent / GraphDB / Letta 均为 living doc，**无固定 pub_date**，只能标 accessed=2026-11-25。交付中必须标「无」而不是编日期。
8. Letta 只取到片段（正文被截断），关于 Dreaming 的完整机制与「Agent reviews before applying」的具体行为，只有两句原文，其余为外推，标 med。
9. GraphRAG 的索引成本**没有量化数字**：论文与官方 index/overview 页都未给出成本论述。任何「GraphRAG 索引太贵」的说法无法引证。

**外推（不得当作规范/论文结论引用）**
10. 「Datalog 的 why-provenance 能直接回答『去掉哪条事实结论就不成立』」——本次未引到 provenance semiring 的一手来源。
11. 「符号校验器应只做否决不做生成」——分工建议，无先例。
12. 「OWL 2 RL 在十万条记忆、1000ms 预算内可行」——**没有证据支持，也不主张**。规范只给 PTIME-complete，不给常数因子。设计文档不应写「已验证可行」。
13. 10.4 的 C1/C2/C3 判据是**为 DSH 新拟**的，不是从任何来源抄来。C2 的 <5ms 阈值按写入热路径常识给出，未经实测。

**方法学**
14. web_search 在本 session 不可用（60s 超时，一次即失败）。所有证据来自 pwsh + Invoke-WebRequest 直连一手页面（arXiv API / ar5iv 全文 / W3C / 官方文档），**未经过搜索引擎的二手摘要**，这一点对可信度是正向的。
15. Crossref 429、doi.org SSL 失败，故 CLS 论文元数据经 PubMed E-utilities 核实（PMID 7624455）。
16. 被拒/无正文来源（列出以免重复踩坑）：SweetTools/SWEET wiki（空正文）、gocardless.com/blog/data-contracts/（404）、confluence.ihtsdotools.org（SSL 失败）、docs.snomed.org/specifications/SNOMED-CT-OWL（空正文）。
