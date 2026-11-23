# MemoryOS · 实现机制 digest

> 调研方式：仓库浅克隆（commit `587ed7755c7aed179965792830ff1b5ad9a6fa92`，2026-07-07）后本地逐文件读源码；论文页与 issue 通过 GitHub API / arXiv 页面取。
> 证据标注约定：**［代码］**= 源码里确实这么写；**［README］**= 项目自述；**［推断］**= 我的推论；**［未证实］**= 本轮没取到证据。
> 仓库内路径一律相对仓库根目录，行号基于上述 commit。

## 身份确认（URL、star、语言、最近提交、是否有论文）

| 项 | 值 | 证据 |
|---|---|---|
| 仓库 | https://github.com/BAI-LAB/MemoryOS | 克隆成功，顶层含 `memoryos-pypi/`、`memoryos-mcp/`、`memoryos-chromadb/`、`memoryos-playground/`、`eval/`、`docs/` |
| Star / Fork | 1626 / 171 | GitHub API `/repos/BAI-LAB/MemoryOS`（2026-11-22 取） |
| 主语言 | Python | 同上 `language=Python`；全部实现为 .py |
| 创建 / 最近推送 | 2025-05-30 创建；2026-07-07 推送 | 同上；本地 `git log -1` = `587ed77 Merge pull request #73 ... fix/thread-safety-mcp-playground` |
| 论文 | arXiv:2506.06326 *Memory OS of AI Agent*；EMNLP 2025 main 接收 | https://arxiv.org/abs/2506.06326 ；README:77（2025-08-21 接收公告） |
| 许可证 | Apache-2.0 | `LICENSE`；README 徽章 |
| **吻合性** | **无 mismatch**：仓库非空，README 自述的四模块（Storage/Updating/Retrieval/Generation）、三层记忆、heat 晋升、MCP 与本轮读到的代码一一对应 | README:209 起；`memoryos-pypi/mid_term.py`、`memoryos-pypi/memoryos.py` |

**"轻量化"这个词需要纠偏**：项目本体不轻。依赖里 pin 了 `faiss-gpu`（`memoryos-pypi/requirements.txt:8`）和 `FlagEmbedding`（同文件 :6），装齐要 GPU 轮子；回复生成默认 `max_tokens=1500`（`memoryos-pypi/memoryos.py:341`）并把"全量用户画像"塞进每次请求（:282-293）。所谓"轻量三层分层"更接近**分层存储 + 事件驱动晋升**这个结构思想，而不是运行时开销小。［推断，依据见上两处代码］

## 一句话定位

给"长期陪伴型个人助理"用的**分层记忆中间件**：把每轮 QA 压在短期队列里，队列满时整批交给 LLM 做主题摘要并升级成"会话段"，段按 heat 阈值攒够热度后再把内容蒸馏进长期记忆（用户画像 + 用户私有知识 + 助手知识），检索时三层并行取回拼进 prompt。

宿主形态是**四种并列**，不是一个：① Python 库 `pip install memoryos-pro` / `import memoryos`（README:246 起安装段、`memoryos-pypi/__init__.py:1`）；② MCP Server（`memoryos-mcp/server_new.py`，暴露 3 个 tool）；③ Chroma 持久化变体（`memoryos-chromadb/`）；④ Flask Playground（`memoryos-playground/memdemo/app.py`）。

## 架构总览（组件与数据流）

组件（README:212-226 的目录说明，与代码一致）：

```
memoryos-pypi/
  memoryos.py   Memoryos —— 编排器：初始化四份存储、add_memory、get_response、heat 触发
  short_term.py 短期：deque(maxlen=N) + JSON 落盘
  mid_term.py   中期：sessions{id -> {summary, summary_embedding, details[pages], heat 因子}} + LFU 淘汰
  long_term.py  长期：user_profiles{uid -> 画像字符串} + knowledge_base/assistant_knowledge（带 embedding 的 deque）
  updater.py    短→中：分页、连续性判定、meta_info、多主题摘要、话题合并
  retriever.py  读：三层并行检索 + top-k 页堆
  prompts.py    全部 LLM 提示词（含 90 维人格分析）
  utils.py      OpenAI 客户端、embedding 缓存、时间衰减、画像/知识抽取
```

数据流（全部**同步内联**，无后台线程/无 cron）：

```
用户一轮对话
  └─ Memoryos.add_memory(user_input, agent_response, ts)          memoryos.py:226
       ├─ if short_term.is_full(): Updater.process_short_term_to_mid_term()   :242-244
       │     ├─ pop 到短队列不满 → 每个 QA 变一个 page（page_id/pre_page/next_page/meta_info）updater.py:117-153
       │     ├─ 逐页 LLM 判"是否与上一页连续"（temperature=0, max_tokens=10）utils.py:359-374
       │     ├─ LLM 生成/滚动更新 meta_info（对话链概览，max_tokens=100）utils.py:376-386
       │     ├─ 整批文本 → LLM 多主题摘要（themes + keywords + content）updater.py:164-170
       │     └─ 每个 theme 调 insert_pages_into_session：与已有 session 算 (cosine + Jaccard) 决定合并 or 新建  mid_term.py:190-279
       ├─ short_term.add_qa_pair(qa)                              short_term.py:18-25
       └─ _trigger_profile_and_knowledge_update_if_needed()       memoryos.py:126-224, 250
             └─ 取 mid-term 堆顶 session，若 heat ≥ 阈值且含未分析页
                   → 并行两路 LLM：画像重写 / 知识抽取（ThreadPoolExecutor(2)）  memoryos.py:154-180
                   → 写 long_term（画像整篇替换、知识按行追加）              memoryos.py:186-204
                   → 该 session 全部 page 标记 analyzed=True，并重置 N_visit / L_interaction  memoryos.py:206-218

用户提问
  └─ Memoryos.get_response(query)                                 memoryos.py:252
       ├─ Retriever.retrieve_context：3 路并行（ThreadPoolExecutor(3)）  retriever.py:100-124
       ├─ 拼 prompt：短期历史 + 【Historical Memory】+【User Profile】+ 知识 +【Assistant Knowledge Base】+ 元数据  memoryos.py:268-327
       └─ LLM 生成回复（max_tokens=1500）→ 回复本身又回灌 add_memory  memoryos.py:338-346
```

## 数据模型与存储

**没有数据库、没有 schema 文件、没有迁移**。四份 JSON 就是全部持久化（`memoryos-pypi/memoryos.py:71-84`）：

```
<data_storage_path>/users/<user_id>/short_term.json
<data_storage_path>/users/<user_id>/mid_term.json
<data_storage_path>/users/<user_id>/long_term_user.json
<data_storage_path>/assistants/<assistant_id>/long_term_assistant.json
```

### 粒度一：QA 对（短期单元）
`{user_input, agent_response, timestamp}`［代码］`memoryos.py:234-239`；timestamp 缺失时由 `short_term.py:20-21` 补。容量 `deque(maxlen=max_capacity)`（`short_term.py:14`），溢出**自动丢弃最旧**（deque 语义），但正常路径会先把满队列刷到中期（`memoryos.py:240-244`）。

### 粒度二：page（中期的最小检索单元）
字段（`updater.py:118-128` + `mid_term.py:144-152`）：
`page_id, user_input, agent_response, timestamp, preloaded, analyzed, pre_page, next_page, meta_info, page_embedding, page_keywords`
- `pre_page/next_page`：对话链指针，构成**时序链**（不是图数据库，是页内两个指针）。
- `meta_info`：LLM 维护的"对话链概览"，同一链上所有页会被批量覆写（`updater.py:70-98`）。
- `page_keywords`：由多主题摘要给出（`updater.py:176`），但检索时基本没用上（见读取路径）。
- `page_embedding`：**归一化后的向量直接以 float 列表存进 JSON**（`mid_term.py:147`、`long_term.py:61-66`）→ 文件体积随页数线性膨胀，bge-m3 是 1024 维，一条 page 光向量就 ~10KB 文本量［推断，按维度与 JSON 序列化估算］。

### 粒度三：session（中期的组织单元）
`{id, summary, summary_keywords, summary_embedding, details[page], L_interaction, R_recency, N_visit, H_segment, timestamp, last_visit_time, access_count_lfu}`［代码］`mid_term.py:156-169`。
即"主题摘要 + 该主题下的页列表 + 热度计分卡"。上限 `max_capacity=2000` 个 session（`mid_term.py:39`，配置默认见 `memoryos-mcp/config.json:8`）。**session 内的 page 数没有上限**（`insert_pages_into_session` 直接 `append`，`mid_term.py:268`）；issue #29 问过这点，已 closed，代码里仍未加页级上限［两条来源：issue #29 + 代码］。

### 粒度四：长期记忆
```python
user_profiles = {user_id: {"data": "<画像字符串>", "last_updated": ts}}   # long_term.py:16, 37-40
knowledge_base = deque(maxlen=capacity)  # 元素 {knowledge, timestamp, knowledge_embedding}  :62-67
assistant_knowledge = deque(maxlen=capacity)  # 同上，助手侧知识  :19
```
画像不是结构化字段，是**一整段自然语言文本**（可含多段，追加模式会插 `--- Updated on <ts> ---` 分隔，`long_term.py:30`）。知识条目是**一行一条**的自由文本（`memoryos.py:196-198` 按 `\n` 切行后逐条入库）。

### 检索用的向量索引
**没有持久化索引**。每次查询现建 FAISS：`faiss.IndexFlatIP(dim)` + `index.add(全部向量)` + `search`（`long_term.py:114-119`；`mid_term.py:298-306`）。即 O(N) 暴力内积，N=session 数或知识条数；好处是无索引一致性问题，坏处是每次查询重建。Chroma 变体把存储换成了 `storage_provider.py`（`memoryos-chromadb/storage_provider.py`，364 行），但主体逻辑仍是同一套。

## 写入路径

触发点只有两个，都是**同步事件**，没有定时器：
1. `add_memory()` 被调用（业务侧每轮对话调一次，或 `get_response()` 内部自动回灌，`memoryos.py:346`）；
2. `add_memory` 末尾的 heat 检查（`memoryos.py:250`）。

**谁决定写**：写入分层由**结构性条件**决定，不是模型自决——短期满 → 刷中期（`memoryos.py:242`）；中期堆顶 heat ≥ 阈值 → 蒸馏进长期（`memoryos.py:140`）。这是这个项目最"操作系统"的一点：晋升阈值是硬编码策略，LLM 只负责**内容抽取**，不负责**决定要不要记**。

**抽取方式：全 LLM，无规则抽取**
- 中期主题切分：`gpt_generate_multi_summary`（`updater.py:170`）→ `{summaries:[{theme, keywords, content}]}`；
- 对话连续性：`check_conversation_continuity`，让模型只回 `true/false`（`utils.py:359-374`，`max_tokens=10`）；
- 链概览：`generate_page_meta_info`（`utils.py:376-386`）；
- 画像：`gpt_user_profile_analysis`（`utils.py:266-281`），prompt 里塞 **90 个人格偏好维度**，要求"逐维度判 High/Medium/Low 并给理由，未体现的不列"（`prompts.py:80-124`）；
- 知识：`gpt_knowledge_extraction`（`utils.py:284-320`），靠 `【User Private Data】`/`【Assistant Knowledge】` 两个中文标记**字符串切分**返回值（:300-313）——不是 JSON 解析，模型不按格式输出就静默退化成 "None"。

**去重与噪声控制：弱**
- 只过滤空值与字面量 `"none"` / `"- none"`（`long_term.py:51-53`、`memoryos.py:195-198`）；
- session 级合并有阈值（见下），但**知识条目之间没有任何去重**，同一事实每次晋升都可能再追加一行［代码：`memoryos.py:196-198` 直接 `add_user_knowledge`］；
- 长期知识是 `deque(maxlen=100)`，超过就**静默丢最旧**（`long_term.py:18, 67`）——遗忘是容量副作用，不是显式策略；
- 画像做了质量闸门：更新后文本长度 < 30 字符则跳过（`memoryos.py:186-188`），且**整篇替换**（`merge=False`，`memoryos.py:190`），靠 prompt 让模型"输出更新后的完整画像"（`utils.py:269`）。这避免了 `long_term.py:30` 那种无限追加，但也意味着**模型一次写坏就覆盖掉旧画像**，无版本回滚［推断，依据 `merge=False` 与 `long_term.py:37-40` 的覆盖式赋值］。

## 点名深挖：轻量化三层分层（短/中/长期）、heat 热度驱动的晋升与衰减、时序记忆更新、对话人格记忆

### 1) 三层分层：不是"轻量"，是"三种不同粒度 + 三个不同的淘汰策略"

| 层 | 数据结构 | 容量默认 | 淘汰/晋升规则 | 证据 |
|---|---|---|---|---|
| 短期 | `deque(maxlen=capacity)` | 10（库默认 `memoryos.py:35`；README 示例 7 `README.md:300`；MCP config 2 `memoryos-mcp/config.json:7`） | 满 → 整批刷到中期；deque 兜底丢最旧 | `short_term.py:10-14`；`memoryos.py:242` |
| 中期 | `dict` of session，每 session 含页列表 | 2000 sessions（`memoryos.py:36`） | 超容量 → **LFU 淘汰整个 session**（`mid_term.py:71-101`，按 `access_frequency` 最小者）；热度达标 → 蒸馏进长期 | `mid_term.py:176-178` |
| 长期 | 画像字符串 + 两个 `deque` | 知识 100 条（`memoryos.py:37`） | deque 溢出丢最旧；画像整篇覆写 | `long_term.py:15-19` |

关键设计点：**三层的淘汰策略各不相同**——短期 FIFO、中期 LFU、长期 FIFO+覆写。这是"操作系统"隐喻里真正被实现的部分（README 只在 :209 用一张图带过）。

### 2) heat 热度驱动：公式、参数、以及它的三个实现缺陷

公式（`mid_term.py:26-36`）：
```python
H_segment = alpha*N_visit + beta*L_interaction + gamma*R_recency
alpha = beta = 1.0, gamma = 1            # mid_term.py:21-23
R_recency = exp(-Δhours / tau_hours)     # utils.py:228-237
tau_hours = 24                           # mid_term.py:24
```
- `N_visit`：该 session 被**检索命中**的次数（每次命中 +1，`mid_term.py:346`）；
- `L_interaction`：session 内页数（新建时 = `len(details)`，合并时累加，`mid_term.py:162, 271`）；
- `R_recency`：距 `last_visit_time` 的指数衰减，半衰期 ≈ 16.6h（`ln2*24`）［推断，按公式算］。

晋升阈值：`mid_term_heat_threshold`，库默认 **5.0**（`memoryos.py:26, 39`），MCP 配置 **7.0**（`memoryos-mcp/config.json:12`），README 示例 **5**（`README.md:301`）。注意：新建 session 时 `H = L_interaction + 1.0`（`mid_term.py:170`），所以**一批 ≥4 页的对话一进中期就可能直接越过 5.0 阈值**——晋升几乎不依赖"被访问"，只依赖批量大小［推断，由公式代入 `N_visit=0` 得］。

三个实现缺陷（都能在代码里指出来）：
1. **只看堆顶一个 session**：`neg_heat, sid = heap[0]`（`memoryos.py:137`），堆顶不达标就整个函数 `pass`（:222-224）。堆是懒重建的（`rebuild_heap` 只在若干处手动调），一旦堆顶是"无未分析页"的老 session，其余热 session 全被挡住（:220-221 只打印不推进）。
2. **晋升后 heat 被清零**：`N_visit=0; L_interaction=0`（`memoryos.py:211-212`），导致"越热的记忆越难再次晋升"，与"热度=重要性"的直觉相反。
3. **衰减没有独立时钟**：`R_recency` 只在 `compute_segment_heat` 被调用时重算（新建/合并/检索命中/晋升后），没有周期性 tick。长期不访问的 session 的 `H_segment` 会**冻结在旧值**，衰减事实上不生效［代码：全仓无定时器，`compute_segment_heat` 调用点仅 `mid_term.py:170,273,350` + `memoryos.py:214`］。

### 3) 时序记忆更新：页链 + 滚动 meta_info，而不是时间线索引

- 每页入中期时用 LLM 判"与上一页是否连续"（`updater.py:130`），连续则 `pre_page` 指向上一页（:132-133），并让 LLM 把新的 `meta_info` 滚进"对话链概览"（:141）；
- 若上一页已在中期库里，还会沿 `pre_page/next_page` 做 BFS，把新 meta 覆写到整条链（`updater.py:70-98`）——这是唯一带"图"味道的操作，但只是个链式传播；
- 检索时该概览以 `Conversation chain overview: {meta_info}` 注入（`memoryos.py:277`）。
- 注意：**连续性判定是每页一次 LLM 调用**（`updater.py:117-154` 循环内），一批 10 页 = 10 次额外调用 + 1 次多主题摘要 + 每页 embedding。这是写入成本的主要来源［推断，按调用点计数］。issue #12 里维护者称"平均每完成一个回答消耗 3000 多 token"（https://github.com/BAI-LAB/MemoryOS/issues/12 ），与此不矛盾，但那是**读侧**；写侧的批量调用未计入。

### 4) 对话人格记忆：90 维画像 + 整篇重写

- 画像 prompt 明确要求覆盖 90 个维度，分四组：心理模型（大五人格 + 需求层次，`prompts.py:95-111`）、AI 对齐维度（Helpfulness/Honesty/... `:113-121`）、内容平台兴趣标签（`:123` 起）、以及后续的交互风格维度（文件共 233 行）。
- 输出是"只输出 user profile 段"的自由文本（`prompts.py:87-88`），**不是 JSON、不是打分表**，所以下游无法按维度检索或衰减。
- 更新策略：每次触发都把"现有画像 + 新对话"一起喂进去，要求输出**更新后的完整画像**（`utils.py:271-281`），然后 `merge=False` 整篇替换（`memoryos.py:190`）。好处是不会像 `long_term.py:30` 那样无限堆叠；坏处是 token 随画像变长而线性增长，且无历史版本。
- 读取时**总是注入整篇画像**（`memoryos.py:282-293`，`background_context`），不做相关性筛选。这是 prompt 预算失控的首要原因。
- 为什么是 90 维？仓库里没有论证；issue #59「90 personality preference dimensions, why 90？」至今 open 且 0 回复（https://github.com/BAI-LAB/MemoryOS/issues/59 ）［未证实：维度集的来源/验证］。

## 读取路径

**纯向量 + 结构性阈值，没有关键词、没有图遍历、没有 rerank 模型。**

三路并行（`retriever.py:100-124`，`ThreadPoolExecutor(max_workers=3)`）：

1. **中期**：session 级召回 —— 对所有 `summary_embedding` 建 `IndexFlatIP` 取 top 5（`mid_term.py:298-306`），得分 = `cosine + keyword_alpha * Jaccard`（:220, 330）。**但 `query_keywords` 被硬编码为空集**（`mid_term.py:292` 注释「Keywords extraction removed, relying on semantic similarity」），所以 Jaccard 项恒为 0，实际只剩余弦。session 过阈值（默认 0.1）后，再对**该 session 内每一页**算与 query 的点积，页阈值同为 0.1（`retriever.py:94-95`，`mid_term.py:341`）。
2. **用户长期知识**：`search_user_knowledge(query, threshold=0.01, top_k=20)`（`retriever.py:96-98`，`long_term.py:132-135`）。阈值 0.01 对内积而言几乎等于"全收"。
3. **助手长期知识**：同上，`top_k=20`（`retriever.py:79-90`）。

**排序与截断**：所有命中页进一个大小为 `retrieval_queue_capacity=7` 的**最小堆**，按页分数保留 top 7（`retriever.py:56-66`）。注意 `combined_score = page_score`（:54），session 相关性**没有**参与页排序（注释里写着"could be"，未实现）。

**注入形态**（`memoryos.py:268-327`）：
```
system: 角色/关系(relationship_with_user)/【Assistant Knowledge Base】/【Current Conversation Metadata】
user:   短期 history_text
        【Historical Memory】 × top7 页（User/Assistant/Time/Conversation chain overview）
        【User Profile】<整篇画像> 【Relevant User Knowledge Entries】 × top20（知识 + 记录时间）
        query
```
**token 预算：没有预算控制**。没有任何截断/计 token/去重的代码；能约束规模的只有 `retrieval_queue_capacity`、`top_k_knowledge=20` 和 `max_tokens=1500`（后者是输出上限，`memoryos.py:341`）。画像整篇注入 + 20 条知识 + 7 页历史，长会话下输入侧无上界［推断，依据上述常量与"无截断代码"］。这正是 issue #12 的抱怨来源，也是 #49 追问 Table 3 的 token 数至今无回复的原因。

## 生命周期规则与参数

| 参数 | 默认 | 含义 | 证据 |
|---|---|---|---|
| `short_term_capacity` | 10（库）/ 7（README 示例）/ 2（MCP config） | 短期 QA 条数，满了就刷中期 | `memoryos.py:35`、`README.md:300`、`memoryos-mcp/config.json:7` |
| `mid_term_capacity` | 2000 | session 数上限，超了 LFU 淘汰 | `memoryos.py:36`、`mid_term.py:176-178` |
| `long_term_knowledge_capacity` | 100 | 每侧知识条数上限，溢出丢最旧 | `memoryos.py:37`、`long_term.py:18-19` |
| `retrieval_queue_capacity` | 7 | 每轮注入的历史页数上限 | `memoryos.py:38`、`retriever.py:56` |
| `mid_term_heat_threshold` | 5.0（库）/ 7.0（MCP） | 晋升到长期的 heat 阈值 | `memoryos.py:26,39`、`memoryos-mcp/config.json:12` |
| `mid_term_similarity_threshold` | 0.6 | 新页并入已有 session 的判定（cosine+Jaccard） | `memoryos.py:40`、`mid_term.py:191, 226` |
| `segment_similarity_threshold` | 0.1 | 检索时 session 级门槛 | `retriever.py:94` |
| `page_similarity_threshold` | 0.1 | 检索时页级门槛 | `retriever.py:95` |
| `knowledge_threshold` | 0.01 | 长期知识相似度门槛（近乎全收） | `retriever.py:96` |
| `top_k_sessions` / `top_k_knowledge` | 5 / 20 | 召回上限 | `retriever.py:97-98` |
| `RECENCY_TAU_HOURS` | 24 | recency 指数衰减时间常数（半衰期 ≈16.6h） | `mid_term.py:24`、`utils.py:228-237` |
| `HEAT_ALPHA/BETA/GAMMA` | 1.0 / 1.0 / 1 | heat 三项权重 | `mid_term.py:21-23` |
| 画像最短长度 | 30 字符 | 低于则跳过画像更新 | `memoryos.py:186-188` |
| 连续性判定 | temp=0, max_tokens=10 | 只回 true/false | `utils.py:373` |
| meta_info 生成 | temp=0.3, max_tokens=100 | 滚动对话链概览 | `utils.py:386` |
| 回复生成 | temp=0.7, max_tokens=1500 | | `memoryos.py:338-343` |
| embedding 缓存 | 上限 10000 条，超了批量删 1000 | 进程内 dict | `utils.py:202-209` |

**降级/合并/遗忘的完整清单**（没有别的了）：
- 合并：新页 → 最相似 session（阈值 0.6），合并后重算 heat 并重建堆（`mid_term.py:226-276`）；
- 降级：**不存在**。没有"长期→中期"或"中期→短期"的回流路径［代码：全仓无此逻辑］；
- 遗忘：短期 deque 溢出、中期 LFU 整 session 删、长期 deque 溢出、画像被覆写。**没有基于时间或重要性的显式遗忘**；
- 删除：issue #53 提过「删除记忆」，已 closed，但公开 API 里没有 delete/forget 方法（`memoryos.py` 只有 add/get/stats/force_analysis）［两条来源：issue #53 + 代码］。

## 后台调度

**没有后台任务，一行都没有。** 全仓无 `cron`/`schedule`/`APScheduler`/`asyncio.create_task`/后台线程；所谓"调度"是**在写路径上同步触发的两个 if**（`memoryos.py:242`、`:250`）。

- **并发**：`ThreadPoolExecutor` 用在三处——晋升时并行跑画像+知识抽取（`memoryos.py:169`，2 workers）、检索三路并行（`retriever.py:110`，3 workers）、OpenAI 客户端自带 5 workers（`utils.py:45`）。存储层每份数据一个 `threading.Lock`（`short_term.py:15`、`mid_term.py:50`、`long_term.py:23`），**只保护 save，不保护读改写**——`add_memory` 与检索并发时对 `session["N_visit"]` 的读改写无锁［代码：`mid_term.py:346-351` 无锁区］。PR #73 的标题正是「fix/thread-safety-mcp-playground」，说明这是被真实踩到的坑。
- **幂等**：靠 `page["analyzed"]` 标记（`memoryos.py:148, 207-209`）与"无未分析页则跳过"（:220-221）。但注意 :208 的注释自问「mark all pages in session, or just unanalyzed_pages?」——把整个 session 的页都标成 analyzed，包括从未被抽取过的页［代码 + 注释］。
- **失败恢复**：几乎为零。LLM 并行任务异常时直接 `return`（`memoryos.py:178-180`），不重置 heat、不标记，下次调用会重试（at-least-once，尚可）；JSON 解析失败时**静默初始化空记忆**（`mid_term.py:391-394`、`long_term.py:170-173`、`short_term.py:62-64`）→ 文件损坏 = 记忆归零，无备份、无事务。

## 工程形态与代价

- **语言/依赖**：Python ≥3.10（README:252）。核心依赖 `numpy==1.24.*`（`memoryos-pypi/requirements.txt:3`）、`sentence-transformers==5.0.0`、`FlagEmbedding>=1.2.9`、**`faiss-gpu>=1.7.0,<2.0.0`**（:8）、`openai`、`flask`。faiss-gpu 是硬 pin：无 GPU / 无对应 CUDA 轮子的机器装不上。issue #16 建议"按环境自动装 faiss-cpu 或 faiss-gpu"，已 closed，但 requirements 仍是 faiss-gpu［两条来源：issue #16 + requirements.txt:8］。
- **安装坑**：`numpy==1.24.*` 在 Python 3.12 上无 wheel，会退化成源码构建并失败——issue #76（open，2026-07-28）里维护者复现了 `BackendUnavailable: Cannot import 'setuptools.build_meta'`，并只提了"补文档说明支持的 Python 版本"的 PR，明确不升级 numpy（https://github.com/BAI-LAB/MemoryOS/issues/76 ）。
- **部署形态**：Dockerfile 全文 7 行——`FROM python:3.10-slim`、`WORKDIR /app`、COPY 源码、`pip install -r`、顺带 `apt-get install vim`，**无 ENTRYPOINT/CMD、无 HEALTHCHECK、无 VOLUME**（`Dockerfile:1-7`）。也就是说 `docker run` 之后容器立刻退出，没有任何服务被启动；部署者必须自己提供启动命令——README 的 Docker 段（:405-425）确实没给 run 示例。MCP 侧提供 `memoryos-mcp/mcp.json`（客户端注册示例）与 `config.json`。
- **可观测性**：**只有 print()**。仅 `memoryos-pypi/` 7 个核心文件里就有 97 处 `print(`（本轮 `grep` 实测计数），没有任何日志框架或指标出口（典型打点见 `mid_term.py:175, 227, 278`）。唯一的"监控"是 `get_memory_stats()` 返回 4 个计数（`memoryos.py:367-393`）。
- **性能数字（均为自述，未见第三方复现）**：
  - LoCoMo 上 F1 +49.11%、BLEU-1 +46.18%（README:28；论文摘要同源，arXiv:2506.06326）——**同一作者自述，非独立验证**；
  - "5 times faster（延迟下降），靠并行化"（README:85-86）；issue #12 里维护者另称"并行化加速，推理速度提升 80%"（https://github.com/BAI-LAB/MemoryOS/issues/12 ）——两个数字口径不同（5× vs 80%），都无 benchmark 脚本或基线说明［未证实：加速比的可复现性］；
  - "平均每个回答 3000 多 token"（维护者在 issue #12 的说法）——但同一 issue 里另有用户报告"跑 langmemeval 一条数据输出了 200w token"，说明该数字只在特定配置下成立。
- **代码重复**：`memoryos-pypi/`、`memoryos-mcp/memoryos/`、`memoryos-playground/` 三份几乎同源的拷贝（如 `mid_term.py` 三处均 394 行、`long_term.py` 均 173 行）→ 修 bug 要改三遍，PR #73 的 "thread-safety-mcp-playground" 命名印证了这点［代码：文件行数比对］。

## 可迁移到「本地优先的 DSH 插件」的部件（逐条：能搬什么、搬过去会坏在哪）

1. **"结构性晋升阈值"取代"每轮都让 LLM 决定记不记"**
   - 能搬：短期满 → 中期、heat 达标 → 长期，两级都是**纯数值判定**（`memoryos.py:242, 140`），零 LLM 调用、零额外延迟，且天然可解释、可调试。
   - 会坏在哪：DSH 插件是**按 turn 触发**的，短期容量按"轮数"算（10 轮）会让晋升时机抖动很大；而且 `N_visit` 依赖"检索命中"计数，插件里没有统一的检索记账点，得自己埋点，否则 heat 退化成 `L_interaction+1`（`mid_term.py:170` 就是这个后果）。

2. **page 链 + 滚动 meta_info（对话链概览）**
   - 能搬：把"上一轮/下一轮"指针 + 一段 LLM 维护的链概览一起注入（`memoryos.py:277`），比注入 7 条孤立历史片段更能保住"这件事的前因后果"，实现成本很低（两个字段 + 一个 prompt）。
   - 会坏在哪：连续性判定是**每页一次 LLM 调用**（`updater.py:130`），本地优先场景下这是纯增延迟；且 `_update_linked_pages_meta_info` 会 BFS 覆写整条链（`updater.py:70-98`），链一长就是 O(链长) 次写盘，插件里必须改成惰性/批量。

3. **"画像整篇重写"而不是增量 append**
   - 能搬：`merge=False` + "输入旧画像，输出完整新画像"（`utils.py:269-281`、`memoryos.py:190`）避免了 append 式画像越滚越脏，配合 30 字符下限（:186-188）能挡掉空更新。对"人格/偏好"这类**需要自我一致性**的记忆，整篇重写比逐条 patch 更稳。
   - 会坏在哪：画像**无条件全量注入**（`memoryos.py:282-293`）在长会话里必爆 token；90 维维度集无验证（issue #59 无人回应），搬到别处应换成 8-12 个可验证维度；整篇覆写无版本、无 diff，写坏一次就丢历史。

4. **（反面）不要照抄：JSON 全量重写 + 查询时现建 FAISS 索引 + faiss-gpu 硬依赖**
   - 每次状态变更都 `json.dump` 整个文件（`mid_term.py:374-377`、`long_term.py:148-151`），中期的 page 向量也在里面 → 文件随对话线性膨胀，写放大 O(文件大小)；
   - 每次查询 `IndexFlatIP` 重建（`long_term.py:114-119`）→ O(N) 且无法增量；
   - `faiss-gpu` pin（`requirements.txt:8`）+ `numpy==1.24.*`（:3）在新 Python 上直接装不上（issue #76）。
   - 本地优先插件应换 SQLite（WAL）+ 内嵌小向量索引（如 sqlite-vec / hnswlib），把向量从热路径挪出去。

5. **可搬的"小东西"**：`compute_time_decay` 的指数衰减（`utils.py:228-237`，一行公式 + 24h 常数）可以直接做"记忆新鲜度"排序因子；`get_memory_stats`（`memoryos.py:367-393`）这种"只读健康检查"接口适合做插件自检；embedding 进程内缓存带上限清理（`utils.py:199-209`）是本地场景的必需品。

## 未证实 / 缺口

- **论文与代码的一致性**：论文 Table 3 的 token / LLM 调用数没有仓库脚本可对账，issue #49 直接问过，**至今 open、0 回复**（https://github.com/BAI-LAB/MemoryOS/issues/49 ）。49.11%/46.18% 这两个数字**只有作者自述**（README + arXiv 摘要），无第三方复现。
- **复现分歧**：issue #42「复现结果不理想」有 9 条讨论，维护者回应"我们论文用的是 3B，你 7B 结果更高是正常的"，提问者随后指出**多跳推理类 F1 反而下降**，维护者未给出解释；2026-06 又有人问"为什么复现 memorybank 有十几点差距"（https://github.com/BAI-LAB/MemoryOS/issues/42 ）。→ "多跳推理不如基线"这一说法**未被证伪也未修复**。
- **eval 与库的 prompt 不一致**：issue #50 指出 eval 里的 prompt 与 `prompts.py` 不一致（已 closed，未核对其修复方式）［未证实］。
- **heat 参数（α=β=γ=1、τ=24h、阈值 5/7）没有任何调参依据**；仓库无消融脚本，论文里是否给了敏感性分析**本轮未取**（受工具预算限制，未读 PDF 正文）。
- **Chroma 变体与主实现的行为是否等价**：只看了目录与文件规模，未逐行对比 `memoryos-chromadb/mid_term.py`(361 行) 与 `memoryos-pypi/mid_term.py`(394 行) 的差异。
- **多用户/多租户**：issue #36 提过"能否在 add_memory 时指定 user_id"，已 closed；代码里 user_id 仍是构造期固定（`memoryos.py:45, 71`），即一个 Memoryos 实例 = 一个用户。
- **MCP 三个 tool 的并发安全**：PR #73 标题声称修了 thread-safety，但 `mid_term.py:346-351` 的无锁读改写仍在 → 是否真的修好**未验证**（未跑并发测试）。
- 星数、issue 数量等动态值取于 2026-11-22，会变。

## 来源清单（每行：标题 — URL — 访问日期 2026-11-22）

- MemoryOS 仓库首页 — https://github.com/BAI-LAB/MemoryOS — 2026-11-22
- README（性能声明、架构、安装、MCP 工具说明） — https://raw.githubusercontent.com/BAI-LAB/MemoryOS/main/README.md — 2026-11-22
- 论文 *Memory OS of AI Agent*（EMNLP 2025） — https://arxiv.org/abs/2506.06326 — 2026-11-22
- 仓库源码（浅克隆，commit 587ed77，2026-07-07）：`memoryos-pypi/{memoryos,short_term,mid_term,long_term,updater,retriever,utils,prompts}.py`、`memoryos-mcp/{config.json,server_new.py}`、`requirements.txt`、`Dockerfile` — https://github.com/BAI-LAB/MemoryOS/tree/main/memoryos-pypi — 2026-11-22
- Issue #42 复现结果不理想（9 评论，多跳 F1 下降问题未解） — https://github.com/BAI-LAB/MemoryOS/issues/42 — 2026-11-22
- Issue #12 tokens 数量爆炸 / 本地化部署（含"3000 多 token/回答"与"5×/80% 加速"自述） — https://github.com/BAI-LAB/MemoryOS/issues/12 — 2026-11-22
- Issue #76 安装失败（Py3.12 + numpy 1.24，open） — https://github.com/BAI-LAB/MemoryOS/issues/76 — 2026-11-22
- Issue #59 90 维人格维度为何是 90（open，0 回复） — https://github.com/BAI-LAB/MemoryOS/issues/59 — 2026-11-22
- Issue #49 论文 Table 3 的 tokens 与 LLM 调用数（open，0 回复） — https://github.com/BAI-LAB/MemoryOS/issues/49 — 2026-11-22
- Issue #29 session 内 page 是否无限膨胀（closed，代码仍未设上限） — https://github.com/BAI-LAB/MemoryOS/issues/29 — 2026-11-22
- Issue #16 建议按环境自动装 faiss-cpu/gpu（closed，requirements 仍 pin faiss-gpu） — https://github.com/BAI-LAB/MemoryOS/issues/16 — 2026-11-22
- Issue #53 删除记忆（closed，公开 API 无 delete） — https://github.com/BAI-LAB/MemoryOS/issues/53 — 2026-11-22
- Issue #50 eval 的 prompt 与 prompts.py 不一致（closed） — https://github.com/BAI-LAB/MemoryOS/issues/50 — 2026-11-22
- Issue #45 短期记忆表现不太正常（closed） — https://github.com/BAI-LAB/MemoryOS/issues/45 — 2026-11-22
- Issue #5 模型返回总是很简短 / "已在某个时间点展示过了"（closed） — https://github.com/BAI-LAB/MemoryOS/issues/5 — 2026-11-22
- GitHub REST API 仓库元数据（stars 1626 / forks 171 / language Python / pushed_at 2026-07-07） — https://api.github.com/repos/BAI-LAB/MemoryOS — 2026-11-22
