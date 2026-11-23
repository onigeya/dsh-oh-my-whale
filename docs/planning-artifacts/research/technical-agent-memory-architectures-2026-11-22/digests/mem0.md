# Mem0 · 实现机制 digest

> 证据基线：mem0ai/mem0 浅克隆（depth 50），HEAD = fff8a6472512d1bc1a4bccab8c645b65a1df7fe5，2026-11-18 12:54 +0530，分支 main。下文所有「路径:行号」均指该 commit 的仓库相对路径；访问日期 2026-11-22。
> 标注约定：**[代码]** = 我读到的源码确实这么写；**[README]** = 官方文档/README 声称，未在代码中验证；**[推断]** = 我基于代码的推理，无直接证据；**[未证实]** = 本轮没取到证据。

## 身份确认

| 项 | 值 | 证据 |
|---|---|---|
| URL | https://github.com/mem0ai/mem0 | 克隆成功，内容吻合 |
| Star / Fork | 69,332 / 8,246（2026-11-22 抓取） | api.github.com/repos/mem0ai/mem0（代码外证据，单源） |
| 主语言 | Python（另有 TypeScript SDK mem0-ts/） | api 返回 language=Python；mem0-ts/ 目录 |
| 创建 / 最近推送 | 2023-06-20 / 2026-11-18 | api；git log HEAD=fff8a64（2026-11-18） |
| 版本 | 2.2.1，Apache-2.0，requires-python >=3.10,<4.0 | pyproject.toml:8、:9、:15 |
| 论文 | 有：arXiv:2504.19413，2025-04-28 提交，标题 "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory"，5 位作者，含 graph-based 变体 | https://arxiv.org/abs/2504.19413 |
| Open issues | 978 | api |
| 仓库体积 | ~69.6 MB，含 evaluation 子模块（指向 mem0ai/memory-benchmarks） | api size_kb=69584；.gitmodules:1-3 |

**mismatch 检查：未发现 mismatch。** 目录里同时存在 mem0/（Python 库）、server/（FastAPI 自托管）、mem0-ts/、integrations/（十余个 IDE/框架插件）、docs/、evaluation（子模块），与「Mem0 记忆层」一致。

## 一句话定位

给 AI 助手/Agent 用的**外挂记忆层**：把对话交给 LLM 抽成一句句「自包含事实」，存进向量库（+SQLite 审计日志），检索时用 语义 + BM25 + 实体链接 三路融合打分返回 top-k，再由调用方自己拼进 prompt。**它自己不管注入、不管遗忘、不管后台整理。**

宿主形态（四种并存）：
- **库/SDK**：pip install mem0ai，Memory 类直接嵌入进程 [代码] mem0/memory/main.py:487
- **自托管服务**：FastAPI，端点 /memories、/search、/configure 等 [代码] server/main.py:322-557
- **云平台**：MemoryClient 打 app.mem0.ai；平台独享 decay / graph / temporal [代码] mem0/client/project.py:400-460、docs/platform/features/graph-memory.mdx:3-8
- **插件 / MCP**：integrations/{claude-code,codex,cursor,kimi,deepseek,hermes,opencode,antigravity,pi-agent,openclaw}-plugin 每个都带 core/mcp_server.py [代码]（如 integrations/claude-code-plugin/core/mcp_server.py:215），根目录另有 marketplace.json、.claude-plugin/、.codex-plugin/

## 架构总览（组件与数据流）

Memory 构造函数把五件东西装起来 [代码] mem0/memory/main.py:487-514：
1. EmbedderFactory → 向量化（embed / embed_batch）
2. VectorStoreFactory → 向量库（20+ 后端，见 vector_stores/）
3. LlmFactory → 抽取用 LLM
4. SQLiteManager(config.history_db_path) → 审计 history + 原始 messages
5. 可选 RerankerFactory；entity_store 惰性初始化（:513-514、:559-561）

数据流（写入）：
messages → parse_vision_messages → _add_to_vector_store
 → [Phase0] 取该 session 最近 10 条消息
 → [Phase1] 用本轮对话做 query，向量检索 top_k=10 旧记忆（只作去重/链接上下文）
 → [Phase2] 单次 LLM 调用，ADDITIVE_EXTRACTION_PROMPT，输出 {"memory":[{id,text,linked_memory_ids?}]}
 → [Phase3] 批量 embed
 → [Phase4] md5 精确去重（对旧 hash + 本批 hash）
 → [Phase6] 批量写向量库（失败逐条重试）
 → history 表写 ADD 行
 → [Phase7] 抽实体、按实体合并 linked_memory_ids（独立 entity 向量集合）
 → [Phase8] messages 表落原始消息
证据：mem0/memory/main.py:918-1220

数据流（读取）：
query → 词形还原 + 实体抽取 → 语义检索(max(top_k*4,60)) → keyword_search(BM25) → sigmoid 归一 → 实体 boost → 加法融合 / max_possible → 阈值过滤（只卡语义分）→ 排序取 top_k
证据：mem0/memory/main.py:1642-1745；mem0/utils/scoring.py:60-139

**关键结论：这是一条「只增不改」的管线。** README 明说 "Single-pass ADD-only extraction -- one LLM call, no UPDATE/DELETE. Memories accumulate; nothing is overwritten." [README] README.md:68；代码里确实没有 UPDATE/DELETE 分支 [代码] main.py:881-1220。

## 数据模型与存储

**记忆单元 = 向量库里的一条 point，不是文件、不是行。** payload 字段 [代码] main.py:1030-1039、1704-1713：
- data：记忆正文（一句话事实，含被折算后的绝对日期）
- hash：md5(text)，用于去重（:1022、:1034）
- text_lemmatized：为 BM25 预处理的词形还原文本（:1028、:1033）
- created_at / updated_at：ISO8601 UTC（:1035-1037）
- 作用域：user_id / agent_id / run_id（由 _build_filters_and_metadata 写入 metadata，:822-827）
- 可选：actor_id、role、attributed_to、expiration_date（:1038-1039、:1704-1713）
- 其余用户 metadata 原样并入 payload（:1031）
- id = str(uuid4())（:1030）

对外返回结构 MemoryItem [代码] main.py:1722-1741：id、memory、hash、created_at、updated_at、score、metadata{}，explain=True 时加 score_details{semantic_score,bm25_score,entity_boost,raw_score,max_possible_score,final_score,threshold}（scoring.py:126-135）。

**粒度**：一条记忆 = 一个自包含事实陈述，不是一轮对话、不是文档块。抽取提示词要求「每个话题单独一条、把相对时间锚定到绝对日期」[代码] prompts.py:472-476、524-540、718-722。粒度由 LLM 决定，代码不做结构化约束。

**实体集合（第二套向量空间）** [代码] main.py:422（_entity_collection_name）、:1186-1191：
- payload = {data: 实体文本, entity_type, linked_memory_ids: [...], ...作用域字段}
- 合并规则：文本归一化精确命中，或向量相似度 ≥ 0.95 → 更新既有实体并并入 linked_memory_ids；否则新建（:1164-1191）

**存储位置**：
- 向量库：由 config.vector_store.provider 决定（qdrant/chroma/faiss/pgvector/pinecone/…，mem0/vector_stores/ 下 30+ 文件）
- SQLite：history 表（id, memory_id, old_memory, new_memory, event, created_at, updated_at, is_deleted, actor_id, role）[代码] storage.py:102-121；messages 表（id, session_scope, role, content, name, created_at）[代码] storage.py:128-148
- 默认 DB 路径：mem0 包目录下 history.db [代码] configs/base.py:42-45；SQLiteManager 自身默认 :memory:（storage.py:12）
- **没有** per-memory 文件、没有 YAML/Markdown 落盘、没有图数据库 [代码]（mem0/ 下 glob **/*graph* 为空）+ [README] 平台文档说 graph 是平台内建 docs/platform/features/graph-memory.mdx:3-8

**schema 定义在哪**：payload 无 schema 文件，靠写入处字典字面量（main.py:1030-1039）与读取时白名单（:1704-1713）维持；SQLite schema 在 mem0/memory/storage.py:102-148；配置 schema 在 mem0/configs/base.py:29-57。

## 写入路径

**触发**：应用显式调用 memory.add(messages, user_id=...)，没有钩子、没有自动监听 [代码] main.py:760-773。

**谁决定写**：两层。第一层是调用方（给什么消息、infer 真假、expiration_date）；第二层是 LLM（决定抽哪几条事实）。代码不做规则式判定 [代码]。

**抽取方式**：
- infer=False：每条 message 原样存一条（跳过 system）[代码] main.py:882-916
- infer=True（默认）：单次 LLM 调用 → ADDITIVE_EXTRACTION_PROMPT [代码] main.py:942-964，prompts.py:468
- 提示词的核心约束 [代码] prompts.py:472-546：
  - "Your sole operation is ADD"（:472）
  - 用户与助手消息都抽；助手推荐/计划/达成的约定算一等公民（:474、:486-488、:567-572）
  - 不抽：空洞的助手评价、寒暄、助手自我描述（:490-493、:576）
  - 去重参考："Recently Extracted"（最多 20 条）+ "Existing Memories"（:501-516）
  - 时间锚定：所有相对时间按 Observation Date 折算成绝对日期，禁止用当前日期（:524-540）
  - 相关旧记忆通过 linked_memory_ids 关联，而不是覆盖（:513、:701）
  - 输出 schema：{"memory":[{"id":"0","text":"..."}]}（:718-722）

**去重与噪声控制**（三道，全部是廉价补丁而不是裁决）：
1. LLM 侧语义去重：提示词让它别重复抽（prompts.py:503-516）
2. 哈希精确去重：md5(text) 命中旧 hash 或本批 hash 就跳过 [代码] main.py:1022-1026。**注意窗口很小**：旧 hash 只来自 Phase1 的 top_k=10 检索结果（:928-933、:1009-1013），所以「第 11 条之外的旧重复」抓不到 → 与 issue #7123 描述一致
3. 实体层合并：同实体不同记忆合并成 linked_memory_ids，不新建重复实体 [代码] main.py:1164-1191

**失败处理（V3 的工程改进）**：
- LLM 抽取失败不再静默返回空列表，抛 LLMError（main.py:965-971，注释明确说旧行为是 silent return []）
- 批量 insert 失败逐条重试；全部失败抛 VectorStoreError（:1056-1076）
- 只有真正落库的记录才写 history、才进返回值（:1052-1055 注释）
- 跳过的重复项默认只在 debug 日志出现，返回值里没有「为什么没存」→ 正是 issue #7865 的抱怨

**UPDATE / DELETE API 存在，但不在写入链路里**：memory.update(memory_id, data) 是显式重写（main.py:1829、:2052），delete 是显式删除（:1883、:1904）。抽取过程永远不会触发它们。

## 点名深挖：记忆分层策略、记录-提取-召回整体链路、冲突/更新（ADD/UPDATE/DELETE）判定、episodic 与 semantic 分区、多框架适配

### 1) 记忆分层策略：只有「作用域分层」，没有「抽象层级」

- 作用域三层：user / agent / run，可任意组合过滤 [代码] main.py:822-827、:926、:1471-1475。检索必须至少给一个，否则 ValueError（:1471-1475）。
- 类型层：只有 MemoryType.PROCEDURAL（"procedural_memory"）一种特殊类型，且代码已标 TODO 计划在未来破坏性版本移除 [代码] main.py:793-796、:853-856、:2007-2048
- **没有** 短期/长期、工作记忆/语义记忆、原始层/摘要层之类的分层。所有记忆平铺在一个向量集合里，唯一区别是 payload 字段与作用域 [代码] main.py:1030-1039
- [推断] README 声称的 "Multi-Level Memory: retains User, Session, and Agent state"（README.md:89）在实现上就是 user_id/run_id/agent_id 三个过滤维度，不是不同寿命的存储层。

### 2) 记录 → 提取 → 召回 全链路（逐段）

| 段 | 做什么 | 参数/默认 | 证据 |
|---|---|---|---|
| 记录 | 原始 messages 落 SQLite，供下一轮指代消解 | 最近 10 条（get_last_messages limit=10） | main.py:922、:1207；storage.py:128-148 |
| 提取 | 单次 LLM，加法式抽取 | 每轮 1 次 LLM；抽 0..N 条事实 | main.py:942-964 |
| 归并 | md5 去重 + 实体链接 | 去重窗口 top_k=10；实体合并 0.95 | main.py:928-933、:1022、:1166-1167 |
| 召回 | 三路信号融合 | 语义池 max(top_k*4,60)；阈值 0.1 只卡语义 | main.py:1655、1698；scoring.py:111-119 |
| 输出 | 返回 list[MemoryItem]，不拼 prompt | 默认 top_k=20 | main.py:1397、1536 |

### 3) 冲突 / 更新判定：**V3 之后不存在了**

这是一个必须写清楚的版本分水岭：

- **旧机制（仍留在代码里但已死）**：DEFAULT_UPDATE_MEMORY_PROMPT [代码] prompts.py:176 起，get_update_memory_messages()（:406）。grep 全仓，这两个符号除了定义处**没有任何调用点**（grep "DEFAULT_UPDATE_MEMORY_PROMPT|get_update_memory_messages" 只命中 prompts.py:176、:406-409）→ 死代码。
- **新机制**：ADD-only。旧记忆只被「链接」，不被改写；冲突表现为两条并存的事实，靠检索时的实体 boost 与时间信息让较新那条排前面 [代码] main.py:881-1220 + [README] README.md:68。
- **文档漂移证据**：add() 的 docstring 至今仍写 "an LLM is used to extract key facts ... and decide whether to add, update, or delete related memories" [代码] main.py:790-792，与实现直接矛盾。这是本项目最典型的坑：读文档会得到错误模型。
- 平台侧是否保留 UPDATE/DELETE：README 与迁移指南说 v3 是 ADD-only，但平台有 proprietary optimizations [README] README.md:65、:74；**OSS 代码里确定没有** [代码]。

### 4) episodic 与 semantic 分区：**不存在**

- grep "episodic" 在 mem0/ 下 0 命中；"procedural" 仅命中上文所述 MemoryType [代码]。
- 语义上最接近的替代物：role（user/assistant）、actor_id、attributed_to 三个字段标记「谁说的」[代码] main.py:896-901、:1038-1039；以及 created_at 供时间排序。没有「事件记忆 vs 事实记忆」的建模。
- 结论：**Mem0 对 episodic/semantic 不做分区，只做「事实平铺 + 作用域过滤 + 实体链接」**[代码]。这也解释了为什么时间推理（temporal）被做成平台增值功能（README.md:72）。

### 5) 多框架适配：靠「插件 + MCP」而不是适配器层

- 核心库不感知框架：只有 add/search/get_all/update/delete/history 等原子方法 [代码] main.py:760-2190
- 集成层是独立目录，每个框架一个插件包，各自带 MCP server：[代码] integrations/{claude-code,codex,cursor,kimi,deepseek,hermes,opencode,antigravity,pi-agent,openclaw}-plugin/*/mcp_server.py；另有 n8n-nodes-mem0、zapier-mem0、vercel-ai-sdk、mem0-strands
- 文档面覆盖 37 个集成页 [代码] docs/integrations/*.mdx（agno、autogen、crewai、langchain、langgraph、llama-index、dify、flowise、openai-agents-sdk、livekit、pipecat 等）
- 插件侧还有自己的批处理 worker：[代码] integrations/claude-code-plugin/core/flush_worker.py:25
- [推断] 这种「一个框架一个插件」成本很高（十余份 mcp_server.py 复制），但换来了对每个宿主 hook 语义的贴合；对本地优先插件是可借鉴的边界划分，不是可借鉴的实现方式。

## 读取路径

**检索方式：向量 + BM25 关键词 + 实体 boost 的加法融合** [代码] main.py:1642-1701、utils/scoring.py:60-139

1. query 预处理：lemmatize_for_bm25(query)、extract_entities(query)（main.py:1647-1649）
2. 语义检索：top_k 放大到 max(top_k*4, 60) 作为候选池（:1655）
3. 关键词检索：vector_store.keyword_search(lemma, top_k=internal_limit)（:1661-1663）。存储不支持时启动即告警，降级为纯语义（:543-550）
4. BM25 归一：按 query 词数选 sigmoid 中点/陡度（≤3 词 5.0/0.7；≤6 词 7.0/0.6；≤9 词 9.0/0.5；≤15 词 10.0/0.5；>15 词 12.0/0.5），再 1/(1+exp(-k(x-m))) 压到 [0,1]（scoring.py:16-40、:43-54）
5. 实体 boost：query 实体最多 8 个 → 实体库检索（阈值 ≥0.5）→ 命中实体的 linked_memory_ids 每个记忆取最大 boost，上限 0.5（main.py:1747-1760；scoring.py:57）
6. 融合：combined = min((semantic + bm25 + entity)/max_possible, 1.0)，max_possible 随活跃信号在 1.0/1.5/2.0/2.5 之间自适应（scoring.py:97-119）
7. 阈值：**只对 semantic_score 生效**（scoring.py:110-112，注释在 :74-75 明说）。也就是说 BM25/实体再强，语义分低于 0.1 也进不来
8. 排序：按 combined 降序取 top_k（scoring.py:138-139）
9. 过期过滤：payload.expiration_date 已过且 show_expired=False 则丢弃（main.py:1684-1685、:442）
10. 可选重排：rerank=True 且配置了 reranker 才走；失败回退原结果不报错（main.py:1514-1519）

**默认参数**：top_k=20、threshold=0.1、rerank=False、explain=False（main.py:1397-1401）。

**注入到 prompt 的形态与 token 预算：本项目不做。**
- search() 只返回结构化结果（main.py:1536），没有任何「拼进 system prompt」的代码路径；调用方自己决定格式。
- MEMORY_ANSWER_PROMPT（prompts.py:4-13）是问答用模板，未被 search 调用。
- 没有 token 预算/截断逻辑（代码中无 tiktoken 或 token 计数）；唯一相关约束是 top_k 与候选池倍数 [代码]。
- README 的评测口径是 top_200 检索预算、约 7K tokens（README.md:58-65）——benchmark 设定，不是运行时预算 [README]。

## 生命周期规则与参数

**结论：OSS 版本没有衰减、没有晋升、没有降级、没有合并、没有自动遗忘。** 只有两件东西：显式过期日期 + 显式删除。

| 机制 | 是否存在 | 具体规则/参数 | 证据 |
|---|---|---|---|
| 过期（TTL） | 有，但只是硬过滤 | expiration_date "YYYY-MM-DD" 写入 payload；检索与 get_all 默认隐藏，show_expired=True 才返回 | main.py:427-442、:820-829、:1684-1685、:788-789 |
| 衰减 decay | **无**（平台独有） | OSS 显式报错 "The decay parameter is not supported by the OSS Memory SDK." | notices.py:134；client/project.py:410-412（"Toggle Memory Decay ... Off by default"） |
| 半衰期 | 无 | 全仓无 half_life 实现 | grep 结果 |
| 晋升 / 降级 | 无 | 没有 importance/热度/层级字段，没有升层逻辑 | 数据模型仅 main.py:1030-1039 所列字段 |
| 合并（consolidation） | 无 | 旧记忆只被 linked_memory_ids 关联，正文不改写 | main.py:1168-1191；README.md:68 |
| 遗忘 / 淘汰 | 仅显式 delete / delete_all | delete(memory_id)、delete_all(user_id/agent_id/run_id) | main.py:1883、:1904 |
| 定期整理任务 | 无 | 见「后台调度」 | grep |

**最刺眼的一处设计**：notices.py 专门写了 detect_decay_usage_from_delete()（:341）与 detect_decay_usage_from_delete_all()（:361）——当用户在一周内删除 ≥5 条记忆（DECAY_USAGE_DELETE_THRESHOLD=5，窗口 7 天，上限 10 次，notices.py:114-117），就判定「你在手工模拟衰减」，弹出平台 decay 功能的推销。**这是「OSS 缺能力 → 用行为埋点做升级引导」的实证**，也是评估「Mem0 有没有生命周期」最硬的证据：不仅没有，产品上还明确把它当付费差异点。

## 后台调度

**OSS 核心零后台任务。**
- grep schedule|cron|asyncio.create_task|BackgroundTasks|celery|APScheduler 在 mem0/*.py 内**没有一处调度实现**，仅命中提示词里 "plans or schedules created" 之类自然语言（prompts.py:486、:569）
- 所有工作在调用栈内同步完成（add 一个 LLM 调用 + 若干 embed；search 两次检索）；AsyncMemory（main.py:2195）只是异步 API 面，不是 worker
- 并发与幂等：SQLiteManager 用 threading.Lock 串行化写（storage.py:15、:26、:103）；向量库写入无事务语义，靠 md5 去重做幂等——但窗口只覆盖 top_k=10（main.py:928-933），所以重试可能重复（issue #7879、#7123）
- 失败恢复：批量操作逐条回退（main.py:1056-1076、:998-1005、:1090-1098）；实体链接整体失败只 warn 不阻塞（:1203-1204）
- 唯一的「后台」在插件层：integrations/claude-code-plugin/core/flush_worker.py:25，负责把 hook 收集的事件刷进 mem0，属于宿主适配而非核心调度

## 工程形态与代价

- 语言/依赖 [代码] pyproject.toml:15-25：Python ≥3.10，核心依赖 qdrant-client、pydantic、openai、httpx、posthog、pytz、sqlalchemy、protobuf。注意**默认就带 qdrant-client 和 openai**——即「本地优先」也要拉一个向量库客户端与云 LLM SDK
- 可选 extras：vector-stores 一档列了 20+ 后端（chromadb、faiss、pinecone、pgvector、milvus、weaviate、redis、elasticsearch、mongodb、oracledb、databricks…）[代码] pyproject.toml:27-60；nlp 档为 spacy（BM25 词形还原用）
- 部署复杂度：库模式 0 运维但需 LLM/embedding key；自托管 = FastAPI + Postgres（alembic 6 个迁移）+ dashboard + docker compose（server/main.py:322-557；server/alembic/versions/*）；平台为托管
- 可观测性：posthog 埋点（mem0.add / mem0.search / mem0.init / mem0.reset，main.py:1214-1219；telemetry.py:54），可用 MEM0_TELEMETRY 关闭（main.py:516）；日志用 logging；**无 metrics、无 tracing** [代码]
- 性能数字（全部来自 README 表格，单一来源且明确是平台口径）[README] README.md:58-65：

| Benchmark | Old | New | Tokens | Latency p50 |
|---|---|---|---|---|
| LoCoMo | 71.4 | 92.5 | 7.0K | 0.88s |
| LongMemEval | 67.8 | 94.4 | 6.8K | 1.09s |
| BEAM (1M) | — | 64.1 | 6.7K | 1.00s |
| BEAM (10M) | — | 48.6 | 6.9K | 1.05s |

  原文自陈："Scores reflect Mem0's managed platform, which includes proprietary optimizations not available in the open-source SDK; open-source users should expect directionally similar gains but not identical numbers."（README.md:65）→ **任何引用 92.5 的说法都必须带上这句限定**，否则是错误归因。
- 论文（2025-04）与 README（2026-04 新算法）不是同一代数字：论文讲 extraction+consolidation 那套，README 已改为 ADD-only V3 [README] README.md:56-74；引用论文数据前必须核对版本。

## 可迁移到「本地优先的 DSH 插件」的部件

逐条：能搬什么 / 搬过去会坏在哪。

1. **加法式抽取提示词的「纪律条款」**（prompts.py:472-546）
   能搬：a) "sole operation is ADD" 消除冲突裁决这类最贵、最易幻觉的 LLM 决策；b) 强制把相对时间折算成绝对日期（:524-540）——本地插件没有服务端时钟校准，这条更重要；c) no-echo 规则（:574、:682）避免助手复述被存成新事实；d) "entity 出现 ≠ 该实体所有信息已捕获"（:516）写得很细。
   会坏在哪：这套提示词假设有 Observation Date 与 recently-extracted 列表两个外部输入（:501-521）。本地插件若没有会话边界/时间戳，日期锚定会退化成「按当前时间瞎算」，比不锚定更糟。

2. **md5 精确去重 + 候选窗口**（main.py:1009-1026）
   能搬：极便宜、零 LLM、可离线，适合本地优先。
   会坏在哪：窗口只有 top_k=10（:928-933），长会话必然漏判 → 社区已在 #7123（TS 侧硬编码 top-10 无相似度阈值）与 #7879（SQLite 写失败仍落向量，重试即重复）踩到。搬的时候要换成「按 scope 全量 hash 集合」或「嵌入相似度 > 0.95 才算重复」，成本从 O(10) 变 O(n)，本地库撑得住。

3. **加法融合打分与自适应除数**（utils/scoring.py:60-139）
   能搬：三路信号各自归一后相加、除数随活跃信号变化（1.0/1.5/2.0/2.5），实现 30 行、无外部依赖，非常适合本地 SQLite FTS5（替代 keyword_search）+ 任意向量索引。
   会坏在哪：a) 阈值只卡语义分（:110-112），本地小模型 embedding 分布偏移时 0.1 几乎无意义，必须重标定；b) 依赖存储实现 keyword_search（main.py:543-550 会静默降级），本地若无 FTS5 就退化成纯语义，融合逻辑白写；c) entity boost 上限 0.5 会让「实体命中但语义不相关」的记忆挤进结果。

4. **实体链接表（entity → linked_memory_ids）**（main.py:1100-1204）
   能搬：这是 Mem0 最像「图记忆」的部分，却只需一张普通表 + 可选向量；对本地插件实现「跨会话同一实体聚合」性价比极高，且不需要 Neo4j。
   会坏在哪：合并阈值 0.95（:1166-1167）在不同 embedding 模型下不稳定，容易把本不该合并的实体并成一个节点；实体抽取成本会翻倍（add 时多一轮）。

5. **history / messages 双表审计**（storage.py:102-148）
   能搬：event + old_memory/new_memory + is_deleted 的审计流，天然适配「记忆可回溯、可撤销」的本地需求；messages 表带 session_scope，可做指代消解（main.py:922 取最近 10 条）。
   会坏在哪：Mem0 的 history 只记 ADD（因为不更新），一旦本地插件要做 UPDATE/合并，old_memory/new_memory 语义必须自己补齐；且 SQLiteManager 单锁串行（storage.py:15），高并发写会成瓶颈。

6. **过期字段（expiration_date + show_expired）**（main.py:427-442、:1684-1685）
   能搬：最小可用的「遗忘」原语，比伪造衰减曲线诚实——到点就隐藏，不做伪精确打分。
   会坏在哪：它是硬过滤，没有「临期降权」，排序里看不出「这条快过期」；且过期项仍参与 add 去重上下文（issue #7620 才修，2026-10-12 closed）。

**最不该照抄的一条：ADD-only + 永不整理。**

理由不是「加法式抽取不好」——恰恰相反，它是 Mem0 这轮涨分的关键（README.md:68）。不该照抄的是**把「整理」整体外包给付费平台**的组合后果：OSS 里既没有 decay（notices.py:134 明说 OSS 不支持），也没有任何后台任务（grep 零命中），于是记忆只增不减、只链不改。对本地优先插件，这意味着磁盘与检索噪声单调增长，而用户没有任何内建手段回收——只能 delete，而 delete 又被产品当成「你想要 decay」的信号去打点（notices.py:341-371）。本地插件必须自己补上「合并/淘汰」这一环，且必须可解释、可回滚（例如按 scope 容量上限 + 时间衰减权重 + 合并时保留 history），而不是照搬 Mem0 的沉默积累。

## 未证实 / 缺口

1. **star 数只有单一来源**（api.github.com，2026-11-22 抓取）。GitHub 网页为 React 渲染，未取到页面级二次确认。→ 引用时标注「api 抓取」。
2. **图记忆的归属**：mem0/ 下无 *graph* 模块（glob 空），docs 称 graph 为平台内建（docs/platform/features/graph-memory.mdx:3-8、:22）；但仓库有 .gitmodules（仅 evaluation → memory-benchmarks，:1-3），我未逐一检查历史 tag，**不能 100% 排除旧版本或平台侧存在独立图实现**。→ 结论限定为「当前 main 的 OSS 树里没有图存储」。
3. **平台侧是否仍有 UPDATE/DELETE 判定**：OSS 代码没有；平台闭源，只有 README 的 "no UPDATE/DELETE" 声明（README.md:68）与 "proprietary optimizations"（:65）。→ 未证实。
4. **token 预算**：代码里没有任何注入/截断逻辑，因此「Mem0 的 prompt 注入形态」在 OSS 层不存在；README 的 7K tokens 是评测口径。→ 若需要「它如何注入」，答案只能是「调用方自己拼」。
5. **性能数字未经独立复现**：README 表格为厂商自测；论文（arXiv:2504.19413）是上一代算法。声称「92.5」时必须附 README.md:65 的限定语。
6. **issue 抽样偏差**：我按 keyword 检索了 duplicate / memory quality / extraction / slow 四组（GitHub Search API），只看标题与状态，未逐条读正文；#7953（BYOK 88% 解析失败）是平台问题，不代表 OSS。
7. **未跑的验证**：没有实际 pip install / 跑 add+search 做端到端复现；所有结论来自静态读码 + 官方文档 + issue 标题。行号对应该 commit，后续提交会漂移。

## 来源清单

- Mem0 仓库首页 — https://github.com/mem0ai/mem0 — 2026-11-22
- Mem0 README（新算法表、ADD-only 声明、部署形态）— https://raw.githubusercontent.com/mem0ai/mem0/main/README.md — 2026-11-22
- Mem0 论文 "Building Production-Ready AI Agents with Scalable Long-Term Memory" — https://arxiv.org/abs/2504.19413 — 2026-11-22
- GitHub API 仓库元数据（stars/forks/language/pushed_at）— https://api.github.com/repos/mem0ai/mem0 — 2026-11-22
- Graph Memory 文档（平台内建、替代外部图库）— https://github.com/mem0ai/mem0/blob/main/docs/platform/features/graph-memory.mdx — 2026-11-22
- Issue #7123（mem0-ts add 去重硬编码 top-10 无阈值 → 重复记忆）— https://github.com/mem0ai/mem0/issues/7123 — 2026-11-22
- Issue #7879（SQLite history 失败仍落向量 → 重试产生重复）— https://github.com/mem0ai/mem0/issues/7879 — 2026-11-22
- Issue #7865（add 静默丢弃，不告知为何没存）— https://github.com/mem0ai/mem0/issues/7865 — 2026-11-22
- Issue #7953（Platform BYOK 抽取 88% 解析失败）— https://github.com/mem0ai/mem0/issues/7953 — 2026-11-22
- Issue #7620（过期记忆污染 add 去重上下文，已关闭）— https://github.com/mem0ai/mem0/issues/7620 — 2026-11-22
- Issue #7274（截断的抽取 JSON 抢救，已关闭）— https://github.com/mem0ai/mem0/issues/7274 — 2026-11-22
- Issue #4707（JS OSS add() 在慢 LLM 下挂起，已关闭）— https://github.com/mem0ai/mem0/issues/4707 — 2026-11-22
- 代码：mem0/memory/main.py、mem0/memory/storage.py、mem0/configs/prompts.py、mem0/configs/base.py、mem0/utils/scoring.py、mem0/memory/notices.py、mem0/client/project.py、server/main.py、pyproject.toml（commit fff8a64，本地克隆 D:\tmp\mem0recon）— 2026-11-22
