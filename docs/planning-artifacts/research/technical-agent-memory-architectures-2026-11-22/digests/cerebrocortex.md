# CerebroCortex · 实现机制 digest

> 研究截止 2026-11-22。主张一律以主仓库 https://github.com/buckster123/CerebroCortex 为准；Rust 移植版 CerebroCortex-RS 仅作对照。
> 证据标注：`代码` = 我本轮读到的实现；`README` = 文档声称；`推断` = 我的判断。

## 身份确认（URL、star、语言、最近提交、是否有论文）

| 项 | 值 | 证据 |
|---|---|---|
| 主仓库 | https://github.com/buckster123/CerebroCortex | api.github.com/repos/buckster123/CerebroCortex |
| star / fork | 38 / 5 | 同上（2026-11-22 取） |
| 描述 | "AI Brain" | 同上 |
| 语言 | Python（pyproject 要求 >=3.11） | pyproject.toml:19 |
| 许可 | MIT | api 元数据 |
| 创建 / 最近推送 | 2026-02-05 / 2026-05-19 | api 元数据 |
| 最近提交 | `05937a0` 2026-05-19 "fix(ccbs): SQLite-first module lookup in bootstrap assembler" | 本地 `git log -1` |
| 版本 | 0.5.1（2026-05-16） | CHANGELOG.md:8 |
| issue | 0 条（`state=all` 查询返回空数组，含已关闭） | GitHub API 本轮查询 |
| 论文 | 未发现 —— README 全文目录无 citation/arXiv 节，pyproject 无引用字段；未检索 arXiv，故记「未证实」 | README.md 标题树 43–1623；pyproject.toml |

**吻合性检查**：仓库存在、非空、MIT、内容与委托描述一致（Python 记忆系统 + dream 引擎 + MCP/REST/CLI 三种宿主）。**无 mismatch**。

**移植版对照**：CerebroCortex-RS 自称「pure Rust, one binary, one SQLite file」，67 个 MCP 工具、8 阶段 dream、Darwinian skill 选择、sqlite-vec 替代 ChromaDB（https://github.com/buckster123/CerebroCortex-RS README）。打分公式与主仓库一致（RS README「0.35·vector + 0.30·ACT-R + 0.20·FSRS + 0.15·salience」vs config.py:72-75），说明这是同一设计的重写而非分叉。

## 一句话定位

给 AI agent 用的「大脑类比」长期记忆层：一个 Python 库 + MCP server + REST API + CLI，把每条记忆做成带 ACT-R 激活值、FSRS 遗忘曲线、情绪显著性和图连接的节点，靠一个可手动触发的 6 阶段 dream 引擎做离线整合。

## 架构总览（组件与数据流）

四个面：**接口层**（MCP 63 工具 / REST 78 端点 / CLI / Dashboard / 文件监听 / CCBS）、**协调器**（`remember()` `recall()` `associate()`）、**9 个"脑区"引擎**、**三后端存储**（README.md:60-122 的 mermaid 图）。

写入流（`remember`，cortex.py:263-342）：
1. **Thalamus 门控** —— 长度过滤、精确去重、类型分类、salience 估计、层分配（thalamus.py:59-94）
2. **Temporal 语义** —— 词频抽概念（temporal.py:46-71）
3. **Amygdala 情绪** —— 关键词判 valence/arousal，并微调 salience（amygdala.py:45-110）
4. **首次 access 记账** —— 立刻记一次 ACT-R 访问（cortex.py:316-324）
5. **StorageCoordinator 落盘** —— SQLite 先写、Chroma 后写、失败进 backfill 队列（coordinator.py:64-145）
6. **自动连边** —— responding_to / derived_from / 上下文 / 共享 tag（association.py:50-144），再叠加语义边与情绪边
7. **Episode 归属** —— 有 session_id 就挂到当前 episode（cortex.py:339-341）

读取流（`recall`，cortex.py:527-696）：向量检索（3 个 collection 各取 top）→ 以命中为种子做扩散激活 → 合并候选（可选视觉侧车）→ 空结果时 FTS5 兜底 → 按 4 项加权打分排序 → 对 top-k 做 Hebbian 强化并**逐个写回 access**。

## 数据模型与存储

**记忆单元 = MemoryNode**（models/memory.py:88-115），粒度是「一段文本 + 一份元数据 + 一份强度状态」，没有 token/chunk 内嵌结构（chunk 化发生在 ingestion 层）：

- `id`：`mem_<12hex>`；`content`：纯文本
- `metadata`（MemoryMetadata，models/memory.py:42-85）：agent_id、visibility（private/shared/thread）、layer（sensory/working/long_term/cortex）、memory_type（6 类）、media_type、tags、concepts、attachments、source_file、deleted_at、session_id、conversation_thread、episode_id、responding_to、related_agents、recipient、valence、arousal、salience、source（user_input/llm_generation/consolidation/dream/import）、derived_from
- `strength`（StrengthState，models/memory.py:12-39）：FSRS 的 stability(天)/difficulty(1-10)，ACT-R 的 access_timestamps（最多 50 条）+ access_count + 压缩历史（compressed_count / compressed_avg_interval），缓存值 last_retrievability / last_activation / last_computed_at
- 时间戳：created_at / last_accessed_at / promoted_at；`link_count` 是图侧缓存，`similarity` 不持久化

**六类记忆**：episodic / semantic / procedural / affective / prospective / schematic（types.py:18-25）。**四层**：sensory / working / long_term / cortex（types.py:41-46）。**九种边**：temporal / causal / semantic / affective / contextual / contradicts / supports / derived_from / part_of（types.py:28-38）。

**Episode**（models/episode.py:23-56）是第二个一等公民：有序 steps（memory_id + position + role: event/context/outcome/reflection），带 consolidated / schema_extracted 标志 —— dream 引擎的工作队列就是「未 consolidated 的 episode」。

**存储三件套**（README 声称 + 代码一致）：
- **SQLite = 单一真相源**，schema 在 `src/cerebro/storage/sqlite_schema.py:15-256`，SCHEMA_VERSION 7（:13）。表：memory_nodes、attachments、associative_links（UNIQUE(source,target,type)，:114）、episodes、episode_steps、agents、dream_log、memory_versions、audit_log、schema_version，外加 FTS5 虚表 memory_nodes_fts + 三个同步触发器（:192-215）。PRAGMA：WAL、foreign_keys、busy_timeout=5000（:264-266）。content_hash 存 sha256 前 16 位（graph_store.py:143-144）。
- **igraph 内存图** = 从 SQLite 全量重建的派生缓存，用 `PRAGMA data_version` 检测跨进程写入后才重建（graph_store.py:72-136）。这是整个设计里我最欣赏的一处：跨进程一致性不靠锁，靠一个零成本计数器。
- **ChromaDB** = 可重建的向量索引，三个 collection（cerebro_memories / knowledge / sessions，config.py:46-49），384 维 all-MiniLM-L6-v2（config.py:38-39）。按记忆类型路由：semantic/schematic→knowledge，episodic→sessions，其余→memories（coordinator.py:47-58）。
- 落盘位置：`~/.cerebro-cortex/`（可用 `CEREBRO_DATA_DIR` 覆盖），SQLite 文件名 `cerebro.db`（config.py:13-33）。

## 写入路径

**触发**：宿主显式调用（MCP `remember`、REST、CLI）、批量 `bulk_remember`、ingestion pipeline（7 种 adapter）、文件监听（watchdog，默认关闭）、dream 引擎自己产出（schema/procedure）、迁移脚本。**没有**「对话自动抽取」这一层 —— 没有 hook 去监听 agent 的会话流，写不写完全由调用方决定（`代码`：全仓库无 chat-hook；`推断`：这是它和"自动记忆"类产品最大的形态差异）。

**谁决定写**：Thalamus 门控（thalamus.py:42-94）。三道闸：
1. `len(content.strip()) < 10` 直接丢（:59-61）
2. 精确重复（content_hash 命中）→ 不新建，改为给旧记忆记一次 access（:63-71）
3. 类型/salience/层由关键词启发式决定（:96-184）：出现 "step 1/when you/how to" → procedural；"felt/frustrat/excit" → affective；"need to/todo/will" → prospective；"then/yesterday/deployed" → episodic；否则 semantic。salience 基线 0.5，命中 important/bug/fix/error/breakthrough 等词 +0.1/个（上限 +0.3），长度>200 +0.1，带 tag +0.05/个，含 ? 或 ! 各 +0.05（:134-162）。

**抽取方式 = 规则，不是 LLM**：概念抽取是词频 + 停用词表 + 大写双词加权（temporal.py:46-71）；情绪是正负关键词计数（amygdala.py:45-83）。代码注释自己承认「Real classification would use LLM, but this provides a fast default」（thalamus.py:99-100）。LLM 只出现在 dream 的三个阶段。

**去重与噪声控制**（两层，都在 coordinator.py:90-130）：
- 精确层：sha256 前 16 位命中即合并（graph_store.py:442-448）
- 近重复层：在**同一 collection** 内做向量检索，余弦 ≥ `NEAR_DEDUP_THRESHOLD=0.95` 即合并 —— 合并动作是「并集 tags + salience +0.02 + 建一条 supports 边指回新节点」（coordinator.py:103-130）。阈值设 1.0 即关闭（config.py:180-181）。
- 注意方向性缺陷：近重复分支最后 `return near_dup`，而新节点**并未入库**，但那条 supports 边却以 `node.id`（不存在的 id）为 target 写入 —— 我在 coordinator.py:119-126 读到该写法，`推断`外键约束（sqlite_schema.py:112-113 声明了 FOREIGN KEY ... ON DELETE CASCADE，且 PRAGMA foreign_keys=ON）下这条边会插入失败并被 `except Exception: pass` 吞掉（:127-128）。

## 点名深挖：分阶段 dream 引擎（SWS 重放 / REM 重组 / schema 抽象）、重放采样策略、抽象合并流程、FSRS/ACT-R 衰减曲线、显著性更新

### 总体：6 阶段 + 预算 + 断点续跑

`DreamEngine.run_cycle(agent_id, cycle_id)`（dream.py:204-288）顺序跑 SWS_REPLAY → PATTERN_EXTRACTION → SCHEMA_FORMATION → EMOTIONAL_REPROCESSING → PRUNING → REM_RECOMBINATION（:245-252）。开跑前先 `close_stale_episodes()` 收掉超 24h 未结束的 episode（:239-242）。

三个关键工程约定：
- **LLM 预算**：整轮 20 次调用，硬切分 12（pattern）/ 4（schema）/ 4（REM）（config.py:134-137），每次调用前扣减，耗尽直接返回 None（dream.py:787-805）。`已知`：预算是**每 agent 各 20 次**，不是全局 20（HANDOVER.md:76 自述这是待办）。
- **断点续跑**：每阶段跑完写一行 dream_log（phase + cycle_id + 计数 + success，dream.py:921-938；表结构 sqlite_schema.py:173-187），下轮用 `get_completed_phases(cycle_id)` 跳过已完成阶段（dream.py:230-257）；`resume_cycle()` 找回最近未完成 cycle（:290-301）。
- **单实例互斥**：进程内 `self._running` 布尔锁，重入直接抛 RuntimeError（:220-223）。`跨进程无锁` —— ROADMAP 把 "Concurrency Locks" 列为 Sprint 4 待办（ROADMAP.md:16）。

### 阶段 1 — SWS 重放（算法，无 LLM）

采样策略：**不随机**，取全部未 consolidated 的 episode（dream.py:355），每个 episode 内的记忆做种子、权重一律 0.9（:373-374），**只扩 1 跳**（:378），然后把激活到的节点集合做两两 Hebbian 强化，每对 +0.08（:382-388）。
`README` 说这一步「强化 temporal 和 contextual 边」（README.md:730），`代码`实际是「强化任意已存在的边」—— `strengthen_co_activated` 只对已存在的边加权，不区分类型（association.py:150-176）。**README 与代码在此不一致，代码为准。**

### 阶段 2 — Pattern 抽取（LLM）

聚类：**按 tags/concepts 分组**，不是按向量相似度（dream.py:880-905）。每个 key 下记忆数 ≥ 3（`DREAM_CLUSTER_MIN_SIZE`）才成一个簇。
关键点：config 里 `DREAM_CLUSTER_SIMILARITY_THRESHOLD = 0.80`（config.py:138）被 dream.py:32 import 了，但**全文件再无任何使用**（我逐行确认）。README.md:735 却写「clusters similar memories using a similarity threshold (default: 0.80)」。→ **这是文档与实现的实质出入**。
每个簇取前 10 条、每条截 200 字符喂 LLM（:434, :907-915），prompt 要求返回 JSON 数组（content / source_indices / tags，:118-129）。
**抽象合并流程（幂等）**：写入前用 `find_duplicate_content(content)` 查精确重复，命中就跳过（:451-453）—— 这是为「阶段重跑」设计的幂等键；否则 `procedural.store_procedure()` 建一条 PROCEDURAL 记忆并连 derived_from 边（:458-466）。

### 阶段 3 — Schema 抽象（LLM）★

对每个未 consolidated episode（≥2 步）：先按 episode 首个节点的 tags 找**已有 schema**，命中就 `reinforce_schema`（加 supports 边、支持计数 +1、salience +0.05）而不新建（dream.py:506-515；neocortex.py:156-188）—— 这就是它的"合并而非叠加"策略，粒度是 **tag 集合匹配**，不是语义匹配。
没命中则 LLM 生成一句「general principle」（prompt 见 :131-143），建成 `MemoryType.SCHEMATIC` 节点：**层从 WORKING 起步**、salience 0.6、stability 7 天、带两个记账 tag `support_count:0` `dream_cycles_idle:0`（neocortex.py:59-96）。
阶段末调 `evaluate_schema_candidates()`（dream.py:545-548；neocortex.py:216-285）：
- **晋升**：WORKING 且 support_count ≥ 3 且 access_count ≥ 2 → 升 LONG_TERM、salience +0.2、stability 直接写 30 天（neocortex.py:247-265；config.py:150-151）
- **降级**：WORKING 且 access_count == 0 → idle 计数 +1，累计 3 轮 → **直接删除节点**（不是降层）（neocortex.py:267-278；config.py:152）
- 有 access 但 support 不够 → idle 计数清零（:279-283）

### 阶段 4 — 情绪再加工（算法）

对未 consolidated episode 里的每条记忆重新跑一次关键词情绪分析，再按 episode 的整体 valence 回调 salience：**负面结果额外 +0.15**，其余按 salience_adj 加，夹在 [0.1, 1.0]（dream.py:582-601；amygdala.py:153-179）。这就是它「从错误中学习」的全部机制 —— 规则，无 LLM，无 outcome 真值校验。

### 阶段 5 — 修剪（算法）

三步（dream.py:629-674）：decay sweep（全库重算缓存值）→ promotion sweep（全库查晋升资格）→ 逐节点判断修剪。修剪的**四个条件必须同时成立**：层 == sensory、salience ≤ 0.3、创建时间 > 48h、图度数 == 0（:651-666）；且只删自己 agent 的节点（:648-649）。阈值来自 config.py:140-141。ROADMAP 明确把「degree==0 才可修剪」当作**桥节点保护**的设计决定（ROADMAP.md:26）。
→ `推断`副作用：一次都没被访问、但 salience 恰好 ≥0.4 的记忆会直接落在 working 层，而修剪只看 sensory，于是 **working 层的噪声永远不会被自动清理**；long_term 同理只能靠 schema 降级路径。

### 阶段 6 — REM 重组（LLM）★采样策略

采样：从该 agent 可见的全部节点里 `random.sample` 抽 20 条（`DREAM_REM_SAMPLE_SIZE`），丢掉内容 ≤20 字符的（dream.py:706-716）；再从样本里随机抽**最多 10 对**（`DREAM_REM_PAIR_CHECKS`，且不超过组合数）（:724）；已连边的对直接跳过（:736）；**同类型对以 70% 概率跳过**，刻意偏向跨类型配对（:740-742）。
每对把两侧各截 300 字符喂 LLM，要求返回 {connected, link_type, reason, weight}（:145-158, :863-874）。写入门槛：weight 夹到 [0.1,0.9] 后必须 ≥ `DREAM_REM_MIN_CONNECTION_STRENGTH=0.4`（:752-753；config.py:144），link_type 不合法则回落 semantic（:754-758），边标 `source="dream_rem"` 并把 LLM 给的理由存进 `evidence`（:760-767）。
→ 这就是「创造性」的全部实现：**随机跨类型配对 + LLM 判连 + 权重下限**。没有任何 embedding 距离约束、没有多样性度量。

### FSRS / ACT-R 衰减曲线（公式与默认参数）

**ACT-R 基础激活**（strength.py:40-83）：`B(t) = ln(Σ_k t_k^(-d)) + B_const`，`d = 0.5`（config.py:54），时间下限 1 秒防除零。为省存储，只保留最近 50 条时间戳（`MAX_STORED_TIMESTAMPS`，config.py:59），更早的压成 `compressed_count` + `compressed_avg_interval`，用等间隔假设重建贡献（strength.py:72-78）。压缩逻辑在 `record_access`（:276-295）：溢出时取最旧的若干条算平均间隔，与已有均值做加权合并。
**FSRS 可提取性**（strength.py:91-108）：`R(t,S) = (1 + t/(9S))^(-1)`，S 以天计、定义为 R=90% 的时间。S 初值 1.0 天（config.py:64），可提取性初值 1.0。
**成功召回后的 S 更新**（:111-136）：`SInc = exp(11 - D) · S^(-0.2) · (exp((1-R)·9) - 1)`，`S' = S·(1+SInc)`，夹在 [0.1, 365] 天（config.py:66-67）—— 即「越难想起来的时候想起来，增益越大」（desirable difficulty）。
**遗忘/失败后的 S**（:139-153）：`S' = S · 0.3 · (11-D)^0.2`（下限 0.1）。`注意`：主流程里**没有地方调用它** —— recall 成功才写回，失败没有信号（grep 结果：只在测试里出现），所以实际行为是「只增不减的 stability + 单调衰减的 retrievability」。
**难度 D 更新**（:156-175）：`delta = -0.8·(R-0.5)`，再向初值 5.0 做 10% 均值回归，夹在 [1,10]。
**召回概率**（:183-205）：`P = sigmoid((A(t)-τ)/s)`，τ=0（config.py:57），s=0.4（:58）。`注意`：这里的 s 是**sigmoid 温度**，不是 ACT-R 原版的随机噪声 ε —— RS 版 README 写的是 `ε ~ U(±0.4)`，两版语义不同，主仓库实现是确定性的。
**综合打分**（:208-246）：`0.35·vector + 0.30·sigmoid(B+assoc) + 0.20·R + 0.15·salience`（权重 config.py:72-75），各项先夹到 [0,1]。
**边的衰减**（spreading.py:27-54）：`w_eff = w · (1 + age/(9·H))^(-1)`，`H = 30 天`（config.py:86）—— 复用 FSRS 曲线形状做「边也会忘」。流式计算，不改写存储值。

### 显著性（salience）更新汇总

四条路径，全是加法/上限夹逼，没有学习：
1. 写入时关键词 + 长度 + tag + 标点（thalamus.py:134-162），基线 0.5
2. 情绪分析 +0.1/负词（上限 0.3）、+0.05/正词（上限 0.15）、+0.05/高唤醒词（上限 0.1）（amygdala.py:74-81）
3. dream 阶段 4 负面 outcome 再 +0.15（amygdala.py:168-173）
4. schema 被新证据支持 +0.05、晋升 +0.2（neocortex.py:185-186, :255）
5. 反向：`resolve_intention` 把意图 salience 压到 0.1（prefrontal.py:92-94）

## 读取路径

**检索方式 = 向量为主 + 图扩散 + FTS5 兜底，没有纯关键词主路径**（cortex.py:566-647）：
1. 对 3 个 collection 分别向量检索，每个取 `max(top_k,10)` 条，合并时同 id 取最大相似度（:573-585）。where 过滤在 Chroma 侧按 type/agent/salience/thread 预先收窄（:567-569, :219-257）。
2. 命中作种子，`context_ids` 追加权重 0.8 的种子（:592-596），默认 2 跳、每跳 ×0.6、激活阈值 0.05、上限 50 节点（config.py:80-83）。
3. 候选 = 向量命中 ∪ 激活节点（:608）。
4. 可选视觉侧车：文搜图，已有候选乘 0.9 提升、新候选乘 0.85 折扣（:611-630）。
5. **仅当候选为空**才用 FTS5 `MATCH` 兜底，命中给中性相似度 0.5（:632-647）。
6. 二次过滤（type/可见性/salience），再进打分器（:649-669）。

**排序与阈值**：打分器 prefrontal.py:141-206，按 `combined_recall_score` 降序；`explain=True` 时附带 10 项分解（:186-201）。**没有任何最低分阈值** —— `top_k` 永远填满（只要有候选）；τ=0 只作用于 sigmoid 内部，不用于截断。这是它能"总是有结果"、也容易"总是给噪声"的根源。

**扩散激活的实现**（spreading.py:102-236）：BFS 前沿制，每跳先批量取邻居的可见性缓存再做权限判定（:57-99, :174-176），单条传播量 = `源激活 × 边有效权重 × 边类型权重 × 跳衰减`（:208），边类型权重表见 config.py:89-99（causal 0.9 最高，contradicts 0.3 最低）；已激活节点二次到达只按 `existing + spread*0.5` 亚线性叠加（:214-217）；返回前整体归一化到 [0,1]（:231-234）。

**注入到 prompt 的形态与 token 预算**：
- 记忆本身：MCP/CLI 直接把召回结果作为结构化文本返回给调用方（含 content/score/breakdown），**没有内置的"注入模板"**，怎么塞进 prompt 由宿主决定（`代码`：mcp_server.py 的 recall 处理器只做序列化；`推断`因此不存在 recall 侧的 token 预算控制）。
- 真正的预算机制在 **CCBS（Cognitive Bootstrap）**：把 13 个认知模块（soul / core / 6 个 cerebro 子模块 / technical / analysis / creative / research / communicate）预先作为记忆入库，再按 query 关键词 + 手动触发器挑模块拼成一段 prompt 前缀（api_server.py:373-521）。每模块有硬编码 token 估计（:377-391，soul 350、core 250 …），`MANDATORY_MODULES` 6 个常驻（:393-400），`assemble(max_tokens=4000)` 超预算时按模式裁剪（:478-513）。README 给的三档：Minimal ~900 / Standard ~1600 / Full ~4200（README.md:279-283）。触发器是字符串匹配：`"full load"` 全量、`"solo core"` 最小、`"debug mode"` 加 technical+analysis 等（:461-473）。

## 生命周期规则与参数

| 动作 | 规则 | 默认参数 | 证据 |
|---|---|---|---|
| 层衰减半衰期 | 每层一个半衰期（sensory/working/long_term 有值，cortex 无衰减） | 6h / 72h / 720h / ∞ | config.py:104-129 |
| 晋升 sensory→working | access_count ≥ 2 | 无年龄要求 | config.py:105-110 |
| 晋升 working→long_term | access_count ≥ 5 且 age ≥ 24h | — | config.py:111-116 |
| 晋升 long_term→cortex | **代码不可达**：long_term 的 promotion_access_count 为 None，而 `check_promotion_eligibility` 遇到 None 先返回 False | — | config.py:117-122 + decay.py:49-51 |
| 修剪 | sensory + salience ≤ 0.3 + age > 48h + degree == 0 | 0.3 / 48h | config.py:140-141；dream.py:651-666 |
| 合并（近似重复） | 同 collection 余弦 ≥ 0.95 → 并入旧节点 | 0.95 | config.py:180；coordinator.py:103-130 |
| schema 晋升 | support ≥ 3 且 access ≥ 2 → long_term + stability 30d | 3 / 2 / 30d | config.py:150-151；neocortex.py:247-265 |
| schema 遗忘 | 3 轮 dream 零访问 → 删除 | 3 | config.py:152；neocortex.py:267-278 |
| 边衰减 | 30 天半衰期（FSRS 形状，流式） | 30d | config.py:86；spreading.py:53 |
| episode 自动关闭 | 24h 未结束即关闭 | 24h | config.py:147；hippocampus.py:215-255 |
| 软删除 → 硬删 | deleted_at 非空；可批量清理 N 天前 | 30 天 | cortex.py:1001-1025；sqlite_schema.py:349-363 |

**降级/遗忘的实际缺口**（`代码`静态阅读，未跑测试）：
- 除 schema 之外的节点**没有降层路径**，只有"删"（且仅 sensory+孤立）。
- long_term→cortex 不可达（见上两处证据）。
- `_assign_layer` 里 `salience >= 0.7` 与 `>= 0.4` 两个分支都返回 WORKING（thalamus.py:171-176），前一个是死分支 —— 实际只有 salience < 0.4 才进 sensory。
- `update_stability_on_lapse` 无调用点，所以不存在"遗忘惩罚"。

## 后台调度

**结论：没有 cron、没有空闲触发，dream 完全靠外部显式调用。**
- 证据一（否定式 grep）：全仓 `src` 下无 `apscheduler` / `cron` / `schedule.every`；仅有的定时器是文件监听里的 `threading.Timer` 防抖（watcher.py:130-141）。
- 证据二：三个入口都是"被调用才跑"—— CLI（README.md:783）、`POST /dream/run`（api_server.py:1844-1859，起一个 daemon 线程后立刻返回 started）、MCP `dream_run`（README.md:789）。README 说「Claude will call this automatically」（:788），即依赖宿主 agent 自觉。
- 文件监听：watchdog 递归监控，默认**关闭**（`WATCH_ENABLED=False`，config.py:194），仅当 API 启动且开关打开才起线程（CHANGELOG.md:91-94）；按文件扩展名白名单匹配（config.py:198-203），同一路径的重复事件用 Timer 去抖并记录已处理集合（watcher.py:111-126）。

**并发与幂等**：
- 互斥：进程内布尔锁（dream.py:220-223）+ REST 层 `is_running` 返回 409（api_server.py:1850-1851）。跨进程无锁（ROADMAP.md:16 待办）。
- 幂等：阶段级 checkpoint（dream_log.cycle_id）+ 阶段内 `find_duplicate_content` 跳过重复 procedure（dream.py:451-453）+ `ensure_link` 靠 UNIQUE(source,target,type) 天然幂等（sqlite_schema.py:114）。
- 失败恢复：单阶段异常被 `try/except` 捕获，记 success=False 后**继续跑下一阶段**（各 phase 内部同构，如 dream.py:394-397）；整轮异常也只在 finally 里收尾（:275-288）。→ 阶段失败不会回滚已写入的节点，也没有事务边界；下一轮靠 `consolidated` 标志与内容去重兜底，`推断`会留下"半成品 procedure"。

## 工程形态与代价

- **语言/依赖**：Python ≥3.11；核心依赖 chromadb、sentence-transformers、python-igraph、pydantic、click、watchdog（pyproject.toml:32-40）；可选 extras：mcp / api(fastapi+uvicorn) / llm(anthropic+openai) / vision(pillow+pytesseract+pymupdf+bs4)。→ **装完即带 torch + 向量库 + C 图库**，是重量级安装（`推断`，基于 sentence-transformers/chromadb 的已知体积；未实测安装体积）。
- **代码量**：161 个文件，其中 107 个 .py、共 26,764 行（本轮统计）；核心 cortex.py 1588 行、mcp_server.py 2687 行、api_server.py 2361 行 —— **接口层占了大头**（约 45%），说明这是"先把面铺满"的产品化路线。
- **部署复杂度**：单机单进程即可（`cerebro` CLI / `cerebro-mcp` stdio / `cerebro-api` + dashboard on :8767，config.py:213-214）。README 宣称能在 8GB 树莓派 5 上跑（README.md:840）。
- **可观测性**：dream_log（每阶段计数/耗时/success）、audit_log（7 类事件，schema v7）、`explain=True` 的 10 项打分分解、dashboard 11 个面板（含 decay/dream/audit）、`/dream/status` 与 `/activation/heatmap|at-risk|curve`。这部分比多数同类项目扎实。
- **性能数字**：主仓库**没有**自报基准。我能给的只有：(a) 测试 506 个、在 RPi5 上约 7 分钟（HANDOVER.md:81）；(b) 「spreading activation in microseconds」（README.md:837，`README 声称`，无测量方法）；(c) 移植版的实测：裸二进制 23MB RSS / 6 线程 / 26ms recall，带 bge-small 时 275MB RSS / 9 线程 / 26ms，冷启动 4.4s（CerebroCortex-RS README）。**这三条互不等价，不能拿来给 Python 版下结论。**
- **测试**：tests/ 下 40+ 文件，含 scope 强制（608 行）、dream（544 行）、MCP（737 行）等；CHANGELOG 汇报 477→506 个测试通过（CHANGELOG.md:85, :101）。

## 可迁移到「本地优先的 DSH 插件」的部件（逐条：能搬什么、搬过去会坏在哪）

1. **三段式打分 + 可解释分解**（strength.py:208-246；prefrontal.py:186-201）
   能搬：4 权重 + sigmoid 化的激活项 + 每次返回 breakdown 的形态，纯函数、无依赖，最适合做 DSH 侧 recall 的排序器。
   会坏在：DSH 若把 recall 结果直接展示/复述，缺少"最低分阈值"会让每次召回都塞满 top_k；且它依赖 `access_timestamps` 这类历史字段，插件必须在自己的库里补齐，否则激活项恒为 -inf（strength.py:60-61）。
2. **ACT-R 时间戳压缩（50 精确 + 区间近似的长尾）**（strength.py:276-295）
   能搬：单行 schema 就能容纳的记忆强度表示，写放大可控。
   会坏在：压缩是不可逆的近似，事后想重算精确 B(t) 已无数据；且 `record_access` 每次召回都写全量 StrengthState（cortex.py:689-690），高频召回下反而是热写点。
3. **边的 FSRS 形状时间衰减（流式，不改存储）**（spreading.py:27-54）
   能搬：7 行纯函数，任何图/边表都能直接加。
   会坏在：依赖 `last_activated` 的语义 —— 若插件没有"边被走过"的事件，全表该字段为 NULL，衰减永不生效（:48-49 直接返回原权重），等于白搬。
4. **dream 的阶段化 + 每阶段 checkpoint + LLM 预算硬上限**（dream.py:230-257, :787-805；sqlite_schema.py:173-187）
   能搬：这是我认为最值得抄的工程骨架 —— 长任务拆阶段、每阶段落一行"已完成的阶段名"、重入时跳过；LLM 调用配一个整轮预算计数器，天然防跑飞。
   会坏在：`_running` 是进程内布尔（dream.py:220-221），DSH 插件若有多个 worker/多个会话并发，必须换成 SQLite 行锁或文件锁；另外"失败也继续下一阶段"的策略在插件里会把半成品写进用户记忆，建议改成失败即停。
5. **写入门控的规则集（长度/精确 hash/类型启发/显著性打分）**（thalamus.py:59-184）
   能搬：极低成本地把"什么值得记"变成可调参数，且不依赖模型。
   会坏在：关键词表是英文（HIGH_SALIENCE_KEYWORDS，thalamus.py:29-33），中文输入几乎命中不到，salience 恒为 0.5 基线、类型恒为 semantic；搬到 DSH 必须先做中英双语词表或直接改成 embedding/LLM 判据。
6. **双层去重（精确 hash + 近重复向量，合并即加边不新建）**（coordinator.py:90-130）
   能搬：精确层零成本；近重复层"合并 tags + 微调 salience + 留证据边"比"覆盖写"更可回溯。
   会坏在：近重复分支以新节点 id 建边但新节点未入库（coordinator.py:119-130），在有外键的库里会被吞掉；且它只在**同 collection** 内搜（:303），跨 collection 的重复漏检。
7. **schema 晋升/降级用 tag 记账（support_count:N / dream_cycles_idle:N）**（neocortex.py:59-64, :216-285）
   能搬：不引 schema 迁移就能给节点加"计数字段"的土办法，适合插件早期快速验证"抽象是否被使用"。
   会坏在：状态在 tags 字符串里，查询靠 `LIKE '%"tag"%'`（:113-147），一旦 tag 内容含引号/中文就会失配；计数与真实语义脱钩 —— 零访问 3 轮即**删除**而不是降权，会误杀低频但重要的抽象。
8. **igraph + PRAGMA data_version 的"派生图缓存"**（graph_store.py:72-136）
   能搬：跨进程一致性不靠锁、不轮询，只在真被写过时重建 —— 对"DSH 一个进程写、另一个进程读"的形态极合适。
   会坏在：重建是**全量**从 SQLite 拉全表（:79-110），记忆量上万后每次跨进程写入都全量重建，代价会突然变得不可接受；且它要求真相源是单个 SQLite 文件，插件若拆多库就不成立。
9. **不值得搬：9 个脑区引擎的命名与 63 工具/78 端点的接口面**
   `推断`这是"叙事驱动设计"的产物：thalamus/amygdala/neocortex 这些名字带来的是阅读成本而非机制差异（例如 AffectEngine 实质是一个关键词表，amygdala.py:23-36）。DSH 插件应保留机制（门控/打分/整合/衰减），丢掉分区命名与"每个脑区一个类"的目录结构。

## 未证实 / 缺口

- **无 issue 证据**：仓库 issue 数为 0（含已关闭），因此「用户抱怨」只能来自 ROADMAP/HANDOVER 的自述，不是第三方反馈。
- **无性能基准**：主仓库无 benchmark、无延迟/内存数字；唯一的量化是测试耗时与 Rust 移植版的实测，不能外推。
- **无论文**：未检索 arXiv/Google Scholar，仅确认 README 与 pyproject 不含引用条目。
- **未跑代码**：全部结论来自静态阅读（26,764 行中精读了约 5,000 行核心路径）+ 文档对照；未执行 `pytest`、未启动 MCP/REST 服务、未做端到端写入-召回-做梦验证。
- **long_term→cortex 不可达**、**`_assign_layer` 死分支**、**近重复边悬空**三处均为静态阅读结论，建议实测确认。
- **`DREAM_CLUSTER_SIMILARITY_THRESHOLD` 未使用**：我确认了 import 与 config/settings 三处出现，但 dream.py 内无使用点；不排除有我未读到的动态注入路径。
- **记忆质量类风险（`推断`）**：
  - **召回即写入**：每次 recall 给 top-k 全量记 access 并升 stability（cortex.py:682-690；strength.py:305-308），形成"被召回→更容易被召回"的正反馈；配合"无最低分阈值"，热门记忆会持续垄断 top_k（经典富者愈富）。
  - **LLM 抽象无质量闸**：schema 只按 tag 命中复用（dream.py:506-515），procedure 只按精确内容去重（:451-453）；LLM 返回什么就存什么，除 REM 的 0.4 权重下限外无置信度门槛。
  - **显著性不可证伪**：salience 全靠关键词加法（thalamus.py:134-162；amygdala.py:74-81），负面词加得比正面多（0.1 vs 0.05），会让"失败/报错"类记忆系统性占优。

## 来源清单（每行：标题 — URL — 访问日期 2026-11-22）

- CerebroCortex 主仓库 — https://github.com/buckster123/CerebroCortex — 2026-11-22
- 主仓库元数据（star/fork/license/pushed_at）— https://api.github.com/repos/buckster123/CerebroCortex — 2026-11-22
- README（架构、CCBS token 三档、dream 六阶段、存储三件套）— https://github.com/buckster123/CerebroCortex/blob/main/README.md — 2026-11-22
- CHANGELOG（0.5.1 / 0.5.0 CCBS / 0.4.0 StorageCoordinator）— https://github.com/buckster123/CerebroCortex/blob/main/CHANGELOG.md — 2026-11-22
- ROADMAP（Sprint 1-4，问题陈述与未完成项）— https://github.com/buckster123/CerebroCortex/blob/main/ROADMAP.md — 2026-11-22
- HANDOVER（Session 2 交接，含 "What's NOT Done"）— https://github.com/buckster123/CerebroCortex/blob/main/HANDOVER.md — 2026-11-22
- 源码（本地 clone，commit 05937a0，MIT）— https://github.com/buckster123/CerebroCortex/commit/05937a06265d7558528fb2af8ed15d95b8b31194 — 2026-11-22
- CerebroCortex-RS（对照：性能数字、8 阶段 dream、Darwinian skill 选择）— https://github.com/buckster123/CerebroCortex-RS — 2026-11-22
