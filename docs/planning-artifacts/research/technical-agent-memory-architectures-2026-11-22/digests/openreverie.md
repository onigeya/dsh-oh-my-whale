# OpenReverie · 实现机制 digest

> 研究方式：git clone --depth 1 全量读取源码与文档，所有行号取自本次克隆（workspace 版本 0.9.2）。标注约定：【代码】= 源码确实这么写；【文档声称】= README/docs/AGENTS.md 的说法；【推断】= 我基于代码的推理，未被测试或文档直接确认。

## 身份确认

- 仓库存在且内容吻合：https://github.com/vishalvshekkar/openreverie 可克隆，根目录含 packages/（cli, core, memory, providers, server, web 六个包）、README.md(66 KB)、AGENTS.md(12 KB)、BACKLOG.md(177 KB)、docs/。不是同名替代品。
- 版本与许可：workspace package.json:4 version=0.9.2，package.json:7 license=FSL-1.1-ALv2，package.json:10 engines.node>=22，packageManager=pnpm@10.8.1（package.json:12）。
- 身份：README.md:3 “A self-hosted companion agent with a memory that does not forget.”；AGENTS.md 首段“A self-hosted companion agent for personal reflection and mental wellbeing, with a layered memory that never forgets.”

## 一句话定位

跑在用户自己机器上的陪伴型 agent（终端 REPL + 本地 Web），记忆落在用户自己的文件夹里（markdown + append-only graph.jsonl）；会话结束由 reflection 抽取入库，会话之间由 dreaming（受 REM 启发的非关联重组）产出“叙事 + 带证据指针的假设”，再以受上限约束的段落注入下一次系统提示。

- 【代码】宿主形态：CLI 子命令 + 本地 HTTP 服务（README.md:24-31；packages/server/src/launch.ts），server 只绑 127.0.0.1（README.md:147）。
- 【文档声称】目标用户是想对生活做反思/心理保健的人（README.md:5, README.md:141-143），不是开发者工具，也不是治疗产品。

## 架构总览

- 【文档声称】六包、只允许向下依赖：cli -> core -> memory -> providers；server -> core -> memory -> providers；web 只走 HTTP（AGENTS.md “Architecture rules”）。
- 【代码】记忆目录布局（packages/memory/src/paths.ts:53-69）：constitution.md、profile.md、journaling.md、realms/、arcs/、people/、sessions/、rollups/daily|weekly、graph.jsonl、proposals.jsonl、index.db、dreams/、dreams/log.jsonl、sessions/log.jsonl。
- 【文档声称】真值在文件夹，SQLite 只是可重建的派生索引（AGENTS.md；README.md:61 “a SQLite index over both is derived and disposable”）。
- 【代码】三套持久化各司其职：prose（YAML frontmatter + markdown，writeDocumentAtomic）、graph（append-only JSONL，fold 成当前状态）、SQLite（FTS5 + 向量，packages/memory/src/sqlite.ts）。

## 数据模型与存储

**图单元**（packages/memory/src/graph.ts）

- 【代码】节点记录 NodeRecord{ ts, op:'assert'|'retract', node, type, label, doc?, commitment? }（graph.ts:96-107）；节点类型 7 种 realm|arc|item|session|person|entity|commitment（graph.ts:25-33）。
- 【代码】边记录 EdgeRecord{ ts, op, edge, from, to, confidence, source?, confirmed }（graph.ts:109-118）；边类型 6 种 part_of|in|from|involves|relates_to|waits_on（graph.ts:36）。source 与 confirmed 是溯源与“未经证实”的字段级入口。
- 【代码】fold 语义：按文件顺序应用，later wins；retract 从当前状态移除但断言与撤回都留在文件里；节点撤回不级联到边，悬空边由调用方跳过（graph.ts:1-10；foldGraph graph.ts:226-264）。
- 【代码】写入前 zod 校验、读回同样校验，坏记录无法落盘（parseGraphRecord graph.ts:275-287；appendGraph graph.ts:289-301）。

**文档单元**

- 【代码】DOC_KINDS 共 11 种：constitution, realm, arc, summary, rollup_daily, rollup_weekly, person, journal, journaling, dream, dream_insight（sqlite.ts:86-98）。
- 【代码】id 为带前缀 ULID（newId('doc') dreaming.ts:713；newId('ins') dreaming.ts:565）。
- 【代码】dream 产物也在同一 doc 体系内（kind: 'dream' | 'dream_insight'），因此天然可被 search_memory / read_document 检索（dreaming.ts:713-736）。

**是否图结构**：是，但图只记录“实体与关系”，不记录“梦境假设”——dream 的图写入被显式推迟（docs/dreaming.md:226-234 的 later 方案；docs/dreaming.md:265 “Graph writes deferred. Prose plus a dream log in v1”）。

## 写入路径

1. 触发：会话结束时 reflection（packages/memory/src/reflection.ts:612 reflectSession）；另有对话内即时写入的 remember 工具（packages/core/src/tools.ts:334；README.md:255）。
2. 抽取：LLM 输出经 reflectionOutputSchema 结构化校验（reflection.ts:323-396），一次纠错重试后退化（该模式见 docs/dreaming.md:46）。
3. 落库：applyReflection（reflection.ts:1016）确定性落地——先 appendGraph（reflection.ts:1150），再 writeDocumentAtomic 写 summary / arc / person 页与 constitution（reflection.ts:1153, 1157, 1275）。
4. 去重：靠提示词约束，不靠实体消解。【代码】明确要求已列在 Known people / Known entities 的名字不要再进 newPersons/newEntities，“whether or not it has a page yet”（reflection.ts:552-554），同名不同人例外（reflection.ts:554）。【推断】重复节点只能靠模型自律，代码层没有唯一键或相似度合并。
5. 无审批：【文档声称】任何置信度的归属都直接保存，不挂起等审批（README.md:258；理由 README.md:75 “A companion that remembers should not have to ask permission to remember”）。

## 点名深挖：REM 式非关联重组 + dream 重放 + graph 溯源

### 0. 命名与血缘

- 仓库里没有 REM 这个标识符；对应机制叫 dreaming。【文档】docs/dreaming.md:59 写血缘：“Sleep-Consolidated Memory (arXiv:2604.20943). A WAKE / NREM / REM / forgetting state machine… REM has high-importance nodes start random walks through the memory graph to propose novel associations, constrained to not contradict established facts… The REM phase is nearly a blueprint for our seeded random walk.”
- 同文档承认部分 2026 论文未核对全文：“Several 2026 arXiv entries were not independently verified against full PDFs; treat the specifics as likely, not certain.”（docs/dreaming.md:53）
- 【文档声称】重组的产品化目标拆成两个真值标准不同的产物：insights（可证伪、带证据）与 narrative（允许反事实）（docs/dreaming.md:15-16, docs/dreaming.md:72）。

### 1. 怎么选被重组的记忆（采样策略）

【代码】packages/memory/src/dreamSelection.ts + engineDreams.ts：

- 候选池 = 全部图节点 + 全部公共文档，但排除 journaling / dream / dream_insight（engineDreams.ts:52-83，过滤在 71-74）。节点候选 degree 用一次边扫描算出（58-61），文档候选 degree=0。
- 权重 = staleness × significance（dreamSelection.ts:49-63）：staleness = min(days,365)/365，STALENESS_CAP_DAYS=365（27,59）；节点 significance = 1 + log2(1+degree)，文档按 kind 给基权：constitution 3, arc 2.5, person 2, realm 2, summary/journal 1.5, rollup 1（36-45,60-61）；lastDreamt 来自 dream log 折叠（dreamLog.ts:94-111），无记录则退回文档自身日期（dreamSelection.ts:54）。
- 随机性：JITTER=0.35，每候选取 candidateWeight + 0.35*rng()（31,140-143）。
- 可复现：mulberry32(seed)，seed = this.now().getTime() >>> 0，rngSeed 写入 insight.md 的 frontmatter（engine.ts:3232-3233；dreaming.ts:733）。同一 seed 的选择可重放。

### 2. 怎么判断“非关联”（距离/随机/时间窗）

不是 embedding 距离，而是图邻接 + 日期间隔 + 中位数回溯三条硬约束（pickSeeds dreamSelection.ts:129-174）：

- MIN_SEED_GAP_DAYS=60：任意两个 seed 日期差 ≥60 天（28,163-168）。
- adjacent(a,b)：两 seed 不能在 graph.jsonl 里直接相连（169-170；实现 engineDreams.ts:38-43）。
- 第一个槽位只从中位数日期及更早的候选里抽，保证每场梦“往回够得着”（145-150 与 157-160 的 c.date <= median）。
- 渐进放宽：抽 20 次后放弃日期约束（RELAX_DATE_AFTER=20），40 次后放弃邻接约束（RELAX_ADJACENCY_AFTER=40）（29-30,163-171），最后由 fillRemainingSeeds 用剩余最高权重兜底（108-119）。
- seed 数 = 3（DREAM_SEED_COUNT，engine.ts:589），理由见 docs/dreaming.md:102：“a single seed produces a summary; a pair produces a connection”。
- bounded random walk：3 hops（DREAM_WALK_HOPS，engine.ts:590），按邻居自身 degree 加权、不走回头路、只走存在的节点（randomWalk dreamSelection.ts:185-211）；只有节点型 seed 参与游走，多 seed 路径去重（engineDreams.ts:276-295）。
- 【未证实/未建】“高 embedding 距离 + 共享稀有特征”“纪念日共振”均未实现：日历共振被明确记录为从未构建（docs/dreaming.md:305），且 DreamCandidate 无 embedding 字段（dreamSelection.ts:17-24）。

### 3. 重组产物是什么

【代码】六阶段流水线 runDream（packages/memory/src/dreaming.ts:510-760）：

1. exploration：把 packet（trigger、period、近期梦摘要、seed 正文每段上限 DREAM_SEED_BODY_CAP=2000 字符，engine.ts:588；seeds+walk 一起拼，dreaming.ts:435-449）交给模型，允许 4 个只读工具 search_memory/read_document/read_transcript/graph_query（22-67），工具调用硬上限 maxToolCalls（默认 10，packages/core/src/config.ts:89），耗尽后再答一轮并拒绝新调用（145-190）。
2. insights：结构化 JSON，5 类 pattern|change_over_time|connection|open_question|strength，每条含 headline/claim/confidence/evidence（209-236）；evidence 必须恰好指向 doc / session / node 之一（225-230）。
3. 证据解析闸门：指针必须真能解析到存在的文档/节点/转录，否则该条 insight 被丢弃并记 insight_dropped；全灭则整场 abort，不写任何文件（559-578）。
4. narrative：300-600 词，temperature: 0.9（388,601-606），三种人称可配（378-385），允许反事实（390-391）。
5. tone gate：单独模型调用判定“无噩梦/无危机/无诊断/无未加限定的性格断言”（412-433）；不合格则重写一次并复查（645-700），仍不合格则扣留 narrative 但保留 insights（696-699）。
6. 落盘（702-758）：dreams/<localDate>-<dreamId>/dream.md + insight.md + process.jsonl，再向 dreams/log.jsonl 追加 dreamt 记录。

### 4. 如何落库而不污染

- 只新增不改写：dream 目录在“所有模型调用都成功之后”才创建（dreaming.ts:702-708），三个文件写一次即冻结（AGENTS.md “Dream files are written once and never modified afterward”；README.md:85）。
- 隔离命名空间：dreams/ 与 dreams/log.jsonl（paths.ts:67-68）；过去梦境不会被选为素材（候选池排除，engineDreams.ts:71-74）。
- 不许自证：提示词禁止把过去的梦当证据（dreaming.ts:367-368 “Never point at a past dream as evidence… chaining from one dream to the next compounds guesses”）；设计文档把这条列为 confabulation drift 的防线（docs/dreaming.md:89）。
- 审计轨迹：process.jsonl 记录 seed、每次 tool_call、budget_exhausted、分阶段 model_call 与耗时、tone_verdict、outcome（dreaming.ts:511-520,540,608,629-637,704）。
- 失败留痕：abort/failed 写 attempt 记录到 dreams/log.jsonl（engine.ts:3520-3531；dreamLog.ts:44-51）；例行拒绝（关闭/本周期已覆盖/未达门槛/锁被占）故意不记，避免刷屏（dreamLog.ts:34-43）。

### 5. 是否有淘汰

- 没有遗忘/衰减机制。【代码】dream log 只做加法；【文档】“Insight decay” 仍是 later（docs/dreaming.md:157），forgetting 只在“借鉴他人”一节被讨论（docs/dreaming.md:59），本项目未实现。
- 实际起淘汰作用的三件事：候选池排除梦境类文档、证据解析失败即丢弃、用户反馈 wrong / do_not_bring_up 后该 insight 不再进提示词（context.ts:239-246；反馈写入 engineDreams.ts:199-229，折叠 dreamLog.ts:104-105）。
- 【代码】提示词段落上限 DREAM_INSIGHTS_CAP=8（engine.ts:596）：超出不删除，只是不进上下文。

### 6. graph 溯源的真实程度

- 记录了：每条 insight 的 evidence 指针（doc/session/node id）+ insight.md frontmatter 里的 seeds 与 rngSeed（dreaming.ts:726-736）；dreamt 日志记录 entities = 本场 seeds（dreaming.ts:750-758；engine.ts:3517）。
- 没记录：walk 路径与工具循环读过的实体。docs/dreaming.md:309 自认第 6 条偏差：“The dreamt log record stores seeds only… Walked and tool-read entities are never marked dreamt, so their staleness keeps accruing even after a dream actually touched them.”
- 没有图边：dream 不产生任何 relates_to 边（docs/dreaming.md:265）。所以“graph 溯源”的准确说法是“文档级证据指针 + seed 清单”，不是图上的来源链。【推断】这也是证据解析闸门要“三个 id 空间都试一遍”的原因（dreaming.ts:451-478）：模型常把 node id 塞进 doc 字段。

## 读取路径

- 注入形态：系统提示是固定顺序的段落拼接，且不读时钟（为前缀缓存稳定）（packages/core/src/context.ts:1-23,90-108）。顺序：persona → time → profile → constitution → journaling protocol → realms → arcs → people → entities → recent intentions → commitments → dreams → latest daily rollup → rollups available → recent sessions（context.ts:90-106）。
- dream 段：## Between-session reflections (dreams)，每条一行 “[insightId] (kind) headline: claim”，最多 8 条，超出时渲染“用 search_memory kind dream_insight 找更老的”（context.ts:247-273）；语气规定为“你自己的试探性观察，不是既成事实”，并给归因话术（context.ts:263-272）。
- 按需检索：search_memory = FTS5 + 余弦两路各取 20 候选、RRF 融合（k=60）、默认返回 8 篇；节点命中单独一路不融合（packages/memory/src/retrieval.ts:47-50,126-172）；每篇最多 3 个 chunk（79），单 chunk ≤1200 字符（sqlite.ts:159）。
- 排序细节：recency 只做完全同分时的 tiebreak，缺失日期的“活文档”排最后（retrieval.ts:242-277）。
- 【文档/代码一致】局限：暴力向量检索、无 rerank、日期过滤不排除持续改写的活文档（README.md:75；机制 retrieval.ts:12-18）。

## 生命周期规则与参数

| 规则 | 值 | 证据 |
|---|---|---|
| 默认开关 | dreaming off | README.md:81；config.ts:81-89 |
| 节奏 | daily 或 weekly，默认 daily，按本地日/ISO 周 | config.ts:83；dreamSchedule.ts:14-17 |
| 启动门槛 | ≥5 场已反思且未跳过的会话 | dreamSchedule.ts:12,40；engineDreams.ts:104-111 |
| 每周期次数 | 至多 1 次；artifact 存在即完成 | dreamSchedule.ts:19-42；docs/dreaming.md:139 |
| 错过周期 | 从不补做 | dreamSchedule.ts:1-3；README.md:83 |
| 并发 | dreams/.lock，wx 创建，15 分钟过期 | dreamSchedule.ts:44-90 |
| 进程内防重 | dreamAttemptedPeriods，锁内、任何模型调用前标记 | engine.ts:3187-3190, 3217-3222 |
| 手工运行 | 只有 --force 跳过“本周期已覆盖”；未强制的手工运行仍被拦 | engine.ts:3274-3287, 3354-3359 |
| 工具预算 | maxToolCalls 默认 10 | config.ts:89 |
| 其他常量 | 3 seeds / 3 hops / seed 正文 2000 字符 / 近期梦摘要 3 场 / 提示词内 insight 上限 8 | engine.ts:588-596 |
| 不可删除 | 转录与 dream 产物只增不改；retract 保留历史 | README.md:75,85；graph.ts:7-10 |

## 后台调度

- 【代码】四个触发口：afterSession（会话结束反思后）、onStart（进程启动维护后）、serverTimer（Web server 定时）、manual（reverie dream）（engine.ts:3171-3182；README.md:83）。
- 【代码】server 端 DREAM_SWEEP_INTERVAL = 30 * 60 * 1000（packages/server/src/registry.ts:22），经 dreamTrigger 注入、可整体关闭（registry.ts:90,122-130,266-270）。
- 【代码】maybeDream 永不抛出：失败只 push 到 engine.warnings 并返回 undefined，避免拖垮触发它的 endSession()（engine.ts:3165-3170,3244-3266）。
- 【代码】幂等靠“artifact as completion marker”，无 job 表（docs/dreaming.md:37-38,139）；锁内二次核对周期覆盖，防两个进程同时通过 due 检查（engine.ts:3224-3227）。
- 【文档】配置无热重载：config.toml 启动读一次并烘焙进 registry 的 trigger wiring（README.md:221-222 段落说明；docs/dreaming.md:318）。

## 工程形态与代价

- 【代码】TypeScript ESM monorepo，6 包，pnpm 10.8.1，biome lint，vitest（package.json:8-30）；原生依赖 better-sqlite3（package.json:13-16），Node ≥22（package.json:10）。
- 【代码】体量：packages/memory/src/engine.ts 3692 行；dream 子系统约 1550 行纯实现（dreaming.ts 760、engineDreams.ts 371、dreamSelection.ts 211、dreamLog.ts 113、dreamSchedule.ts 98），另有 6 个 .test.ts。
- 【文档声称】一次全分支验证：pnpm test 1281 passed / 1 failed（既有失败），分支净增 148 个测试（docs/dreaming.md:296）。
- 【代码】单场梦模型调用下限 4 次（exploration 多轮 + insights + narrative + tone），最坏再加 3 次重试（insights/narrative/tone 各自第二次），外加最多 10 次工具调用；预算“可预测但不便宜”（docs/dreaming.md:147 的目标 vs 实际实现）。
- 【推断】dreaming 刻意关在 packages/memory 内，用注入的 ChatProvider + 只读工具循环，而不复用 core 的 AgentSession——理由写在 docs/dreaming.md:162-172（可测、可复现、避免包依赖倒挂）；代价是这套 tool loop 手写，与主对话 agent 的循环并行存在。

## 它踩过的坑（真实抱怨与缺陷记录）

先说实话：GitHub issue 里没有真实用户抱怨——#1 至 #4 全是已关闭的 release/重构条目，评论数 0（api.github.com/repos/vishalvshekkar/openreverie/issues）。真正的踩坑记录在仓库自己的 changelog 与 README Status，属于作者自述、非外部投诉：

1. 模型回退选错，dream 永远跑不起来（docs/dreaming.md:312）：models.dreaming 原本缺省回退 models.reflection，而 reflection 模型是“便宜、无工具的结构化输出”用模型，真实用户的推理模型对 function tools 直接返回 HTTP 400，每次尝试都在 exploration 之前死掉。修复：只在一处 resolveDreamingModel 决定，回退到 models.chat。
2. 失败完全无痕（docs/dreaming.md:313）：错误只进 engine.warnings，Web 不展示、进程一退就没；现加 attempt 日志 + computeDreamStatus + GET /api/v1/dreams/status + reverie doctor 检查。
3. reverie dream --force 报 “another process is already dreaming”（docs/dreaming.md:314）：同进程 MemoryEngine.open() 的 onStart 后台尝试先抢到锁。修复：该子命令打开引擎时 suppressDreamOnStart。
4. Web 端几乎永远等不到第一次 dream（docs/dreaming.md:315）：launchServer 用 { maintenance: false } 打开引擎，连带跳过 onStart，只剩 30 分钟扫描；频繁起停的用户永远撞不上。修复：引擎打开后立刻踢一次 maybeDream('serverTimer')。
5. 所有 insight 都被“证据无法解析”丢掉（docs/dreaming.md:316）：insights 指令示例只示范 {"doc": ...}，模型把 node id 也塞进 doc，永远解析不到。修复：示例写明三种 id 空间 + 解析不再信任字段名，三种空间都试。
6. temperature: 0.9 被推理模型拒绝（docs/dreaming.md:317）：gpt-5 只接受默认温度，HTTP 400 且 error.param == 'temperature'。修复在 provider 层：识别参数后重试一次不带温度，并用 ChatResult.warnings 显式暴露，runDream 写入 process.jsonl。
7. 空的 dream persona 静默跑完全部阶段（README.md:234-236）：现在渲染为空/纯空白就记 failed 并抛出；但“非空却没有危机立场”的 persona 仍能通过，缺口留在 BACKLOG（README.md:236-238）。
8. 测试时区假设造成假绿：作者在 AGENTS.md 记录同一天三次因硬编码时区导致的假通过，以及“跨包测试必须先 pnpm build”的教训（AGENTS.md “Build before trusting a cross-package test”）。

## 可迁移到「本地优先的 DSH 插件」的部件

1. 确定性种子 + 记录 rngSeed：mulberry32 + now().getTime()>>>0 + seed 写进产物 frontmatter（engine.ts:3232-3233；dreaming.ts:733）。对本地插件意味着后台 LLM 任务可离线重放，也能只重跑选择阶段（dreamNow({dryRun:true}) 返回 seeds/weights/walk，engine.ts:3335-3347），排查“为什么挑了这个”不必再花一次模型钱。
2. “产物即完成标记”的幂等：无 job 表，周期目录存在即完成，miss 不补（dreamSchedule.ts:1-42）。适合没有常驻进程的本地插件：不需要调度器状态机，崩溃后自然重试，代价仅是“错过不补”。
3. 证据解析闸门 + attempt 日志：先要求 evidence 指针，再逐条真解析，解析不到就丢，全丢就 abort（dreaming.ts:559-578）；同时把 abort 原因落盘（dreamLog.ts:44-51；engine.ts:3567-3582）。这比“记一条 warning 然后静默”更能回答“为什么它什么也没做”。
4. 只追加的派生层：源记录（转录/正文）绝不改写，派生层写一次冻结，审计走 process.jsonl（dreaming.ts:702-758）。迁移时可实现为“memory/ 只读 + derived/ 只写一次”。

**最不该照抄**：一次后台任务串起 4 次以上模型调用 + 3 个独立重试分支 + 最多 10 次工具循环（dreaming.ts:510-758）。这套设计在“用户显式开启、知道在花钱”的自托管桌面应用里成立（README.md:81 因此默认关闭），在本地插件里会变成不可控的启动抖动与账单；也不该照抄“dreaming 手写一套 tool loop、主对话另有一套”的双循环结构（docs/dreaming.md:162-172 自述这是为可测性付的代价）。若迁移，应把 exploration 压成单次结构化调用、把 tone gate 降级为规则检查，并保留 dry-run 作为默认入口。

## 未证实·缺口

- issue 中的真实抱怨：无数据。只有 4 个已关闭的 release 类 issue（#1 至 #4），0 条评论；用户抱怨只能从作者自述 changelog 取，不能当作外部反馈。
- dream 质量没有任何量化：作者自列 8 项“只能人来判断”的手工测试，并写明 “Nothing below has been checked yet”（docs/dreaming.md:280-288）。因此“重组是否真的产生了有意义的连接”未证实，只有流程与 schema 级测试。
- 未建：日历共振（docs/dreaming.md:305）、dream_state 表（docs/dreaming.md:295）、相关性排序注入（later，docs/dreaming.md:125）、insight 衰减（later，docs/dreaming.md:157）、dream 写图边（docs/dreaming.md:265）。
- walk 与工具读取不进入 lastDreamt（docs/dreaming.md:309），所以“没有任何东西会长时间不被梦到”只对 seeds 成立。
- 去重无代码保障：只有提示词约束（reflection.ts:552-554），无实体消解；重复节点是否累积取决于模型。未证实。
- 性能/成本数字：仓库无 dreaming 耗时或成本实测（process.jsonl 有 durationMs，但无汇总）。检索侧唯一量化是离线 recall@5 = 0.88（retrieval.ts:34-46），与 dreaming 无关。
- 版本兼容：README.md:39 称 v0.9.x 起五个 engine 包也发布到 npm；本次只验证 workspace 0.9.2（package.json:4），未验证 npm 上与代码一致。

## 来源清单

仓库（本次 clone，默认分支最新）：

- README.md（:1-9 定位/版本，:61-89 记忆布局与 dreaming，:166-260 Status 自述与缺陷，:24-57 安装与升级）
- AGENTS.md（架构边界、dream 产物写一次、评审与测试教训）
- package.json（:4,7,8-30 版本/许可/Node/工具链）
- docs/dreaming.md（:59 REM 血缘，:99-158 想法目录，:162-172 方案取舍，:226-234 未来图写入，:280-288 手工测试队列，:296-318 发布与缺陷 changelog）
- docs/superpowers/specs/2026-08-24-dreaming-design.md、docs/superpowers/plans/2026-08-24-dreaming-implementation.md（设计/TDD 计划，未逐行引用）
- packages/memory/src/dreamSelection.ts:1-211（采样/去关联/随机游走）
- packages/memory/src/dreaming.ts:1-760（六阶段流水线、闸门、写盘）
- packages/memory/src/engineDreams.ts:1-371（候选池、摘要、反馈、状态）
- packages/memory/src/dreamSchedule.ts:1-98（周期、门槛、锁）
- packages/memory/src/dreamLog.ts:1-113（四类记录、折叠）
- packages/memory/src/graph.ts:1-347（记录模型、fold、append）
- packages/memory/src/engine.ts:3160-3660（dream 触发/幂等/执行/seed 正文），:588-596（常量）
- packages/memory/src/retrieval.ts:1-358（RRF 融合、tiebreak、上限）
- packages/memory/src/sqlite.ts:86-98（DOC_KINDS）、:159（MAX_CHUNK_CHARS）
- packages/memory/src/paths.ts:53-69（记忆目录布局）
- packages/memory/src/reflection.ts:323-396, 552-554, 1016-1160（抽取 schema、去重提示、落地）
- packages/core/src/context.ts:1-23, 90-108, 239-273（注入形态与 dream 段）
- packages/core/src/config.ts:33, 73-97, 216-229（[dreaming] 默认值与模型解析）
- packages/core/src/tools.ts:207-500（search_memory / graph_query / read_document / read_transcript / remember 等工具面）
- packages/server/src/registry.ts:18-22, 90, 122-130, 266-270（30 分钟 dream sweep）
- api.github.com/repos/vishalvshekkar/openreverie/issues?state=all（#1 至 #4，全部 closed，0 评论）

外部：

- https://github.com/vishalvshekkar/openreverie（仓库主页，克隆入口）
