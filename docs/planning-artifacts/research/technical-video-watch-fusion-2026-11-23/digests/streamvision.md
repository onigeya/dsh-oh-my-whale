# streamvision (dsh-streamvision v0.2.8) — 技术侦察 digest

> **首要结论：本仓库不含视频下载 / ASR / LLM 识图管线。** 它是 DSH 的 Windows 屏幕连续视觉插件："抽帧"=按 fps 采屏幕，"字幕"=屏幕分带 OCR。下文只记仓库内可见事实，视频域能力一律标「未见」。

## 1. 定位
- 解决的问题：agent 只能看单张截图，看不到"屏幕上发生了什么变化"；提供连续采样 + 块级差分 + 门控事件流 `README.md:3`,`README.md:6`。
- 给谁用：DSH 宿主内的 agent，通过 `sv_*` 工具调用 `lib/index.js:160`；也可脱离 agent 循环用 `sv_daemon.mjs` 跑 `sv_daemon.mjs:1-5`。
- 宿主假设：Windows + Win32 GDI + Windows.Media.Ocr；以 DSH bundle patch 挂载 `README.md:126`,`cordis.patch.yml:2`；进程须 per-monitor DPI aware `README.md:132`。
- 非目标：只采样，不做输入与窗口控制 `README.md:134`。
- 视频域：下载、yt-dlp、ASR、ffmpeg、视频文件解码、LLM 视觉理解 —— 全部「未见」（全仓 15 个文件，无相关依赖 `package.json:24-26`）。

## 2. 完整处理管线（实际实现）
主路径，像素不进上下文 `README.md:5-7`：
1. 采样：BitBlt 抓窗口/整屏 → 最近邻缩到 maxHeight（`sv_arm` 默认 480，`sv_watch` 720）`lib/native.js:107-153`,`lib/index.js:192`。
2. 落盘：同一帧同时写 `data/samples/s_<ts>.png` 与 `data/vectors/s_<ts>.svg` + `.json` `lib/pipeline.js:52-70`。
3. 矢量转化：32×18 网格量化颜色 → 贪心矩形合并 → SVG path + 对象/关系/统计 `lib/vector.js:109-227`。
4. 差分：块级 RGB 均值差 `lib/native.js:158-188`；HSV 三判据打分 `lib/score.js:141-157`。
5. 事件转写：强度分档 + 变化位置（百分比坐标 + 颜色名）+ 当前画面摘要 + 上一事件 `lib/pipeline.js:103-139`。
6. 写入队列：`data/events.jsonl`，id 高水位线存 `data/events.seq` `lib/index.js:657-689`。
7. 读取：`sv_events({wait})` 长轮询，返回最早未读，带 `pending/truncated/nextId` `lib/index.js:489-581`。
文本链路（并行，不阻塞运动通道）：三带裁剪 → 2×/2×/3× 放大 → 并发 OCR → 稳定判定 → `data/text.jsonl` `lib/text.js:127-149`,`lib/text.js:211-251`。
- 未见：下载 / 音频抽取 / ASR / 视频解码 / 调 LLM 识图 / 报告生成环节。

## 3. 抽帧与采样算法（屏幕域）
- 采样率：`sv_watch` 默认 8 fps（0.5–30）；`sv_arm` 默认 4 fps（上限 10，间隔 ≥100ms）；daemon 默认 8 fps `lib/index.js:189`,`lib/index.js:694`,`sv_daemon.mjs:29`。
- 差分网格：32 列 × 18 行块；块内 RGB 三通道绝对差均值，块判"变化"阈值 ≥6/255 `lib/native.js:158-183`。
- HSV 打分（64×36 降采样）：`scorePair = mean( |ΔH|·min(S_prev,S_cur)/255 + |ΔS| + |ΔV| ) / 3`，值域 0–255 `lib/score.js:58-67`。
  亮度增益 `gain = min(1.85, max(1, 96 / max(40, V_mean)))`，且差 <2 时不放大 `lib/score.js:110-113`,`lib/score.js:150`。
  局部分 `local = max(8×6 块内同式均值)` `lib/score.js:74-100`；面积分 `area = #{像素 d ≥ 20} / N`，`d` 同上式 `lib/score.js:121-133`。
- 三判据 OR：`score ≥ cutAbs(12) || local ≥ localCut(12) || area ≥ areaCut(0.004)` `lib/index.js:775`,`README.md:91-97`。
- daemon 另一套自适应门：`gate = max(4, p85(最近 40 帧 mean) × 1.15)`，触发条件 `mean ≥ gate || peak ≥ gate×4` `sv_daemon.mjs:123-127`,`sv_daemon.mjs:215`。
- 场景切分：连续静止超过 `quietMs`（`sv_scenes` 默认 400ms，daemon 700ms）闭合场景 `lib/index.js:350`,`sv_daemon.mjs:32`。
- 关键帧：场景内取 peak 最大的一帧；`peaks` 模式按 mean 降序取 N=6、间隔 ≥800ms，候选缓冲 100 帧 `lib/index.js:333-339`,`lib/index.js:362-370`。
- 去重：事件级冷却 `cooldownMs` 1500（daemon 2000）+ 每分钟上限 `maxPerMin` 6（daemon 8）`lib/index.js:706-707`,`sv_daemon.mjs:31-33`；文本级 bigram Jaccard ≥0.85 且间隔 ≥1200ms `lib/text.js:32-33`,`lib/text.js:219-243`。
- 帧数上限：`data/frames` 留 60 张（`SV_MAX_FRAMES`）`lib/index.js:28`；采样池按时间留 3 分钟、硬上限 3000 份 `lib/pipeline.js:17-18`（`sv_arm` 工具描述写 "latest 100"，与代码不一致 `lib/index.js:834`）。

## 4. 成本控制
- 核心手法是"像素永不进上下文"，只进数字 / 路径 / ≤2400 字符的 SVG `README.md:5`,`lib/pipeline.js:133`。
- 长轮询代替"每条事件唤醒一次会话"，理由明写：唤醒=新回合=重读上下文，更慢更贵 `README.md:86-87`。
- 文本读预算：单次 `maxChars` 默认 4000，每条另计 120 字符开销 `lib/text.js:256`,`lib/text.js:266-269`。
- 节流：cooldown + maxPerMin + 空闲 60s 自动收工 + 30min 硬停 `lib/index.js:694-707`。
- 实测数字：720p 每帧抓取 ~45–65ms `README.md:52`；一次三带 OCR ~1.2s `README.md:42`。
- 未见：token 预算、模型选择、LLM 调用、prompt 缓存、"先便宜后贵"分级 —— 本仓库无任何模型调用，无相关实测。

## 5. 质量保障
- 防漏：三条互补判据（全帧 / 最活跃块 / 变化面积）专治"整帧平均把一行字稀释掉" `lib/score.js:69-73`,`README.md:96-97`。
- 防抖：文本必须两拍都认到才入流，落盘用第一拍版本；同一 (band,text) 只留最早一条 `lib/text.js:6-9`,`lib/text.js:219-243`。
- 噪声过滤：时间码 / 清晰度标签 / URL / 纯符号行剔除 `lib/text.js:87-104`。
- 可观测：采样或写盘异常进 `ARMED.lastError`，连续 10 次失败自动停 `lib/index.js:748-753`；`sinceId` 过期会 clamp 并标 `staleSince` `lib/index.js:514-520`；增量读从最早未读开始，避免中间事件被静默跳过 `lib/index.js:536-539`。
- 自检 / 评测：**未见**任何测试、评测集、对照数据或指标基线（无 test/、无 docs/）。

## 6. 依赖与环境
- OS：仅 Windows（Win32 GDI + Windows.Media.Ocr）`README.md:126`。
- 运行时：Node ≥20 `package.json:32-34`；唯一 npm 依赖 `koffi ^3.3.1` `package.json:24-26`；OCR 走 powershell + `lib/ocr.ps1` `lib/ocr.js:89-109`。
- GPU / 本地模型 / 模型权重 / 网络：均不需要 `README.md:15-16`。API key：未见。
- 安装：`npm install link:<path>` → 加入 profile 的 `dsh.profile.bundles` → 重启 DSH（插件不热重载）`README.md:117-122`。
- 安装体积：未见实测数字。

## 7. 局限与未实现项
- Windows 独占；OCR 中文准确率差，README 自陈"安装→女装""目录→d i rectO"，建议只当提示 `README.md:127-131`。
- 抓屏读屏幕像素：窗口被遮挡就抓到遮挡物 `README.md:133`；只采样，不做输入与窗口控制 `README.md:134`。
- 视频域能力（下载 / ASR / 视频抽帧 / LLM 识图 / 结构化报告）全部未见，不能直接当视频管线参考。
- 未见 ARCHITECTURE / docs 目录，未见测试，未见评测集，未见 token 或费用数据。
