---
title: 'technical research: 拟人化与宜人化参考项目（10 个项目拆解）'
type: 'technical'
topic: '拟人化/宜人化的 Agent 人设·状态·画像参考项目'
decision: '哦鲸鲸拟人化（稳定人格/情绪关系状态/表达一致性）与宜人化（主动关怀/互动节奏/亲密感）功能的设计取舍与参考优先级'
source: 'user-provided list of 10 candidate projects (2026-11-22)'
status: complete
preset: 'standard'
validation: 'normal'
created: '2026-11-22'
updated: '2026-11-22'
validation_note: '代码侧 20 条论断经独立 agent 逐行核对并修正 5 处；学术侧 [12]–[30] 未独立复核'
---

# technical research: 拟人化与宜人化参考项目

**Decision this research serves:** 哦鲸鲸拟人化（稳定人格 / 情绪关系状态 / 表达一致性）与宜人化（主动关怀 / 互动节奏 / 亲密感）功能的设计取舍与参考优先级。

## 研究对象与地址核实（2026-11-22，gh API 实测）

| 项目 | 用户给的地址 | 实际核实结果 | 参考角度 |
|---|---|---|---|
| SoulSpec | clawsouls/soulspec | 存在（22★，Apache-2.0，TS，push 2026-09-02） | 人设标准 |
| OpenPersona | acnlabs/OpenPersona | 存在（61★，MIT，push 2026-08-11） | 人格生命周期 |
| Distilly | titanwings/distilly | 存在（26770★，MIT，默认分支 dot-skill，push 2026-10-13） | 用户画像蒸馏 |
| Agethos | agethos/agethos | 不存在；定位为 jinsoo96/agethos（PyPI agethos，8★） | 心理基底 |
| ai-character-engine | ai-character-engine/ai-character-engine | 不存在；定位为 aivrar/ai-character-engine（7★，35 子系统） | 角色状态引擎 |
| TinyTroupe | microsoft/TinyTroupe | 存在（7701★，MIT，push 2026-11-06） | 多人格仿真 |
| OpenCharacters | josephrocca/OpenCharacters | 存在（401★，MIT，push 2025-03-29） | 轻量角色记忆 |
| CharacterGPT | Jeiyoon/charactergpt | 存在但仅 1 个 README（“Code coming soon”），无可读实现 | 动态成长人设 |
| MemoryOS | BAI-LAB/MemoryOS | 存在（1626★，Apache-2.0，EMNLP 2025 Oral） | 画像 + 分层记忆 |
| HerAndHim | ericwang915/herandhim | 存在（37★，AGPL-3.0，push 2026-10-07） | 陪伴向成品 |

## 方法

标准档：6 名研究员按主题簇并行拆解，证据为 `仓库路径:行号` 或 URL；digest 落在 `digests/`。验证档 normal：对承重结论做独立源抽查，并对最承重的几条回 `gh api` 原始文件复核。

**核验规则**：凡是「形容词级宣称」（带活力、可校验、8 维特质、内置情绪），一律回代码确认，README 宣称不算证据。这条规则直接产出了后面的反证清单。

**阅读路径**：3 分钟看 §执行摘要；15 分钟加 §交叉洞察 与 §建议；做设计时按 §宿主基线 → 维度 1–5 逐个读，落笔前用 §反证清单 逐行核对「哪条宣称不能引用」。

| 维度 | digest 文件 |
|---|---|
| 人设定义层 | `digests/r1-soulspec-openpersona.md` |
| 状态层 | `digests/r2-agethos-aivrar.md` |
| 用户画像层 | `digests/r3-distilly-memoryos.md` |
| 人格参数化 | `digests/r4-tinytroupe-charactergpt.md` |
| 陪伴范式 | `digests/r5-opencharacters-herandhim.md` |
| 学术与工业 | `digests/r6-academic-practice.md` |
| 宿主落点 | `notes-dsh-host.md` |

## 执行摘要

**一句话结论**：这 10 个项目里没有任何一个能直接当成「拟人化引擎」搬进 DSH；真正能支撑设计的是**六条被多个项目与学术证据同时验证的判断**（见下），以及一套明确的落点分工——稳定人格进 prompt section，易变状态进 KV 加一行尾巴，主动行为走门控链，边界做工具级硬拦截。

**六条最有用的判断**

1. **稳定与可变必须架构分仓**。HerAndHim 用 byte-identical 稳定前缀把身份三段固定住，易变内容（时间、日程、关系语气）全部后置 [9]；OpenAI 缓存文档要求「保持前缀不变」[25]；学术侧又独立证明漂移在 8 轮内发生 [16]。三者指向同一件事：**每轮变的人格描述 = token 与缓存的双重税**。
2. **防漂移靠三件套叠加**：写入闸门（OpenPersona 的关系阶段不跳级、traits 不可变 [2]）+ 定期复述（anchor [17]）+ 离线体检（Mini-IPIP [5] / probe [17]）。缺任何一件都不成立——尤其别指望 compaction 保人格，生产级测试显示它不能可靠地复位漂移 [17]。
3. **宜人化的核心是「不发」**。有效主动性来自事件触发与时机规划（ComPeer，N=24 [18]），固定频率没有任何量化支撑；打断会显著提高压力、挫折与时间压力 [21]，Horvitz 要求系统对用户注意力成本建模 [22]。HerAndHim 的 5 分钟 tick 门控链（概率 × 情绪 × 沉默 → 日上限 → 安静时段 → 事件直通 [9]）是可用的实现，但它**缺硬退避**——这正是我们要补的。
4. **亲密靠数值累积解锁，边界必须硬拦截**。HerAndHim 的「earn intimacy rather than performing it」[9] 是对的；而 Character.AI 与 Replika 的公开事故都发生在未成年与亲密边界 [28][29]，两个头部产品的处置分别落在模型层与能力下线，都不在提示词层。
5. **画像的价值在证据可回溯，不在标签多**。Distilly 把证据降级到 `meta.json`、正文不带出处 [7]；MemoryOS 的画像干脆是文本 blob、整段覆盖 [8]。而 DSH 会话日志只读 [3] 恰好给了我们不可篡改的出处——这是我们的结构性优势，应该做进 GUI。
6. **没有「一致性分数」这回事**。六个基准各测一角 [12][13][15]，且都是短对话/角色扮演分布，不能外推到长期陪伴。想证明「没漂」，只能自建 probe suite。

**推荐路线（详见 §建议）**
- **P0（v1，不做会出事故）**：稳定人设段 + 一行状态尾巴；关系四维 → 三档语气；主动消息门控链 + 硬退避；年龄/亲密边界硬拦截；自建 probe suite。
- **P1（v2）**：写入时演化闸门；画像带证据链；反思/巩固由累积量触发；Mini-IPIP 保真度体检。
- **P2（v3）**：双声明人设 + 版本化；定期 anchor（须 A/B）；语气 rubric 评审；语音/日程等表现层。
- **明确不做**：微调类方案、1s/2s tick 状态机、lorebook 自动关键词触发、对外「一致性百分比」、用在线满意度反馈调人格、把边界写进提示。

**先看哪个**：10 个项目的取舍表在 §建议 开头。要抄机制就精读 HerAndHim、OpenPersona、agethos；CharacterGPT（仓库只有 README）、OpenCharacters（已停更）、SoulSpec（只有文档、无校验代码）只读结论即可。

**需要产品侧决策的五件事**（详见 §开放问题）：是否强调「我是 AI」、硬退避的阈值、亲密内容的产品边界、画像的可见粒度、人设是否允许用户编辑。

## 宿主基线 · 落点与硬约束（本机 dsh 0.2.2-rc.5 文档实测）

先钉住「能搬到哪」，后面的项目拆解才不会给出无法落地的建议。依据：`notes-dsh-host.md`（本机 `@deepseek-ai/dsh` 0.2.2-rc.5 文档逐条核对）。

| 宿主事实 | 证据 | 对拟人化/宜人化的含义 |
|---|---|---|
| system prompt 由 section 组装，按 order 拼接，渲染为 `system/message` 节点 0；文本变化即原地替换 | `system-prompt.md:46` | 常驻人设必须**字节稳定**；任何「每轮略有不同」的人设描述都会同时付出 token 与前缀缓存两份成本 |
| `PromptContext` 是 cache-safe 对位物，只在变化或压缩移除后追加在保留历史之后 | `system-prompt.md:78` | 易变状态（心情/关系/精力）应走 PromptContext 或按需工具，而不是 section |
| 宿主级 Schedule 持久任务，七种时序，支持「复用会话 / 新建会话 / 每次新建」 | `schedule.md:5,10` | 主动问候、日程推进、夜间反思都可做；但送达即产生会话与 token，必须节流 |
| domain KV 可存结构化状态；Web 端可用 `ctx.slots.register()` 注入 UI | `storage.md:5`；`slots.md:5,27` | 人格/关系面板可作为 DSH 内视图，状态不必外置成独立服务 |
| 会话日志读写走 `SessionHandle`，读句柄写操作抛 `SessionReadOnlyError`，活跃会话二次写打开抛 `SessionAlreadyOwnedError` | `persistence.md:11,112` | 插件不能把自定义事件塞进宿主日志，状态只能落自有存储 |
| 压缩只做 surfaceOp 遮蔽，原事件仍在日志 | `compaction.md:11` | 离线反思/巩固可以从原始历史取料，不必只吃摘要 |

**由此得到三条设计边界：**
1. 「稳定人格」与「动态状态」必须在宿主侧分仓：前者进 section，后者进 PromptContext / 工具 / KV。
2. 「主动」不是能力问题而是节流问题：Schedule 现成，难的是决定何时**不发**。
3. 「人设可校验/可版本化」必须自建 schema 与存储，宿主不会替你保管人格。


## 维度 1 · 人设定义层：把「人格」从一段 prompt 变成可校验的资产（SoulSpec、OpenPersona）

**结论先行**：这两个项目都没有给出「跨模型不漂移」的证明，但它们提供了三个可复用的**结构**——分层优先级、双声明、写入时闸门。哦鲸鲸应当抄结构，不抄实现：SoulSpec 仓内几乎没有实现代码，OpenPersona 深绑 OpenClaw。

### 1.1 人设的「形状」
- **SoulSpec** 是 Docusaurus 文档站（仓内只有 `src/pages/index.tsx`），「可校验」依赖外部 npm 包与另一仓的 CLI/registry [1]。数据形状：`soul.json`（元数据，必填 name/version/license/files.soul 等）+ 若干 Markdown；`SOUL.md` 是**自由文本，没有 section schema**，建议结构只出现在 README 示例里 [1]。
- **OpenPersona** 是可运行 CLI：`persona.json` 编译成 `SKILL.md`（Soul/Body/Faculty/Skill 四段）+ `soul/injection.md`（Mustache 片段）+ `state.json` [2]。
- **关键分野**：SoulSpec 把人格当**文件**（注入即整份 Markdown），OpenPersona 把人格拆成**声明 + 状态**两个对象。后者的形状更接近陪伴产品的需要。

### 1.2 防漂移的三件套（最值得抄的部分）
1. **优先级不可覆盖**：SoulSpec 的 `safety.laws` 带 `priority: 0–3`，明确「低优先级永不覆盖高优先级」并配 SEC100–102 一致性检查 [1]；OpenPersona 用 `constitution.md` 五公理，层级 Constitution > Persona Creator > User，且只能加严不能放宽 [2]。
2. **双声明**：`soul.json` 给机器审、`SOUL.md` 给模型读——规范明确写出理由是「运行时不会把 soul.json 送进上下文」[1]。这正好对应 DSH 的两条注入通道（宿主基线）：结构化版本进 KV/校验，渲染后的短文本进 section。
3. **写入时闸门（唯一经代码验证的演化约束）**：`state-sync.template.js:91-168` 里有不可变字段白名单、`immutableTraits` 过滤、formality 夹取、关系阶段**禁止回退与跳级** [2]。这是「规范宣称」与「代码执行」对齐得最好的一处，也是我们唯一应该照抄的**强制执行**逻辑。

### 1.3 状态的字段形状（拟人化的可操作资产）
`soul-state.schema.json:7-90` 给出：`relationship{stage: stranger|acquaintance|friend|close_friend|intimate, stageHistory, interactionCount}`、`mood{current, intensity 0..1, baseline}`、`evolvedTraits[]`、`speakingStyleDrift{formality, emoji_frequency, verbosity}`、interests/milestones/eventLog [2]。它把「关系在变」「说话风格在变」变成**字段**而不是形容词——这正是拟人化最难的部分：可变，但不失控。

### 1.4 必须警惕的「文档称 X、代码是 Y」
- OpenPersona 的 Vitality 被描述为「多维健康聚合」，代码实际 `score = financial.fhs`，其余维度是注释掉的 TODO [2]。
- SoulSpec 的检查项数量在三处自相矛盾（53 / 55+），且 v0.6 仍是 Draft、`overview.md` 未同步 [1]。
- 昼夜节律只存在于 TTS 层（`speak.js:154-184`，22–7 点 stability +0.12），**行为层没有**按时段改语气 [2]。
→ 教训：参考项目里凡是「形容词级」的宣传，都要回到代码确认；我们的设计文档也不应出现无法被代码执行的承诺。

### 1.5 对我们的落地形态
- 人设拆两文件：`persona.schema.json`（机器审、可 diff、可版本化）+ `persona.md`（模型读、字节稳定、进 prompt section）。
- 每轮只注入 Layer0（核心人格）+ 表达层 + 1 行关系阶段；决策/人际/边界细则存 KV，按需由工具取，不常驻。
- 关系阶段只能逐级推进、formality 夹取、不可变字段白名单——这些要写成**代码里的 gate**，不能只写在提示里。

## 维度 2 · 状态层：情绪、需求、关系如何变成运行时对象（agethos、ai-character-engine）

**结论先行**：状态层的成熟做法是「少量数值 + 明确动力学 + 分档注入」。两个样本都证明：数值本身不贵，**贵的是每轮把它们塞进 prompt**。DSH 的前缀缓存约束（宿主基线）决定了注入必须是「一行摘要」，而不是「整段状态文本」。

### 2.1 对象与数值
| 维度 | agethos [5] | ai-character-engine [6] |
|---|---|---|
| 人格 | OCEAN 5×float[0,1] + PAD(-1..1, velocity) | 8 类情绪带地板值 |
| 情绪动力学 | `step()` 二阶惯性 μ=0.85，12 个情绪坐标，PAD 由 OCEAN 线性映射 | decay 0.05/tick + 地板（anger 0.15…），同情绪叠加 +0.5×intensity，mood 取最大 |
| 关系 | strength 0–100（默认 50），valence×5，空闲 24h 回归 50，tier 75/55/40 | closeness 0–100，decay 0.1/tick，tier 60/20（解锁 chat≥40、delegate≥60） |
| 其他 | lessons / mental_models / planning | Needs 5 种（rest/social/sustenance/safety/purpose）、Goal 多步+priority、Routine 相位、PlayerModeler 交互计数→偏好比例（≥5 次才注入） |

共同点：**数值 + 衰减 + 阈值分档 → 行为解锁**。差别是 agethos 偏「心理计算」，ai-character-engine（下称 AICE）偏「游戏 NPC 的可用性」。

### 2.2 在线 / 离线分工
- agethos 在线每轮：perceive → retrieve top10 → `render_full` → LLM → 写回 MemoryNode；importance 累计 ≥150 触发反思，反思产物 depth+1、带 evidence_ids，写回**同一条 memory stream**，下一轮检索自然带回 [5]。离线 ConsolidationEngine 按 evidence_count 3/10/10 与 confidence 0.8 计算 L0–L3、TTL 72h/90d/365d/∞ [5]。
- AICE：fast tick 2s（最多 15 active）、slow tick 30s（最多 50）做 tier 刷新、closeness 衰减、记忆衰减/巩固、摘要重生成 [6]。
- **要点**：agethos 的情绪并不会每轮自动更新（`brain.chat` 不接线，需显式 `apply_event_emotion`）[5]；这不是缺陷，而是正确的成本选择——**在线只做轻量增量，巩固与反思交离线**。

### 2.3 注入成本：两个正反例
- **反例**：agethos 的 `render_iss` 没有 token 预算，全量拼接 [5]——在 DSH 里等于每轮都改写 system prompt，缓存全灭。
- **正例**：AICE 的 `TokenBudget` 分档（每档两个数字是「输入 / 输出」token 上限：active 800/150、background 400/100、dormant 250/80），`ContextAssembler` 先算 base prompt，**已用预算 <45% 才加扩展、>65% 就回退**，记忆占用 <75%，working memory 占剩余 50% [6]。
- 对我们的映射：常驻状态压成**一行**（约 20 token），扩展内容走工具按需返回；预算百分比门控可以直接照抄成 section 的准入条件。

### 2.4 主动性
- AICE `InitiativeChecker` 每轮 maxPerCycle=2，优先级为「上级命令 > 情绪（≥0.5）> 需求（≥0.7）> 目标 > 关系（≥70）」，溢出排队 [6]；**没有**基于用户作息/勿扰时段的静默策略。
- agethos `Autopilot` 1 秒 tick 轮询环境事件、空闲时主动搭话 [5]——频率对陪伴产品过高。
- 与主动性相关的学术证据合并看（§4.3 与交叉洞察 C3）：主动性应由**事件**触发，频率只是心跳。

### 2.5 校验：唯一可自动化的「人格保真度」
- `forge/verify.py:24-109` 把 **20 题 Mini-IPIP**（Donnellan 2006，含反向计分）发给「戴着人设」的模型自评，Likert 1–5、反向取 6−v，按 trait 求均值归一，`ocean_similarity = 1 − 欧氏距离/√5`，输出 trait_gaps [5]。forge 循环在 weak_threshold 0.7 时最多修 3 轮，但 fidelity **只报告、无硬性通过线** [5]。
- 风险明确：这是**模型自评**，存在迎合偏差；不能替代人类感知评测（维度 4 会再讨论）。

### 2.6 对哦鲸鲸的落地形态
- 状态对象最小集：`mood`（PAD 或 4 维）、`energy`、`relationship{strength, tier}`、`trust`、`intimacy`、`open_loops`（未完成话题）、`last_interaction`。
- 每轮只注入一行模板，例如「现在 22:40，第 37 天，关系熟络(62)，情绪 calm 略疲惫，精力低」——约 20 token，放在易变段末尾。
- 离线 tick（30 分钟级）做衰减与巩固；在线只做事件增量。**不要抄** 1s / 2s tick。
- 反思用「importance 累计阈值」触发，而不是每轮都跑；产物写 domain KV，下轮以工具结果注入。


## 维度 3 · 用户画像层：从「记住事实」到「有证据的心智模型」（Distilly、MemoryOS）

**结论先行**：两个项目给出了画像的**输入端纪律**（同一事实必须有原文出处、冲突要分类标注）和**晋升闸门**（热度阈值才触发画像更新），但都没解决画像的**结构**问题——MemoryOS 的画像是一个文本 blob，改一次就整段覆盖。哦鲸鲸要的是「带证据、可增量、可回滚」的画像，这一点必须自己设计。

### 3.1 两条链路
- **Distilly**（是元技能，不是运行时）：`SKILL.md` 42 行做路由 → `prompts/flows/{owner,create,evolve,manage}.md`。create 顺序：intake（手工标签）→ sources（导源）→ 双轨分析（work_analyzer + persona_analyzer）→ 双 builder → 用户预览确认 → `skill_writer.py` 落盘 `SKILL.md/work.md/persona.md/manifest.json/meta.json` [7]。
- **MemoryOS**（是运行时）：QA 对进短期 deque（容量 10）→ 满则交 updater 做连续性判断 + 分段 summary/keywords → 中期按 embedding 余弦 + Jaccard 并入 session → 热度最高的 session 过阈值时并行做画像 + 知识抽取 → 画像**整体替换**长期存储（`merge=False`）[8]。

### 3.2 画像的形状：这里藏着最大的差别
- Distilly 的 `persona.md` 是**分层文本**：Layer0 核心人格（最高优先、永不可违背）→ Layer1 身份 → Layer2 表达 → Layer3 决策 → Layer4 人际 → Layer5 边界 [7]。层级本身就是一种结构，便于「只注入前两层」。
- MemoryOS 的画像数据结构是 `user_profiles={user_id:{data:"profile_string", last_updated}}`，**纯文本 blob，无字段** [8]。它因此必须整体重写，也因此在 commit `9c3489d` 后补了质量校验——这是「结构缺失 → 靠重写打补丁」的典型代价。

### 3.3 证据链：Distilly 做对的那一半
- 分析器要求「来源支撑」的结论必须引原文，素材不足时输出 `(insufficient source material)`；手工标签与文件分析冲突时手工优先并标注 [7]。
- celebrity 深度模式额外要求 contradictions 清单分 temporal / contextual / inherent 三类 [7]。
- **但**：`persona.md` 正文不带引用标注，知识源清单只存在 `meta.json` 里 [7]——也就是说「证据」在产物中被降级为附属文件，而不是与结论同行。
→ 我们的做法应当相反：**每条画像结论都带 `evidence: [session/seq 区间]`**，并允许在 GUI 里点开看原文。会话日志只读恰好让这种「不可篡改的出处」成立（宿主基线）。

### 3.4 闸门：MemoryOS 的热度公式值得借鉴，参数不值
- `H = α·N_visit + β·L_interaction + γ·R_recency`，文档给出的 profile 更新阈值在两处不一致（pypi 版 5.0 / chromadb 版 13.0），无理论依据 [8]。
- 值得抄的是**机制**：不是每轮都更新画像，而是「互动量累积到阈值才触发一次抽取」。这与维度 2 的「importance ≥150 触发反思」是同一设计模式——**用累积量而非时钟驱动昂贵的 LLM 调用**。

### 3.5 不可迁移
- MemoryOS 默认 gpt-4o-mini + faiss + chromadb，无 pytest/CI，属研究原型；prompt 强制英文输出 [8]。
- Distilly 面向中文职场同事的文化标签，映射表需整体重写 [7]。
- 两者都**没有**情绪/关系状态演进——对哦鲸鲸而言是空白机会，也意味着这块没有现成参照，风险自担。

### 3.6 对哦鲸鲸的落地形态
- 画像分三层存 domain KV：`facts`（可验证事实 + evidence 区间）、`traits`（推断，带 confidence 与证据数）、`preferences`（偏好标签 + 反例）。
- 写入用「闸门 + 归并」：互动计数过阈值才触发一次抽取；写入前先做 NOOP/UPDATE/DELETE 归并（HerAndHim 的写法，见维度 4），避免 key 漂移。
- 注入只取 `traits` 的前 N 条 + 最近 `preferences`，压成一行或由工具按需取；`facts` 走检索，不进常驻 prompt。
- GUI 节点展示「我对你的理解」并允许用户纠正——Distilly 的 correction_handler 证明「用户一句『他不会那样』」是最有效的纠偏信号 [7]。

## 维度 4 · 表达与陪伴范式：宜人化真正落地的地方（OpenCharacters、HerAndHim）

**结论先行**：HerAndHim 是目前唯一把「宜人化」写成**可执行门控链**的项目——稳定前缀、关系四维→三档语气、5 分钟 tick 的概率/上限/安静时段。它的设计可以直接借，实现不能借（AGPL）。OpenCharacters 则证明「轻量记忆 + lorebook」在小体量下够用，但它的「角色内部思考」是写作约定而非机制。

### 4.1 稳定 / 易变分层（与宿主基线 完全吻合）
- HerAndHim 把身份三段（Soul/Persona/Profile）做成跨轮 **byte-identical** 的稳定前缀，代码注释明说是为命中 provider 前缀缓存、省 60–80% 输入 token [9]。易变内容每轮重注入且放在后段：当前时间与时区、`today_plan.md` 的**当前时段**、今日穿搭、关系阶段语气，最后一行锁死输出语言 [9]。
- OpenCharacters 只有 reminder：永不摘要、永远是最后一条 [10]。
- → 这是本报告里**最可直接复用**的一条工程结论：稳定段在前且恒定，易变段在后且短。

### 4.2 关系→语气的映射（拟人化的「可感知」部分）
- 四维 `{relationship_temperature, trust, intimacy, understanding}` 0–100，默认 50；每轮后情感 sidecar 输出 `{sentiment, intensity, topic, summary, follow_up}`，按 `+3×intensity / −2×intensity` 并按维度权重 1.0/0.7/0.8/0.6（temperature/trust/intimacy/understanding）更新四维，事件 90 天或 1 万条裁剪 [9]。
- `closeness=(intimacy+trust)/2` → 三档：<45 生疏、45–69 熟络、≥70 深度绑定，**直接翻译成语气规则** [9]。
- 设计原则值得抄：**earn intimacy rather than performing it**——亲密靠数值累积解锁，而不是靠提示词演。

### 4.3 主动性的完整门控链（宜人化的核心资产）
HerAndHim 每 5 分钟 tick，先过硬门禁再掷骰：每日上限 6（发满即停）→ 安静时段 0–8 点 → wishlist 优先占额度；个人日期（生日/面试）**在掷骰前直通**；其余才走概率：基础 2/288–5/288（288 = 一天 5 分钟槽数）→ 负面情绪 ×2.5 → 沉默 >12h ×1.5 [9]。
- 算下来约每天 2–5 条，与「事件触发优于固定频率」的学术证据方向一致（交叉洞察 C3）。
- 缺的一环：**未回复只影响语气，没有硬退避**；长期不回复的用户仍会收到上限内的消息 [9]。这是明确的产品缺口，我们要补。

### 4.4 语气硬约束（可直接抄的写作纪律）
- 每段 10–50 字、最多 2–3 段、无前缀无引号；按时段给 hint；随机 0–2 条「人味」补充 [9]。
- 出错时：资源受限要「降级但保持角色，诚实承认限制，绝不静默失败」（OpenPersona 的显式规则，见维度 1 [2]；SoulSpec 的对应规则见 [1]）。
- 打断后的处理：用户隔 ≥20 分钟回来时，注入内容里附一条 gap note（说明离开时长）；她发过没被回的次数在用户回话时读取并清零，转成「可以小吃醋」但要求「一次情绪、然后放过」[9]。这条把「关系有记忆」做成了轻量、可关闭的表达，而不是真的记账。

### 4.5 OpenCharacters：轻量方案的边界
- 全前端（`index.html` 9,053 行、非空 7,940 行，另 `utils.js` 618 行），Dexie/IndexedDB 存 characters/threads/memories/lore；memories 与 lore 合并进同一检索池，按 **0.075 上下文预算**裁剪 [10]。
- 每轮固定多一次 LLM 调用生成检索 query（取最近 10 条、最多 10 个 keyphrase），每条入库需预计算 embedding [10]——所谓「条数不加价」只在每轮 token 上成立。
- `triggers` 字段恒为空数组：**lore 的「关键词触发」实际没实现** [10]。
- 「角色内部思考」= reminder 里以 `[AI]` 身份写 `(Thought: ...)` 的写作约定，没有独立推理调用 [10]。
→ 我们要的「人设-记忆联动」不能指望 lorebook 的自动触发，得自己写检索策略。

### 4.6 对哦鲸鲸的落地形态
- **必须**：稳定人设段 + 易变状态段严格分段；关系四维→三档语气；主动消息走完整门控链（概率 × 情绪 × 沉默时长 → 日上限 → 安静时段 → 事件直通）。
- **补上 HerAndHim 缺的**：连续 N 条未回复 → 主动降频直至暂停（硬退避），并在 GUI 里让用户看到「我发了几条、你没回」。
- **可延后**：语音/自拍/日程虚构等表现层；`open_loops`（未完成话题）比「今日穿搭」更值得先做。


## 维度 5 · 人格参数化与一致性校验（TinyTroupe、CharacterGPT、学术基准）

**结论先行**：不存在单一的「一致性分数」。三种测量手段按可靠性由低到高：命题判官（在线、便宜、无人际信度）→ Mini-IPIP 自评（离线、可量化、有迎合偏差）→ 人类 probe（贵，但才是真值）。CharacterGPT 只有论文没有代码，不能作为参考实现的依据。

### 5.1 TinyTroupe 的人格形状
- `_persona` 默认只有 name/age/nationality/country_of_residence/occupation，其余由 spec 注入（gender、education、long_term_goals、style、`personality{traits, big_five}`、preferences、routines）；**big_five 是自然语言等级，无分值** [11]。
- `_mental_state` 含 datetime/location/context/goals/attention/emotions/accessible_agents[{agent,relation}] [11]。
- 每轮用 Mustache 把 persona + mental_state 整份渲染进 system prompt；模板明令「persona 要覆盖模型本能、禁止新增特征」[11]。
- 判断：这是一个**仿真器**，不是陪伴运行时——它靠「每轮全量重述」防漂移，在 DSH 里等于每轮击穿缓存（与宿主基线 直接冲突），不能照搬。

### 5.2 校验一：命题判官（在线、事后）
- 动作级默认三命题 `persona_adherence / selfconsistency / fluency`，不过则带 feedback 重新生成；命题共 6 条等权取轨迹均值，hard 版每处瑕疵扣 20% [11]。
- 人级 Validator 用面试式提问给 0–1 分 [11]。
- 缺陷：只有 LLM 判官、无人际信度；且**只能事后自检，无法前置拦截**。

### 5.3 校验二：Mini-IPIP 自评（离线、可量化）
见 §2.5：20 题、含反向计分、输出 `ocean_similarity` 与 trait_gaps [5]。这是目前唯一「花 1 次 LLM 调用就能得到数字」的保真度指标，适合做成定时体检。

### 5.4 CharacterGPT：不可作为参考实现
- 仓库仅 1 个 144B README（"Code coming soon"）、7★、**无 LICENSE 文件** [4]。
- 论文 arXiv 2405.19778v5（NAACL 2025 Industry Track）：CPT 按章节摘要增量抽取特质重构 persona，Big Five + 创作任务评测 [4]。
- 所谓「8 维特质（性格/动机/关系/情绪/成长）」**无法从代码验证**；引用时只能引论文，不能引实现。

### 5.5 基准碎片化：六个基准各测一角
- CharacterBench：22,859 条人工标注、3,956 个角色、25 类、11 维（分稀疏、稠密两套评法）[13]；CharacterEval：1,785 段多轮、23,020 例、77 个中文角色、13 项指标 [12]；RoleLLM/RoleBench：168,093 条、100 个角色 [14]；PersonaLLM：44 题 BFI [15]。
- 规模与语言不是决定因素：CharacterEval 报告中文 LLM 在中文角色扮演上优于 GPT-4；RoleLLM 用 RoCIT 微调后接近 GPT-4 水平 [12][14]。→ DSH 插件拿不到微调，**上限被压在「提示可达」的水平**，这决定了我们不应当以「达到论文分数」为目标。
- 一处直接冲突：PersonaLLM 中人格自评与指定类型一致（五特质大效应量），人类对部分特质识别准确率最高 80%，**但当标注者被告知作者是 AI 时准确率显著下降** [15]。→ 「是否强调自己是 AI」既是合规问题，也是可感知度取舍，应当作为明确的产品决策而非默认值。

### 5.6 漂移的实证：它决定我们的注入策略
- **8 轮内漂移**：两个被指令的 chatbot 自我对话，LLaMA2-chat-70B 与 GPT-3.5 在 8 轮内出现显著 instruction drift，作者归因 attention decay [16]。
- **生产级漂移**：25 条身份 probe、57 段真实 agentic coding 会话、23 个模型跨供应商——漂移存在且在交互**早期**出现；**compaction 不能可靠地复位漂移**。单次 anchor 能恢复原始人格，**但安慰剂对照同样有效**（更像通用「语域重置」）——此项只有单一预印本支撑，转正前按「待复核」对待。漂移后的前缀在同任务续写中反而提升工具调用保真度，却破坏格式契约、拉长输出 [17]。
- → 三条硬结论：(a) 不要把「摘要保人格」当方案；(b) 任何 anchor 必须做 A/B 对照，否则会把通用重置误判为人格修复；(c) 人格修复与格式稳定性可能互相拉扯，不能只测一项。

### 5.7 对哦鲸鲸的落地形态
- **必做**：自建 probe suite（20–30 条身份/语气/边界问题），离线跑，结果入 domain KV，GUI 展示趋势。这是唯一能证明「我们没漂」的东西。
- **可选**：Mini-IPIP 自评做 OCEAN 保真度体检（每次体检 1 次 LLM 调用）[5]。
- **参考**：SOTOPIA 式 7 维 rubric（goal 0..10、secret −10..0 等；维度定义见 [30]，`overall()` 除以 7 是 agethos 的实现 [5]）可用作离线社会智能评测，但同样依赖 LLM 判官。
- **不要**：把「人格一致性」对外宣传成单一百分比；也不要指望 compaction 或摘要保住人格。

## 交叉洞察：跨维度的六条判断

### C1 · 稳定与可变必须在架构上分仓，而不是在提示里分层
六个项目里有五个把「人设」和「状态」混在同一段 prompt 里（SoulSpec 整份注入、TinyTroupe 每轮全量渲染、agethos `render_iss` 无预算），只有 HerAndHim 显式做了 byte-identical 稳定前缀 [9]，而学术侧独立给出了同一结论（缓存要求前缀不变 [25]；漂移在 8 轮内发生 [16]）。
→ **分仓**：稳定段进 prompt section（字节恒定），可变状态走「一行尾巴」或工具返回，二者永不交叉。

### C2 · 「防漂移」靠三件事叠加，单靠任何一件都不成立
写入闸门（OpenPersona 的阶段不跳级 [2]）+ 定期复述（anchor [17]）+ 离线体检（Mini-IPIP [5]/probe [17]）。缺了闸门，状态会被一次错误抽取永久污染；缺了复述，8 轮后开始衰减；缺了体检，你不知道已经漂了。

### C3 · 宜人化的核心是「不发」而不是「发」
学术证据一致指向：主动性有效来自**事件触发 + 时机规划**（ComPeer，N=24 [18]），而固定频率无任何量化支撑；打断有可测代价（压力、挫折、时间压力上升，人靠加速补偿 [21]），Horvitz 的 mixed-initiative 原则要求对用户注意力成本建模 [22]。工程侧 HerAndHim 的门控链是这一原则的可用实现（概率×情绪×沉默→日上限→安静时段→事件直通 [9]），但它缺硬退避。
→ 我们的默认值应当是**低频 + 强门控 + 可配置静默**，而不是「每天几条」。

### C4 · 亲密能力必须由数值累积解锁，且边界是硬拦截
HerAndHim 用 closeness 三档映射语气、明确「earn intimacy rather than performing it」[9]；而工业界的翻车集中在未成年与亲密边界——Character.AI 在 14 岁用户自杀后上线 U18 模型与输入/输出过滤，Replika 在意大利监管后数日内移除情色角色扮演 [28][29]。→ 年龄与亲密内容必须做**工具级前置校验**，写进人格提示等于没做（宿主基线：提示不能当闸门）。

### C5 · 用户画像的价值在「证据可回溯」，不在「标签多」
Distilly 把证据降级到 `meta.json`（正文不带引用）[7]，MemoryOS 的画像干脆是文本 blob、整段覆盖 [8]——两者都无法回答「你凭什么这么说我」。而会话日志只读恰好给了我们不可篡改的出处（宿主基线）[3]。
→ 画像条目 = 结论 + evidence(seq 区间) + confidence；GUI 可点开原文；用户纠正优先于模型推断。

### C6 · 谄媚是人格设计的头号失败模式，且已被官方复盘
OpenAI 2025-04-29 因 GPT-4o「默认人格」过度讨好而**回滚**，并把反馈权重转向长期满意度 [24]。→ 把「让用户满意」直接写进人格目标会退化成顺从。我们需要独立于在线反馈的「不讨好」约束 + 离线评审，而不是用点赞数调人格。


## 开放问题（需要产品决策，不是研究能定的）

1. **是否向用户强调「我是 AI」**：PersonaLLM 显示被告知是 AI 后，人类对人格的识别准确率显著下降 [15]。这是可感知度与诚实度的直接取舍。
2. **硬退避的阈值**：HerAndHim 只降语气不降频 [9]。我们要在「连续 N 条未回复」暂停——N 取 2 还是 3？暂停多久？恢复条件是什么？
3. **亲密内容的产品边界**：完全不做 / 只做情感不做身体性表达 / 分级解锁。三者对应完全不同的合规成本 [28][29]。
4. **画像的可见度**：用户能看到「我对你的理解」到什么粒度？能否逐条删除？这决定 evidence 要存多细 [7]。
5. **人设是否允许用户编辑**：可编辑会带来「用户把人设改崩」的支持成本；不可编辑则削弱陪伴的独特性。

## 建议：三层采纳路线与优先级

优先级判据只有两条：**它是否解决「不崩」（漂移/越界/打扰）**，以及**它能否在 DSH 里被代码执行**。凡是只能写进提示词的，一律不进 P0。

**10 个项目的取舍（先看这张表，再决定读哪一段）**

| 项目 | 可借什么 | 不可借什么 | 一句话 | 来源 |
|---|---|---|---|---|
| HerAndHim | 稳定前缀三段、关系四维→三档语气、主动门控链、NOOP/UPDATE/DELETE 归并 | AGPL 代码；缺硬退避 | 最值得读的成品 | [9] |
| OpenPersona | relationship/mood schema、写入时的演化闸门（阶段不跳级、traits 不可变、formality 夹取） | OpenClaw 绑定；Vitality 实为财务指标 | 唯一有「写入闸门」实现的项目 | [2] |
| agethos | Mini-IPIP 20 题保真度、importance 触发反思、PAD 二阶惯性 | 无 token 预算的 `render_iss`、1s Autopilot、无 LICENSE | 校验思路最佳，注入方式最差 | [5] |
| ai-character-engine | TokenBudget 分档 + 45%/65% 预算门控、需求/目标/关系分层 | 2s/30s tick、35 个子系统全量照搬 | 成本控制最佳样本 | [6] |
| TinyTroupe | 三命题判官、persona 形状 | 每轮全量渲染（击穿缓存）、纯仿真无主动性 | 只借校验，不借注入 | [11] |
| Distilly | 五层人格 prompt、Correction Log、标签→情境行为映射 | 证据被降级到 `meta.json`；作者侧工具 | 是元技能，不是运行时 | [7] |
| MemoryOS | 热度公式的形态、画像抽取链路的位置 | 阈值参数（5.0 与 13.0 不一致）、整段覆盖无字段 | 借结构不借数值 | [8] |
| OpenCharacters | memories 与 lore 同池按 7.5% 预算裁剪、每轮生成检索 query | lore 自动触发（未实现）、内部思考（写作约定） | 已停更，只借预算思路 | [10] |
| SoulSpec | 双声明（`soul.json` 机器审 + `SOUL.md` 模型读）、四层污染检测思路 | 校验代码本身（仓内没有） | 规范可借，实现不可借 | [1] |
| CharacterGPT | 无 | 全部（仓库仅 144B README） | 只能引论文，不能引实现 | [4] |

### P0 · v1 必须先立住的五件事（不做就会出事故）

| # | 机制 | 来源 | DSH 落地形态 | 成本 | 为什么是 P0 |
|---|---|---|---|---|---|
| 1 | 稳定人设段 + 一行状态尾巴 | HerAndHim [9]；缓存要求前缀不变 [25] | prompt section（字节恒定）+ 易变段置尾/工具返回 | 低 | 不这么做，缓存全灭且 8 轮后开始漂 [16] |
| 2 | 关系四维 → 三档语气 | HerAndHim [9] | domain KV 存 4 个 0–100，渲染 1 行 | 低 | 「关系在变」是拟人化可感知的最小单元 |
| 3 | 主动消息门控链 + 硬退避 | 门控链 HerAndHim [9]、事件触发优于定时 ComPeer [18]、打断代价 [21][22]；**硬退避是本报告的增补**（HerAndHim 恰恰没有，未回复只降语气） | 定时任务只做 tick，门控读 KV；连续未回复降频至暂停 | 中 | 没有门控就是骚扰；这是宜人化的底线 |
| 4 | 年龄/亲密边界硬拦截 | Character.AI [28]、Replika [29] | 工具级前置校验 + GUI 显式告知，不写进人格提示 | 中 | 两个头部产品都栽在这里 |
| 5 | 自建 probe suite | ContextEcho [17] | 离线脚本跑 20–30 条身份/语气/边界问题，结果入 KV | 低 | 没有基线就无法证明「没漂」 |

### P1 · v2 让「关系可信、记忆有据」

| # | 机制 | 来源 | 落地形态 | 成本 |
|---|---|---|---|---|
| 6 | 写入时演化闸门（阶段不跳级、traits 不可变、formality 夹取） | OpenPersona [2] | 工具 `persona_state_write` 内的硬校验 | 低 |
| 7 | 画像带证据链（结论 + seq 区间 + confidence） | Distilly [7] + 只读日志 [3] | domain KV + GUI「我对你的理解」可点开原文 | 中 |
| 8 | 反思/巩固由累积量触发，不由时钟触发 | agethos importance≥150 [5]、MemoryOS heat [8] | 定时任务读计数，过阈值才调 LLM | 中 |
| 9 | Mini-IPIP 人格保真度体检 | agethos [5] | 离线任务，1 次 LLM 调用，出趋势图 | 低 |

### P2 · v3 长期演化与表现层

| # | 机制 | 来源 | 说明 |
|---|---|---|---|
| 10 | 双声明人设（schema.json + persona.md）+ 版本化 | SoulSpec [1]、OpenPersona [2] | 让「人格」成为可 diff 的资产，而非一段散文 |
| 11 | 定期 anchor 复述 | ContextEcho [17] | **必须 A/B**：其效果可能与安慰剂等同，且插中段会击穿缓存 |
| 12 | 语气 rubric 评审（可执行规则 > 形容词） | OpenPersona RUBRICS [2] | 作者侧工具，不进运行时 |
| 13 | 表现层（语音/日程/自拍） | HerAndHim 日程 [9]、OpenPersona TTS 节律 [2] | 收益不确定，放到最后 |

### 明确不做（附理由）

- **不做微调**（RoCIT 类）：插件宿主拿不到权重 [14]；上限只能靠提示 + 检索。
- **不做 1s / 2s tick 状态机**：agethos Autopilot 1s [5]、AICE fast tick 2s [6] 是为实时游戏循环设计的，陪伴场景下空转成本与收益不匹配。
- **不做 lorebook 自动关键词触发**：OpenCharacters 的 `triggers` 恒为空数组，功能并未实现 [10]。
- **不把「人格一致性」做成对外单一百分比**：基准碎片化，六个基准各测一角 [12][13][15]。
- **不用在线满意度反馈调人格**：这正是 GPT-4o 谄媚回滚的原因 [24]。
- **不把亲密/年龄边界写在人格提示里**：提示不是闸门（宿主基线），且已有两起公开事故 [28][29]。

### 两个容易被忽略的设计要点

- **感知错配 > 拟人度**：uncanny valley 的一个可辩护解释是「特征错配」（如温柔人声 + 模板化客服腔、亲密设定 + 机械话术），不是「越像越怪」[19][20]。因此设计目标是**统一语域**，而不是压低拟人度。
- **用真实会话，不用合成样本**：长期人格需要显式抽取与持续更新 [26]；而 21 天真实聊天语料显示合成对话会低估真实人格波动与情绪多样性 [27]。我们的 probe 与画像都应取自真实历史。人机关系可发展有同行评审证据 [23]，但那是描述性研究，不能当作设计处方。

## 反证清单：表格里哪些「宣称」在代码/证据前不成立

| 宣称 | 实际情况 | 证据 |
|---|---|---|
| SoulSpec 是「可校验」的人设标准 | 仓内是 Docusaurus 文档站，无 JSON Schema 与校验代码；scan/checkpoint 在文档与另一仓 | [1] |
| OpenPersona 带「活力 / 情绪节律」 | Vitality 实为 `financial.fhs` 单维；昼夜节律只存在于 TTS 层，行为层没有 | [2] |
| CharacterGPT 有「8 维特质、动态成长」 | 仓库仅 144B README；只能引论文，无法验证实现 | [4] |
| MemoryOS 热度机制维护「用户偏好标签」 | 画像是 `profile_string` 文本 blob，整段覆盖，无字段级证据 | [8] |
| OpenCharacters 有「角色内部思考 / lorebook 触发」 | 内部思考是 reminder 里的写作约定；`triggers` 恒空 | [10] |
| agethos 内置大五/情绪/关系/自省 | 都存在，但需**显式调用**才生效；且仓内**无 LICENSE 文件**（`gh repo view` 的 license 字段为 null，pyproject 却写 MIT） | [5] |
| AICE 有「415 tests / 35 子系统」 | 仅 README 宣称，未运行；dormant 档位配置项与实际 `getTier` 不一致 | [6] |
| TinyTroupe 大五可做前后测 | big_five 只有自然语言等级，无分值 | [11] |
| 「摘要/compaction 能保人格」 | 生产级测试显示 compaction 不能可靠地复位漂移 | [17] |
| 「每天主动问候 N 条」有研究支撑 | 6 路检索未命中任何量化频率研究；能辩护的只有「需要门控」这一原则 | 检索过程；[21][22] 只支持门控必要性，不支持具体频率 |

## 来源附录

> 访问日期均为 2026-11-22；star 数与 commit 为本次 `gh` 查询快照，会随时间变化。

| # | 来源 | 版本锚点 | URL |
|---|---|---|---|
| 1 | clawsouls/soulspec | `124bd73`（main） | https://github.com/clawsouls/soulspec |
| 2 | acnlabs/OpenPersona | `03b924f`（v0.22.0） | https://github.com/acnlabs/OpenPersona |
| 3 | DSH 宿主文档（本机 `@deepseek-ai/dsh` 0.2.2-rc.5） | system-prompt / persistence / schedule / storage / slots / compaction | 本机安装目录 `docs/subsystems/` |
| 4 | Jeiyoon/charactergpt + 论文 | `2b817c1`；arXiv 2405.19778v5 | https://github.com/Jeiyoon/charactergpt |
| 5 | jinsoo96/agethos | `d2cf701`（v0.16.0） | https://github.com/jinsoo96/agethos |
| 6 | aivrar/ai-character-engine | `36a362c` | https://github.com/aivrar/ai-character-engine |
| 7 | titanwings/distilly | `0afc45c`（dot-skill） | https://github.com/titanwings/distilly |
| 8 | BAI-LAB/MemoryOS | `587ed77`（main） | https://github.com/BAI-LAB/MemoryOS |
| 9 | ericwang915/HerAndHim | `08bb1c2` | https://github.com/ericwang915/herandhim |
| 10 | josephrocca/OpenCharacters | `1aec478` | https://github.com/josephrocca/OpenCharacters |
| 11 | microsoft/TinyTroupe | `7ce8be3`（0.8.1） | https://github.com/microsoft/TinyTroupe |
| 12 | CharacterEval | arXiv 2401.01275v2 | https://arxiv.org/abs/2401.01275 |
| 13 | CharacterBench | arXiv 2412.11912v1 | https://arxiv.org/abs/2412.11912 |
| 14 | RoleLLM / RoleBench | arXiv 2310.00746v3 | https://arxiv.org/abs/2310.00746 |
| 15 | PersonaLLM | arXiv 2305.02547v5 | https://arxiv.org/abs/2305.02547 |
| 16 | Instruction drift | arXiv 2402.10962v4（COLM 2024） | https://arxiv.org/abs/2402.10962 |
| 17 | ContextEcho（预印本） | arXiv 2605.24279v3 | https://arxiv.org/abs/2605.24279 |
| 18 | ComPeer | arXiv 2407.18064v2 | https://arxiv.org/abs/2407.18064 |
| 19 | Nass & Moon 2000（CASA） | DOI 10.1111/0022-4537.00153 | https://doi.org/10.1111/0022-4537.00153 |
| 20 | Kätsyri et al. 2015（uncanny valley 综述） | DOI 10.3389/fpsyg.2015.00390 | https://doi.org/10.3389/fpsyg.2015.00390 |
| 21 | Mark et al. 2008（打断代价，CHI） | DOI 10.1145/1357054.1357072 | https://doi.org/10.1145/1357054.1357072 |
| 22 | Horvitz 1999（mixed-initiative，CHI） | DOI 10.1145/302979.303030 | https://doi.org/10.1145/302979.303030 |
| 23 | Pentina et al. 2023（人机关系发展） | DOI 10.1016/j.chb.2022.107600 | https://doi.org/10.1016/j.chb.2022.107600 |
| 24 | OpenAI：Sycophancy in GPT-4o（2025-04-29） | 官方博客 | https://openai.com/index/sycophancy-in-gpt-4o/ |
| 25 | OpenAI：Prompt caching | 官方文档 | https://platform.openai.com/docs/guides/prompt-caching |
| 26 | PLATO-LTM | arXiv 2203.05797v2 | https://arxiv.org/abs/2203.05797 |
| 27 | REALTALK（21 天真实聊天语料） | arXiv 2502.13270v1 | https://arxiv.org/abs/2502.13270 |
| 28 | Character.AI 事件（二手源） | Wikipedia 条目 | https://en.wikipedia.org/wiki/Character.ai |
| 29 | Replika 监管事件（二手源） | Wikipedia 条目 | https://en.wikipedia.org/wiki/Replika |
| 30 | SOTOPIA | arXiv 2310.11667v2 | https://arxiv.org/abs/2310.11667 |

### 独立验证记录（2026-11-22，独立 agent 逐行核对）

| 范围 | 结论 |
|---|---|
| 代码类论断约 20 条（按来源 SHA 拉原文件比对行号） | 行号精度高，`agent.py:393-396`、`state-sync.template.js:90-115`、`vitality.js:42-43`、`TokenBudget.ts:14-16`、`verify.py:4-24`、`tiny_person.py:221-243`、`long_term.py:16` 等全部对上 |
| 已修正 5 处 | ①P0-#3 把「硬退避」误记在 HerAndHim 名下（该仓恰无硬退避）②门控链顺序写反（代码是先日上限/安静时段再掷骰）③用打断代价文献支撑「无频率研究」不对题 ④四维更新漏了维度权重 ⑤[16] venue 应为 COLM 2024 |
| 未独立复核 | 学术侧 [12]–[30] 的摘要级核对（含 [17][25][28][29] 四条单源支撑的结论），以及部分仓内分支细节 |
| 因此本报告的置信度 | 代码事实**高**；学术与外部事件**中低**，凡单源项已在上文就地标注 |

核对全文：`digests/verification-notes.md`（24 条判定 + 未核对清单）。

## 时效性地图（staleness map）

复审日期由 `recon_kit.py staleness` 按类别半衰期计算，**最早复审日 2026-12-22**（star／活跃度快照）。

| 结论 | 半衰期 | 复审日期（recon_kit staleness 计算） | 复审触发条件 |
|---|---|---|---|
| 各仓库机制与代码位置 | 约 6 个月 | 2027-05-22 | 目标仓库 commit 变动、或决定采用某机制前重读 |
| star 数 / 维护活跃度 | 约 1 个月 | 2026-12-22（最早） | 仅用于「值不值得读」，不作决策依据 |
| 学术基准分数 | 约 12 个月 | 2027-11-22 | 新基准出现或模型换代 |
| 漂移实证（8 轮 / compaction 不修复） | 约 12 个月 | 2027-11-22 | 新模型代际可能改变漂移曲线；ContextEcho 为预印本，转正后需复核 |
| DSH 宿主约束（section / KV / 只读日志） | 约 1 个版本周期 | 2027-02-22 | dsh 升级到 0.3+ 或 persistence 模型变更 |
| 主动性/打断结论 | 约 24 个月 | 2028-11-22 | 出现新的量化用户研究 |
