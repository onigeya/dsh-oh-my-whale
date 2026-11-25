---
title: 'technical research: 本体模型 / 世界模型设计参考'
type: 'technical'
topic: 'ontology world model references'
decision: '为私有知识库的“本体模型/世界模型”选择可借鉴的设计模式：双时态信念演化、本体约束与校验、情景记忆与世界状态推演、概率信念与 surprise、睡眠巩固、溯源与冲突裁决'
source: 'native run (lead + 3 assistants)'
status: draft
preset: 'standard'
validation: 'normal'
created: '2026-11-22'
updated: '2026-11-22'
---

# technical research: 本体模型 / 世界模型设计参考

**Decision this research serves:** 为私有知识库的“本体模型/世界模型”选择可借鉴的设计模式：双时态信念演化、本体约束与校验、情景记忆与世界状态推演、概率信念与 surprise、睡眠巩固、溯源与冲突裁决。

## 摘要

九条候选里，**四条在核查阶段就被推翻**：zepai/graphiti 与 pranav-singh/nous 两个地址 404，Anda Hippocampus 与 Clawra 已改名，Clawra 的实际仓库只有 2 星 [28]。这批条目显然由语言模型生成，**不能当作选型基线**——这是本次调研最省钱的一条结论。

真正值得抄的是四种机制，而不是四个产品：

1. **双时态三轴 + 软失效 + 按世界时间裁决**（Graphiti）：valid_at / invalid_at 记事实时间，expired_at 记事务时间，reference_time 记来源情景时间；冲突时“后发生的事实赢”，补录的旧证据不会覆盖新事实 [2][3]。
2. **修正即封版，而不是覆盖**（Utopia）：边被物化（reified），改一条事实是“关闭旧版本 + 链接新版本”；冲突给三选一，决策留 append-only 账本 [7]。
3. **写入期硬校验 + 显式失败状态**（TrustGraph）：本体域/值域不符的三元组在抽取期被拒，而不是静默写入；查询期再用策略做逐节点过滤 [19][20]。
4. **分层巩固预算 + 确定性结算与模型作业分离**（anda-brain）：daydream / quick / full 分别每 21 / 42 / 168 个对话触发，巩固前的结算由宿主确定性执行，模型只做归纳；遗忘只降可及性，不改真值 [16][17]。

两个“看上去很美”的要警惕：**概率信念**（Nous 真实存在但只有 2 星、单作者预印本，且是点概率不是分布 [14][15]）；**“知识图谱即世界模型”**（AriGraph 已停更，代码里没有推演模块，只有记忆图与 TextWorld 管线 [12]）。

一句话给决策：**把“世界模型”降级为“可回溯的事实状态图 + 显式冲突状态”，v1 不做预测器。**

## 方法与证据边界

- **存在性核查**：对九个地址逐个打 GitHub API，记录 404、改名、所属组织变更 [28]。
- **代码级核验**：八个仓库浅克隆到本地，逐文件读实现（commit 见各节括注），而不是只读 README。这是本次与“问一遍大模型”的主要差别。
- **三组并行外部调研**：时态世界模型组、概率信念与巩固组、本体治理组，各自独立检索并返回带来源的 digest，落盘于 digests/。
- **边界**：未运行任何系统（只读代码与文档）；AriGraph 论文只读到摘要与仓库说明，未读 PDF 正文；GitHub 未认证 API 一度限流，部分 issue 细节未展开。

## 一、存在性核查：表格本身不可信

| 表内条目 | 实际情况 | 结论 |
|---|---|---|
| Graphiti zepai/graphiti | 404；真实仓库 getzep/graphiti，32,996★，64 位贡献者，v0.31.2 [1][28] | 地址错，项目真 |
| Utopia deeplethe/utopia | 8,692★，1,194 fork，33 位贡献者，2026-08 建仓，v0.1.0-rc9 [28] | 真，但极早期 |
| AriGraph AIRI-Institute/AriGraph | 177★，4 位贡献者，最后提交 2024-09-10，无 release [28] | 真，已停滞 |
| Nous pranav-singh/nous | 404；真实项目是 PyPI nous-state + Pranavsingh431/nous-state，2★，单作者 [14][15][28] | 地址错，项目极小 |
| Anda Hippocampus | 已改名 ldclabs/anda-brain，87★，单贡献者，v0.13.x [28] | 真，单人项目 |
| Ontofelia | semantification-org/Ontofelia，34★，2 位贡献者，v0.0.1 [28] | 真，实验品 |
| ontology-worlds | 6★，0 fork，1 位贡献者，最后提交 2026-05-16 [28] | 真，单人原型 |
| Clawra wu-xiaochen/ontology-platform | 已改名 clawra-engine，**2★**，v4.2.0-alpha [28] | 真，营销远大于成熟度 |
| TrustGraph | 3,205★，375 fork，31 位贡献者，v2.8.17，Apache-2.0 [28] | 真，唯一“工程级” |

**判读**：九个条目里能与“企业级/时态/本体治理”这些形容词匹配的，只有 Graphiti、TrustGraph、Utopia 三个；其余四个是单人实验或已停更的论文代码。选型时若按表格措辞直接采信，会把论文 demo 当成基础设施。

## 二、双时态与信念演化

### Graphiti：三轴时间 + 区间逻辑失效

EntityEdge 同时携带四种时间语义 [2]：

- valid_at / invalid_at：事实在世界里开始/停止为真的时刻；源码注释明确“软截止日期不算 invalid_at”。
- expired_at：**事务时间**，即 Graphiti 判定这条边失效的时刻——这是“信念何时改变”的轴，README 里没强调。
- reference_time：产出该边的 episode 的参考时间。

失效是**软失效**：_apply_temporal_invalidation 只写 invalid_at / expired_at，从不删边 [3]。冲突裁决按世界时间排序而非摄入顺序——当新边与某条候选冲突、而候选的 valid_at 更晚时，被标失效的是**新边**（resolved_edge.invalid_at = candidate.valid_at），随后交给 resolve_edge_contradictions 处理区间重叠 [3]。含义很直接：**后发生的事实赢**，补录的旧证据不会覆盖新事实。代价是这一切依赖 LLM 把日期抽对，日期错了就是静默错判。

一个容易踩的坑：**默认查询不过滤失效边**。search() 在 search_filter=None 时传入空的 SearchFilters()，而 valid_at / invalid_at / expired_at 三个字段默认都是 None [4][5]。README 说“查询当下为真的事实”是能力，不是默认行为。

另有两点值得抄：SagaNode 把每次提交写成带 summary 与首尾 episode 的提交记录 [6]；enforce_edge_type_signatures 在写入路径按“端点类型签名 → 边类型”校验抽取结果，不符则丢弃或改名，而不是交给提示词自觉 [3]。

### Utopia：修正即封版 + 决策账本

Utopia 不把双时态图放进图数据库，而是一个 Rust 二进制 + 一个 Postgres：边被物化，修正一条事实是“关闭旧版本并链接新版本”，而不是覆盖；冲突分三类、每类给三种处置（闭旧/并存/拒新），确认、驳回、合并、回滚都留一条“谁、何时、当时对象是什么样”的决策账本 [7]。

它的 MCP 接口把两条时间轴直接暴露成两个参数，这一设计比多数项目干净：at 读**世界时间**（那时什么是真的），as_of 读**记录时间**（那时系统持有什么）[11]。remember 需要写权限，且要人工确认才进图 [11]。

代价同样明显：版本 0.1.0、迁移只前滚不可回滚、roadmap 里“Agent memory over MCP”仍未勾选 [7][28]。它现在是“带审计的时态知识库”，不是 README 暗示的决策模拟器。

### 对本项目的含义

最小可用集是四个字段（valid_from、valid_to、recorded_at、superseded_at）加一段区间逻辑，**再加一条硬规则：默认查询只返回 superseded_at IS NULL 的断言**。Graphiti 用血的教训证明了“过滤要显式”这件事不该交给调用方。

## 三、本体约束与校验：三个拦截点

### TrustGraph：写入期拒收 + 查询期策略

本体由用户自带（BYOO，上传 OWL 域模式）；OWL 在**抽取期**生效——抽出的三元组对照 domain/range/subclass 校验，违例的直接拒绝，官方自述“不是完整的 OWL reasoner”，查询期没有推理 [19]。代码里对应 ontology/service.py 与抽取器的 ontology_selector，后者真的拿 domain/range 去比对实体类型 [20][21]。

SHACL 走的是另一条路：一个 SHACL-AF 变体在**查询期**做逐节点策略过滤，三态（Allowed / Filtered / Violation），策略存 urn:graph:policy；溯源用 PROV-O 写进 urn:graph:source 与 urn:graph:retrieval 两个命名图，可 SPARQL 查询 [19][22]。它的缺口是：**没有逐三元组的证据/置信度字段**，置信度只活在 Laya/Cloze 两个评分模型里 [19]。

### Utopia：公理检查，不是 SHACL 校验（已由主线定案）

助手在文档层找不到 SHACL，主线在代码层找到了，但结论相反于表格：ontology_rdf.rs **把 SHACL 形状当作本体来源**，用 sh:property / sh:path / sh:class / sh:datatype 反推属性的 domain 与 range（注释写明“只填空白”，为的是兼容 UCO 这类把约束写在形状上的词汇表）[8]。真正的约束检查在 utopia-reason：Axioms { functional, inverse_functional, inverse_of, sub_property_of } 加对称/反对称，违规写进 axiom_violations，且刻意与 fact_conflicts 分表——“后者问哪条对，前者可能是本体定义错了” [9]。

**所以“SHACL 本体约束”这个描述对 Utopia 不成立**：它做的是公理一致性检查，SHACL 只是导入词汇。这恰恰是个好设计——约束该落在哪种机制上，取决于你要抓的是“数据错”还是“定义错”。

### Ontofelia 与 ontology-worlds：诚实的实验与廉价的拦截

Ontofelia 的 Neuro-Symbolic 是真推理但范围有限：OWL 2 RL 物化（Reasonable，Rust N-API），README 自己写明“不是 OWL-DL、无完整一致性检查”，冲突靠独立 SPARQL 查不相交类，且全文没有 SHACL [23]。它的可信度来自自我披露：自称 vibe coding 实验、非生产级。

ontology-worlds 的“禁止本体外断言”是**后处理启发式**：系统提示注入合法实体/谓词 → PreToolUse hook 校验并阻断 → 生成后用 domain_validator.py 算“回复里的命名实体有多少落在 JIT Wikidata 子图内”，低于 0.5 就重写，最多自纠 3 轮，仍不达标标 out_of_scope [24]。我读了那个验证器：它确实是实体覆盖率打分，不是本体一致性证明——合法但新颖的表述会被误杀，措辞游戏也能绕过，但“标 out_of_scope 而不是强行改写”这个降误杀策略值得抄。

### Clawra：规则引擎是真的，Neo4j 不是

src/clawra/core/reasoner.py 有 1,085 行，RuleType.FORWARD、forward_chain、内置传递/对称规则——符号推理是真的 [25]。但 Neo4j 只是可选依赖，默认持久化是本地 JSON；2 星、单人、v4.2.0-alpha，README 的“企业级私有化”与代码现实差距最大 [28]。

### 对本项目的含义

拦截点只有三个位置，各有代价：**写入期**（硬、但依赖本体完备性与抽取质量）、**检索期**（可做策略隔离，但写错策略会系统性误杀）、**生成后**（自由文本只能启发式，结构化输出可硬约束）。TrustGraph 最值得学的一点是：**把每一种校验失败都建模成显式状态**（Violation / rejected / out_of_scope），而不是静默重试或放过。

## 四、情景记忆与世界状态推演

AriGraph 的目录结构是 agents / graphs / prompts / pipelines / qa_data，图是 TripletGraph，**没有模拟器、没有转移函数、没有前向推演模块** [12]；论文的增益集中在 TextWorld（1.0/0.79/1.0 对 RAG 0.33/0.35/0.36），QA 只是“可比”，项目 2024-09 后停更 [12][28]；论文正文本次未读（[13]），上述判断仅基于摘要与仓库结构。

这引出一个必须说清的概念问题，否则本项目会为一个不存在的能力做设计：**世界模型的本义是“状态 + 转移 + 预测”**（给定当前状态与动作，预测下一状态），而知识图谱提供的是**状态载体**，不是转移函数。AriGraph 把“用 KG 记住环境”称作 world model，是借词；它真正贡献的是“episodic 顶点 + 语义关系”的记忆结构。

对本项目可行的做法是分两步：先做**状态快照与时间旅行查询**（Utopia 的 at / as_of 已是现成范式 [11]），把“某时刻的世界状态”变成可查询对象；等有了明确的动作/转移语义，再谈预测层。跳过第一步直接做推演，等于在没有状态定义的情况下写模拟器。

## 五、概率信念与 surprise：真实但危险

Nous（nous-state 0.2.0）确实存在：LLMExtractor → (entity, attribute, value) → BayesianUpdater → surprise → posterior，存储为 Dimension（概率分布）+ Delta（不可变历史）+ SQLite DeltaLog，API 有 observe / predict / query_at / history / explain / surprise / apply_decay [15]。但两点要看清：

1. 它**不是 Beta/Dirichlet 共轭更新**，而是分类分布乘浮点再归一化，遗忘走熵衰减 [15]；所谓“贝叶斯”是修辞层面的。
2. 项目 2 星、单作者、README 自述“首份公开报告，非最终/未完整审计” [15]；其论文投稿标记为 jmlr-submission-2026-10-04 [28]。

anda-brain 走的是相反方向，而且更值得抄：**置信度永不衰减**，强度在**读取时**按“搁置多久”计算，且“读取不强化”；asserted_at 记的是观察时间而非写入时间 [16]。这与 MemoryBank 的艾宾浩斯遗忘曲线（按经过时间与重要性衰减）[26]、Generative Agents 的重要性/新近性/相关性打分与 reflection 综合 [27] 构成三种可选路线：**衰减存储值**、**读时投影**、**检索打分**。三者中“读时投影”最可审计——因为存储的断言从未被改写。

**判读**：不要引入点概率层。它带来“假精确”（0.73 这个数字没有校准依据），调试成本高于收益；用“证据计数 + 置信区间 + 读时衰减”表达不确定性，既够用又可解释。surprise 的正确定位是**分配写入/巩固预算**，而不是判定真假。

## 六、睡眠巩固（dream）：机制比名字重要

anda-brain 的巩固是本次调研里工程完成度最高的部分 [16][17]：

- **预算分档**：daydream 每 21 个已形成对话、quick 每 42 个、full 每 168 个且每 Space 至少 24 小时一次——代码里 space.rs 的注释逐字写着这三个数字 [17]。
- **确定性结算与模型作业分离**：每轮先由宿主确定性执行“登记修正、遍历依赖被修订断言的下游、触发到期承诺、retention 过期归档、产出评估”，再由 Maintenance agent 做认知工作（事件聚类成带 lineage 的派生断言、身份合并、stale 标记、把重复成败编译成未验证的 Skill 候选）[16]。
- **工具面**：以 rmcp 的 ToolRouter 暴露 MCP 工具，巩固与查询都能被外部 agent 直接调用 [18]。
- **遗忘不改真值**：README 原文“Forgetting is about accessibility, never truth”，维护从不清理记忆；Activity 记录每次形成/巩固/修订，配合版本化图可回放 [16]。

**判读**：“dream”这个词容易让人以为要做随机重组或反事实生成，anda-brain 恰恰没做——它做的是**批处理式的整理与核算**。这对本项目是好消息：巩固闭环可以在没有生成模型创造性的前提下落地，而且可审计。

## 七、溯源、可信度分级与冲突裁决

- **TrustGraph**：PROV-O 命名图分别记“抽取谱系”和“推理追踪”，可查询；但没有逐断言的可信度字段 [19][22]。可信度只出现在下游评分模型里——这是它的结构性缺口。
- **Utopia**：决策账本 + 先例式裁决。adjudication.rs 处理实体消解的灰区对：先查裁决缓存，未命中攒批（一次 LLM 裁 12 对），高置信（≥0.8）自动合并/分开，其余转人工；**缓存键里包含先例**，人被裁一笔，旧答案自动作废 [10]。这是“把人的裁决变成可复用判例”的少见实现。
- **Graphiti**：SagaNode 提供按 episode 的提交摘要 [6]；失效链上保留 invalidated_by 映射（哪条新边否定了哪条旧边）[3]。

**判读**：溯源要分两层——**证据层**（这条断言从哪来、何时取、抽取器是谁）与**决策层**（谁在何时基于什么把它升/降/合并）。多数项目只做前者（PROV-O），Utopia 把后者也做了，这正是“知识是演化信念”最需要的部分。
## 八、横向矩阵

| 维度 | Graphiti | Utopia | TrustGraph | anda-brain | Nous | Ontofelia | ontology-worlds | Clawra | AriGraph |
|---|---|---|---|---|---|---|---|---|---|
| 双时态 | 三轴，软失效 [2][3] | 物化边+封版 [7] | 无（靠 PROV 溯源） | 观察时间/读时投影 [16] | 不可变 delta 历史 [15] | 无 | 无 | 无 | 无 |
| 本体校验位置 | 写入期类型签名 [3] | 公理检查（非 SHACL）[9] | 写入期 OWL + 查询期 SHACL-AF [19] | 无 | 无 | 写入期知识引擎 + RL 物化 [23] | 生成后覆盖率 + JSON Schema [24] | 符号规则引擎 [25] | 无 |
| 概率/不确定性 | 无 | 置信度阈值 | 无（外部评分模型） | 主观置信，不衰减 [16] | 分类分布 + entropy decay [15] | 无 | 覆盖率分数 | 无 | 无 |
| 巩固/整理 | 社区重建 | 重算与 errata | 无 | 三档 sleep + 确定性结算 [16][17] | 无 | RL 物化 | 自纠循环 | 进化循环 | 无 |
| 溯源 | episode 锚点 + saga [6] | 决策账本 [7] | PROV-O 命名图 [22] | Activity 日志可回放 [16] | delta 历史 [15] | 三元组习得记录 [23] | 无 | 未验证 | 无 |
| 时间旅行查询 | 需自行过滤 [4][5] | at / as_of [11] | 无 | 无 | query_at [15] | SPARQL | 无 | 无 | 无 |
| 成熟度 | 高（v0.31，64 贡献者）[28] | 早期（v0.1-rc9）[28] | 高（v2.8.17，31 贡献者）[28] | 低（单人，v0.13）[28] | 极低（2★）[28] | 极低（v0.0.1）[28] | 原型（6★）[28] | 极低（2★）[28] | 停滞（2024-09）[28] |
| 可借鉴度 | ★★★★★ | ★★★★☆ | ★★★★☆ | ★★★★☆ | ★★☆☆☆ | ★★☆☆☆ | ★★☆☆☆ | ★☆☆☆☆ | ★★☆☆☆ |

## 九、对本项目“本体模型/世界模型”的设计建议

建议按五层落地，每层只借一个项目的主意，避免把某个产品的世界观整套搬进来。

### L0 事实层：断言与证据分离

借 anda-brain 的 Assertion / Evidence / Activity 三分 [16]，加 Graphiti 的时间轴 [2]、Utopia 的物化边 [7]：

- Assertion：id、subject、predicate、object、valid_from、valid_to（世界时间）、recorded_at、superseded_at（事务时间）、status、confidence_band、ontology_term_id。
- Evidence：id、source_type、uri、retrieved_at、extractor、quote_span、trust_tier。
- AssertionEvidence：assertion_id、evidence_id、relation（supports / refutes / supersedes）。

关键约束：**断言一旦写入不可改写**，修正 = 新增断言 + 给旧断言填 superseded_at；confidence_band 由证据推导，不手工赋值。

### L1 本体层：小 TBox + 写入期拒收

借 TrustGraph 的“抽取期校验、违例拒收”[19] 与 Utopia 的“数据错 vs 定义错分表”[9]：

- TBox 只定义：类、属性、domain/range、基数、互斥类。**不做 OWL-DL 推理，不做全量 SHACL。**
- 校验结果三态：accepted / rejected / needs_review，全部落库可查——不要静默丢弃。
- 本体自身也有版本与变更记录；改本体要能回答“这次改动让哪些历史断言变成违规”。

### L2 信念层：读时投影，不存点概率

借 anda-brain 的“置信不衰减、读时计算、读取不强化”[16]：存证据与规则，读的时候算 confidence_band（strong / weak / disputed），而不是存 0.73。证据计数加区间足够覆盖晋升/降级，且能被审计。

### L3 巩固层：分档预算 + 确定性结算

借 anda-brain 的三档节奏与“结算与认知分离”[16][17]：巩固任务分 light / standard / deep；每次巩固前先跑确定性结算（过期、依赖失效传播、待决承诺），再让模型做聚类与归纳；产物必须带 lineage 指回原始断言。**巩固不得改写真值**，只允许新增派生断言、调整可及性与标记 stale。

### L4 溯源与裁决层：双账本

借 TrustGraph 的 PROV-O 证据图 [22] 与 Utopia 的决策账本 + 判例缓存 [10]：证据账本记“从哪来”，决策账本记“谁为什么改了信念”；判例缓存让同类冲突不重复付模型费用，人裁一次即成为先例。

### 查询层的一条硬规则

默认查询只返回 superseded_at IS NULL；需要历史时显式传 at（世界时间）或 as_of（记录时间）——直接照抄 Utopia 的两个参数语义 [11]，避免 Graphiti 那个“默认不过滤”的坑 [4][5]。

### 三条明确不做

1. **v1 不做预测式世界模型**：没有状态定义与转移语义时，任何“推演”都是叙事。AriGraph 停更且无模拟器，已是最好的反证 [12]。
2. **不做点概率**：Nous 是 2 星预印本，且不是共轭更新 [15]；假精确比不确定性更贵。
3. **不把 SHACL 当唯一校验层**：Utopia 只把它当导入词汇 [8]，TrustGraph 用的是 SHACL-AF 变体 [19]；标准 SHACL 在“LLM 抽取”这个噪声源面前，收益不如写入期类型签名 + 显式失败状态。

### 演进顺序

1. **第 1 步（约 2–3 周）**：L0 + 默认过滤 + at/as_of 查询。此时系统已是“可回溯的事实库”，能独立产生价值。
2. **第 2 步**：L1 + 冲突状态机 + 决策账本。此时能回答“为什么我现在相信这条”。
3. **第 3 步**：L3 巩固 + L2 读时置信 + lineage 回放。此时才谈得上“演化信念”。

## 十、反面证据与风险

- **表格由 LLM 生成，且错误率 4/9** [28]。基于它做选型，等于把幻觉当地图。任何“参考项目清单”都应先过存在性核查。
- **Utopia 的增长速度值得警惕而非背书**：3.5 个月 8,692★、1,194 fork，但版本仍是 0.1.0-rc9，迁移只前滚 [7][28]。高星不等于可生产。
- **Graphiti 有 575 个 open issue** [28]，双时态的正确性依赖 LLM 抽日期 [3]——把它当“开箱即用的时序底座”会低估数据质量成本。
- **anda-brain 是单人项目**（1 位贡献者）[28]，机制值得抄，依赖不值得押。
- **Clawra 的宣传与实现落差最大** [25][28]；“企业级/多租户”与 2 星单人 alpha 不是一回事。
- **本次未运行任何系统**：所有“性能/易用性”判断都来自代码结构与文档，不是实测。

## 十一、未解问题

1. TrustGraph 的 SHACL-AF 三态判定细则与策略语言，只读到 README 层描述 [19]。
2. Utopia 的 axiom_violations 在真实数据上的误报率——未跑数据。
3. anda-brain 的 21/42/168 是否可配置、以及满载时的成本曲线——代码确认了默认值 [17]，未测。
4. AriGraph 论文正文的局限章节未读，其“world model”用法是否在论文中有更严格定义，待核。
5. 本项目自身的本体范围（哪些类/属性进 TBox）尚未定义——这决定 L1 的工作量，需要产品侧输入。

## 来源表

| # | 来源 | 版本 / 日期 |
|---|---|---|
| [1] | GitHub API — getzep/graphiti 元数据（stars / forks / contributors / release） | API · 2026-11-22 |
| [2] | graphiti_core/edges.py L228–259（EntityEdge 时间字段） | commit 9b8a463 · 2026-11-20 |
| [3] | graphiti_core/utils/maintenance/edge_operations.py L438–460、L625–660、L762–830 | commit 9b8a463 |
| [4] | graphiti_core/graphiti.py L2248、L2295、L2341（search 默认过滤器） | commit 9b8a463 |
| [5] | graphiti_core/search/search_filters.py L55–65 | commit 9b8a463 |
| [6] | graphiti_core/nodes.py L894–903（SagaNode） | commit 9b8a463 |
| [7] | deeplethe/utopia README（Features / Status） | commit a0a800f · 2026-11-22 |
| [8] | crates/utopia-store/src/ontology_rdf.rs L96–120（SHACL 形状作本体来源） | commit a0a800f |
| [9] | crates/utopia-reason/src/lib.rs L40–70（Axioms / Violation） | commit a0a800f |
| [10] | crates/utopia-server/src/adjudication.rs L1–24（灰区对裁决、先例缓存） | commit a0a800f |
| [11] | web/src/docs/mcp.md L1–55（at / as_of / remember 人工确认） | commit a0a800f |
| [12] | AIRI-Institute/AriGraph README 与仓库结构（无模拟器模块） | commit e884b76 · 2024-09-10 |
| [13] | AriGraph 论文正文 —— **这是「未读缺口」标记，不是一条来源**：正文 :114 用它标出「哪些判断只凭摘要与仓库结构、没有论文正文支撑」。编号留在表里是为了让 `[13]` 在正文可解引用，不代表本报告读过该论文。见未解问题 4 | 保留位（有意空置） |
| [14] | PyPI nous-state 0.2.0 元数据 | 2026-11-22 |
| [15] | Pranavsingh431/nous-state README（管线、Dimension/Delta、API） | release 2026-10-04 |
| [16] | ldclabs/anda-brain README（sleep 三档、settlement、forgetting 语义） | commit a139642 · 2026-11-19 |
| [17] | anda_brain/src/space.rs L1603（daydream 21 / quick 42 / full 168） | commit a139642 |
| [18] | anda_brain/src/mcp.rs（rmcp ToolRouter） | commit a139642 |
| [19] | trustgraph-ai/trustgraph README（BYOO、写入期 OWL、查询期 SHACL-AF、PROV-O） | commit 17e5d74 · 2026-11-12 |
| [20] | trustgraph-flow/trustgraph/ontology/service.py | commit 17e5d74 |
| [21] | trustgraph-flow/trustgraph/extract/kg/ontology/ontology_selector.py L260–325 | commit 17e5d74 |
| [22] | trustgraph-flow/.../analyse_trace.py（urn:graph:retrieval、prov: 前缀） | commit 17e5d74 |
| [23] | semantification-org/Ontofelia README（OWL 2 RL / Reasonable、无 SHACL、自评基准） | commit a4e166c · 2026-11-17 |
| [24] | ArthurSrz/ontology-worlds CLAUDE.md 与 plugin/src/domain_validator.py L1–45（0.5 阈值） | commit 8638199 · 2026-05-16 |
| [25] | wu-xiaochen/clawra-engine src/clawra/core/reasoner.py（1,085 行，RuleType.FORWARD） | commit 7c6525b · 2026-07-10 |
| [26] | MemoryBank: Enhancing LLMs with Long-Term Memory, arXiv:2305.10250 | 2023-05-17 |
| [27] | Generative Agents: Interactive Simulacra of Human Behavior, arXiv:2304.03442 | 2023-04-07 |
| [28] | GitHub API 仓库健康度批量采集（九个仓库：stars / forks / open issues / contributors / last release / license） | API · 2026-11-22 |
