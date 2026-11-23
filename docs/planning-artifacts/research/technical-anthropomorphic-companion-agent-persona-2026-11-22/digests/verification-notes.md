# 独立验证：引用标记 ↔ 论断 匹配核查

> 核查者：独立验证 agent（无该报告写作历史）。日期 2026-11-22。
> 方法：`research.md` 全文 + 6 份 digest + `notes-dsh-host.md`；再用 `raw.githubusercontent.com` 按来源附录 pin 的 SHA 拉原文件逐行比对（`curl` 直取，本地落盘后按行号读）。学术引用仅核到 [16]。
> **本次受时间限制提前收工：只覆盖了代码侧约 20 条，学术侧 [12]–[30] 基本未核（见文末「未核对」）。本文不是完整验收。**

## 一、严重问题（不支持 / 张冠李戴）

| # | 报告中的论断 | 引用 | 判断 | 依据 |
|---|---|---|---|---|
| S1 | 建议表 P0-#3「主动消息门控链 **+ 硬退避**」的来源标为 HerAndHim [9] | [9] | **张冠李戴** | HerAndHim 恰恰没有硬退避：`proactive.py:419-484` 只有日上限(6)/安静时段(0–8)/概率(2–5/288)/事件直通，未回复不降频。报告 §4.3 自己也承认这点，建议表却把它写成 [9] 提供的机制 |
| S2 | 门控链顺序「概率×情绪×沉默 → 日上限 → 安静时段 → 事件直通」 | [9] | **部分支持（顺序错）** | 代码先判日上限(`:429`)、安静时段(`:432`)、wishlist 抢占(`:438`)，再掷骰(`:441-477`)；个人日期在掷骰**前**直通(`:454-457`)。报告把判定顺序写反了 |
| S3 | 「每天主动问候 N 条」无研究支撑 | [21][22] | **部分支持（来源不对题）** | [21] 是打断代价实证、[22] 是 Horvitz mixed-initiative 原则，二者都不能证明「不存在量化频率研究」。否定性结论应由检索过程承担，不该挂这两条 |
| S4 | HerAndHim 四维按「+3×intensity / −2×intensity」更新 | [9] | **部分支持** | `emotional_graph.py:432-459` 确为 +3/−2×intensity，但还要乘维度权重 1.0/0.7/0.8/0.6（temperature/trust/intimacy/understanding），报告省略了加权，读起来像四维同幅变动 |
| S5 | [16] Instruction drift 标注为「ICLR 2024」 | [16] | **部分支持（venue 错）** | arXiv 2402.10962 实为 COLM 2024（Conference on Language Modeling）。正文描述（8 轮内漂移、attention decay、split-softmax）与摘要一致，仅出版信息标错 |

## 二、证据不足（无法核实 / 需降级）

| # | 论断 | 引用 | 判断 | 依据 |
|---|---|---|---|---|
| U1 | 生产级测试：compaction 不能可靠复位漂移、anchor 与安慰剂等效（C2 / §5.6 三条硬结论） | [17] | **无法核实** | ContextEcho（arXiv 2605.24279）为预印本，本次未取到原文；P0-#5 的 probe suite 与 P2-#11 的 A/B 要求全部压在这一条单一预印本上 |
| U2 | 缓存「保持前缀不变」/ 折扣最高 95% | [25] | **无法核实** | 官方文档本次未抓取。该结论同时被 [9] 的代码注释独立支持，方向可信，但数值未验 |
| U3 | GPT-4o 谄媚回滚（C6、明确不做清单） | [24] | **无法核实** | 官方博客未抓取 |
| U4 | Character.AI / Replika 事故与处置 | [28][29] | **无法核实** | 报告已自标「二手源（Wikipedia）」；本次未核。且「两家都做成过滤/模型层」对 Replika 是**能力下线**，非过滤层，措辞偏强 |
| U5 | 年龄/亲密边界应做「工具级前置校验」 | [28][29] | **部分支持（推断）** | 事故与「过滤/下线」事实可佐证风险，但「工具级前置校验」是报告自己的设计推论，来源未直接支持 |
| U6 | 六个基准的规模数字（22,859 / 1,785 段 / 23,020 例 / 168,093 条 / 44 题） | [12][13][14][15] | **无法核实** | 未核 arXiv 摘要。这组数字是「基准碎片化」唯一量化依据，建议补核 |
| U7 | ComPeer 事件触发优于固定频率（N=24） | [18] | **无法核实** | 未核；报告已注明样本小、单周 |
| U8 | uncanny valley = 「特征错配」而非「越像越怪」 | [19][20] | **无法核实** | 未核 DOI；Kätsyri 2015 综述结论通常更保守（多假说并存），此处的单因归因可能过强 |
| U9 | PLATO-LTM 显式抽取 / REALTALK 21 天语料低估真实波动 | [26][27] | **无法核实** | 未核 |
| U10 | SOTOPIA 七维 rubric 及 `overall()/7` | [30] | **部分支持** | 七维是 SOTOPIA 论文的定义，但「overall() 除以 7」是 agethos 的实现细节（digest r2 指向 `agethos/models.py:937-951`），挂在 [30] 下不准确 |
| U11 | agethos 仓内无 LICENSE（pyproject 却写 MIT） | [5] | **无法核实** | 未查 license API；digest 称 license=null。这条被写进反证清单，属法务结论，应实证 |
| U12 | AICE「415 tests / 35 子系统」仅 README 宣称 | [6] | **部分支持** | README 宣称属实（未运行）；「dormant 配置项与实际 getTier 不一致」我只确认了 `config.ts:70-71` 存在 background=20 / dormant=5 两项，未读 `getTier` 分支 |
| U13 | MemoryOS 画像更新阈值 pypi 5.0 / chromadb 13.0 | [8] | **无法核实** | 未读 README:301/398 |
| U14 | OpenCharacters 已停更、lore 触发与「内部思考」均未实现 | [10] | **部分支持** | `triggers:[]`（`index.html:857,3221,3792`）与额外 query 调用（`:4415-4417`）成立；「内部思考未实现」依赖 digest 对 reminder 的解读，本次未复核 |
| U15 | CharacterGPT 仅 144B README、7★、无 LICENSE | [4] | **无法核实** | 未查该仓；这条同时是反证清单整行，风险集中在单一 README 描述 |
| U16 | 各仓 star 数 / 最后提交时间（研究对象表整表） | — | **无法核实** | 未查 repo metadata；报告已声明为快照，不作决策依据，影响有限 |

## 三、已确认（逐行对上）

| # | 论断 | 引用 | 判断 | 依据 |
|---|---|---|---|---|
| C1 | 稳定前缀 byte-identical，注释称省 60–80% 输入 token | [9] | **支持** | `herandhim/core/agent.py:393-396` 注释原文一致 |
| C2 | closeness=(intimacy+trust)/2 → 三档语气，earn intimacy | [9] | **支持** | `agent.py:1526-1550`：<45 生疏、<70 熟络、else 深度绑定，含 "earn intimacy rather than performing it" |
| C3 | 情绪事件 90 天 / 1 万条裁剪 | [9] | **支持** | `emotional_graph.py:31-32` MAX_DAYS_KEEP=90、MAX_EVENTS_KEEP=10000 |
| C4 | 每 5 分钟 tick、日上限 6、安静时段 0–8、概率 2/288–5/288 | [9] | **支持** | `proactive.py:389-403`、`:419-420`、`:429-433` |
| C5 | 写入闸门：不可变字段白名单 + immutableTraits + 阶段不跳级 | [2] | **支持** | `state-sync.template.js:90-91` IMMUTABLE 集合、`:112-115` immutableTraits 过滤、`:96` clamp 而非整包拒绝 |
| C6 | 关系阶段枚举 stranger→intimate | [2] | **支持** | `soul-state.schema.json:39` |
| C7 | Vitality 实为 `financial.fhs` 单维，其余为注释 TODO | [2] | **支持** | `lib/report/vitality.js:42-43`（多维权重的算式被注释掉） |
| C8 | 昼夜节律只在 TTS 层，22–7 点 +0.12 | [2] | **支持** | `speak.js:154-184` 四段 delta，且仅被 `--circadian` 调用 |
| C9 | Mini-IPIP 20 题、含反向计分 | [5] | **支持** | `forge/verify.py:4,23-24`（Donnellan 2006、keyed=-1 反向） |
| C10 | importance 累计 ≥150 触发反思 | [5] | **支持** | `brain.py:117` reflection_threshold = 150.0 |
| C11 | Autopilot 1 秒 tick | [5] | **支持** | `autopilot.py:50` tick_interval = 1.0 |
| C12 | TokenBudget active 800/150、background 400/100、dormant 250/80 | [6] | **支持** | `TokenBudget.ts:14-16` |
| C13 | <45% 才加扩展、>65% 回退、记忆 <75% | [6] | **支持** | `ContextAssembler.ts:79,85,99` |
| C14 | InitiativeChecker maxPerCycle=2、情绪 0.5、需求 0.7、关系 70 | [6] | **支持** | `InitiativeChecker.ts:11-14,24-25` |
| C15 | TinyTroupe 默认 persona 仅 5 键；mental_state 字段表 | [11] | **支持** | `tiny_person.py:221-243` 完全一致 |
| C16 | Distilly Layer0 最高优先、Layer5 边界 | [7] | **支持** | `persona_builder.md:18,119,141` |
| C17 | MemoryOS 画像是文本 blob、有 merge 开关 | [8] | **支持** | `long_term.py:16` 注释即 `{data:"profile_string"}`，`:26-34` merge 逻辑 |
| C18 | OpenCharacters lore `triggers` 恒空、0.075 预算、每轮多一次 query 调用 | [10] | **支持** | `index.html:857,3221,3792`；`:4174` 0.075；`:4415-4417` 检索 query 提示 |
| C19 | SoulSpec 是文档站，soul.json 为元数据（`specVersion/name/...`） | [1] | **支持** | `docs/spec/overview.md:17,31-41`；仓内 80 个条目以 docs 为主 |
| C20 | 漂移在 8 轮内出现、归因 attention decay、提出 split-softmax | [16] | **支持（内容）** | arXiv 2402.10962 摘要与第三方索引一致（venue 除外，见 S5） |

## 四、未核对清单（本次没查，勿当作已验）

- 学术侧：[12] CharacterEval、[13] CharacterBench、[14] RoleLLM、[15] PersonaLLM、[18] ComPeer、[19] Nass & Moon、[20] Kätsyri、[21] Mark 2008、[22] Horvitz、[23] Pentina、[24] OpenAI sycophancy、[25] OpenAI caching、[26] PLATO-LTM、[27] REALTALK、[28][29] 两个百科条目、[30] SOTOPIA——**摘要级核对全部未做**。
- 代码侧未验：agethos `cognition/relationship.py`(tier 75/55/40)、`renderer.py` 无 token 预算、`forge/loop.py`(0.7/3 轮)、`models.py:937-951`；AICE `getTier` 分支与 415 tests；TinyTroupe 命题判官与 hard 扣 20%；SoulSpec v0.5 的 safety.laws 优先级与 SEC100-102；Distilly create.md 的 meta.json 证据降级、correction_handler；HerAndHim `telegram_bot.py:368-379` gap note / 未回计数、`agent.py:1455,1474-1501,1691`、`manager.py:127-155` NOIP 归并；`notes-dsh-host.md` 引用的 DSH 文档行号（本机 docs/subsystems）。
- 观察（非结论）：报告 §4.5 称 `index.html` 7940 行，实际 9053 行——7940 是「非空行」计数口径，不影响结论，但说明该数字来自统计而非行号定位。

## 总体置信度

**中等偏低。** 凡我逐行核过的代码类论断（20 条）几乎全部站得住，行号精度也高，这说明 digest 阶段的取证是扎实的；但**承重链最关键的学术侧（漂移/主动性/缓存/事故）我几乎没核**，而报告有 3 条结论（[17] compaction 不复位、[25] 前缀缓存、[28][29] 边界事故）是单源支撑。另有 1 处真正的机制归属错误（S1，硬退避记在 HerAndHim 名下）与 1 处判定顺序写反（S2）。建议在正式引用前补核 [12]–[30] 的摘要，并修正 S1/S2/S5。
