# elo-memory · 实现机制 digest

> 研究对象：https://github.com/server-elo/elo-memory
> 取证方式：从 codeload 拉取 main 分支 tarball（2026-11-22 20:23 抓取）后本地逐文件阅读；GitHub REST API 取元数据与 issue 列表。以下行号均对应本次 tarball 中的 elo-memory-main/。
> 约定：**[代码]** = 源码确实这么写；**[README 声称]** = 仅文档宣称、代码未见；**[推断]** = 我基于代码的判断，未经运行验证。

## 身份确认（URL、star、语言、最近提交、是否有论文）

| 项 | 值 | 证据 |
|---|---|---|
| 仓库 | github.com/server-elo/elo-memory，非 fork，描述为空 | api.github.com/repos/server-elo/elo-memory（2026-11-22 抓取） |
| Star / Fork | 11 / 1 | 同上 |
| 主语言 / 体积 | Python / 327 KB | 同上；tarball 共 79 个文件 |
| 创建 / 最后推送 | 2026-03-24 / 2026-04-07 | 同上；包内文件 mtime 2026-04-08 |
| 版本 | 0.3.1 | `pyproject.toml:7` |
| 许可 | BSL-1.1（非 MIT；CHANGELOG 仍写 MIT，自相矛盾） | `pyproject.toml:10`、`LICENSE`、`CHANGELOG.md:12` |
| 作者 | Lorenc Ndoj, Elvi Zekaj | `pyproject.toml:12-15` |
| 论文 | 无。README/代码只引用他人文献（EM-LLM、A-MEM、Tulving 等），无自研论文链接 | `src/elo_memory/memory/episodic_store.py:8-11`、`memory/forgetting.py:8-11` |
| Issues | 0 open / 1 closed：#1 "Comprehensive quality improvements: tests, validation, logging, caching" | api.github.com/.../issues?state=all（2026-11-22） |

**内容吻合确认**：README 描述的 16 组件（governor / causal / dream / auditor / prefetcher / world simulator / evolution / federation）在源码中均有对应文件，且 `brain.py` 中逐一实例化（`src/elo_memory/brain.py:100-120`）。不存在 mismatch。

## 一句话定位

一个"单机、零 API key、纯 Python"的 **agent 长期记忆库**：用规则抽取 + 句向量检索 + 心理学启发式（惊讶度、遗忘曲线、睡眠式巩固）拼出"会做梦、会画因果图、会自证未篡改"的记忆层，主打"不调 LLM、成本 $0、66ms"（`README.md:251-265`，数字为作者自测，见"未证实"）。

## 架构总览（组件与数据流）

**[代码]** 宿主形态有四种外壳，核心是同一个 `EloBrain`：

- 库：`pip install elo-memory`，`from elo_memory import EloBrain`（`README.md:1-40`）
- CLI：`brain` 入口，默认以本地 HTTP 服务方式跑（`pyproject.toml:74-76`、`src/elo_memory/brain.py:378-400`，服务地址硬编码 http://127.0.0.1:9876）
- 本地 HTTP 服务：`src/elo_memory/memory_server.py`（564 行，路由见 :594 的 `/forget`）
- MCP server：`mcp_server.py` / `mcp_server_async.py` + `MCP_SETUP.md`（仓库根目录，非 src 包内）

组件装配在 `EloBrain.__init__`（`src/elo_memory/brain.py:100-120`）：`UserMemory`（episodic store + two-stage retriever + entity extractor）、`KnowledgeBase`、`MemoryGovernor`、`CausalInferenceEngine`、`DreamConsolidation`、`ParametricEvolution`、`MemoryAuditor`、`PredictivePrefetcher`、`WorldSimulator`、`FederationClient`。

数据流（`process_turn`，`src/elo_memory/brain.py:238-269`）：
1. `self._kb.update(user_message)` —— 先抽结构化事实（:247）
2. 构造 `DecisionContext(surprise=0.5)` 并 `self._governor.decide(ctx)`（:252-253）
3. 若 `_should_skip` 为假 → `self._memory.store(text)`（:255-256）
4. 因果抽取 `self._causal.ingest(...)`、审计链 `_auditor.add_to_chain(...)`、prefetcher 观察（:258-264）
5. 助手回复中的承诺被单独存为 [assistant commitment] 记忆（:266-269）

读取流（`prepare`，`src/elo_memory/brain.py:145-200`）：KB 查询 + `_memory.recall(q, k*2)` + KB 值命中加成 + 拼 prompt。

**[推断]** 架构是"多模块并置"而非"分层管线"：每个模块自带 JSON 持久化，单独 save/load，彼此只通过 brain 手工调用串联；dream、evolve、decay 之间没有自动编排（见深挖节）。

## 数据模型与存储

**[代码]** 记忆单元 `Episode`（`src/elo_memory/memory/episodic_store.py:38-85`）：

| 字段 | 类型 | 含义 |
|---|---|---|
| content | np.ndarray \| Dict | 负载；实际写入时为 {"text": ...} |
| timestamp | datetime | 编码时间 |
| location | str? | 空间上下文 |
| entities | List[str] | 实体名 |
| embedding | np.ndarray? | 向量（默认 embedding_dim=512，见 :114；UserMemory 用 384，user_memory.py:291） |
| surprise | float | 惊讶度（写入时多为 0.0） |
| importance | float=0.5 | 巩固优先级 |
| metadata | Dict | text/topics/session_id/entities_structured/_retrieval_count/_activation/_dream_pruned 等 |
| episode_id | str | ep_{ts}_{uuid12}（:64-69） |

存储是**三层混合**，无 SQLite：
1. 内存热存 `self.episodes: List[Episode]` + 四个索引（id / 时间 / 空间 / 实体，:151-163）
2. 向量库 ChromaDB `PersistentClient`（:192-199），或 FAISS 选项（:122）
3. 磁盘 JSON 冷存：`persistence_path/offloaded/{episode_id}.json`（:714-723），状态 `json.dump`（:780）；`_load_offloaded_episode` 明确注释"已移除 pickle 以防任意代码执行"（:727-732）

结构化事实有第二套存储：`KnowledgeBase`（`memory/knowledge_base.py`，817 行）以 key → value 存 `self._facts`，`json.dump(..., indent=2)` 落盘（:891）。因果图 `causal_graph.json`、演化权重 `evolution.json` 存于用户目录（`brain.py:366-371`）。

**[代码]** 每个用户一个目录：`persistence_path/{user_id}/`，user_id 超 80 字符则 sha256 截断（`user_memory.py:301-306`），并用 `filelock` 做跨进程互斥（:309）。

## 写入路径

- **触发**：每次调用 `brain.think()` / `process_turn()`。`think` = `prepare` → `llm_fn(prompt)` → `process_turn`（`brain.py:129-139`）。
- **谁决定写**：两道闸。第一道是 `MemoryGovernor` 的 Thompson Sampling（`brain.py:253`），但见下"坑"：实际喂进去的是常量上下文。第二道是 `_should_skip(text)` 垃圾过滤（:255），README 点名会跳过 "thanks / ok / what time?"（`README.md:47`）；**[代码]** 过滤函数存在于 brain.py 模块级（未逐行取证其规则）。
- **抽取方式**：**纯规则，不调 LLM**。实体由 `EntityExtractor` 正则抽取（`user_memory.py:569-570`），主题由 `_TOPIC_RULES` 关键词表匹配（:384-393），事实由 `KnowledgeBase.update` 的 key-value 模式抽（`brain.py:247`）。
- **去重**：余弦阈值 `DUPLICATE_COSINE_THRESHOLD = 0.92`（`user_memory.py:285`）；≤200 条时全量扫描，>200 条时走向量库且阈值抬高到 0.95（:399-425）。命中即 `{"stored": False, "reason": "near-duplicate"}`（:560-566）。已 `_superseded` 的记忆不参与去重比较（:419）。
- **派生事实**：原句之后会再存若干 `_generate_derived_facts` 产生的句子，`derived_from` 指回原 episode（`user_memory.py:594-610`）。**[推断]** 这会让"一条用户输入"膨胀为多条记忆，是后续相似度噪声的来源之一。
- **干扰正交化**：新 embedding 会与最近 `interference_check_window=100` 条做正交化（`episodic_store.py:310-320`，`interference.py:25` 阈值 0.85）。副作用：写进库的向量已不是原始句向量，所以去重阈值在 >200 条时被迫 +0.03（`user_memory.py:412-416`，代码注释自认）。

## 点名深挖：“在线积累信号 → 后台 dream 更新权重/衰退系数”完整链路、dream 周期、因果 DAG 抽取、episodic+facts 双召、冲突检测

这一节必须先给结论：**委托书假设的"在线信号 → 后台 dream 调参"闭环，在代码里不存在；它只存在于 README 叙述中。**

### 1) 闭环：设计意图 vs 实现

- **[README 声称]** brain.think() 后 governor 学到这条值得存、evolution 适配 embedding（`README.md:9-14`）；"After dreaming: world simulator re-segments, evolution updates weights, causal engine decays stale links"（`README.md:172`）。
- **[代码]** `brain.dream()` 全文只有一句：`self._dream.dream(store=self._memory._store)`（`src/elo_memory/brain.py:345-347`）。**没有** re-segment、没有 `evolve()`、没有 `decay_strengths()` 调用。全库 grep dream 仅命中这些点，无 `process_turn` 内的自动触发。
- **[代码]** `brain.process_turn` 里 governor 只被 `decide()`，上下文是硬编码 `DecisionContext(surprise=0.5)`（`brain.py:250-253`）；在该函数内没有 `record_decision()`，也没有把 retrieval 结果回填给 governor。**[推断]** 因此 `_pending` 队列不会被填充，`_resolve_pending` 的延迟奖励在 brain 主路径上不会发生；"学习用户偏好"的 bandit 实际退化为在某个固定 bin 上按先验采样。
- **[代码]** 唯一真实的"在线信号"是检索时对 episode 的 `_retrieval_count` 自增（`episodic_store.py:515-523, 555-563`），它影响 `compute_activation` 的 rehearsal boost；这个计数不落盘为学习率，也不进入 governor 或 evolution。
- **[代码]** evolution 的更新由 `brain.evolve()` 手动调用（`brain.py:352-353`），README 说"每次 prepare() 都喂训练数据、每次 dream() 触发权重更新"（`README.md:150`）在 `prepare` 内未见任何 `_evolution` 调用（`brain.py:145-200`）。

### 2) dream 周期与四阶段

- **[代码]** 触发：**仅手动** `brain.dream()`（`brain.py:345`）、HTTP `/dream`（`memory_server.py:606`）、CLI `dream` 命令（`brain.py:548, 703`）。README 的"auto-triggers every 200 episodes"（`README.md:159`）**在代码中没有对应实现**。
- **[代码]** 四阶段（`consolidation/dream_cycle.py:113-147`）：
  1. NREM 优先回放：按 `importance^0.7 * (surprise+0.1)^0.3` 加权无放回抽样 `replay_fraction=0.3`（:41-42, 168-189），每条 `importance *= 1.05`（上限 1.0，:118）
  2. REM 合成：对回放集做 SLERP 式插值/加噪，`augmentations_per_episode=2`、噪声 0.05、`interpolation_count=3`（:45-47）；合成记忆 importance 乘 0.3 并标 `_synthetic`（:128-129）
  3. Deep 抽象：余弦 `cluster_threshold=0.7` 贪心单链聚类，簇 ≥ `min_cluster_size=3` 抽 "principle"（:50-51, 347-369）；同 (topics, 前 3 实体) 重复 ≥ `skill_repetition_threshold=3` 记为 "skill"（:58, 373-398）
  4. Dawn 修剪：activation < `prune_activation_threshold=0.05` 的候选，最多删 `max_prune_fraction=0.1`，做法是 `importance = 0.0` + `metadata["_dream_pruned"]=True`（:54-55, 414-434）
- **[代码]** "修剪"是软删除：episode 仍留在 `store.episodes`，检索排序按 activation 下降名次，但 `retrieve_by_similarity` 里没有 `importance == 0` 的硬过滤（`episodic_store.py:486-568`）。**[推断]** 记忆稀疏时被"剪掉"的记忆仍可能被召回。
- **[代码]** 合成记忆被 append 进 `store.episodes`（`dream_cycle.py:127-131`），但**没有**写进 ChromaDB，也没有更新 temporal/spatial/entity 索引 → 它们无法被向量检索命中（**[推断]** 只当 evolution 的训练数据用，与 README 说法一致，`README.md:125-126`）。

### 3) 因果 DAG 抽取

- **[代码]** 图是 `networkx.DiGraph`（`causal_engine.py:96`），节点 key = 小写归一化文本前 120 字符（:262-265），边属性 `strength / evidence_count / source_episodes / first_seen / last_seen`（:64-73, 232-240）。
- **[代码]** 抽取靠**正则模板表** `_CAUSAL_PATTERNS`，覆盖 "X because Y"、"after X, Y"、"X, therefore Y"、"since X, Y" 等（:55-59 可见后三条；"because" 分支在 :129-134 另抽实体级子链接）。**无 LLM、无句法分析。**
- **[代码]** 噪声控制：丢弃 <2 或 >200 字符的成分（:121-124）；`_is_bad_extraction` 拒绝以 and/but/or 结尾的 cause、以及 cause 与 effect 同时小写且不以 the/a/an 开头的情况（:242-260）。
- **[代码]** 强化：同向边再加一次 → `strength = min(10.0, +1.0)`，`evidence_count += 1`（:223-230）。默认新边 strength=1.0（:69）。
- **[代码]** 衰减：`decay_per_day=0.02`，`decay_strengths(days)` 逐边减 0.02*days，低于 `min_link_strength=0.1` 删除边并清孤立节点（:80-83, 447-459）。**该方法无自动调度点**（不在 dream 内，见上）。
- **[代码]** 查询：`query_causes(effect, depth=3)` 反向 BFS，按 strength 降序（:269-299）；`counterfactual` 移除某 cause 后枚举下游（README.md:125-127 给示例，代码在 causal_engine.py:340-393 区域）。

### 4) 冲突检测（两层，都不是语义判断）

- **因果层**（`causal_engine.py:397-439`）：新边 A→B 若已存在 B→A 且旧边 `strength >= contradiction_threshold=0.5`，记 `reverse_causation`；另用 `nx.simple_cycles` 找环（上限 20 条）。只记录，不消解。
- **情节层**（`memory/user_memory.py:438-503`）：三类规则 —— ① 显式过渡 "switched from X to Y"（`_TRANSITION_PATTERNS`，:442-448）；② 隐式生命阶段 "promoted" → 压制 "junior"/"intern"（`_IMPLICIT_PATTERNS` + `_IMPLICIT_OLD_VALUES`，:450-459）；③ 语义压制："got a new X" 且与旧记忆中等相似（:461-486）。压制方式是把旧 episode_id 加进 `self._superseded` 集合（:483, 503），此后检索过滤（:638-639）、facts（:685-693）、去重（:419）都跳过它。**不删除**，可审计。
- **[代码]** GDPR `forget(text)`：子串匹配 episode → 加 `_superseded`，同时从 KB 删 key 与 `_old_{key}`（`brain.py:308-327`）；HTTP `/forget`（`memory_server.py:594-600`）。

### 5) "episodic + facts 双召"的真实形态

- **[代码]** `UserMemory.recall` 只返回 episode 文本 + 分数（`user_memory.py:627-663`）：向量检索（two-stage）→ 滤掉 superseded → 再用关键词主题补充（`_recall_by_topics`，每命中 1 个主题 +0.3，:665-683）→ 去重取 top-k。
- **[代码]** `brain.prepare` 把 KB 事实单独成段注入：KB key 命中 query/value/text → 该条记忆 +0.15 分（`brain.py:155-171`），随后 prompt 里出现 `## Current facts (Knowledge Base)`（最多 20 条，:178-183）、`## Direct answer from KB`（:185-186）、`## Related memories`（带分数，:188-191）。
- **[代码]** `facts = self._memory.get_facts()` 被算出来并放进返回字典，但**没有**进入 system prompt（`brain.py:173 vs 176-193`）。**[推断]** README 说的 "recalls relevant memories + KB facts in parallel"（`README.md:53`）真实含义 = "两条独立通道各自拼进 prompt"，而不是统一打分排序。

## 读取路径

- **[代码]** 两阶段（`retrieval/two_stage_retriever.py`）：
  - Stage 1 向量召回 `k_similarity`（UserMemory 设为 30，默认 20），余弦硬阈值 `similarity_threshold=0.3`（默认）/ `0.05`（UserMemory 覆盖，user_memory.py:320-322）（two_stage_retriever.py:32-33, 146-154）
  - Stage 2 时间邻域扩张：±`temporal_window=30` 分钟内的 episode 一并纳入（:36, 156-184），模拟"想起一件事带出一串"
  - 排序：`0.4*sim + 0.2*recency + 0.2*importance + 0.2*keyword`（:40-43, 237-241），recency = `exp(-Δt/24h)`（:46, 222）
  - 截断 `max_retrieved=20`（UserMemory）→ 最终 recall 再截到 k（默认 7，brain.prepare 传 k*2）
- **[代码]** 每次召回会给命中 episode 的 `_retrieval_count` +1 并按 activation 重排（`episodic_store.py:553-566`）—— 这是"复述强化"的唯一在线痕迹。
- **[代码]** 缓存：相似度查询 LRU `query_cache_size=128`（:125, 503-525）；prefetcher 用主题转移马尔可夫链预热（`retrieval/prefetcher.py`，README 称命中 5ms vs 60ms，README.md:181）。
- **token 预算**：**[代码] 无**。全库 grep 无 max_tokens/截断逻辑；prompt 只有"KB 事实最多 20 条"（brain.py:180）与 top-k 条记忆两个软上限。**[推断]** 单条记忆长度不受控，长对话可能撑爆上下文。
- **[代码]** 注入形态（`brain.py:176-193`）：system_prompt + `## Current facts (Knowledge Base)`（自然语言化，如 "Works at {value}"，见 :206-232）+ `## Direct answer from KB` + `## Related memories`（`- [score] text`）。

## 生命周期规则与参数

| 机制 | 规则 / 默认值 | 证据 |
|---|---|---|
| 激活度衰减 | 幂律 A(t) = A0*(1+t_hours)^(-0.5)，decay_rate=0.5；可选指数（use_power_law=True 默认幂律） | memory/forgetting.py:24-28, 77-82 |
| 复述加成 | A0 * (1 + 1.5*ln(1+n))，rehearsal_boost=1.5，刻意用对数防"永生" | :25, 71-74 |
| 遗忘阈值 | activation < min_activation=0.1；遗忘概率 sigmoid，陡度 5.0 | :26, 86-111 |
| 重要性衰减 | 每次 consolidation importance *= 0.99 | episodic_store.py:117, 659-661 |
| 巩固触发（数量/时间取先到） | ≥ consolidation_min_episodes=100（UserMemory 覆写 200）且（新增 ≥500 条 或 距上次 ≥8h）；首轮按首条时间判定 | :118-121, 370-396；user_memory.py:315-317 |
| 巩固动作 | 按 importance 排序，把超出 max_episodes=10000 的尾部写到磁盘并从向量库删除 | :113, 651-712 |
| 晋升 | governor PROMOTE = importance ×1.5；DEMOTE = ×0.6（配置项，是否真正接线见"坑"） | governor.py:73-75 |
| dream 回放强化 | importance ×1.05；consolidation 回放回调 ×1.1 且 _retrieval_count+1 | dream_cycle.py:118；episodic_store.py:643-646 |
| dream 修剪 | activation <0.05，单轮最多 10%，软删除 | dream_cycle.py:54-55, 414-434 |
| 因果边衰减 | −0.02/天，<0.1 删边 + 清孤立节点 | causal_engine.py:80-83, 447-459 |
| 干扰正交化 | 与近 100 条相似度 ≥0.85 时正交化 | interference.py:25；episodic_store.py:124, 310-320 |
| 去重 | 余弦 >0.92（小库）/ >0.95（>200 条走向量库） | user_memory.py:285, 399-425 |

**没有任何"半衰期"参数**：衰减是指数/幂律系数与小时尺度，不是 half-life 配置。**[代码]**

## 后台调度

- **[代码] 没有后台线程/定时器/队列。** 所有"后台"动作都是同步、由某个 API 调用顺带触发的：
  - 巩固检查在 `store_episode` 末尾同步执行 `if self.should_consolidate(): self._consolidate_memory()`（`episodic_store.py:348-351`）—— 峰值请求会承担磁盘 offload 成本。
  - dream 只在 `/dream`、CLI `dream`、`brain.dream()` 被调时跑（`memory_server.py:606`、`brain.py:703`）。
  - governor 的延迟奖励结算挂在下一次 `decide()` 上（每 50 次决策检查一次，`governor.py:186-187, 240-258`）。
- **并发**：用户级 `filelock`（10s 超时，user_memory.py:309）；governor 内部 `threading.Lock`（governor.py:143）；无进程池、无任务队列。
- **幂等 / 失败恢复**：**[代码]** 弱。向量库写入失败只 `logger.error` 后返回 False（episodic_store.py:482-484），无重试、无 outbox；offload 失败仅记日志（:724-725）。状态持久化是全量 `json.dump`（:760-800），没有原子写/临时文件重命名，崩溃可能留半截 JSON。**[推断]** 断电或强杀后 store 可能加载失败。

## 工程形态与代价

- **[代码]** Python ≥3.10（pyproject.toml:11）。依赖较重：chromadb（内含 onnxruntime 等）、sentence-transformers（拉 torch）、hmmlearn、scikit-learn、networkx、aiohttp、filelock（pyproject.toml:40-49）。**"pip install 三行接入"的代价是 GB 级 torch 依赖**；作者也承认首存 ~9s 是模型加载（README.md:250）。
- **[代码]** 部署形态：库 / CLI / 本地 HTTP（127.0.0.1:9876，硬编码，brain.py:382）/ MCP。MCP 入口在仓库根目录（mcp_server.py、mcp_server_async.py、MCP_SETUP.md），不在 src/elo_memory 包内 → **pip 装包拿不到 MCP server**（**[推断]** 需从 git clone 运行）。
- **[代码]** 仓库存在重复实现：根目录的 brain.py(312 行)、memory_server.py(492 行)、mcp_server.py(215 行) 与 src/elo_memory/ 下同名文件（592/564 行）并存，二者不同长度。**[推断]** 根目录是旧版/入口副本，维护双份是明显工程债。
- **可观测性**：**[代码]** logging 到处在用（如 logger.warning("Causal contradiction detected: ...")，causal_engine.py:418）；`what_i_know()` 汇总各模块统计（brain.py:275-302）；HTTP 有 `/health`（brain.py:389）。无 metrics/tracing。
- **性能数字（全部来自作者自测 README，单一来源）**：store 66ms、prepare 62ms、init 129ms、dream 3ms/10 episodes、verify <1ms（README.md:243-255）；"24 题召回 100% vs ChromaDB 83%"（README.md:263）。**测试集未公开、无复现结果，按证据规则只能算 README 声称**（仓库有 benchmarks/bench_retrieval.py，本次未运行）。
- **测试**：18 个测试文件、约 3.9k 行（tests/），含 test_stress.py；CI .github/workflows/tests.yml。**[代码]** 有测试，但无覆盖率数字。

## 可迁移到「本地优先的 DSH 插件」的部件（逐条：能搬什么、搬过去会坏在哪）

1. **power-law activation + 对数 rehearsal（forgetting.py:44-84）**
   能搬：纯 numpy 的十几行公式，无依赖，可直接做"记忆排序衰减因子"。
   会坏：它假设 timestamp 是编码时间且 rehearsal_count 单调递增；DSH 插件若按会话重放历史，计数会重置，"复述越多越难忘"退化为"最近一次会话最难忘"。
2. **两阶段检索的"时间邻域扩张 + 四因子加权"（two_stage_retriever.py:36-49, 156-241）**
   能搬：4 个可解释权重 + ±30 分钟邻域，是给纯向量检索补"上下文连贯性"的低成本手段，且不依赖 Chroma。
   会坏：DSH 的检索对象是文件/工具输出而非等间隔对话，±30 分钟窗口意义不大；keyword_score 只对 content["text"] 生效（:229-235），换成结构化记录会恒为 0。
3. **软删除式冲突压制 _superseded 集合（user_memory.py:438-503, 638-639）**
   能搬：不物理删、只加集合，检索/facts/去重三处统一过滤，天然可审计可回滚——正是本地插件需要的"可撤销记忆"。
   会坏：规则是英文正则（"switched from X to Y"、"promoted"），中文输入几乎零命中；且集合只存 id，重启后要靠 meta.json 恢复（:764），跨设备同步会失配。
4. **正则因果 DAG + 衰减剪边（causal_engine.py:55-60, 447-459）**
   能搬：strength/evidence_count/source_episodes 这套边模型很轻，把"为什么"变成可查询边比塞进 prompt 更省 token。
   会坏：抽取纯正则、英文模板，中文与代码日志基本抽不出边；节点 key 是整句前 120 字符（:265），近义改写会碎成多个节点，图会迅速稀疏。**别照抄这一层。**
5. **governor 的"延迟奖励"记账结构（governor.py:109-118, 240-303）**
   能搬：PendingDecision(action, bin_key, episode_id, timestamp) + 到期结算 + Beta(α,β) 更新，是"存了之后有没有被用到"的可落地记账法，比拍脑袋阈值强。
   会坏：奖励信号依赖"episode_id 是否出现在后续检索结果"，而 DSH 插件常做摘要/改写，id 不稳定；且 ENCODE 的成功奖励需要外部把 _retrieved_ids 填进来（governor.py:150-152），漏接就像本项目一样永远拿不到奖励。
6. **JSON + Chroma 双层存储（episodic_store.py:192-199, 714-740）**
   能搬：热存/冷存分离，冷存纯 JSON 且明确禁用 pickle（安全考虑值得学）。
   会坏：Chroma 的 PersistentClient 会拉起本地服务/重依赖，对"零依赖本地插件"是负担；更该换成 sqlite-vec 或直接 numpy 暴力检索。

## 未证实 / 缺口

1. **"自动 dream 每 200 条"** —— README 声称（README.md:159），代码中无触发点（brain.py:345 仅手动）。**结论：README 与实现不符。**
2. **"dream 后自动 re-segment / evolve / causal decay"** —— README 声称（README.md:172），brain.dream() 无后续调用。**不符。**
3. **governor 是否真的学到策略** —— 主路径喂常量 surprise=0.5 且未见 record_decision（brain.py:250-256）。我未全库确认 record_decision 的其它调用点，故"bandit 从未获得奖励"记为**推断**，非定论。
4. **性能数字**（66ms/62ms/100% 召回）—— 仅 README，无基准复现；benchmarks/bench_retrieval.py 未运行。单一来源，不采信为事实。
5. **与 Mem0 的对比公允性** —— README 对比表暗示同功能（README.md:259-265），但本项目抽取是正则、无 LLM，能力不等价，该对比有误导性（我的判断）。
6. **issue 里的真实抱怨** —— 全库仅 1 个 issue 且为 closed 的自我质量改进（#1），**没有任何用户反馈**；因此"它踩过的坑"只能从代码自证：去重阈值因正交化被迫上调（user_memory.py:405-416）、pickle 移除的 RCE 历史（episodic_store.py:728-732）、根目录与 src 双份实现、无原子写。**外部抱怨：未证实（不存在）。**
7. **MCP 是否可用** —— 有 mcp_server.py / MCP_SETUP.md，本次未运行验证；tests/test_mcp_server.py 存在但我未读其覆盖范围。
8. **中文支持** —— 实体/主题/冲突/因果全部英文正则（user_memory.py:384-393, 432-436；causal_engine.py:55-60）。中文场景效果**未证实**，按代码推断接近失效。

## 来源清单（每行：标题 — URL — 访问日期 2026-11-22）

- elo-memory 仓库主页 — https://github.com/server-elo/elo-memory — 2026-11-22
- elo-memory 源码包（main tarball，逐文件取证） — https://codeload.github.com/server-elo/elo-memory/tar.gz/refs/heads/main — 2026-11-22
- GitHub REST：仓库元数据（star/fork/语言/时间） — https://api.github.com/repos/server-elo/elo-memory — 2026-11-22
- GitHub REST：issue 列表（0 open / 1 closed） — https://api.github.com/repos/server-elo/elo-memory/issues?state=all — 2026-11-22
- README（性能表、对比表、16 组件叙述） — https://github.com/server-elo/elo-memory/blob/main/README.md — 2026-11-22
- 包定义（版本 0.3.1、BSL-1.1、依赖、entry points） — https://github.com/server-elo/elo-memory/blob/main/pyproject.toml — 2026-11-22
