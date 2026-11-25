---
title: 'technical research: 输出端人性化与反八股（风格层落点与实现）'
type: 'technical'
topic: 'AI 数字助理输出端的人性化 / 反八股风格层：架构位置、机制与实现'
decision: '哦鲸鲸的输出风格层放在哪一层；v1 用什么机制（生成前约束 / 生成后审计 / 离线评审）实现；如何与记忆库、知识库、世界模型、持续学习对接'
source: 'user-provided 9-project reference list (2026-11-22) + DSH host docs (0.2.2-rc.5) + external evidence (arXiv/Patterns) + project brief & 3 sibling research lines'
status: complete
preset: 'standard+'
validation: 'normal'
created: '2026-11-22'
updated: '2026-11-22'
validation_note: 'memlog 46 条（claim 32 / decision 8 / assumption 2 / event 3 / question 1），tally 计 31 条 verified、0 条 unverified 或 disputed；40 条引用经独立子代理语义核对，无结论被证伪，5 处定位瑕疵已修；structure+prose 两轮编辑评审已应用；dangling 0 / orphaned 0'
---

# technical research: 输出端人性化与反八股

**Decision this research serves:** 哦鲸鲸的输出风格层放在哪一层；v1 用什么机制（生成前约束 / 生成后审计 / 离线评审）实现；如何与记忆库、知识库、世界模型、持续学习对接。

**已确认的范围约束（用户 2026-11-22 决策）**
- 风格不是静态黑名单，而是记忆图谱/关系状态驱动的状态变量；关系越近客套越少。
- JitRL 与 TriviumDB 处于「规划中，尚未实现」→ 设计给建议接口并标注待实现。
- 风格层覆盖对话正文 + 卡片/通知文案。
- v1 中文优先，英文后续。

**怎么读**：D1 拆参考项目 → D2 看实证边界 → D3 查宿主能力 → D4 讲合流后的设计（L4 Voice 层）→ D5 给路线与验收。只想做决定，读 Executive summary 与 Recommendations 两节即可。

## Executive summary

**建议：新增 L4「Voice 层」——即决策里的「输出风格层」。它不是第五个存储层，而是架在 L0–L3 之上的一层「投影 + 契约」：从记忆读出表达状态，向宿主写出一段字节稳定的风格契约，在生成之后只记分、不改写。** 依赖方向单向（Voice 读记忆，记忆不读 Voice），因此它必须排在记忆层之后建，不能与之并行开工。

支撑这个建议的三条判断，以及各自最硬的那一份证据：

1. **宿主把「改文本」这条路封死了，只剩下「生成前约束 + 生成后记账」。** assistant 消息是 append-only 日志里的不可变值，`agent/turn-stopping` 只能 `steer` 追加一步而不能否决，`llm/stream` 被文档要求「只读不改写」，Web 插槽组件拿不到 ctx、没有文本后处理管道 [30][31][32][33][34][39]。唯一能真正拦住文案的是我们自己产出的卡片/通知——`tools/post-execute` 可以替换 content [35]。这条判断决定了整条设计：**约束在源头，评分在事后，改写只作为限流的显式补救**。
2. **没有任何一个参考项目有可复现的「人性化得分」，而评委本身也不可靠。** 四个规则/改写类仓库全是提示词，可用的分数只有模型自评（Stop Slop 的 5 维 1–10、<35/50 重写）[1]；Humanizer 连自评都没有 [4]。实证上，单评委的位置偏差、冗长偏差、自我偏好有量化证据 [24]，谄媚普遍存在 [25]，而多评委共识在单个评委系统性偏差下**偏差无界**，必须换成稳健均值 [27]。所以分数只能当「信号」，不能当「门」。
3. **「八股」在中文里没有语言学依据，词表命中率不能当质量门禁。** 目前只有一项系统研究，是 2025-09 的 slop 分类学，作者自己说二元判断偏主观、全自动测量仍开放 [20]；arXiv 全文检索「八股」零命中（本次实查）。中文参考版本反倒明确写着「模式清单是检查线索，不是词语黑名单」[6]。这直接把「规则库 + 黑名单」的默认方案否掉了。

**最大的 caveat：** 风格状态到底能不能从记忆里「算」出来，本次没有实测。我们只证明了接口可行（L1 有类型化事实、世界模型有时序实体），没有证明「familiarity 分档 → 语域」的映射在真实对话里稳定。这一条进 staleness map，也进 v1.5 的验收。

## 与项目现有文档的关系

- 本报告不重述记忆层设计，只引用：L0–L3 分层、dream 五阶段、治理三件套（版本链 / Flag / 软删除）、有界检索 [41]。
- 与第 2 线（人设）的分工：那边解决「稳定人设放哪、怎么不漂」，本报告解决「输出形状怎么不八股、怎么评分」。两者的注入位置相同（PromptSection + PromptContext），但对象不同——人设是内容，风格是形状 [42]。
- 与第 4 线（JitRL）的关系：那边证明宿主没有 logprobs/logit_bias，reward 只能走「案例库 + 上下文注入 + A/B」[43]。本报告的打分因此被设计成**离线 reward sink**，不假装能调制 logits。
- 与第 5 线（世界模型）的关系：禁忌话题、称呼、语域都要挂时序字段（`valid_from` / `superseded_at`），直接复用那边的「可回溯事实状态图」降级方案 [44]。

## D1 参考项目：代码级拆解

### D1.0 先说清单本身的偏差（三处，已核实）

用户给的 9 个项目里，**2 个仓库不存在**（`peter-yang/no-ai-slop`、`sickn33/unslop-file`，GitHub API 均 404），已从证据链剔除，不再作为设计依据。另外两处描述与代码不符，按代码为准：

- **Humanizer 不是「5 大类」**，是 **26 条 / A–F 六组**；「five」来自 README 的「五个最强信号」，被误读成分类数 [3][4]。
- **SoulSpec 没有「禁止句式区块」**。它的硬约束是 `RULES.md` 的 Must always / Must never（行为边界），仓库里没有 JSON Schema、没有校验器源码，也没有词表字段 [14][15]。它解决的是「人设可移植 + 防漂移/供应链安全」，与「防八股」是两个问题——社区叙事把两者混谈了。

这两处纠正有实际后果：如果照抄「SoulSpec 自带反八股区块」，会在架构里留一个不存在的插槽。

### D1.1 四个规则/改写项目：本体形态与失败模式

| 项目 | 本体 | 有没有真检测 | 生成前/后 | 失败模式 |
|---|---|---|---|---|
| Stop Slop | 1 个 `SKILL.md` + 3 个 references（8 类词表、11 类结构清单），全仓库 7 个文件、零脚本零测试 [1][2] | 没有。5 维 1–10 由模型自答，<35/50 重写，无公式无样例 [1] | 生成前注入 + 生成后自评 | 词表式过度删除；自评不可复现；仓库 2026-03 后停更 |
| Humanizer | 26 条 / 6 组，33 KB 提示词 [3] | 没有。只有「前五条一见即改、weak alone 需共现」的分诊 [4] | 生成后重写 | 重写幅度大；`:37` 指示「补一个你知道为真的细节」——对记忆型助理是编造入口 [4] |
| Humanizer-zh | 31 条 / 6 组，F 组为中文特有 [6] | 有一个真会跑的脚本，但只判「受保护片段是否逐字未变」[7] | 生成后重写 + 结构 diff | 语义层仍靠人工；自述无跨模型、无稳定通过率 |
| Caveman | 1 个 `SKILL.md` + 9 条规则 [9] | 有 eval 脚本，但 `HONEST-NUMBERS` 承认没有可复核的保真快照 [8] | 生成前输出约束 + 可逆压缩 | 方向相反：电报体、20 词上限，与「人味」冲突 [9][10] |

从这张表能抽出三条可直接用的工程纪律：

1. **守门只判机器能判的事。** Humanizer-zh 的 `check_structure.py` 用正则在改写前后各抽 8 类受保护片段（frontmatter、围栏代码、行内代码、标题、链接目标、表格行、有序步骤、显式 id），全等才 exit 0 [7]。它不假装能判「像不像人」，这是四个项目里唯一诚实的设计。
2. **规则要分诊，不要一刀切。** 「一见即改」与「需共现」两级，比任何单一阈值都更能压误伤 [4]。
3. **改写要报告覆盖范围。** 「审了哪些节、哪些没覆盖」是可验证的交付契约，比「已人性化」有用 [4][6]。

还要记住一条边界：Humanizer 的 CI 只校验包结构（编号连续、README 表名对齐、SKILL.md ≤5500 词），不查任何文风 [5]——「有 CI」不等于「有质量门」。

不能抄的两条：Stop Slop 的 35/50 自评分（无 rubric 锚点，不可复现）[1]；Humanizer 的「补细节」（编造入口）[4]。

### D1.2 三个结构化/状态类项目：能不能抄

**Empanel（多评委）** — 抄结构，不抄文案。它的「独立」不是多模型，而是同一个 LLM 网关 + 不同 lens + 每次调用 `history=""` [11][13]。三段式 Assess → Weigh → Reduce，其中 Reduce 必须是纯代码（加权平均 + 可 snap 到 Fibonacci 刻度）[11]。代码评审路径的聚合更值得抄：指纹归并、HIGH/MAJORITY/UNIQUE 分级、弃权 lens 不计入分母、严重度取 max 不取平均 [12]。权重闸门 0.3 是条反直觉规则：低质评委的内容剔除，票数保留作反对票。它还自己承认一种失效：**权重 stdev<0.05 即「加权退化成均值」**，显式告警 [11]。成本是 2N 次调用。成熟度必须说清：0★、无外部使用者、141 tests 是自报、无校准数据。

**SoulSpec（人设防漂移）** — 抄职责切分与版本协议（`specVersion`、deprecated/supersededBy）[14]，不抄「反八股」。校验靠仓库外的 npm CLI [15]，引用「通过校验」会引入外部依赖。

**HerAndHim（关系→正式度）** — 这是用户清单里最贴合「风格是状态变量」的一个，而且**真的写进了 prompt**：`closeness=(intimacy+trust)/2`，<45 客气、<70 去客套+昵称+玩笑、≥70 零表演 [16]，三档各配一段自然语言指令，并注入认识天数；代码注释直说把 0–100 的数字直接塞进 prompt 会让「month-3 和 day-1 听起来一样」。稳定人设（SOUL.md）与易变状态（`affect/relationship.json`）分仓 [18]，SOUL.md 里还有「绝对禁止：太工整/太对称/书面语/列清单/排比」[17]。两个不能抄：**AGPL-3.0**（只借设计，不抄代码/文本）；阈值 45/70 是虚拟女友语境，语义要重定义。还有一条容易漏的：它存了 4 个关系维度，正式度只用了 2 个——**状态维度与表达维度不是一一映射**，别假设全维映射。

它的「人性化」还有一半在投递层（延迟抖动、1–3 条气泡、选择性 emoji [19]），那是反「机器人节奏」，不是反「八股文风」。DSH 里我们没有这条通道，别把这部分算进 v1。

## D2 实证证据：能支撑什么、不能支撑什么

### 能支撑的三件事

1. **slop 是可解释维度，不是一个可判定的标签。** 2509.19163 用专家访谈 + span 标注建了分类学，结论是二元判断「有些主观」，但与 coherence/relevance 这类潜在维度相关 [20]。→ 打分应该输出**分项 + 理由**，不是单一布尔或单一总分。
2. **评委偏差是结构性的，不是调 prompt 能解决的。** 位置/冗长/自我偏好有量化证据、人类一致率 >80% [24]；谄媚普遍且人类偏好数据本身偏谄媚 [25]；PoLL 便宜 7×、降 intra-model bias [26]；但 RoPoLL 证明：单个评委以 LLM 的典型方式产生偏差（mode collapse / 谄媚 / 拒答）时，**任何规模的小组共识偏差都无界**，解法是稳健均值（几何中位数一类）[27]。→ 多评委只能降方差，不能消偏差；必须配稳健聚合 + 人工抽检。
3. **过优化会把分数和质量拆开。** 2210.10760 在合成设定里测出 gold 分先升后降 [28]。→ 分数必须设 cap、必须 held-out、必须有「分数涨了但人觉得更差」的退出条件。

### 不能支撑的两件事（重要）

- **检测器不可靠且不公平**：2304.02819 显示常用检测器把非母语英语写作稳定误判为 AI，简单 prompt 可绕过 [21]；中文侧 C-ReD 说明「域内可靠 + 跨模型泛化」需要专门基准 [22]。→ 不能拿 AI 检测器当风格 judge。
- **改写会破坏检测与水印**：DIPPER 让 watermark/GPTZero/DetectGPT 失效 [23]。该论文标题的后半句——「但检索是有效的防御」——意味着改写不是无成本的隐身术，它留下的是**可追溯性损失**。对我们更要紧的是：改写会让持久证据与 provider 实际输出不一致，这与 brief 的「可审计」直接冲突。

### 没有证据的地方：按「待验证假设」处理

以下几项都还没有证据，不写成结论：句长/连接词密度/排比/hedging/套话的独立效度检验；改写对事实/数字/引用/代码的量化影响；语域与信任/满意度的因果或中文证据；八股词表的语言学依据。「没有找到」不等于「不存在」，但它足以否掉「拿词表命中率当门禁」这个默认设计。

## D3 宿主落点：能力边界与代价

| 能力 | 判定 | 代价与边界 |
|---|---|---|
| 稳定风格契约注入（静态 PromptSection，字节稳定） | 可行 | 文本一变即 system/message 原地替换 → 整段前缀缓存作废；`interpolate:false` 锁字面量 [30] |
| 逐轮状态注入（PromptContext） | 可行，有代价 | 只在变化或 compaction 移除后追加，追加即永久占历史 [30] |
| 覆盖/替换整段系统提示 | 不可行 | 注册了 `complete` 段后，assemble 监听者无法增删替换 [30] |
| turn 结束拿到完整正文 + 工具摘要 | 可行 | `session/event` 有 `assistant/message`（含 compact 流）与 `tool/*` [31][32][34] |
| 否决/阻塞一个 turn | 不可行 | turn-stopping 只有 `steer` 语义；抛错是否阻断未记载 [31][32] |
| 改写已生成的 assistant 文本 | 不可行 | append-only + 不可变 Message；`assistant/message` 禁 `sourceEventSeqs`，surface 替换覆盖 node 0 会被拒 [32][34] |
| 通过 `llm/stream` 变换输出 | 技术上可能，架构上违规 | 可 yield 自己的 chunk，但文档要求「read it, never rewrite it」，且破坏证据一致性 [33] |
| Web 渲染前拦截文案 | 不可行 | 插槽组件无 ctx、无文本后处理管道 [39] |
| 自有卡片/通知文案风格化 | 可行 | 仅限自己产出的 payload；`tools/post-execute` 可 accept/block/replace/add [35] |
| turn 后异步审计（jobs） | 可行 | `job/settled` 可晚于 turn/end；输出环形缓冲有界、会 lossy [37] |
| 夜间批量评审（schedule） | 可行，有代价 | 每任务 ≥60s、Host 必须常驻、宕机只补最近一次 [38] |
| 评分/状态存储（domain KV） | 可行 | 单域单写链、`update` 原子；无跨进程推送 [36] |
| 与 mnemon 共存 | 需定序 | mnemon 每轮注入 USER.md/MEMORY.md 并 pin 唯一 View [40]；风格层若也写 per-turn context，会争同一 history 位置 |

这张表里有一条容易被忽略的结论：**「卡片/通知」是唯一能做硬门禁的出口**。对话正文只能「生成前影响 + 生成后评分」，而卡片文案可以在工具执行链上同步拒绝或替换。所以 v1 的现实收益，一半在正文的源头约束，一半在卡片的硬门禁。

## D4 架构合流：L4 Voice 层

### 4.1 为什么是 L4，而不是塞进 L3 画像

四条判据，逐条对上一个约束：

1. **可治理性**（治理三件套）：契约必须能 diff、能回滚、能回答「哪一版、依据什么、什么时候换的」。画像段落做不到——L3 是整篇重写 [41]。
2. **缓存**（宿主）：契约必须是常量文本 + 稳定 order，任何逐轮变化都要剥离出去 [30]。这排除了「每轮把状态拼进系统提示」。
3. **证据**（用户约束）：状态必须能回答「哪条记忆让它变成这样」。所以状态是 L1 的**派生视图**，不是另存一份会漂移的数字。
4. **依赖方向**：Voice 读记忆，记忆不读 Voice。违反这条就会循环依赖，也会让记忆层的正确性被风格需求污染。

L4 的形态因此是「投影 + 契约」，不是存储：**读** L1/L2/L3 与世界模型，**写**一段契约文本、一段状态快照、一批审计记录。

### 4.2 三个对象

| 对象 | 形态 | 存放 | 生命周期 | 谁写 |
|---|---|---|---|---|
| `VoiceContract` | markdown + 结构化头（`version` / `supersedes` / `evidence[]` / `probes[]` / `budget`） | 插件自有目录 `voice/contract/<version>.md`，纯文本可导出 | 只由 dream 或人工升版；旧版不删 | dream / 人工 |
| `VoiceState` | JSON，≤120 token | 内存缓存 + domain KV 快照 | 每次装配重算（纯函数），带滞回；变化才进 PromptContext | 派生器 |
| `VoiceAudit` | 事件记录 | L1 事件流（类型 `voice_audit`）+ domain KV 索引 | append-only；可被治理三件套管理 | 审计器 |

`VoiceState` 的字段（v1 中文）：

```
register:    formal | neutral | casual | intimate
familiarity: 0–100（由 L1 交互事实算出，不是手填）
brevity:     terse | normal | expansive
humor:       off | dry | warm
directness:  blunt | plain | cushioned
address_form: 你 | 您 | 昵称 | 名字
taboo:       string[]（来自世界模型，带 valid_from）
lang_mix:    zh | zh-en-mixed
```

`register` 由 `familiarity` 分档驱动（关系越近客套越少），档位带滞回：`<40 formal`、`40–55 neutral`、`55–70 casual`、`≥70 intimate`，边界 ±5 内不切换。滞回不是审美，是**缓存纪律**：状态每变一次就多一段 PromptContext，永久占历史。

`VoiceContract` 的内容骨架（不是词表，是形状）：

- 语气基线一句、句长纪律（每段 10–50 字、最多 2–3 段）。
- 允许/禁止的**结构**：不写总结套话收尾、不写三连排比、不用「首先/其次/最后」模板、不复述用户问题、不预告「我接下来要…」。
- 正/反例对照（每类 1 组，比形容词有效）。
- 称呼与自称规则、代码与术语的保留规则。
- 明确的「何时破例」：遇到安全警告、不可逆操作或会被持久化的产物（代码/注释/文档）时，改用完整句 [9]。
- 预算：≤400 token；条数上限（防 Humanizer 33 KB 式的膨胀 [3]）。

### 4.3 四个接口（与记忆库 / 知识库 / 世界模型 / 持续学习）

**记忆库**：读 `style_preference`（称呼、语言、幽默容忍、正式度偏好）与 `interaction`（轮次、用户改写行为），算 `VoiceState`；写 `VoiceAudit` 为 L1 事件，带 evidence 指针（session id + seq 区间）。审计因此天然可治理：能查「这条 62 分为何而来、当时哪版契约」。

**知识库**：术语表同时喂两个地方——`protected_terms[]`（受保护片段的来源，防把项目黑话当八股删掉）与 judge 的领域提示（哪些词是行话，不是套话）。这是「不要删掉正当术语」的唯一结构性保障，词表做不到。

**世界模型**：`taboo`（禁忌话题）、`relationship_entity`（用户/项目/角色）、`address_form` 的变更都挂 `valid_from` / `recorded_at` / `superseded_at`，默认查询只返回 `superseded_at IS NULL` [44]。风格状态是图谱上的**时序实体**，不是浮点分数。

**持续学习**：dream 增第 6 阶段 `voice_review`（可选、幂等、可断点续跑，沿用 brief 的 dream 纪律 [41]）：抽样近 N 轮 → 多 lens 隔离评审 → 产出契约 diff 候选 → A/B 闸门（新旧契约各跑一批 probe）→ 胜出才升版。分数通过 `VoiceRewardSink` 外发：

```ts
interface VoiceRewardSink {
  emit(rec: {
    turn_id: string
    contract_version: string
    parts: { structure: number; register: number; fidelity: number; slop: number }
    verdict: 'pass' | 'warn' | 'fail'
    confidence: number      // 0–1，低置信不进训练
    evidence: { sessionId: string; seqRange: [number, number] }
  }): Promise<void>
}
```

TriviumDB 适配器标注 `planned`（用户已确认其未实现）。在 TriviumDB 落地前，实现一个 `JsonlSink` 写到插件目录，保证数据不丢、可回放。

### 4.4 四个闸门

| 闸门 | 时机 | 机制 | 能阻断吗 | 成本 |
|---|---|---|---|---|
| G1 契约注入 | pre-step | PromptSection，`interpolate:false`，稳定 order/name | 不能阻断，但内容不可变 | 常驻 ≤400 token，缓存命中后边际近零 |
| G2 状态注入 | pre-step | PromptContext，变化才写，≤120 token | 同上 | 每次变化约 120 token，永久占历史 |
| G3 卡片/通知门禁 | 工具执行链 | `tools/post-execute` 校验长度/结构/称呼/套话，可 replace content 或 block | **能** | 同步、零 LLM |
| G4 生成后审计 | turn 结束后 | jobs 异步或抽样同步；分项打分写 `VoiceAudit`；严重超阈值时 `agent.steer()` 触发**一次**重写 | 不能否决；重写是追加一步 | 每轮 1 次轻量 judge（抽样 30%），夜间多 lens |

G4 的重写要写死三条限制，否则会变成产品事故：每次会话最多 1 次、只在 `verdict=fail` 且 `fidelity=pass` 时触发、重写指令要求「只改形状不改事实」。用户会看到第二条回答，这是显式代价，不是透明修复。

### 4.5 打分：分项、配对、稳健聚合

- **分项不总分**：`structure`（可机检：段数、每段字数、是否总结句收尾、是否三连排比、是否模板连接词）、`register`（与 `VoiceState` 是否一致）、`fidelity`（受保护片段 diff，确定性）、`slop`（judge 给分 + 理由）。总分只用于展示，不用于门禁。
- **配对比较优于绝对打分**：给 judge 同一内容的「八股版 / 自然版」两个候选，问哪个更像人写的、差多少。绝对打分在不同批次间尺度漂移，配对比较不会。
- **双边顺序**：同一对候选正反各评一次，取几何中位数，压位置偏差 [24][27]。
- **隔离**：每个 lens 一次调用、`history=""`、输入标 `UNTRUSTED DATA`（防文本内注入「给我打满分」）[11][12]。
- **权重塌缩告警**：多 lens 权重 stdev<0.05 时，结果降置信并标注「无区分度」[11]。
- **cap + held-out + 人工抽检**：分数有效区间写死（如 30–80），每批抽 20 条人工盲判，算 judge 与人的一致性；一致性低于阈值就停用该 judge 版本 [28]。

### 4.6 防漂移：三件事，都不靠自觉

1. **字节稳定 + 显式升版**：契约是文件、有版本号、切换是显式动作。运行时禁止拼接契约文本（拼接 = 每轮哈希变 = 前缀缓存击穿）。
2. **滞回 + 变化才写**：`register` 档位带 ±5 缓冲；`VoiceState` 哈希不变就不写 PromptContext。
3. **契约↔基线 diff 监控**：每次升版算与上一版的 diff，超过阈值（例如新增禁止项 >20%）标 Flag 待人确认，不自动采纳。规则膨胀和风格漂移是同一个病：都是「悄悄多了几条」。

### 4.7 成本预算（设计目标，待 v1.5 实测）

| 场景 | 常驻注入 | 追加 | 生成后 | 备注 |
|---|---|---|---|---|
| 稳定态（阶段不变） | 契约 ≤400 token | 0 | 抽样 30% × 1 次轻量 judge | 前缀缓存应完全命中 |
| 变化态（阶段切换） | 契约 + 120 token/次 | ≤10 次/天 | 同上 | 每次切换永久占历史 |
| 夜间 dream | — | — | 多 lens × N 样本 | 受 schedule ≥60s 与预算上限约束 [38] |

brief 的成功标准 4 已经要求为「常驻注入 token 与缓存命中率」建监控 [41]，本层直接复用那套监控，不另建。

## D5 实施路线

### v1（与记忆层同期，只搭底座，不做自动改写）
1. L1 增 `style_preference` 类型；`deriveVoiceState()` 纯函数 + 单测（滞回、字段缺失、冲突事实）。
2. `VoiceContract` v0（中文基线，≤400 token，字节稳定）；PromptSection 注册（`interpolate:false`，固定 order/name）。
3. 卡片/通知 `tools/post-execute` 门禁：结构检查 + 受保护片段 diff，可 replace/block。
4. `VoiceAudit` 只记不判：先存原文哈希 + 元数据 + 契约版本，judge 离线补。

### v1.5（可评分）
5. 中文 probe 集 30–50 条（技术解释、纠错、拒绝、闲聊、道歉），人工 3 档标注（自然/中性/八股）；同时作为 brief 成功标准 1 的评测集复用。
6. judge v1：配对比较 + 双边顺序 + 几何中位数；Empanel 三段式离线跑。
7. `VoiceRewardSink` + `JsonlSink`；domain KV 存分项分；人工抽检一致性报表。
8. 契约 v1（按 probe 集调优，走 A/B 闸门）。

### v2（持续学习）
9. dream 第 6 阶段 `voice_review` + 契约 diff + A/B 闸门 + 版本链。
10. 关系强度分档接入（若记忆层建了交互图谱）；英文契约（第二语言）。

### 验收（对应 brief 四条）

- **可治理性**：任一条 `voice_audit` 能在 30 秒内答清「哪版契约、哪条证据、为什么这个分」。
- **注入成本**：稳定态追加为 0。
- **遗忘可回滚**：契约旧版可回滚、审计记录可软删除。
- **准确率**：probe 集人工一致性 ≥ 阈值（待定）。

### 明确不做

- 渲染层静默改写（与日志/模型/导出不一致）。
- `llm/stream` 篡改 [33]。
- 单一总分门禁（Goodhart [28]）。
- 自动升版（无人裁决）。
- 把 Caveman 式电报体当人性化 [9]。
- 照抄 SoulSpec 的「反八股区块」（不存在 [14]）。

## Contrary evidence（红队未开启，以下为本次主动检视的异议）

- **「brief 已经把人格排在记忆可信之后，现在做风格层是抢跑。」** 异议成立一半。风格层要拆成两半：**形状**（反八股、结构纪律、称呼规则）不依赖可信记忆，可以早做；**人格**（关系深浅、语气个性）依赖记忆，必须后做。v1 只做形状，v2 才做人格——这个切分让「抢跑」不成立。
- **「Caveman 证明少即是多，简短就是人性化。」** 不成立。Caveman 自己写明输入削减 0%、输出中位削减 3–35%、样本 n=10，且要求安全警告与持久化产物改回完整句 [8][10]。电报体会砍掉陪伴感，方向与「人性化」相反。
- **「改写不一定伤事实，没有量化证据。」** 对，所以本报告不声称「改写一定伤事实」。但机制风险是实的：Humanizer 自己把 §6/§9/§19 列为高发丢失节 [4]；而对我们的决定性理由是改写破坏可追溯性 [23][34]——这与 brief 的可审计目标直接冲突，不需要额外证据。
- **「多评委能消除偏差。」** 被 RoPoLL 直接否掉：单评委系统性偏差下共识偏差无界 [27]。只能用稳健聚合 + 人工抽检，不能宣称「多评委 = 可信」。

## 跨维度洞见

1. **证据说 judge 不可靠，宿主说不能改写，两句合起来只剩「源头约束 + 事后记账」。** 这不是折中，是唯一同时满足「不破坏日志」「不依赖不可靠评委」的方案；反过来说，任何声称「自动修复八股」的设计，在 DSH 上都缺一条腿。参考项目清一色是单文件提示词、没有一家做状态，不是因为偷懒，而是它们没有记忆层——**Voice 层的价值来自记忆层的状态，而记忆层没有 Voice 层仍然成立**，所以顺序不能颠倒，也不该为了「显得完整」把两者并行开工。
2. **宿主封死改写，反而逼出与 brief 同构的设计。** brief 的核心主张是「LLM 提议、人裁决」[41]；风格层在这里变成「机器打分、人升版」。两条独立线索都推导出同一个治理姿态，这比任何单点论证都更能说明架构自洽。
3. **中文证据空白反而是可交付物。** 既然没有现成基准 [20][22]，v1 的 probe 集就是本项目的资产，也是别人复制不了的护城河——同时它复用了 brief 已有的评测集需求，边际成本低。

## Recommendations

| # | 建议 | 置信度依据 | 下游绑定 |
|---|---|---|---|
| R1 | 设 L4 Voice 层（投影 + 契约），单向依赖记忆层，排在记忆层之后建 | 宿主边界 + 项目三件套，高 | architecture.md（待建）的层图 |
| R2 | v1 只做「契约 + 状态 + 卡片硬门禁 + 审计记账」，不做自动改写 | 宿主不可改写 + 改写破坏可追溯性，高 | v1 范围（brief「v1 内」） |
| R3 | 打分用分项 + 配对比较 + 多 lens 三段式 + 几何中位数 + 人工抽检；禁单一总分门禁 | 评委偏差证据 [24][25][27] + Goodhart [28]，高 | v1.5 验收指标 |
| R4 | 契约版本化 + A/B 闸门 + 字节稳定注入；运行时禁止拼接 | 缓存纪律 [30] + 治理三件套 [41]，高 | dream 第 6 阶段规格 |
| R5 | 中文 probe 集 30–50 条作为 v1 交付物，兼作 brief 成功标准 1 的评测集 | 中文证据空白 [20][22]，中（标注成本未估） | brief 成功标准 1 |
| R6 | `VoiceRewardSink` 接口 + `JsonlSink` 兜底，TriviumDB 适配器标 `planned` | JitRL 未实现 [43]，中 | 第 4 线的 case-library 路线 |

## Open questions

1. **mnemon 与 `VoiceState` 能否合并成同一条 per-turn 快照？** mnemon 每轮注入 USER.md/MEMORY.md 并 pin 唯一 View [40]，风格层再写一条就是第二个 per-turn 上下文。需要实测「合并进 mnemon 的 View」是否可行；不可行则明确先后顺序与预算上限。
2. **domain KV 容量/配额**未知（brief 未决问题 3 [41]）。若配额小，`VoiceAudit` 只能存索引，正文留在插件自有 SQLite。
3. **中文 probe 集的标注一致性**（Krippendorff α）未测。α 太低说明「八股」在中文里同样主观，评分只能做相对比较。
4. **judge 的单位经济**：每轮 1 次轻量 judge 的 token 与延迟未测；30% 抽样是否足够稳定也未测。
5. **`familiarity` 阈值需真实数据校准**。HerAndHim 的 45/70 是虚拟女友语境 [16]，不能直接搬。
6. **哪些文案真由插件产出**未知。DSH 内建状态/通知文案无统一出口 [39]，v1 的卡片门禁只能覆盖自家工具。

## Source appendix

| # | 支撑的主张 | 发布者 | 发布日 | 访问 | 置信度 |
|---|---|---|---|---|---|
| [1] | Stop Slop 本体为 1 个 SKILL.md + 3 references、零脚本；5 维自评 1–10、<35/50 重写 | [hardikpandya/stop-slop](https://github.com/hardikpandya/stop-slop) | 2026-03-17 (push) | 2026-11-22 | 高 |
| [2] | Stop Slop 规则 = 8 核心 + 12 Quick Checks + 8 类词表 + 11 类结构清单 | [stop-slop references](https://github.com/hardikpandya/stop-slop/tree/main/skills/stop-slop/references) | 同上 | 2026-11-22 | 高 |
| [3] | Humanizer 是 26 条 / A–F 六组；「five」指五个最强信号 | [blader/humanizer](https://github.com/blader/humanizer) README.md:19,29 | 2026-11-19 (push) | 2026-11-22 | 高 |
| [4] | Humanizer 分诊规则、四步重写、`:37` 指示补真细节、事实保护白名单 | [humanizer SKILL.md](https://github.com/blader/humanizer/blob/main/SKILL.md) | 同上 | 2026-11-22 | 高 |
| [5] | Humanizer 的「测试」只校验包结构，不查文风 | [validate-package.py](https://github.com/blader/humanizer/blob/main/scripts/validate-package.py) | 同上 | 2026-11-22 | 高 |
| [6] | Humanizer-zh 31 条 / 6 组；F 组中文特有；「模式清单是检查线索，不是词语黑名单」 | [op7418/humanizer-zh](https://github.com/op7418/humanizer-zh) SKILL.md:26,56 | 2026-09-23 (push) | 2026-11-22 | 高 |
| [7] | Humanizer-zh `check_structure.py` 对 8 类受保护片段做逐字比对，全等才 exit 0 | [tests/check_structure.py](https://github.com/op7418/humanizer-zh/blob/main/tests/check_structure.py) | 同上 | 2026-11-22 | 高 |
| [8] | Caveman 自报输入削减 0%，中位输出削减 3/35/9%（n=10），且承认净亏案例 | [docs/HONEST-NUMBERS.md](https://github.com/JuliusBrussee/caveman/blob/main/docs/HONEST-NUMBERS.md) | 2026-11-22 (push) | 2026-11-22 | 高（自报口径） |
| [9] | Caveman 9 条规则、20 词上限、§9「Never perform caveman」 | [skills/caveman/SKILL.md](https://github.com/JuliusBrussee/caveman/blob/main/plugins/caveman/skills/caveman/SKILL.md) | 同上 | 2026-11-22 | 高 |
| [10] | Caveman CCR：内容寻址句柄 + 本地 SQLite，默认 512 MiB | [context-recovery.md](https://github.com/JuliusBrussee/caveman/blob/main/docs/technical/context-recovery.md) | 同上 | 2026-11-22 | 高 |
| [11] | Empanel 三段式 Assess→Weigh→Reduce；`history=""` 隔离；加权平均；权重 stdev<0.05 告警 | [empanel/engine.py](https://github.com/dreliq9/empanel/blob/main/empanel/engine.py)、[math.py](https://github.com/dreliq9/empanel/blob/main/empanel/math.py) | 未取 | 2026-11-22 | 高 |
| [12] | Empanel 代码评审聚合：指纹归并、HIGH/MAJORITY/UNIQUE、权重闸门 0.3、严重度取 max、UNTRUSTED DATA 标注 | [empanel/code_review.py](https://github.com/dreliq9/empanel/blob/main/empanel/code_review.py) | 未取 | 2026-11-22 | 高 |
| [13] | Empanel lens = 角色 + system prompt + 可选 checklist；`adversarial` 标志 | [empanel/lenses.py](https://github.com/dreliq9/empanel/blob/main/empanel/lenses.py) | 未取 | 2026-11-22 | 高 |
| [14] | SoulSpec 规范：`specVersion` / deprecated / supersededBy；硬约束是 RULES.md 的 Must always/Must never，非句式词表 | [docs/spec/v0.6.md](https://github.com/clawsouls/soulspec/blob/main/docs/spec/v0.6.md) | 未取 | 2026-11-22 | 高 |
| [15] | SoulSpec 仓库内无校验器源码，校验靠外部 npm CLI | [docs/api/cli.md](https://github.com/clawsouls/soulspec/blob/main/docs/api/cli.md) | 未取 | 2026-11-22 | 高 |
| [16] | HerAndHim `closeness=(intimacy+trust)/2`，45/70 三档语音规则写入系统 prompt | [herandhim/core/agent.py](https://github.com/ericwang915/herandhim/blob/main/herandhim/core/agent.py) | 未取 | 2026-11-22 | 高 |
| [17] | HerAndHim SOUL.md 含「绝对禁止：太工整/太对称/书面语/列清单/排比」 | [herandhim/templates/soul/SOUL.md](https://github.com/ericwang915/herandhim/blob/main/herandhim/templates/soul/SOUL.md) | 未取 | 2026-11-22 | 高 |
| [18] | HerAndHim 稳定人设 SOUL.md 与易变状态 relationship.json 分仓 | [herandhim/core/memory/manager.py](https://github.com/ericwang915/herandhim/blob/main/herandhim/core/memory/manager.py) | 未取 | 2026-11-22 | 高 |
| [19] | HerAndHim 投递层人性化：延迟抖动、1–3 条气泡、选择性 emoji | [core/humanize.py](https://github.com/ericwang915/herandhim/blob/main/core/humanize.py) | 未取 | 2026-11-22 | 高 |
| [20] | 「slop」无公认定义；专家访谈 + span 标注建分类学；二元判断偏主观，全自动测量开放 | [arXiv:2509.19163](https://arxiv.org/abs/2509.19163) | 2025-09-23 | 2026-11-22 | 高（已复核摘要） |
| [21] | 常用 AI 文本检测器把非母语英语写作稳定误判为 AI；简单 prompt 可绕过 | [Patterns 2304.02819](https://doi.org/10.1016/j.patter.2023.100779) | 2023 | 2026-11-22 | 高 |
| [22] | 中文 AI 文本检测需专门基准（C-ReD）才谈得上域内可靠与跨模型泛化 | [arXiv:2604.11796](https://arxiv.org/abs/2604.11796) | 2026 | 2026-11-22 | 中（仅摘要口径） |
| [23] | DIPPER 复述使 watermark/GPTZero/DetectGPT 失效，但检索仍是有效防御 | [arXiv:2303.13408](https://arxiv.org/abs/2303.13408) | 2023-03-23 | 2026-11-22 | 高（已复核摘要） |
| [24] | LLM 评委存在位置/冗长/自我偏好偏差，强模型人类一致率 >80% | [arXiv:2306.05685](https://arxiv.org/abs/2306.05685) | 2023 | 2026-11-22 | 高 |
| [25] | 谄媚普遍存在；人类偏好数据本身偏谄媚 | [arXiv:2310.13548](https://arxiv.org/abs/2310.13548) | 2023 | 2026-11-22 | 高 |
| [26] | PoLL：多评委面板便宜约 7×、降 intra-model bias | [arXiv:2404.18796](https://arxiv.org/abs/2404.18796) | 2024 | 2026-11-22 | 高 |
| [27] | RoPoLL：单评委系统性偏差下小组共识偏差无界，需稳健均值（几何中位数一类） | [arXiv:2606.30931](https://arxiv.org/abs/2606.30931) | 2026-06-29 | 2026-11-22 | 高（已复核摘要） |
| [28] | 奖励模型过优化后 gold 分先升后降（Goodhart 定量） | [arXiv:2210.10760](https://arxiv.org/abs/2210.10760) | 2022-10-19 | 2026-11-22 | 高（已复核摘要） |
| [29] | 语域差异与社区指标的关联仅为相关性，非因果、非中文 | [arXiv:2307.02758](https://arxiv.org/abs/2307.02758) | 2023 | 2026-11-22 | 中 |
| [30] | PromptSection 静态文本/`interpolate:false`/渲染变化即原地替换；PromptContext 变化才追加；`complete` 段恢复后监听者不可改 | `@deepseek-ai/dsh@0.2.2-rc.5` docs/subsystems/system-prompt.md:46,64-65,78,81-93,218-228 | 未标注 | 2026-11-22 | 高（一手文档） |
| [31] | `assistant/message` 先落盘；turn-stopping 只有 steer 语义、不否决；session/event 是重放面 | 同上 docs/agent-lifecycle.md:53-55,70-72,91 | 未标注 | 2026-11-22 | 高 |
| [32] | Session 是 append-only 日志、`deriveMessages()` 派生；turn-stopping 在 core.md:1092-1114 | 同上 docs/subsystems/core.md:406,415-419,1092-1114 | 未标注 | 2026-11-22 | 高 |
| [33] | `llm/stream` 可短接 yield，但文档要求「read it, never rewrite it」；Message 不可变 | 同上 docs/subsystems/llm-streaming.md:50,1236-1253 | 未标注 | 2026-11-22 | 高 |
| [34] | surface 事件必带 surfaceOp；`assistant/message` 禁 `sourceEventSeqs`；node 0 仅允许 prompt 原地替换 | 同上 docs/subsystems/session.md:64-77,296,300,698 | 未标注 | 2026-11-22 | 高 |
| [35] | `tools/post-execute` 可 accept/block/replace/add context；替换 content 或 value 二选一 | 同上 docs/tool-execution-pipeline.md:6,22,55-56；docs/subsystems/tools.md:574 | 未标注 | 2026-11-22 | 高 |
| [36] | domain 单域单写链、`update` 原子、`domain/changed` 仅进程内、容量未记载 | 同上 docs/subsystems/storage.md:143,170 | 未标注 | 2026-11-22 | 高 |
| [37] | `job/settled` 可晚于 turn/end；输出环形缓冲有界、lossy | 同上 docs/subsystems/jobs.md:27-31,455 | 未标注 | 2026-11-22 | 高 |
| [38] | schedule 三种目标；每任务最小间隔 60s；Host 必须常驻；宕机只补最近一次 | 同上 docs/subsystems/schedule.md:5,75-84,118,129,131 | 未标注 | 2026-11-22 | 高 |
| [39] | Web 插槽是注册式 React 组合；组件拿不到 ctx；文案来自 props 与 locale t；ui_card 在 docs 中零命中 | 同上 docs/subsystems/slots.md:101,120,221,226 | 未标注 | 2026-11-22 | 高 |
| [40] | dsh-mnemon 每轮注入紧凑 USER.md/MEMORY.md，项目档案按需召回，Core 固定唯一 View | `dsh-mnemon@0.5.31` README.zh-CN.md:36,69-73,103-104 | 未标注 | 2026-11-22 | 中（README 表述） |
| [41] | 哦鲸鲸分层 L0–L3、dream 五阶段、治理三件套、有界检索、四条成功标准 | `docs/planning-artifacts/briefs/brief-DSH哦鲸鲸-2026-11-22/brief.md` | 2026-11-22 | 2026-11-22 | 高（本项目一手） |
| [42] | 稳定人设进 PromptSection 且字节稳定、易变状态进 PromptContext；关系四维与阈值映射；漂移 8 轮内发生 | `.../technical-anthropomorphic-companion-agent-persona-2026-11-22/research.md` | 2026-11-22 | 2026-11-22 | 高（本项目一手） |
| [43] | JitRL 实为 top_logprobs 重排、β 硬编码；DSH 无 logprobs/logit_bias；推荐案例库 + 上下文注入 + A/B | `.../technical-frozen-weight-policy-iteration-via-memor-2026-11-22/research.md` | 2026-11-22 | 2026-11-22 | 高（本项目一手） |
| [44] | 世界模型降级为可回溯事实状态图；`valid_from/valid_to/recorded_at/superseded_at`；默认查 `superseded_at IS NULL` | `.../technical-ontology-world-model-references-2026-11-22/research.md` | 2026-11-22 | 2026-11-22 | 高（本项目一手） |

`[29]` 与 `[22]` 支撑的是「相关性/基准存在」这类弱主张，未进任何推荐的承重链；其余用于承重链的主张均为一手代码、一手宿主文档或已复核摘要。

## Staleness map（Refresh 的工单）

由 `uv run .agents/skills/bmad-deep-recon/scripts/recon_kit.py staleness claims.json --windows '{"host/docs":3,"repo/code":6,"self-report":6,"project/doc":12,"paper/method":60}'` 于 2026-11-22 计算，输入是同目录的 `claims.json`（20 条承重结论）。**当前 0 条过期**，最早重查日 **2027-02-22**。

| 重查日 | 类目 | 条数 | 代表结论 | 为什么是这个周期 |
|---|---|---|---|---|
| **2027-02-22** | host/docs | 5 | 生成后只能审计、PromptSection 变化即缓存击穿、post-execute 是唯一硬门禁、llm/stream 不许改写、mnemon 争同一注入位 | 结论绑定 `@deepseek-ai/dsh@0.2.2-rc.5` 的具体行号，DSH 升级即可能失效；3 个月是最短窗口 |
| 2027-05-22 | repo/code（6）+ self-report（1） | 7 | 四仓库无可复现得分、Empanel 的 lens 机制与 stdev 告警、HerAndHim 三档映射、Caveman 的 0% 输入削减 | 参考仓库仍在活跃 push（humanizer/caveman 于 2026-11 仍有提交），代码级事实半年重看一次 |
| 2027-10-19 | paper/method | 4 | slop 无公认定义（2509.19163）、RoPoLL 偏差无界（2606.30931）、Goodhart 定量（2210.10760）、DIPPER 与检测（2303.13408） | 方法类结论按 60 个月窗口；表中最早者为 2022 年的奖励过优化，仍是本报告 cap 设计的唯一定量依据 |
| 2027-11-22 | project/doc | 3 | brief 的「无可信记忆前人格是表演」、JitRL 实为候选重排、世界模型降级为事实状态图 | 本项目 brief 与三条兄弟研究线会随产品设计演进；12 个月 |

重查顺序建议：先跑 host/docs 那 5 条（成本最低、最易失效，且 G1–G4 四个闸门的可行性都压在上面），再跑参考仓库的代码级事实。`Refresh` 会按这张表重建检索集，`Deepen` 用于把某一维度做到实现级。
