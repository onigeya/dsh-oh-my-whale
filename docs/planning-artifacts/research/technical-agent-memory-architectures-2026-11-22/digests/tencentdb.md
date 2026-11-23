# TencentDB Agent Memory · 实现机制 digest

> 证据基线：`git clone --depth 1` 于 2026-11-22，HEAD = `083c64b11a6748b49278c15f3f0dc77dfd5a99fa`（2026-11-19，作者 Yuntong8888，提交信息 "Update README_CN.md (#2002)"），1302 个受版本控制文件。下文所有 `路径:行号` 均指该 commit。
> 标注约定：**[代码]** = 仓库源码确实这么写；**[README]** = README 的声称；**[推断]** = 我的推理，未直接取到证据；**[未证实]** = 本轮拿不到证据。
> 研究防火墙：本 digest 只基于本仓库公开内容，未读取委托方任何文件。

## 身份确认（URL、star、语言、最近提交、是否有论文）

- 目标 URL `https://github.com/Tencent/TencentDB-Agent-Memory` 返回 200，但 **GitHub API 返回的 `full_name` 是 `TencentCloud/TencentDB-Agent-Memory`** —— 即 Tencent 命名空间下的地址重定向到 TencentCloud 命名空间。**我实际读到的是 `TencentCloud/TencentDB-Agent-Memory` 的内容。** [代码/证据] `https://api.github.com/repos/Tencent/TencentDB-Agent-Memory`（2026-11-22 访问）。
- 直接 web_fetch `https://github.com/TencentCloud/TencentDB-Agent-Memory` 首次返回 `fetch failed`，重试未再取；但 raw clone 与 API 均成功，仓库内容自洽，**不存在 404/空仓库/同名错项目问题**（对 `TencentDB-Agent-Memory` 项目名做体检：README 主题为 "team-level memory hub for AI Agents"，与委托书描述的四类记忆资产完全吻合）。
- 指标（GitHub API 快照，2026-11-22）：**star 31,093 / fork 3,045 / 语言 TypeScript / 最近 push 2026-11-19T12:43:39Z / open issues 850 / license = NOASSERTION**。
- 仓库自述（API `description`）：*"a team-level memory hub for AI Agents — turning conversations, docs, and code into four reusable memory assets (Chat Memory, Skill, LLM-Wiki, Code-Graph) that are governed, shared, and equipped across agents and frameworks."* 顶层 topics 含 `local-first`、`vector-search`、`openclaw-plugin`。
- 是否有论文：**未发现**。README 只有一段 "Benchmark" 表，未给出 arXiv/PDF 链接（`README.md:285-291`）。**[未证实]** 是否存在未链接的论文或博客。
- 版本：`MemoryCore/package.json` `@tencentdb-agent-memory/memory-tencentdb-v2@1.0.2-beta.1`；`MemoryKnowledge` `knowledge-service@0.1.0`；`MemoryProxy` `context-proxy@0.1.0`；`MemoryPanel` `team-memory-control@0.1.0`。整体仍是 beta/0.x，**不是稳定 API**。

## 一句话定位

一个**多进程的服务化「团队记忆中枢」**：用 LLM 把 agent 会话蒸馏成 L0→L1→L2→L3 四层 chat memory，把文档编译成带 wikilink 图的 Wiki、把代码库索引成 CodeGraph、把完成的工作沉淀成带版本的 Skill；四类资产统一注册为「Memory Asset」，靠 team/user/agent/task + ACL 决定「哪个 agent 能装哪个资产」，再按当前 query 检索注入。宿主形态是 **插件 + 常驻服务 + HTTP/MCP 工具面**，不是纯库。

## 架构总览（组件与数据流）

四个可独立部署的包 + 一个 SDK：

| 组件 | npm 名 / 版本 | 角色 | 证据 |
|---|---|---|---|
| `MemoryCore` | `memory-tencentdb-v2@1.0.2-beta.1` | 记忆引擎：capture→L1→L2→L3 管线、存储抽象（sqlite/tcvdb/mongodb）、gateway HTTP、context offload、CLI | `MemoryCore/package.json`；`MemoryCore/src/core/`、`src/gateway/`、`src/offload/` |
| `MemoryKnowledge` | `knowledge-service@0.1.0` | Wiki ingest/检索 + CodeGraph 服务，Hono + drizzle/SQLite，暴露 MCP server 与 `/v3/tools/*` | `MemoryKnowledge/package.json`；`src/mcp/server.ts`、`src/routes/` |
| `MemoryProxy` | `context-proxy@0.1.0` | 站在 agent 与 LLM 之间的反向代理：注入记忆、拦截写入、按需挑 Skill；每个 agent 一个 adapter | `MemoryProxy/src/agent-adapters/{claude-code,codex,dsh,opencode,pi,workbuddy,codebuddy}.ts` |
| `MemoryPanel` | `team-memory-control@0.1.0` | 人用的控制面板（团队、资产库、装填、ACL、分析） | `MemoryPanel/src/panel/` |
| `sdk/memory-core` | — | 对外 SDK 目录 | `sdk/memory-core/` |

数据流（**[代码]** 拼接，非单文件自述）：
1. agent 请求经 `MemoryProxy` → session 注册（`src/session/registrar.ts`）→ 注入管线（`src/injection/pipeline.ts`）在请求里塞记忆 → 转发上游。
2. 会话结束/每轮：`extraction-gate.ts` 判定该资产能否写入（`MemoryProxy/src/extraction-gate.ts:35-44`）→ `recordTdaiTurn` 落 L0。
3. `MemoryCore` 的 `auto-capture` 在 `agent_end` 抓消息（`src/core/hooks/auto-capture.ts`）→ `MemoryPipelineManager.notifyConversation` → 到阈值触发 L1，L1 完成 10s 后 L2，L2 完成后 L3（`src/utils/pipeline-manager.ts:1-77`）。
4. Knowledge 侧独立：文档/仓库进 `ingest-v2` 编 Wiki，或 `codegraph` 建图，状态机 pending→ready 写在 `knowledge_wiki` / `knowledge_code_graph`（`MemoryKnowledge/src/db/schema.ts:18-88`）。
5. 读取时 agent 主动调 MCP 工具（`wiki_search`、`code_callers`…）而非全量注入（`MemoryKnowledge/src/mcp/tools.ts`，工具名见下）。

## 数据模型与存储

**记忆单元 = L1 记录**，一条 = 一句可独立复用的事实/偏好/约束/事件。

```sql
-- MemoryCore/src/core/store/sqlite/memory-store.ts:485-504  [代码]
CREATE TABLE IF NOT EXISTS l1_records (
  record_id TEXT PRIMARY KEY, content TEXT NOT NULL, type TEXT DEFAULT '',
  priority INTEGER DEFAULT 50, scene_name TEXT DEFAULT '',
  session_key TEXT, session_id TEXT, team_id TEXT, task_id TEXT,
  user_id TEXT NOT NULL, agent_id TEXT NOT NULL, version INTEGER NOT NULL,
  timestamp_str, timestamp_start, timestamp_end, created_time, updated_time,
  metadata_json TEXT DEFAULT '{}'
)
```

- `type` 取值域（LLM 抽取时强制）：`persona | episodic | instruction | work_fact | work_task | work_method | work_artifact`（`MemoryCore/src/core/prompts/l1-dedup.ts:67`）。**[代码]**
- `priority` 0–100 整数，默认 50；合并时要求 LLM「酌情提升」（`l1-dedup.ts:77`）。**[代码]**
- L0 原文表：`l0_conversations(record_id, session_key, role, message_text, recorded_at, timestamp, …)`（`memory-store.ts:607-619`）。**[代码]**
- L2 = 按 scene 组织的 markdown 块（`scene_name` 回填到 L1），L3 = persona 长档；两者有备份配额 `backupCount=3`、`sceneBackupCount=10`（`MemoryCore/src/config.ts:705-706`），并有 scene 长度硬上限 `maxSceneBytes=262144` / `maxScenes=15`（`config.ts:700-701`）。**[代码]** 具体落盘文件名/扩展名未逐行核对 **[未证实]**。
- 审计与溯源：`memory_audit(layer in L1/L2/L3, action in update/delete, version, request_id)`（`memory-store.ts:843-855`）；`memory_prompts` / `memory_prompt_settings` / `memory_generation_refs`（`memory-store.ts:862-929`）—— **每条记忆能追到「哪版 prompt 生成的」**，这是本仓库最工程化的设计之一。**[代码]**
- 身份表（"实体链接"的实际形态）：`entity_teams / entity_users / entity_agents / entity_tasks / entity_knowledge`（`memory-store.ts:748-819`）。**[代码]**
- Skill：`skills(row_id, skill_id, version, is_head, content_hash, manifest_json, storage_dir, status)`，主键 `UNIQUE(skill_id, version)`（`MemoryCore/src/core/skill/skill-store-ddl.ts:22-46`）。**[代码]**
- Knowledge 侧：6 张 drizzle 表 —— `knowledge_code_graph`、`knowledge_wiki`、两张 audit、`knowledge_source_credential`、`llm_binding`（`MemoryKnowledge/src/db/schema.ts:18-169`）。**[代码]**
- Wiki 页内索引：`page_meta`、`graph_edge(source_id,target_id)`、`source(filename, sha256, status, ingested_at)`（`MemoryKnowledge/src/engines/wiki/index-db.ts:86-117`）。**[代码]**

**存在哪**：默认 **SQLite**（`storeBackend` 默认 `"sqlite"`，`config.ts:618-622`），另有 `tcvdb`（腾讯向量库）与 `mongodb` 两个后端（`config.ts:245` `type StoreBackend = "sqlite" | "tcvdb" | "mongodb"`）。SQLite 侧用 `sqlite-vec`（`vec0` 虚拟表）+ FTS5；向量维度存在 `embedding_meta` KV 表（`memory-store.ts:412-415`）。**不是图数据库**：wiki 的边是 SQLite 两张普通表 + 进程内 graphology 图（`graphology`/`graphology-communities-louvain` 依赖见 `MemoryKnowledge/package.json`）。

## 写入路径

- **触发**：`agent_end` 事件抓消息（`auto-capture.ts`），L1 在「会话轮数达 `everyNConversations`」或「空闲 `l1IdleTimeoutSeconds`」时触发；默认 `everyNConversations=5`、`l1IdleTimeoutSeconds=600`（`config.ts:721-723`）。**[代码]**
- **谁决定写**：LLM。L1 抽取 prompt 明确排除「重复的内容；AI 助手自身的行为或输出」（`MemoryCore/src/core/prompts/l1-extraction.ts:64`），每 session 最多 `maxMemoriesPerSession=20` 条（`config.ts:694`）。**[代码]**
- **抽取方式**：LLM 抽取 + LLM 去重（默认 `enableDedup=true`，`config.ts:693`）。无纯规则抽取路径（`extraction-gate` 只是开关，不产出记忆）。**[代码]**
- **用户显式**：有 —— `MemoryProxy/src/mem-command/` 解析 `/mem` 命令（`parser.ts`、`commands/`），属于用户手动写。**[代码]**
- **去重与噪声控制（三段）**：
  1. 检索候选：用「FTS ∥ 客户端向量」并行召回再 RRF 融合，取 top-`conflictRecallTopK=5`（`MemoryCore/src/core/record/l1-dedup.ts:41,228`；`config.ts:746`）。**[代码]**
  2. LLM 裁决：输出 `keep / merge / update / delete`，支持**多对多合并**（`target_ids` 数组）与跨 type 合并，并回填 `merged_type`、`merged_priority`、`merged_timestamps` 并集（`prompts/l1-dedup.ts:22-24,66-78`）。**[代码]**
  3. 采集侧防重：L0 记录有「双保险」去重（`MemoryCore/src/core/conversation/l0-recorder.ts:127` 注释 "Dual protection against duplicate capture"）。**[代码]**
- **写闸门**：每个写入调用点套 `isExtractionAllowed(config, asset)`；配置缺失时**故意宽松放行**（`enabled:false` 才全禁，`extractors:[]` 才全禁），这是为向后兼容做的取舍（`MemoryProxy/src/extraction-gate.ts:18-44`）。**[代码]**

## 点名深挖：工程侧 schema、索引隔离、符号+向量混合的双召管线实现、实体链接、四类记忆资产（Chat Memory / Skill / LLM-Wiki / Code-Graph）的组织

### 1) 工程侧 schema
三套 schema 并存，分工明确：**MemoryCore 用裸 DDL 字符串**（`store/sqlite/memory-store.ts` 内 `CREATE TABLE IF NOT EXISTS`），**MemoryKnowledge 用 drizzle-orm**（`db/schema.ts` + `drizzle-kit`，`MemoryKnowledge/package.json` scripts `db:generate/db:migrate`），**MemoryProxy 用 drizzle**（`MemoryProxy/src/db/schema.ts`：`meta`、`sessions`、`hook_cache`）。**[代码]**
软删统一用 `deleted_at` + **部分唯一索引**（`WHERE deleted_at IS NULL`），见 `knowledge_wiki/schema.ts:83-85`、`knowledge_code_graph:46-48`。这是可照抄的小而硬的模式。**[代码]**

### 2) 索引隔离
- 统一抽象 `IsolationFilter`（`MemoryCore/src/core/store/isolation.ts:40`），由 `buildIsolationWhere()` 编译成 SQL WHERE 片段（`:120`），并有**检索后二次校验** `checkIsolation`（`:155-161`）—— 即使后端漏过滤也不会越权返回。**[代码]**
- 三个后端各自实现：sqlite（`store/sqlite/memory-store.ts:1333,3012` 等每个 search/delete 都带 `filter?`）、mongodb（`store/mongodb/doc-mappers.ts:210-228`，注释强调隔离谓词必须在 `$limit` **之前**）、tcvdb（`store/tcvdb/memory-store.ts:189-192`，注释写明「team 级隔离过滤必须最先出现」）。**[代码]**
- 隔离维度就是记录上的 `team_id / user_id / agent_id / task_id` 四列（`l1_records` DDL 见上），**索引隔离 = 查询谓词隔离，不是物理分库**。**[代码]**

### 3) 符号 + 向量混合的双召管线（**这是最值得看的部分**）
- 客户端混合：`auto-recall.ts:644` "Strategy: Hybrid (Keyword + Embedding + RRF)"；两条腿并行 → RRF 融合，`RRF_K = 60`，score = `1/(k+rank+1)`，同 id 相加后再截断（`auto-recall.ts:745-779`）。**[代码]**
- 服务端混合：走 TCVDB 时「single API call 内做 dense + sparse + RRF」，客户端 RRF 只作 SQLite 回退（`auto-recall.ts:519,531`）。**[代码]**
- 公共实现抽成 `rrfMerge<T>()`，注释直接标注「Standard RRF constant from the original RRF paper」（`src/core/store/search-utils.ts:15-61`）。**[代码]**
- 中文/BM25：本地 `@node-rs/jieba` 分词 + `@tencentdb-agent-memory/tcvdb-text` 稀疏编码，`bm25.enabled` 默认 true、`language` 默认 `"zh"`（`config.ts:767-770`）。**[代码]**
- Wiki 侧是**另一种双召**：MiniSearch BM25 出种子 → 沿 `[[wikilink]]` 边做 BFS 多跳，每跳 `score *= decay`，低于 `minScore` 剪枝，硬上限 200 节点防稠密图 DoS（`MemoryKnowledge/src/engines/wiki/graph-search.ts:2-12,38,70-78`）。**[代码]**
- **CodeGraph 侧未发现向量召回**：知识服务的依赖里只有 `minisearch`（BM25），没有 embedding 客户端；代码检索靠外部 `@colbymchenry/codegraph` 的符号工具。所以「符号+向量双召」在**Chat Memory 与 Wiki 成立，在 CodeGraph 未证实**。**[代码 + 未证实]**

### 4) 实体链接
- 仓库里的「实体」是**身份实体**：team/user/agent/task 五张表 + 记录上的四个外键列，关系存在 `user_ids_json / agent_ids_json / task_ids_json` 这类 JSON 数组字段（`memory-store.ts:748-819`）。**[代码]**
- **没有找到语义实体消解/别名归一（entity resolution）的实现**：全仓 grep `entityLink|linkEntities|resolveEntity` 无实现命中，只有身份表读写。**[代码/负证据]**
- 跨资产的「链接」靠两处：`entity_knowledge`（知识资产挂在 team/agent 上，`memory-store.ts:806-819`）与 `meta_assets / meta_agent_fixed_assets / meta_asset_acl`（资产-ACL-装填，`MemoryCore/scripts/db/sqlite-init.sql`）。**[代码]**
- 结论：**它做的是「资产身份图 + ACL」，不是「记忆实体图」**。委托书里的「实体链接」若指 knowledge-graph entity linking，本项目基本没有。**[推断，基于上述两条]**

### 5) 四类记忆资产的组织
| 资产 | 存储 | 单元 | 生成 | 读取 |
|---|---|---|---|---|
| Chat Memory | `l0/l1` 表 + scene/persona 文件 | L1 record（7 种 type） | LLM 抽取 + LLM 去重 | 混合召回注入 prompt |
| Skill | `skills` 表 + `storage_dir` 文件树 | (skill_id, version) 不可变行，`is_head` 指当前版 | 会话里抽取 → 版本化 | Proxy 每轮最多挑 1 个（README:297） |
| LLM-Wiki | Wiki 目录 + `page_meta/graph_edge/source` | 一个 markdown 页 = 节点 | ingest-v2：转换→chunk→LLM 合并→建索引 | `wiki_search/wiki_read/wiki_list/wiki_graph` |
| Code-Graph | 外部 codegraph 索引 + `knowledge_code_graph` 元数据 | 文件/符号/调用边 | 克隆仓库→建图（`store/code-graph-service.ts`） | `code_search/code_explore/code_callers/code_callees/code_impact/code_node/code_status/code_files` |

- 12 个 MCP 工具名取自 `MemoryKnowledge/src/mcp/tools.ts`。**[代码]**
- CodeGraph 是**薄桥接**：`engines/code/bridge.ts` 仅 6.7KB，动态 `import("@colbymchenry/codegraph")` 并按其平台包解析 `mcp/tools.js`（`bridge.ts:2-5,25-39`）。**核心索引能力不在本仓库，是第三方依赖**。**[代码]**
- Wiki 的 ingest 有完整的 v2 管线：`chunker / frontmatter / merge / cascade / index-builder / prompts / safe-path`（`MemoryKnowledge/src/engines/wiki/ingest-v2/`，`manager.ts` 42KB 是最大单文件）。**[代码]**

## 读取路径

- **策略**：`recall.strategy` 默认 `"hybrid"`，可选 `embedding | keyword`（`config.ts:735`）。**[代码]**
- **排序与阈值**：RRF 分数降序；`scoreThreshold` 默认 **0.3**；`maxResults` 默认 **5**；整体超时 `timeoutMs` 默认 **5000ms**，超时则整次 recall 跳过并告警（`config.ts:729-737`）。**[代码]**
- **注入形态**：一行一条，`- [type|scene] <content> (活动时间: …)`，时间支持「点时间」与「段时间」两种语义（`auto-recall.ts:798-851`）。**[代码]**
- **token/字符预算**：`maxCharsPerMemory` 与 `maxTotalRecallChars` 默认 **0 = 不限**（`config.ts:732-733`），`applyRecallBudget()` 会截断或丢弃并计数（`auto-recall.ts:854-870`）。**默认不设预算这一点与 README「capped by character budget」的说法不一致——README 描述的是能力，不是默认值。** **[代码 vs README 差异]**
- **分层读取**：常态用 L2/L3 做 context bootstrap，需要具体事实时才回落到 L1/L0 的 BM25+向量+RRF（`README.md:271` **[README]**；代码侧对应 `persona`/`scene` 装配与 `auto-recall` 两条路径并存）。
- **知识侧不注入**：Wiki/CodeGraph 只在 agent 主动调工具时进上下文，README 明确「called on demand」（`README.md:279-283`），服务端 `/v3/tools/list`、`/v3/tools/call`（`README.md:281`；路由 `MemoryKnowledge/src/routes/tools.ts`）。**[README + 代码]**

## 生命周期规则与参数

| 机制 | 实现 | 默认参数 | 证据 |
|---|---|---|---|
| 晋升 L1→L2 | 每 session「只提前不推后」的下降型定时器，L1 完成后 `now+delay`，下限 `lastL2+min`，上限 `maxInterval` | `l2DelayAfterL1Seconds=10`、`l2MinIntervalSeconds=900`、`l2MaxIntervalSeconds=3600` | `pipeline-manager.ts:18-24,66-71`；`config.ts:724-726` |
| 晋升 L2→L3 | L2 完成后触发，全局互斥 + pending 去重 | `persona.triggerEveryN=50` | `pipeline-manager.ts:26-27`；`config.ts:699` |
| 冷会话停摆 | 不活跃超窗口则取消 L2 定时器，等下一次 L1 重新武装 | `sessionActiveWindowHours=24` | `pipeline-manager.ts:22-24`；`config.ts:727` |
| 合并 | LLM merge/update，多对多，合并后提升 priority | 候选池 top-5 | `prompts/l1-dedup.ts:22-24,77` |
| 遗忘（TTL） | 每日定点清理 L0/L1 | `cleanTime` 默认 `"03:00"`；`l0l1RetentionDays` 默认 **0 = 不清理** | `config.ts:612,688`；`MemoryCleanupConfig` `:204-212` |
| 衰减（decay） | **仅存在于 Wiki 图扩散**：每跳 score×decay | 调用方传参，默认上限 200 节点 | `wiki/graph-search.ts:30-46` |
| 半衰期 | **未发现任何 halfLife/半衰期实现**（全仓 grep `halfLife|half-life|衰减` 仅命中 wiki 图与中文注释） | — | 负证据 |
| 版本/回滚 | `version` 列 + `memory_audit` + 备份配额 | `backupCount=3`、`sceneBackupCount=10` | `memory-store.ts:843-855`；`config.ts:705-706` |
| 单次 L2 上限 | 超限不下发，留给下一轮 L2 | `l2MaxRecordsPerRun=200`、`l2MaxCharsPerRun=60000` | `config.ts:104-113,703-704` |

**结论：这是一套「分层 + 合并 + TTL 遗忘 + 版本备份」的生命周期，没有基于时间或访问频次的记忆衰减/打分衰减。** priority 是静态字段，只在 LLM 合并时被要求提高。**[代码 + 推断]**

## 后台调度

- **调度模型**：进程内 `ManagedTimer`（`src/utils/managed-timer.ts`）+ 两种语义：L1 用**可重置 debounce**，L2 用**只提前不推后的下降型定时器**，L3 用**全局互斥 + pending 标志去重**（`pipeline-manager.ts:29-41,73`）。**[代码]**
- **并发**：所有队列 `SerialQueue(concurrency=1)`（`pipeline-manager.ts:73`；`src/utils/serial-queue.ts`）；另有 `worker-permit-pool.ts`、`services/pipeline-worker.ts`、`services/timer-scanner.ts` 做许可与扫描；Skill 抽取有独立 `worker-pool.ts`。**[代码]**
- **冷启动热身**：L1 阈值 1→2→4→8→…→`everyNConversations`（默认 5），首轮会话即触发一次（`pipeline-manager.ts:53-64`；`config.ts:722`）。**[代码]** 这个「warm-up 阈值倍增」是很值得偷的小设计。
- **失败恢复**：`sceneTimeoutMs=480000`（8 分钟）兜 L2 单次上限（`config.ts:702`）；L2 积压超 200 条/60000 字符就切分，「历史上一次性全塞 LLM 导致每次重试都超时」被写进注释当作教训（`config.ts:104-113`）。**[代码]**
- **优雅退出**：shutdown 时 flush 所有 pending buffer 走 L1→L2（`pipeline-manager.ts:50-51,71`；`MemoryCore/index.ts:931` "scheduler flush"）。**[代码]**
- **另一种后台**：`offload`（上下文压缩）自带 task-transition 状态机、timer-scanner、reclaimer（`src/offload_server/task-transition.ts`、`src/offload/reclaimer.ts`），与记忆管线是两套独立调度。**[代码]**
- 知识侧有 `auto-sync-scheduler.ts` + `build-queue.ts` + `serial-queue.ts`（`MemoryKnowledge/src/store/`）。**[代码]**

## 工程形态与代价

- **语言/构建**：纯 TypeScript ESM，pnpm workspace，`tsdown` 打包，vitest 测试；`MemoryKnowledge` 用 drizzle-kit 迁移。**[代码]** `*/package.json`
- **依赖重量（真实代价）**：`MemoryCore` 40+ 运行时依赖，含 `mongodb`、`sqlite-vec`、`@node-rs/jieba`（原生）、`@ai-sdk/openai`、`ai`、`js-tiktoken`、`undici`、5 个 OpenTelemetry 包；`MemoryKnowledge` 含 `better-sqlite3`（原生）、`graphology`、`minisearch`、`officeparser`、`simple-git`、`@colbymchenry/codegraph`（**平台二进制包，按 `platform-x64` 解析**，`bridge.ts:25-38`）；`MemoryProxy` 含 `ioredis`、`@clickhouse/client`、`node-pty`、Langfuse。**三个包各有原生模块或外部服务客户端**。**[代码]** `package.json`
- **部署复杂度**：4 个服务 + 可选 Redis / ClickHouse / TCVDB / MongoDB / COS；`INSTALL.md` 39KB、`README.deployment.md` 21KB、`README.docker.md` 9.5KB、`deploy/{dockerhub,global-images,panel-knowledge-combined}`、多个 `docker-compose*.yaml`。**[代码]** 这是「团队级产品」而非「塞进 agent 的小库」。
- **可观测性**：OpenTelemetry（trace+logs OTLP）贯穿三个服务；Langfuse（`@langfuse/otel`、`@langfuse/tracing`）；ClickHouse 遥测（`MemoryProxy/src/clickhouse.ts`、`MemoryKnowledge/src/clickhouse-telemetry.ts`）；自有 `api-trace`（请求级日志+脱敏 `api-sanitize.ts`）与 `memory-generation-log`（生成溯源）。**[代码]**
- **性能数字**：README 只给了一个 —— PersonaMem **48% → 76%（+59%）**（`README.md:287-291`）。**这是单来源（项目自述），无第三方复现、无论文、无测试脚本对应**，按委托书规则标 **单源/未证实**。仓库里另有 `scripts/bench-l0-mongo/`（BM25 压测：写入吞吐、索引可见延迟、无命中路径定价），但**没有提交结果报告文件**，故无可引用数字。**[代码 + 未证实]**

## 可迁移到「本地优先的 DSH 插件」的部件（逐条：能搬什么、搬过去会坏在哪）

1. **RRF 混合召回（FTS5/BM25 ∥ 向量，k=60）**
   - 能搬：`rrfMerge<T>()` 是 30 行纯函数（`search-utils.ts:38-61`），SQLite + `sqlite-vec` + FTS5 在 DSH 本地完全可行；`scoreThreshold=0.3`、`maxResults=5`、`timeoutMs=5000` 是可直接沿用的保守默认。
   - 会坏在：`RRF` 分数与「相似度阈值 0.3」**量纲不匹配**——0.3 更像是给余弦相似度用的，而 RRF 分数上限约 2/61≈0.033。代码里两者都叫 score，实际语义要靠各后端自己保证；照抄阈值会得到「永远召回 0 条」或「永不截断」。**必须先统一分数量纲再谈阈值。** **[推断，基于 RRF 公式与 config 注释]**
   - 中文分词：`@node-rs/jieba` 是原生模块，DSH 插件若要求零编译安装，应换 SQLite 内置 `unicode61`/`trigram` 或降级到 keyword-only。

2. **L0→L1→L2→L3 分层 + 每层不同触发节奏**
   - 能搬：分层本身的**语义**（原文留证 / 原子事实 / 场景块 / 长期画像）与 warm-up 阈值倍增（1→2→4→…）非常契合 DSH 的「会话记忆」。
   - 会坏在：本项目靠 `agent_end` hook 和常驻进程计时器（L2 15 分钟 floor、1 小时上限）。DSH 插件是**请求驱动**的，没有常驻调度器时，L2/L3 只能在「下次会话开始」补算，等于把定时语义换成惰性语义；另外 L2/L3 每次都要调 LLM，本地优先场景要不改成可选云端增强，要不就得接受小模型质量下降。**[推断]**

3. **`memory_audit` + `version` + `memory_generation_refs` 三元溯源**
   - 能搬：极轻（三张表，DDL 见 `memory-store.ts:843-929`），让「这条记忆哪来的、哪版 prompt 生成的、被谁改过」可回溯。这是本项目最被低估的设计，也是本地记忆最缺的东西。
   - 会坏在：`memory_generation_refs` 依赖「prompt 版本表 + 生成日志」两套配套，单独抄一张表会变成孤儿记录。

4. **`IsolationFilter` 维度化隔离 + 检索后二次校验**
   - 能搬：把 `team/user/agent/task` 降维成 `project/session/agent` 三列，配合部分唯一索引（`WHERE deleted_at IS NULL`）就能在单机 SQLite 上做到「隔离谓词先于 LIMIT」。
   - 会坏在：本项目的隔离是**多租户 ACL 驱动**的（面板、`meta_asset_acl`、四种 visibility），DSH 单用户场景搬全套 ACL 是纯负担；只需保留「谓词先于 limit + 取回后复查」这两个不变量。**[推断]**

5. **Skill 版本化（`skill_id + version + is_head + content_hash`）**
   - 能搬：不可变版本行 + head 指针 + 内容哈希，天然支持「改了能回滚、能比对」。
   - 会坏在：DSH 已有自己的 skill 目录约定（SKILL.md + frontmatter），再引入一套 SQLite 版本表会产生**双真相源**；更合适的做法是只借 `content_hash` + `is_head` 概念，落到文件系统。

6. **不该照抄的那一个：四包服务化 + 多后端抽象**
   - `MemoryCore/MemoryKnowledge/MemoryProxy/MemoryPanel` 四个进程、三套存储后端（sqlite/tcvdb/mongodb）、Redis、ClickHouse、Langfuse、OpenTelemetry、docker-compose、39KB 安装文档。对一个本地优先的 DSH 插件来说，这是**把运维成本搬进了用户机器**：任何一个后端分支都要维护，原生依赖（jieba、better-sqlite3、node-pty、codegraph 平台二进制）会直接毁掉「装个插件就能用」。
   - 更具体的坑：CodeGraph 的核心是外部闭源二进制包（`bridge.ts:25-38` 按平台解析），**一旦上游不发某个平台包，功能直接缺失**，且错误信息只有一句 "platform package not installed"。这属于不可控依赖，不该照抄。

## 未证实 / 缺口

- **无论文**：未发现 arXiv/PDF；PersonaMem 48→76 只有 README 单源，无脚本、无复现说明。**[未证实]**
- **CodeGraph 无向量召回**：知识服务依赖里没有 embedding 客户端，只有 `minisearch`（BM25）；「符号+向量双召」在 CodeGraph 侧未被证实，可能完全由第三方 codegraph 内部实现（本仓库看不到）。**[未证实]**
- **L2/L3 落盘格式**：只确认了备份配额与 scene 字节上限，未逐行核对文件命名/序列化格式（可能在 `core/persona/` 与 `core/scene/` 内，本轮未展开）。**[未证实]**
- **issue 修复状态**：只取了 open 列表的快照，**未逐条核对是否已有 fix PR/新版本**；任何「已修复」判断都未做。**[未证实]**
- **真实性能**：除 README 的 PersonaMem 数字外，仓库内 `scripts/bench-l0-mongo/` 有压测代码但无结果报告，故无第二个性能来源。**[未证实]**
- **License**：API 报 `NOASSERTION`，`LICENSE` 文件 1341 字节但本轮未读，不能断言是 Apache-2.0 / MIT。**[未证实]**
- **850 个 open issue** 我只看了最新 12 条；issue 总量与项目年龄的比例值得单独评估。**[未证实/范围限制]**

## 它踩过的坑（issue 实录，2026-11 快照）

全部为 **open 状态**（即当前版本仍存在或未确认修复）：

- **#1997 L2 scene extraction 永远卡死**：standalone-runner 的 storage read 工具**没有大小上限** → 400 `context_length_exceeded` 死循环。与 `config.ts:104-113` 那段「积压一次性塞 LLM 导致每次重试都超时」的注释是同一类坑，说明**默认上限只覆盖了 L2 输入侧，没覆盖工具读回侧**。`https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/1997`
- **#2005 存储型 prompt injection**：recall 上下文里注入段落的边界未转义，可由记忆内容自身突破边界。**这是「记忆即攻击面」的直接证据**，对任何把外部文本拼进 system prompt 的插件都适用。`https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/2005`
- **#1996 `queryL1Records` 忽略 `recordIds`**：`/atomic/update` 会读到最旧一行并覆盖目标记录的 identity 字段 —— **记忆串号 / 张冠李戴**类 bug，正是「记忆幻觉」的工程根源之一。`.../issues/1996`
- **#2011 SQLite 后端丢 `sendDimensions`**：导致某些 OpenAI 兼容 embedding 服务（腾讯 TokenHub）不可用 —— 配置项在一条后端路径上**静默失效**，与 `config.ts:178-184` 那段「self-hosted 模型会 400」的注释互为印证。`.../issues/2011`
- **#2000 韩文仅标题 wikilink 无法解析**：Wiki 链路对非中英文字符的 slug/标题匹配有缺口。`.../issues/2000`
- **#2015 Proxy 对 `Expect: 100-continue` 返回 502**、**#2016 README 记的 `/v2/atomic/add` 端点不存在**：文档与实现漂移、反向代理健壮性问题。`.../issues/2015` / #2016
- 旁证：**open issues 850 个**（API 快照），对于一个 2026 年才活跃的项目，issue 吞吐本身说明「团队记忆」这件事的边界条件极多。**[代码/API]**

## 来源清单（每行：标题 — URL — 访问日期 2026-11-22）

- TencentDB Agent Memory 仓库主页（Tencent 命名空间，重定向至 TencentCloud） — https://github.com/Tencent/TencentDB-Agent-Memory — 2026-11-22
- 仓库 API 元数据（full_name/star/语言/pushed_at/license/description） — https://api.github.com/repos/Tencent/TencentDB-Agent-Memory — 2026-11-22
- open issues 列表（#2016/#2015/#2011/#2008/#2005/#2000/#1997/#1996/#1990/#1989/#1986） — https://api.github.com/repos/TencentCloud/TencentDB-Agent-Memory/issues?state=open — 2026-11-22
- 仓库源码快照 commit `083c64b1`（本地 clone，1302 文件） — https://github.com/TencentCloud/TencentDB-Agent-Memory/commit/083c64b11a6748b49278c15f3f0dc77dfd5a99fa — 2026-11-22
- README（定位 / 四类资产 / L0-L3 表 / Benchmark） — `README.md:89-140,206-300`（仓库内） — 2026-11-22
- 核心记忆 DDL（l0/l1/entity/audit/prompt/generation_refs） — `MemoryCore/src/core/store/sqlite/memory-store.ts:412-929` — 2026-11-22
- 默认参数全表 — `MemoryCore/src/config.ts:600-780` — 2026-11-22
- 管线调度语义（warm-up / 下降型定时器 / 串行队列） — `MemoryCore/src/utils/pipeline-manager.ts:1-77` — 2026-11-22
- 混合召回与 RRF — `MemoryCore/src/core/hooks/auto-recall.ts:519,644-792,854-870`；`src/core/store/search-utils.ts:15-61` — 2026-11-22
- 去重裁决 prompt（type 域 / merge / priority） — `MemoryCore/src/core/prompts/l1-dedup.ts:22-108` — 2026-11-22
- 隔离过滤器 — `MemoryCore/src/core/store/isolation.ts:40-161`；`store/tcvdb/memory-store.ts:189-192`；`store/mongodb/doc-mappers.ts:207-228` — 2026-11-22
- 知识服务 schema（6 表 / 软删 / 部分唯一索引） — `MemoryKnowledge/src/db/schema.ts:1-183` — 2026-11-22
- Wiki 图多跳检索（BM25 种子 + hop decay + 200 节点上限） — `MemoryKnowledge/src/engines/wiki/graph-search.ts:1-80` — 2026-11-22
- CodeGraph 桥接（外部二进制依赖） — `MemoryKnowledge/src/engines/code/bridge.ts:1-70` — 2026-11-22
- MCP 工具面（12 个工具名） — `MemoryKnowledge/src/mcp/tools.ts` — 2026-11-22
- 写入闸门 — `MemoryProxy/src/extraction-gate.ts:1-60` — 2026-11-22
- Skill 版本表 DDL — `MemoryCore/src/core/skill/skill-store-ddl.ts:22-46` — 2026-11-22
