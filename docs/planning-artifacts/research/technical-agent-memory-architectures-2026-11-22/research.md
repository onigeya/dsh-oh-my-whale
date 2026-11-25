---
title: 'technical research: AI agent memory architectures (9 reference projects)'
type: 'technical'
topic: 'ai agent memory architectures'
decision: '哦鲸鲸 v1 记忆模块的分层/固化/衰减/检索设计取舍'
source: 'user-provided list of 9 reference projects'
status: complete
preset: 'deep'
validation: 'normal'
created: '2026-11-22'
updated: '2026-11-22'
---

# technical research: AI agent memory architectures (9 reference projects)

**Decision this research serves:** 哦鲸鲸 v1 记忆模块的分层/固化/衰减/检索设计取舍

## 执行摘要

**结论先说：分层与检索已经是标配，差异化只剩「离线固化 + 治理」这一块，而这一块恰好是九家里做得最差的。**

证据：九家里八家有分层、七家有混合检索；但真正落地「做梦」的只有 2 家（CerebroCortex 生成式管线、OpenReverie 四阶段），另 1 家（elo-memory）的 dream 在代码里只是一行调用、README 声称的自动触发与权重回写并不存在；可撤销的遗忘 0/9（nmem 的"遗忘"是静默硬删，用户当 bug 报着）；同时做到「LLM 提议 + 人类可撤销 + 版本可回溯」的 0/9（nmem 只标记不提议，Mem0 干脆不裁决，TencentDB 让 LLM 裁决但无回滚）。

**三条驱动结论的发现：**
1. **参数式 dream 是文档幻觉**——声称"在线积累信号 → 后台 dream 更新权重/衰退系数"的实现里，governor 上下文是硬编码常量，dream 从不回写。本地插件要做这个，需要一整套可验证训练回路；做生成式固化，只需要一条好的批处理管线。
2. **召回即写入是集体陷阱**——CerebroCortex 与 elo-memory 都让检索给记忆升权，结果记忆会被"被检索过的"而非"重要的"占据。
3. **工程品质比算法更稀缺**——确定性种子可重放、产物存在即完成的幂等、逐阶段 dream_log 断点续跑、谓词先于 LIMIT 的隔离。这些决定了 dream 在桌面插件里会不会出乱子，而九家里只有少数做到了。

**最大警示**：九家没有一个可复现的质量或性能数字。本项目的成功标准不能建立在对标数字上，必须自建评测。

**给哦鲸鲸的取舍**：做生成式 dream（不碰参数式）、做可撤销的治理三件套（版本链 + Flag + 软删除）、召回只读、检索先硬阈值后加权、有界检索纪律。这五条合起来，才是这九家没人同时占住的位置。

## 研究对象（用户给定，2026-11-22）

| 项目 | 仓库 | 要挖的角度 |
|---|---|---|
| nmem | https://github.com/nowledge-co/nowledge-mem （原清单的 `nowledge-co/mem` 已 404；核心闭源，无官方开源实现）| 嵌套学习、nightly retrospective（dream）、证据投票晋升、信念修正、多层记忆栈 |
| cerebro-cortex | https://github.com/buckster123/CerebroCortex | 分阶段 dream 引擎（SWS 重放、REM 重组、schema 抽象）、FSRS/ACT-R 衰减曲线、显著性更新 |
| elo-memory | https://github.com/server-elo/elo-memory | dream 周期、因果 DAG 抽取、双召（episodic+facts）、冲突检测、记忆权重动态更新 |
| MemoryOS | https://github.com/BAI-LAB/MemoryOS | 三层分层（短/中/长期）、heat 驱动晋升衰减、对话人格记忆 |
| TencentDB Agent Memory | https://github.com/Tencent/TencentDB-Agent-Memory | 工业分层底座、符号+向量混合召回、实体链接、独立召回管线 |
| Mem0 | https://github.com/mem0ai/mem0 | 生产级记忆层、episodic/semantic 分区、记录-提取-召回链路（对比参考） |
| LangMem | https://github.com/langchain-ai/langmem | 情景/语义/程序三分、事实抽取、冲突校验范式 |
| reflex-memory (ReFlex.AI) | https://github.com/steavehirramsan/ReFlex.AI | 显式 promote/demote 状态机、冷热分层、离线 compaction |
| OpenReverie | https://github.com/vishalvshekkar/openreverie | dream 重放模块、跨时间跨主题重组、graph 溯源 |

## 方法

深档：每个项目 1 名研究员，通读全局后深挖点名部件；证据为 仓库路径:行号 或 URL。digest 落在 `digests/`。

_Sections are appended per the approved research plan; the executive summary is written last and placed here, first._
## 宿主约束：什么能搬、什么搬过来就会坏

依据：`notes-dsh-host-memory.md`（本机实测 + dsh 0.2.2-rc.5 文档）。

| 约束 | 事实 | 对记忆设计的影响 |
|---|---|---|
| 会话日志只读 | 插件可 `sessionPersistence.open(id,'read')`，写入需单写者租约，活跃会话拿不到（persistence.md:11,112） | 记忆必须写进插件自己的存储，不能往宿主日志里塞条目 |
| 事件类型 fail-closed | 未知持久化事件类型不被接受，仅 `ignorable:true` 留存（persistence.md:193） | 不能靠自定义事件做记忆流水，得自建 schema |
| 有持久化 KV | `ctx.storage` domain KV（storage.md:5,34-47） | 元数据、权重、调度游标有地方放；大块记忆仍需文件/DB |
| 有定时任务 | `dsh-schedule` | 「dream」不必等用户触发，可做夜间批处理 |
| 注入点存在且分两种 | `ctx.systemPrompt.section()` 与 cache-safe 的 `PromptContext`（cookbook:112；system-prompt.md:44,78）；每步前置 `agent/pre-step` | 常驻注入会每轮吃 token 且伤缓存 → 记忆注入必须"小而稳"，检索召回走工具或按需 section |
| 工具注册 | `ctx.tools.register()` | 记忆写入/查询可作为显式工具，让 agent 自己决定 |
| GUI 可扩展 | ConversationNodeDefinition + keyed renderer、slots | 记忆浏览/编辑界面可做，不必另开 App |
| 压缩可回溯 | 压缩是 surfaceOp 遮蔽，原始事件仍在日志；反压缩由 billion-context 提供 | 记忆系统可以从"原始历史"里挖料，而不是只吃摘要 |
| 已有竞品 | dsh-mnemon 已实现 USER.md/MEMORY.md 每轮注入 + 记忆空间按需召回 | "记不住"不再是空白点；差异化必须落在固化/裁决/衰减这些它没有的机制上 |

## 横向矩阵（2026-11-22，逐项目 digest 见 digests/）

| 项目 | 分层/结构 | 写入与裁决 | 离线固化（dream） | 衰减/晋升 | 检索管线 | 工程形态 |
|---|---|---|---|---|---|---|
| **nmem**（闭源，318★） | 8 类 unit_type + 三档 importance；Memories/Threads/Wiki/Working Memory；图谱实体+关系 | 模型决定存；写入白名单（只存 decision/procedure/lesson/preference/plan/context）；同主题要求 update 而非新建；契约校验拦非法输出 | 无 dream。替代物：每日 8:00 Working Memory 简报（生成式摘要+图查询）、Crystals、Flags | **无 decay、无 half-life**；遗忘是静默硬删（issue #882 open，用户当 bug 报） | 语义+FTS+图三路；normal/deep/progressive 三档；**有界检索纪律**（默认 5 条、线程读取每问一次、禁 offset 循环、宁报证据不足） | 本地优先 App + 常驻 HTTP 服务 + MCP；核心闭源，schema 不可得 |
| **CerebroCortex**（38★, MIT） | 4 层 sensory/working/long_term/cortex × 6 类记忆 × 9 种边；Episode 是一等公民（dream 工作队列） | Thalamus 门控：长度<10 丢弃、content_hash 精确去重、关键词启发式定类型/salience；近重复余弦≥0.95 合并 | **6 阶段 dream**：SWS 重放→模式提取→schema 形成→情绪再加工→剪枝→REM 重组；每轮 LLM 预算 20 次硬切 12/4/4；逐阶段 dream_log 断点续跑 | FSRS stability/difficulty + ACT-R 激活（access_timestamps ≤50）；四因子打分 0.35 向量+0.30 ACT-R+0.20 FSRS+0.15 salience；**召回即写入**→富者愈富 | 向量（3 collection）→扩散激活→FTS5 兜底→四因子排序；top-k 写回 access | SQLite 单一真相源 + igraph 派生缓存（PRAGMA data_version 做跨进程一致）+ ChromaDB 可重建；Python 库+MCP+REST+CLI |
| **elo-memory**（11★, BSL-1.1） | 单类型 Episode + 独立 KnowledgeBase（key→value facts）；组件并置（governor/causal/dream/auditor/prefetcher/evolution） | 规则抽取（正则实体、关键词主题），**不调 LLM**；两道闸：governor(Thompson) + 垃圾过滤；去重余弦 0.92/0.95；派生事实膨胀 | 四阶段 dream（NREM 按 importance^0.7×(surprise+0.1)^0.3 抽样 30% → importance×1.05；REM 插值生成合成记忆 importance×0.3）；**仅手动触发**，README 的 auto-200 不存在 | 幂律激活衰减 + 对数 rehearsal（几行 numpy）；软删除 `_superseded` 集合，检索/facts/去重三处统一过滤 | 两阶段检索：向量召回 + 时间邻域扩张 + 四因子加权 | 纯 Python，零 API key；内存+Chroma+JSON 冷存三层；根目录与 src/ 双份实现 |
| **MemoryOS**（1626★, EMNLP'25） | 短期/中期/长期三段；中期按 page 组织，page 带 pre/next 链 + 滚动 meta_info；人格画像单独存放 | 每段对话结束更新；画像整篇重写（30 字符闸门）避免 append 脏化 | 无 dream；晋升本身就是固化：短期队列满→刷中期 | **纯数值阈值晋升**：中期堆顶 heat≥5.0 → 蒸馏进长期；heat 清零；无独立衰减时钟（代码无定时器） | 短期/中期/长期各一套检索；查询时现建 FAISS | JSON 全量重写 + 查询时建索引 + 硬 pin faiss-gpu（Py3.12 装不上，issue #76） |
| **TencentDB Agent Memory**（31093★, TS） | L0 原文→L1 记录→L2 scene→L3 persona；外加 Wiki/CodeGraph/Skill 四类资产，统一注册为 Memory Asset | LLM 抽取 + LLM 去重裁决（keep/merge/update/delete，支持多对多合并），采集侧 L0 双保险去重；每 session 上限 20 条 | 分层触发而非 dream：L1 debounce 可重置、L2 定时只提前不推后、L3 全局互斥，warm-up 阈值 1→2→4 | **无 halfLife、无记忆衰减**（decay 只存在于 Wiki 图扩散） | RRF(k=60) 融合 FTS5+向量；scoreThreshold 0.3 与 RRF 量纲不符；IsolationFilter 谓词先于 LIMIT + 取回后复查 | 四包服务化 + 三套存储后端 + Redis/ClickHouse + CodeGraph 外部二进制；本地插件会被原生模块拖死 |
| **Mem0**（69332★, Apache-2.0） | 只有作用域分层（user/agent/run），**没有抽象层级**；记忆平铺在一个向量集合 | **只做 ADD**：单次 LLM 抽取，无 UPDATE/DELETE 判定；md5 精确去重（窗口仅 top-10）+ 实体链接表 | 无。后台零调度，只增不减 | 无 decay（OSS 里显式报错，平台版才有）；删除 5 条就弹窗推销平台 decay | 语义 + BM25（按 query 词数选 sigmoid 参数）+ 实体 boost，加法融合除以自适应除数 | 一条向量库 point 就是一条记忆；含 SDK/服务/云/MCP 插件四种外壳 |
| **LangMem**（1785★） | 语义/情景/程序三分；记忆单元单一 `content` 字段 | 把现有记忆连同**稳定 id** 注入，模型一次并行工具调用产出 insert/update/delete 补丁表；写回前比对 kind/content 是否真变，减少写放大 | 无 dream；有按 thread 去抖的后台反思执行器（新事件到来取消旧任务顺延），不靠 cron | 无；置信度只是提示词里的 p(x) | 向量检索；query_limit 会被截断（issue 报过） | LangGraph 生态；写失败被吞掉（issue #217） |
| **ReFlex.AI**（2★, 6 commits 全在一天） | 单个 SQLite 文件三张表存分层记忆；ArchiveRecord 带 span_start/span_end/source_ids | 未详述抽取；归档时 `DELETE FROM events` 单向删除 | 无 dream；离线 compaction 指归档 | **README 声称 promote/demote 状态机，代码只有一个枚举标签**；`promotion_importance: 0.6` 与 `semantic_threshold` 均声明后从未读取 → 语义层永远不会被归档 | 先按 `min_score` 硬过滤再做 recency 融合（新近不会让无关记忆重新入选）；启动时全量重建向量索引 | 单文件 SQLite，零服务依赖，天然本地优先；但配置项大量空转 |
| **OpenReverie**（1★） | 未详述分层；dream 产物按周期目录组织 | 未详述 | dreaming 四阶段：exploration 多轮工具循环 → insights → narrative → tone；**确定性采样**（mulberry32 + 时间种子，seed 写入产物 frontmatter，`dryRun` 可重放选择） | 未详述 | 未详述；产物必须能解析到真实 doc/session/node 指针，解析不到即丢弃 | 幂等靠「周期目录已存在即完成」，错过周期不补做，无需 job 表；单场梦最多 10 次工具调用 |
**补充：Nested Learning 这条线单独查过了，结论是“不可迁移”。**
一手来源 arXiv:2512.24695v1（Behrouz 等，Google Research，NeurIPS 2025）。它的「多层记忆栈」是 §7 的 CMS：一条更新频率递减的 MLP 链，按 `i≡0 (mod C)` 周期用**梯度**更新（论文里的 “surprise” 就是 ∇L）。**没有官方代码**，只有两个社区复现（★3 / ★2，其中一个自述“无官方代码”且默认偏离论文式 91）。全文 `conflict` / `dream` / `vote` / `promote` 各 0 次。
→ 对一个只有 LLM API、没有训练回路的本地插件，**CMS 不可迁移**：没有梯度就没有 CMS。可借的只有调度直觉——多时间尺度 + 周期批量合并。详见 `digests/nested-learning.md`。

## 跨项目洞察（只有对照之后才看得见的东西）

**1. 分层本身不是差异化，层间流动才是。**
九家里八家有分层，但真正实现了「层间自动流动」的只有 MemoryOS（短期满→中期、中期 heat≥5→长期）、TencentDB（L0→L1→L2→L3 各自触发）和 CerebroCortex（dream 把 episode 提炼成 schema）。Mem0 的"分层"只是 user/agent/run 三个过滤维度，不是寿命层。**照抄分层表不会产生任何价值，抄流动规则才会。**

**2. "做梦"有两种哲学，只有生成式那种落地了。**
- **参数式**：dream 更新权重与衰退系数（elo-memory 的设计意图）。**代码里不存在**——`brain.dream()` 只有一行，没有回写 governor/evolution；governor 的上下文还是硬编码 `DecisionContext(surprise=0.5)`。
- **生成式**：dream 产出新的记忆/摘要/模式（CerebroCortex 6 阶段、OpenReverie 的 insight/narrative/tone 四阶段）。可审计、可复现、可失败重试。
结论：**本地插件要做前者，需要一整套可验证的训练回路；做后者，只需要一个好的批处理管线。** 后者才是一个 DSH 插件够得着的。

**3. 衰减是被集体回避的一环。**
- 有真实数值衰减的只有两家：CerebroCortex（FSRS stability/difficulty + ACT-R 激活，四因子加权）和 elo-memory（幂律衰减 + 对数 rehearsal，几行 numpy）。
- 明确没有的：Mem0（OSS 里 decay 直接报错，平台版才有）、TencentDB（全仓无 halfLife）、nmem（grep half-life = 0）。
- 用别的机制代偿的：MemoryOS 用「晋升阈值」，nmem 用「静默硬删」。
→ 衰减不是"加个半衰期"，而是**决定什么该被遗忘、并且让用户看得见**。目前没人做到"可撤销的遗忘"。

**4. 冲突裁决是最大的空档，而且三家各走极端。**
- nmem：**把裁决交给人**（Flags：矛盾/过期/无据断言，可 dismiss/acknowledge/link），机器只标记。
- Mem0：**干脆不裁决**（只做 ADD，单次 LLM 抽取），代价是只增不减。
- TencentDB：**让 LLM 判决**（keep/merge/update/delete，支持多对多合并），但没有版本链回滚。
没有任何一家同时做到「LLM 提议 + 人类可撤销 + 版本可回溯」。**这是哦鲸鲸最清晰的空地。**

**5. "召回即写入"是这行的集体陷阱。**
CerebroCortex 每次 recall 给 top-k 记一次 access 并升 stability，且无最低分阈值 → 富者愈富；elo-memory 的 `_retrieval_count` 同理只加不减。两家的记忆都会被"被检索过的东西"淹没，而不是被"重要的东西"占据。

**6. 可复现与幂等比算法更值钱。**
OpenReverie 用 mulberry32 + 时间种子，把 seed 写进产物 frontmatter，`dryRun` 只跑选择阶段即可重放"为什么挑了这一条"；它的幂等靠「周期目录已存在即视为完成」，错过周期不补做，不需要 job 表。CerebroCortex 靠 `dream_log` 逐阶段断点续跑。TencentDB 的 L1/L2/L3 触发语义各不相同（debounce 可重置 / 定时只提前不推后 / 全局互斥）。
→ 桌面插件里 dream 最容易出的不是"效果不好"，而是**重复跑、跑一半、跑完不知道改了啥**。这三家用工程手段各自解了一半。

**7. 文档与实现背离是常态，不是例外。**
已确认的三例：elo-memory 的 auto-dream-200 与 dream 后自动演化（代码无对应）、CerebroCortex 的 0.80 聚类阈值（import 了从未使用）与 long_term→cortex 晋升（代码不可达）、MemoryOS 的"轻量"（JSON 全量重写 + 查询时建 FAISS + 硬 pin faiss-gpu）。
**对我们的直接要求：设计文档里每个机制后面必须挂可验证的位置或实验，否则三个月后没人能判断它到底实现了没有。**

## 推荐（绑定到决策）

**R1｜差异化必须落在「离线固化 + 治理」，不能落在「注入更勤」。**（高置信）
证据：dsh-mnemon 已占「每轮注入 USER.md/MEMORY.md + 按需召回」；9 家里分层/检索已是标配（8/9 有分层、7/9 有混合检索）；而 dream 真正落地的只有 2 家、可撤销的遗忘 0/9、LLM 提议 + 人类可撤销 + 版本回溯三者兼得 0/9。

**R2｜"做梦"做生成式，不做参数式。**（高置信）
证据：elo-memory 声称的「在线信号→dream 更新权重/衰退系数」在代码中不存在（`brain.dream()` 单行、governor 上下文硬编码常量）；生成式（CerebroCortex 6 阶段、OpenReverie 四阶段）有可审计产物与断点续跑。参数式需要可验证训练回路，本地插件够不着。

**R3｜衰减用幂律 + 对数 rehearsal 起步，FSRS/ACT-R 留到 v2。**（中置信）
证据：elo-memory 的 `forgetting.py:71-82` 是几行 numpy；CerebroCortex 的 FSRS+ACT-R 四因子需要 50 条访问时间戳与三套参数，且它自己就栽在「召回即写入」上。样本里没有一家证明复杂衰减带来可测收益。

**R4｜检索必须「先硬阈值、后加权」，并把 RRF 与 scoreThreshold 的量纲对齐。**（中高置信）
证据：ReFlex.AI 的 `min_score` 前置过滤（新近不会复活无关记忆）；TencentDB 的 RRF 上限约 0.033 却配默认 `scoreThreshold=0.3`，直接移植会返回空集。

**R5｜召回不写回。**（高置信）
证据：CerebroCortex 与 elo-memory 的召回即写入都导致富者愈富；两家的记忆会被"被检索过的东西"而非"重要的东西"占据。

**R6｜治理三件套是本项目的产品主张：版本链 + Flag + 软删除。**（高置信）
证据：nmem 的 Flags 把裁决交给人但机器不提议；Mem0 只 ADD 不裁决；TencentDB 让 LLM 裁决但无回滚。三者互补，没有现成组合。

## 融合设计草案 v0（供 brief「方案」节使用）

**分层（抄结构，不抄复杂度）**
- L0 原始层：会话事件与工具输出摘录，append-only 文件，**永不进上下文**（DSH 的 session log 已有，我们只存指针）。
- L1 原子记忆：一句话事实/偏好/决策 + `type`（语义/情景/程序）+ `importance`（三档）+ 来源指针（session id + seq 区间）+ `valid_from/valid_to`。
- L2 场景/主题：按项目或主题聚合的 markdown，dream 生成（TencentDB 的 L2 scene + MemoryOS 的 page 链 + 滚动 meta_info）。
- L3 画像：整篇重写而非 append（MemoryOS 的 30 字符闸门），只用于注入。
- 索引：SQLite 单文件（FTS5）+ 可重建向量索引 + 实体链接表（Mem0 的 `linked_memory_ids`）；派生缓存用 `PRAGMA data_version` 判跨进程失效（CerebroCortex）。

**写入（抄补丁表，不抄全量重灌）**
- 入口三种：agent 显式工具 `remember`、用户命令、会话结束的 debounce 抽取（LangMem 的按 thread 去抖执行器，新事件取消旧任务）。
- 抽取：把已有记忆连同稳定 id（`uuid5(namespace, key)`）注入，模型一次并行工具调用产出 insert/update/delete 补丁表；写回前比对 `kind/content` 是否真变。
- 去重：`content_hash` 精确 + 近重复余弦（阈值可关）+ 实体合并。
- 裁决：LLM 只**提议**（keep/merge/update/delete），落库时一律转成「新版本 + 旧版本软删除 `_superseded` + 版本链关系（replaces/enriches/supports/contradicts）」，并生成一条 Flag 待人确认（nmem 的 Flags + elo 的软删除 + TencentDB 的 LLM 判决，各取一半）。

**固化（dream，抄阶段与预算，不抄四阶段模型堆叠）**
- 触发：夜间（dsh-schedule）或空闲；幂等靠「周期标记文件已存在即完成」，错过不补做（OpenReverie）。
- 阶段：① 重放抽样（`importance^0.7 × (surprise+0.1)^0.3`，elo）② 模式提取 ③ 场景/schema 抽象 ④ 剪枝与归档（**可回滚**）⑤ 跨主题重组（产出 insight 必须能解析到真实记忆 id，否则整条丢弃）。
- 预算：每轮 LLM 调用硬上限并按阶段切分（CerebroCortex 的 12/4/4 思路）；逐阶段写 `dream_log`，可断点续跑。
- 可复现：种子写进产物 frontmatter，`--dry-run` 只跑选择阶段（OpenReverie）。

**衰减与晋升（抄阈值，不抄双套理论）**
- 晋升：L1 heat（访问 + 显式确认 + dream 命中）过阈值 → 升 L2；L2 长期不命中 → 归档（不删除）。
- 衰减：幂律 + 对数 rehearsal 作为排序因子，**不改变存储位置**。
- **检索只读**：召回不写回任何计数（修正 CerebroCortex/elo 的缺陷）。

**检索与注入（抄纪律，不抄堆砌）**
- RRF 融合 FTS5 + 向量，`k=60`，阈值与量纲同时校准。
- 有界检索：默认 5 条；每问最多一次；禁止 offset 循环；宁可报「证据不足」。
- 注入：常驻只放 L3 画像摘要 + L2 目录（小而稳，cache 友好）；具体记忆走工具按需取。

**治理（本项目的主张）**
- Flags：矛盾 / 过期 / 无据断言三类，可 dismiss / acknowledge / link（nmem）。
- 版本链：每条记忆可回溯到它替换了什么、被谁改过、哪版 prompt 生成（nmem 四关系 + TencentDB 的 audit/version/generation_refs）。
- 删除：软删除 + tombstone，拒绝静默硬删（nmem issue #882 的教训）。
- 可导出：全部转纯文本 markdown，可读、可 diff、可退出。

## 未决问题

1. ~~nmem 的原始清单指向已 404 的 nowledge-co/mem~~ **已结**：真身是 nowledge-co/nowledge-mem（核心闭源）；补查的 Nested Learning（arXiv:2512.24695）是训练期方法、无官方代码、机制依赖梯度，对本插件不可迁移，只作调度灵感。
2. 九家里没有一家给出可复现的性能或质量数字（Mem0 的 92.5 是厂商自测平台口径，MemoryOS 的 F1 +49.11% 无人复现）。**本项目的成功标准不能建立在对标项目的数字上，必须自建评测集。**
3. ReFlex.AI 与 OpenReverie 都是 1–2 星、单日提交、零外部 issue——它们**不是被验证过的方案，只是有想法的实现**。借鉴它们时按"设计灵感"计，不按"最佳实践"计。
4. DSH 的 `ctx.storage` KV 容量与文件存储位置未实测，需在实现前做一次容量/并发验证。

## 来源附录

| # | 项目 / 来源 | 链接 | 访问 |
|---|---|---|---|
| 1 | nmem（Nowledge Mem） | https://github.com/nowledge-co/nowledge-mem · https://mem.nowledge.co/docs | 2026-11-22 |
| 2 | CerebroCortex | https://github.com/buckster123/CerebroCortex | 2026-11-22 |
| 3 | elo-memory | https://github.com/server-elo/elo-memory | 2026-11-22 |
| 4 | MemoryOS | https://github.com/BAI-LAB/MemoryOS | 2026-11-22 |
| 5 | TencentDB Agent Memory | https://github.com/TencentCloud/TencentDB-Agent-Memory | 2026-11-22 |
| 6 | Mem0 | https://github.com/mem0ai/mem0 · https://arxiv.org/abs/2504.19413 | 2026-11-22 |
| 7 | LangMem | https://github.com/langchain-ai/langmem | 2026-11-22 |
| 8 | ReFlex.AI | https://github.com/steavehirramsan/ReFlex.AI | 2026-11-22 |
| 9 | OpenReverie | https://github.com/vishalvshekkar/openreverie | 2026-11-22 |
