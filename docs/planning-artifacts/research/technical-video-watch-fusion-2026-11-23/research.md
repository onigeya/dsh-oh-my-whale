---
title: 看视频融合方案 — 技术侦察
status: draft-for-review
date: 2026-11-23
depends_on: watch-a-video skill (C:\Users\ellio\.dsh\skills\watch-a-video), dsh-see-now 0.2.6, dsh-streamvision 0.2.8, video-watch-plus, sense-now
scope: 只回答「这四个项目各自真正的贡献是什么、哪些能落回本机技能」。方案设计见同目录 FUSION-DESIGN.md。
---

# 看视频融合方案 — 技术侦察

## 0. 一句话结论

四个项目没有一个是「更好的视频总结器」。它们各自解决成本方程里的一项：

- **see-now / streamvision** 解决「**什么时候该看**」——用变化的因果判据代替等间隔抽帧，并把成本口径算到个位数 token。
- **video-watch-plus** 解决「**一次看多少才不贵**」——把全片压进 ≤36 帧、≤4 张拼图，成本与视频时长解耦。
- **sense-now** 解决「**看什么才不白看**」——索引与回答分离、字幕优先、按问题装配证据、覆盖率必须报数。

本机 `watch-a-video` 技能的四块短板正好对应这四项：等间隔抽帧、没有量测阶段、每帧单独送模型、没有任何覆盖率/预算台账。融合的方向因此不是「换一个更强的管线」，而是**把成本从「帧数×每帧单价」改写成「图版数×每张单价 + 文本 token」**，并让每一次看图都必须有理由。

## 1. 四仓库速览

| 项目 | 形态 | 有视频下载/ASR 吗 | 调模型吗 | 真正能吃下的东西 |
| --- | --- | --- | --- | --- |
| dsh-see-now 0.2.6 | DSH 插件（屏幕/摄像头/本地视频/rtmp） | 无下载；ASR 交宿主 | 否 | 变化打分三出口、档位 k≈√(T·F)、DP 拼图、逐档 token 实价 |
| dsh-streamvision 0.2.8 | DSH 插件（仅 Windows 屏幕） | **全无** | 否 | 三判据 OR（全帧/最活跃块/变化面积）、p85 自适应门、文本去抖 |
| video-watch-plus | 技能包（本地 `vendor/vw.py`） | 不下载（明确排除） | 否 | 0-token ffmpeg 量测、骨架+事件采样、9 格图版、幻觉证伪、图版文字不采信 |
| sense-now | DSH 插件（`sense_now` + `video_index`） | 有（仅 B 站） | 否 | 字幕优先 6 级、5 分钟分块、覆盖率三分离、审计码、预算装配、二次确认 |

> 四者共同的架构纪律：**插件不调模型**。选帧、拼图、建索引、算预算全在本地做，理解由宿主模型完成（`README.md` of see-now:5；sense-now 全仓无模型调用；vwp 的看图由 agent 负责）。这条边界值得直接沿用：它让成本核算成为可能。

## 2. 逐个精读

### 2.1 dsh-see-now — 最完整的「变化驱动采样」实现

输入端是屏幕/摄像头/本地文件/rtmp，一根 `rawvideo rgb24` 管道出帧（`src/capture.js:1-6,271`）。每帧降到 **64×36 网格**、转 HSV 取三通道加权绝对差得 0–255 分（`src/cuts.js:9-80`）。三条出口逐帧决定留不留：

- 切点：`score ≥ cutAbs`（默认 12；calm 20 / dense 7）+ 尖峰 `> 2.5×max(1,前,后)` + 运镜 `mc ≥ 20` + 不应期 0.4s（`src/pipeline.js:94-120`）
- 积分：`need = 4 × 12fps × 3s = 144`，沿时间累加，累够留一帧并清零（`src/pipeline.js:217-219`）
- 兜底：静止 20s 强制一帧（`src/pipeline.js:221-239`）

另有三样细节是别人没有的：**前景抑制**（6 帧稳定背景 + 变化格 ≤600 + `bg<100` 判前景不切，高分候选再等 0.5s 未来帧确认，`src/pipeline.js:148-186,1022-1056`）、**弱切点**（相似构图的 6≤score<12、>3× 邻居、包围盒 ≥20，`src/pipeline.js:132-136`）、**档位**（按过去 1s 留帧密度给 1..8 档，档 k 边长 1/k，一张图放 k² 格，故 `k ≈ √(T·F)`，`src/tiers.js:163-209`）。

成本口径是本轮侦察里最精确的一套：14px patch 对齐 → 42px 一格 → `rows×(cols+1)+2`，单图封顶 1024；实价 low 798×462=**222** / standard 1050×630=**392** / high 1260×756=**560** / ultra 1596×924=**860** token（`src/tokens.js:1-35`、`README.md:75-83`）。最值钱的一句结论在 `README.md:84`：**一张图放 4 帧和放 8 帧同价**——所以「多留一帧近乎免费，漏一帧才贵」。

不能直接用的部分：它没有下载、没有字幕/ASR 主路径（ASR 只是宿主服务可选），也没有一次性总结的产出，只有「图 + 清单」交给你。对我们是**采样内核**，不是管线。

### 2.2 dsh-streamvision — 三判据 OR 与「像素不进上下文」

它与 see-now 同源（同样 64×36 HSV 差分、同样 12fps、同样的 dupMin/cooldown 量级），但在**判据的组合方式**上更稳：

`score ≥ 12 || local(8×6 块最大均值) ≥ 12 || area(像素差≥20 的面积占比) ≥ 0.4%`（`lib/score.js:69-73`、`lib/index.js:775`）

设计意图写得很直白：整帧平均会把「一行字/一个图标的变化」稀释掉，所以必须有**最活跃块**与**变化面积**两条并行判据（`README.md:96-97`）。这一条对视频同样成立——字幕出现、进度条跳变、IDE 里一行代码改动，都是低分但高价值的变化。sense-now 也承认这类变化的分数只有 0.5~2（`docs/调参与实测.md:131-133`），单靠全帧均值必漏。

另一套是 daemon 的自适应门：`gate = max(4, p85(最近 40 帧 mean) × 1.15)`（`sv_daemon.mjs:123-127`）。它解决「固定阈值在静止素材上狂刷、在快节奏素材上全吞」的问题，值得作为 cutAbs 的补充。

还有两个可复用的判定：**文本稳定**（同一行文字要在间隔 ≥1200ms 的两次采样里都认到，且 bigram Jaccard ≥0.85 才入流，`lib/text.js:32-33,219-243`）——这正是 ASR 重叠窗口与滚动字幕去抖的现成配方；**噪声正则**（时间码、清晰度标签、URL、纯符号行剔除，`lib/text.js:87-104`）。

必须说清的限制：**这个仓库没有任何视频域能力**——无下载、无音频、无 ASR、无视频解码、无 LLM（全仓 15 个文件，`package.json:24-26` 只有 koffi）。它是 Windows 屏幕 OCR 插件，我们只取判据，不取管线。

### 2.3 video-watch-plus — 把采样写成可打印的契约

技能包，核心是 `vendor/vw.py`（上游 `CFITCorporation/video-watch-skill`，MIT）。它的贡献是**把「看多少」变成一串可以事先打印出来的数字**：

- 骨架：`t_i = i·(dur/16) + dur/32`，盲区上界 = `dur/16`（`vendor/vw.py:495`、`README.md:182-193`）
- 事件三级优先：切点 `t` 与 `t+0.4s` → `YMAX ≥ 128` 或 `motion_max ≥ max(p95,1.0)` → 动态素材的 `motion ≤ p10` 谷底；按 120s 窗口轮转各取 1，`MIN_GAP 0.6s` 去重（`vendor/vw.py:504-552`）
- 成组：事件点再取 3 帧、间隔 0.12s（`vendor/vw.py:554-571`）
- 封顶：`--max 36` → 最多 4 张 9 格图版 ≈ **1384 token**；20s 素材 18 帧 ≈ 692（`vendor/vw.py:18,576-587`）

**成本与时长解耦**是它最有价值的设计：两小时素材骨架仍是 16 帧，即每 7.5 分钟看一眼。代价清清楚楚写在文档里——`max_gap` 线性变大（`README.md:393-396,503-508`）。这种「把代价写在产出里而不是藏起来」的做法，是本轮最该学的工程习惯。

质量侧的三条硬规矩比采样算法更值钱：

1. **图版文字一律不采信**。拼图里「读」出来的字必须回原分辨率裁切放大验证；作者实测两次在图版里读出画面上不存在的字（`SKILL.md:22-27`、`references/verification.md:79-85`）。
2. **ASR 幻觉两判据**：共同前提是 VAD 无输出；① 互不重叠窗口输出完全相同文本；② `no_speech ≥ 0.4`（`scripts/asr_hallucination_check.py:113-129`）。
3. **声学判型只是候选**：只有静音/纯音/音乐/未达判据四档，**没有「这是语音」这一档**；78s 素材上把人声+配乐误判成纯音（`README.md:263-312`）。

它的短板同样明确：无缓存/增量（重跑即重抽）、无场景关键帧检测（唯一来源是 `scdet` 阈值 10.0）、事件预算「先到先得」导致 2 小时素材的 6 处事件全落在**前 12 分钟**（`README.md:498-501`）——这正是 sense-now 的 FRONT_BIAS 审计要治的病。

### 2.4 sense-now — 索引与回答分离

四个里工程完成度最高的一个，且明确「插件不调模型，识图/理解由宿主完成」（`src/index.js:62` 只 import 工具；全仓无模型 API 调用）。三条结构性设计：

**字幕优先，ASR 是兜底且需授权**。固定 6 级优先级：B 站官方字幕 → 调用方字幕 → 外挂 SRT/VTT/ASS → 内嵌文本轨 → chunk ROI 低帧率 OCR → （缺口且授权）ASR（`README.md:87-94`）。默认 `asr.mode=off`（`README.md:385-395`）。OCR 有门控：只有帧间像素差 > **4%** 才编码 PNG 并调用（`src/video-index/subtitle-band-scanner.js:15-23,127-134`），并设 `maxTotalOcrCalls 2000`、`maxOcrCallsPerMinute 30` 等硬顶（`src/video-index/analysis-policy.js:13-29`）。

**5 分钟分块 + 输入重叠 20s**，overlap 内发言按时间中点归属、再按文本+说话人+时间 400ms slop 去重（`src/video-index/chunk-plan.js:5-6,60-107`）。

**覆盖率三分离**：scan / text / speech 各自算比值，`truncated` 时不得把未扫区域算成已扫；状态由 textCoverage 判 good≥0.7 / partial≥0.3 / poor（`src/video-index/coverage.js:78-115`）。配套五个审计码：`TIME_REVERSE`、`TIME_OVERLAP`、`FRONT_BIAS`（主题集中在前半）、`SUBTITLE_GAPS`、`SPEECH_WITHOUT_TEXT`（`src/video-index/evidence-auditor.js:39-92`）。

预算装配是硬常量：`maxTextTokens 6000`、`maxVisualTokens 8000`、`maxUtterances 20`、`maxStoryboardUnits 4`、`maxSingleFrames 2`、`maxZoomRequests 2`、`maxChapters 3`、`maxEvents 12`（`src/video-index/schema.js:21-30`）。超额时模型可见文本里显式出现 `--- omitted ---`（`src/video-index-tool.js:116-135`）——**省略必须可见**。

两处工程约束值得照搬：**二次分析要 planHash 确认**（sha256 前 24/32 hex + 参数白名单 + `maxRefineWindows 3`，缺 `confirmation` 即拒，`src/video-index/evidence-auditor.js:7-11,144-182`）；**不写假 ready**——capability 六态 `disabled/skipped/unavailable/pending/degraded/ready`，抽帧没落盘就是 degraded，视觉查询明确报 `storyboard_missing_images`（`src/video-index/schema.js:7-9`、`src/video-index/visual-need-router.js:44-57`）。

实测（合成 bench，非真实解码）：复用索引连查 10 次均值 **10.3ms**，每次重建 80.6ms；6h/72 chunk 建索引 680ms，40 次查询共读 264 块占全片 **9%**，p50 6.26ms（`README.md:598-616`）。它自己声明「单元测试与合成 benchmark 不能解读为实机验证」（`README.md:627-649`）——这份自觉比数字本身更可信。

限制：仅 B 站（拒 b23.tv/裸 IP/私网，`src/video-index/url-allowlist.js:2-27`），付费番剧/DRM/直播不支持；OCR 与 VAD 只有适配协议、不携带模型，未注入即 `unavailable`；active-speaker / 人物-音色绑定仍是实验能力。

## 3. 横向对照：能力矩阵

| 能力 | see-now | streamvision | video-watch-plus | sense-now | 本机技能现状 |
| --- | --- | --- | --- | --- | --- |
| 下载 | — | — | — | 仅 B 站 | ✅ yt-dlp 全站 |
| 字幕获取 | — | — | — | 6 级优先 | ✅ CC/外挂 |
| ASR | 宿主服务 | — | faster-whisper cpu int8 | 授权兜底 | ✅ Qwen3-ASR 0.6B 本地 |
| 变化检测采样 | ✅ 最强 | ✅ 三判据 | 仅 scdet+YMAX | 实时侧同源 | ❌ 等间隔 |
| 拼图省 token | ✅ DP 装箱 | — | ✅ 9 格图版 | ✅ storyboard | ❌ 每帧单独 |
| 文本优先/按需视觉 | — | — | 部分 | ✅ 最强 | ❌ 先抽后看 |
| 覆盖率/审计 | changeLog | — | max_gap | ✅ 三分离+5 码 | ❌ 无 |
| 预算台账 | 逐档实价 | — | tokens_est | ✅ 硬常量 | ❌ 无 |
| 弹幕/评论 | — | — | 明确说不能替代 | — | ✅ 全量+时间轴 |

最后一行是本机的独占优势，也是本轮融合最容易被忽略的一处：**弹幕带秒级时间轴**（`fetch_social.py:69-81` 保留 `t`），等于一条 0 视觉成本的全片注意力曲线。四个项目都没有它，vwp 还专门声明「不能替代浏览器实时语境（弹幕/标签/评论）」（`README.md:479-501`）。

## 4. 本机实测（为方案提供基准数）

在同机（1280×720、60s 合成素材）上测得：

| 项目 | 结果 | 含义 |
| --- | --- | --- |
| 逐帧启动 ffmpeg（现技能做法，50 帧） | 5,320 ms → **106 ms/帧** | 开销几乎全在进程启动，不在解码 |
| 单遍 `fps` 滤镜（60 帧） | 362 ms → **6 ms/帧** | 快 **17.7×**，且一次落盘 |
| `scdet` 全片扫描（60s 合成片） | 433 ms | 场景检测基本免费；真实素材上整条量测链是 **21–26× 实时**（见 §4.1） |
| 1280 宽 q:v3 JPEG | 25 KB/帧（合成图；真实素材更高） | 图像体积不是瓶颈，token 才是 |

能力探测：ffmpeg 具备 `scdet`/`select`/`thumbnail`/`freezedetect`/`silencedetect`/`signalstats` 与 NVENC；ASR venv（Python 3.12）有 PIL、numpy、torch，**无 cv2、无 imagehash**——感知哈希需自写（PIL+numpy 约 15 行 dHash 即可）。

结论：**抽帧与场景检测都便宜到可以忽略，唯一贵的是把图送进模型**。所以优化的着力点只能是「少送、拼着送、送之前先知道为什么要送」，而不是「抽得再快点」。

### 4.1 端到端实测（`experiments/watchlab.mjs`，563 行）

> 运行方式与产出：脚本本身入库（`experiments/watchlab.mjs`）；`experiments/data/` 下的帧表、danmaku 原始响应与 `run-*.json` 被 `.gitignore` 的 `**/experiments/data/` 排除（体积大、可重跑再生），所以下表数字是**当次运行的结果记录**，复跑需自备素材与模型配额。

单环节基准说明不了整条链路。用 `experiments/watchlab.mjs`（563 行，已入库可复跑）在**六个不同体裁的真实视频**上跑完整条 V0→V2（5s 量测窗口、五分位定档、切点锚定、dHash 去重、60s 窗口覆盖约束）：

| 素材 | 时长 | 去重后帧 | 图版 | 视觉 token | 覆盖 | ρ | 现做法 token | 省 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 动画讲解 | 3.3 min | 49 | 6 | 2,076 | 100% | 0.80 | 7,826 | 3.8× |
| 科普 EUV | 5.0 min | 69 | 8 | 2,768 | 100% | 0.68 | 11,739 | 4.2× |
| 快剪发布会 | 5.4 min | 154 | 18 | 6,228 | 100% | 0.48 | 12,298 | 2.0× |
| 短剧 | 9.8 min | 88 | 10 | 3,460 | 100% | 0.65 | 22,360 | 6.5× |
| 单人口播 | 9.3 min | 167 | 19 | 6,574 | 100% | 0.54 | 21,242 | 3.2× |
| 短视频评论 | 2.3 min | 50 | 6 | 2,076 | 100% | 0.80 | 5,590 | 2.7× |
| **合计** | 35 min | **577** | 67 | **23,182** | 100% | — | **81,055** | **3.5×** |

提炼出的四条事实（完整口径、含合成真值卷与参数 sweep 见 `FUSION-DESIGN.md` §1.3–§1.4、§12–§13）：

1. **token 口径验证通过**：23,182 ÷ 577 = 40.2 token/帧，理论 346/9 = 38.4，偏差 5%。三套外部口径（像素÷1650）在本机素材上成立。
2. **成本由体裁决定，不由时长决定**：355–1,158 token/分钟（中位 662）。快剪发布会是短剧的 3.3 倍/分钟。任何「每分钟固定抽 N 帧」的预算都会在两端错。
3. **量测 21–26× 实时**：136s→6.6s、585s→27.2s；2h 片约 5 分钟。量测 0 token，抽帧与场景检测确实近乎免费。
4. **切点锚定是帧数的主要来源**：快剪 322s 里 160 个切点 → 154 帧（每镜头一帧）；短剧 585s 只有 63 个切点 → 88 帧。帧数实际是「镜头数」的代理。

合成素材（`SYNTHCUTS1`，120s、7 段、已知硬切 10/25/40/41.5/70/100s）验证切点检出**召回 6/6**；`SYNTHLONG1`（1200s、10 段重复）验证长度缩放：157 帧规划 → 61 帧去重、2,768 token、覆盖 100%、基线 45,279（16.4×）。

## 5. 本机技能现有的六个具体缺陷

1. **等间隔抽帧**：`DEFAULT_RATES = {dense 2, normal 15, sparse 60, gap 10}`（`scripts/plan_densities.py:22`），固定网格必然在静止段浪费、在快变段漏掉；且只在 0.4s 内去重（`:111`），没有画面级去重。
2. **没有量测阶段**：跳过了「先花 0 token 把片子扫一遍」这一步，直接进入「按预估密度抽」。
3. **每帧单独送模型**：1280×720 ≈ 559 token/帧（按 sense-now 口径 `src/runner.js:26-32`），120 帧就是 67K 视觉 token，且**全部留在上下文里**不释放。
4. **逐帧起进程**：500 帧 = 500 次 ffmpeg（`:38-45`），实测 106ms/帧 → 53 秒纯启动开销。
5. **没有覆盖率与预算台账**：`>300` 只 warn、`>500` 直接退出（`:115-118`），既不知道盲区多大，也不知道花了多少。
6. **弹幕只用于写观后感的「弹幕评论」节**，没被当作采样先验——一条免费的信息通道只用了十分之一。

## 6. 选型结论

| 部件 | 取自 | 理由 |
| --- | --- | --- |
| 变化打分与三出口 | see-now | 唯一有完整实现+标定表+离线回放脚本（`scripts/sim.mjs`）的版本 |
| 三判据 OR 与 p85 自适应门 | streamvision | 专治「整帧平均稀释局部变化」，与 see-now 同源可直接拼 |
| 骨架+事件两级采样、max_gap 契约 | video-watch-plus | 把覆盖率变成可打印数字，且成本与时长解耦 |
| 图版文字不采信、ASR 幻觉两判据 | video-watch-plus | 两条防幻觉铁律，成本为零 |
| 字幕优先、覆盖率三分离、审计码、planHash | sense-now | 唯一真正解决「看得全不全」与「二次分析失控」的实现 |
| 弹幕注意力曲线 | 本机技能 | 0 视觉成本的全片事件源，四项目皆无 |
| 下载、ASR、观后感归档 | 本机技能 | 已跑通且是全站支持，唯一需要保留的既有资产 |

方案设计见 [FUSION-DESIGN.md](FUSION-DESIGN.md)。

## 附录 A：来源与可追溯

| 来源 | 版本 / 提交 | 提交日期 | 本地路径 |
| --- | --- | --- | --- |
| github.com/SAOS-3624/dsh-see-now | 0.2.6 / `59c4d1a` | 2026-11-21 | `imports/repos/see-now` |
| github.com/shet114513/dsh-streamvision | 0.2.8 / `6a2bac9` | 2026-11-21 | `imports/repos/streamvision` |
| github.com/xinhailaopo/video-watch-plus | `8ca266f` | 2026-10-04 | `imports/repos/video-watch-plus` |
| github.com/canyueY/sense-now | 0.1.0 / `dc327eb` | 2026-11-12 | `imports/repos/sense-now` |
| 本机技能 watch-a-video | 本地安装 | — | `C:\Users\ellio\.dsh\skills\watch-a-video` |

访问日期：2026-11-23。逐仓库精读记录在 `digests/{see-now,streamvision,video-watch-plus,sense-now}.md`（各 63–74 行，每条判断附 `路径:行号`）。

**证据规则**：本报告的全部判断均来自本次 clone 的仓库文件与本次在本机的实测，未使用训练先验补全。凡标「未见」处，表示该能力在仓库中确实不存在（不是没找到）。本机实测数据（§4）为本机跑数，不可外推为他人环境数据。
