# sense-now 侦察 digest（本地只读精读 2026-11-23，上游 canyueY/sense-now）

## 1. 定位
- 解决的问题：旧长视频方案靠「有上限的全片抓帧」，视频变长后采样变稀、甚至只剩开头；整片字幕/图像一次塞进上下文又烧 token。改为「全片建索引、问题驱动补证据」`README.md:51-56`
- 给谁用：DSH（DeepSeek Harness）desktop profile 里的 Agent。两个工具：`sense_now` 实时陪看屏幕/摄像头，`video_index` 本地或 B 站视频一次建索引多次问答 `README.md:9-15`, `dsh.plugin.json`
- 宿主假设：Node ≥20；Windows-first（采集走 ddagrab/gdigrab），索引与检索跨平台 `README.md:20-23`
- **插件本身不调用任何视觉/语言模型**：全仓库无模型 API 调用，只有 `src/index.js:62` 动态 import `@deepseek-ai/dsh-tools`。「识图/理解」由宿主模型完成，本仓库只做选帧、拼图、建索引、按预算装配证据。

## 2. 处理管线
1. 下载：yt-dlp CLI 适配器，只允许 `*.bilibili.com` HTTPS，拒 b23.tv、裸 IP、私网 `src/video-index/adapters/bilibili-source.js:1-4`, `src/video-index/url-allowlist.js:2-27`；远程音频/帧走 127.0.0.1 计量 Range 代理，上限 64MB/180s/临时 128MB/3 跳 `src/video-index/remote-media.js:17-23`, `src/video-index/metered-media-proxy.js:21-33`
2. 字幕/ASR：固定 6 级优先级——B 站官方字幕 → 调用方字幕 → 外挂 SRT/VTT/ASS/SSA → 内嵌文本轨 → chunk ROI 低帧率 OCR →（缺口且授权）ASR `README.md:87-94`。视频级只 `probeOnly`，OCR 严格按 chunk `[start,end)` 落地 `src/video-index/subtitle-coordinator.js:63-272`；字幕轨与 chunk OCR 两级缓存 TTL 30min `subtitle-coordinator.js:16-19`
3. 分块：core 5 分钟 + 两侧各 20s 输入重叠；overlap 内发言按时间中点归属，再按文本+说话人+时间重叠去重（400ms slop）`src/video-index/chunk-plan.js:5-6,60-68,83-107`
4. 抽帧：实时侧走 `pipeline.js` 因果筛帧（见 §3）；长视频侧字幕优先时 `storyboard=skipped`，仅按需 `zoom`；非字幕优先才批量抓 frame `src/video-index/video-index-engine.js:1040-1050`, `README.md:111`
5. 产出：`catalog.json` + 每 chunk `utterances/events/speakers/storyboard/evidence/chapters`，原子 staging→live 发布 `README.md:526-556`；query 的模型可见文本直接给 `[mm:ss–mm:ss] 台词 (EVID_xxx)`，超预算显式 `--- omitted ---` `src/video-index-tool.js:116-135`

## 3. 抽帧与采样：实时侧（代码最密的部分）
- 打分：整帧缩到 **64×36 网格**（每格 4 采样点求平均），转 HSV 后取三通道加权绝对差，色相按环形处理、低饱和像素色相降权，输出 0–255 `src/cuts.js:9-35,38-73`
- 切点判据：`score ≥ cutAbs && score > 2.5 × max(1, 前帧, 后帧) && t - lastCut ≥ 0.4s`；只延迟一帧（12fps ≈ 83ms）判尖峰 `src/pipeline.js:75-77,417-429`
- 积分取帧：`need = REF_SCORE(4) × fps(12) × integralSeconds(3) = 144`，沿时间累加分数，累够才录一帧并清零；**阈值是固定绝对值**，不随画面涨（否则退化成等间隔抽样）`src/pipeline.js:96,165,210-212`, `docs/调参与实测.md:78-90`
- 兜底：20s 没出帧强制给一帧；两次留帧最小间隔 0.5s `src/pipeline.js:97-100`
- 去重：与「上一张留下的帧」差 < `dupMin=8` 则丢（cut/floor 免检）`src/pipeline.js:102,214-223`
- 档位（一帧占多大格）：按最近 1s（dtFrames=12）留帧密度，阈值 `[0.26,0.6,0.9,1.2,1.8,2.4,3.0]` 帧/秒 + 5% 滞回，档 1..8；档 k 边长 1/k，一张图放 k² 格，故 `k ≈ sqrt(T·F)`（T≈16s）`src/tiers.js:23-41,72-117`
- 上限：`maxFrames 40`、`maxWaitSec 15`、`queueDepth 1`（宁可丢老画面）、画布 800×450@12fps，清晰度三档到 1600×900 `src/pipeline.js:137-148`, `src/runner.js:27-33`
- 节奏档：`calm` cutAbs 20 / 唤醒 30s，`normal` 12 / 15s，`dense` 7 / 8s `src/runner.js:63-67`
- 实测标定（同机 12fps，每画面停 2s）：差异明显照片 46.6~63.4 分，色调接近 16.0~17.9，极相似（裁切差 8px）7.3~8.2，只改亮度 5.3，滚动网页 30~42，光标移动峰值 0.7 `src/pipeline.js:38-47`, `docs/调参与实测.md:37-46`

## 4. 抽帧与采样：长视频侧
- 非字幕优先的批量 storyboard：`fps 6`、`maxFrames 120`、800×450，`-vf fps=,scale=:flags=area` + rawvideo 管道 `src/video-index/video-index-engine.js:3186-3200`
- chunk 轻量帧：从 chunk 中点起 `fps 1`、`320×180`、**每块最多 4 帧** `src/video-index/video-index-engine.js:534-569`
- 字幕 OCR 扫描：`scanFps` 默认 1（可调 0.25~4），ROI 默认底部 45% 高（可到 0.9），裁剪宽高强制偶数 `src/video-index/subtitle-stream-source.js:31-77,79-103`
- OCR 门控：只有帧间像素差 > **4%** 才编码 PNG 并调用 OCR（抽样 step 12、单通道阈 18），未变化帧直接丢 raw `src/video-index/subtitle-band-scanner.js:15-23,127-134`
- 场景切分/关键帧检测：长视频侧**未见**独立场景检测器；切点只存在于实时 pipeline `src/cuts.js`。长视频的「关键帧」= chunk 中点帧 + 按需 zoom + 段尾稳定帧（可选，`maxPerChunk 12`）`src/video-index/video-index-engine.js:1209-1259`

## 5. 成本控制
- 图像 token 口径：≈ 像素 ÷ 1650。800×450=218、1066×600=388、1280×720=559、1600×900=872 token/张 `src/runner.js:26-32`（pipeline 注释同口径写 216/384 `src/pipeline.js:122-142`）
- 拼图经济学：一张图固定开销，塞满更划算——实测帧密场景 **1296 token/分·43/帧**（boost=2）vs 1728·58（boost=0）；静止素材 2 帧/张 → 3 帧/张，token/帧 108 → 72 `src/pipeline.js:119-125,314-316`
- 装配硬预算：`maxTextTokens 6000`、`maxVisualTokens 8000`、`maxUtterances 20`、`maxStoryboardUnits 4`、`maxSingleFrames 2`、`maxZoomRequests 2`、`maxChapters 3`、`maxEvents 12` `src/video-index/schema.js:21-30`
- token 估算公式（显式标 `estimated:true`，不伪装实测）：CJK 按 1.5 字/token、其余 3.5 字/token；视觉按 像素/1200 `src/video-index/token-gate.js:8-21,44-45`
- 索引期硬顶：`scanFps ≤ 4`、`maxFramesScannedPerChunk 400`、`maxOcrCallsPerMinute 30`、`maxOcrCallsPerChunk 120`、`maxTotalOcrCalls 2000`、`maxOcrRuntimeMsPerChunk 120s`、`maxRefineWindows 3`、`maxSecondPassCostRatio ≤ 1`；`Infinity/NaN` 不能绕过 `src/video-index/analysis-policy.js:13-29`, `README.md:408-420`
- 「先便宜后贵」的分级明确存在：字幕 →OCR→ ASR `fallback`/`full` 四模式由 `mayRunAsr(policy,{reason})` 把关（`asr.mode=off` 时零调用）；二次分析 `off/ask/auto_once`，auto_once 至多一次且只改白名单参数 `src/video-index/analysis-policy.js:226-241`, `README.md:131-142`
- 缓存与跳过：字幕轨缓存与 chunk OCR 缓存分离（TTL 30min，key 含 mediaRevision/policyHash）；`cognition-gate` 让普通索引事件不唤醒模型 `src/video-index/subtitle-coordinator.js:16-47`, `src/video-index/cognition-gate.js:14-22`
- 实测（合成，非真实解码）：复用索引连查 10 次均值 **10.3ms/次**，每次重建 80.6ms/次（≈8 倍）；6h/72 chunk 建 680ms，40 次查询共读 264 块（**占全片 9%**），p50 6.26ms、p95 22.64ms，峰值堆 6.25MB `README.md:598-616`
- 实测（真实媒体）：音频 Range 60–120s 提取 4.5s，实际只下载 737KB，输出 1.92MB WAV `docs/超长视频实施复验.md:284`

## 6. 质量保障
- 覆盖率三分离：scan/text/speech 各自算比值，`truncated` 时不得把未扫区域算成已扫；`status` 由 textCoverage 判 good≥0.7 / partial≥0.3 / poor `src/video-index/coverage.js:78-115`
- 自动审计 issue 码：`TIME_REVERSE`、`TIME_OVERLAP`、`FRONT_BIAS`（主题集中在前半）、`SUBTITLE_GAPS`、`SPEECH_WITHOUT_TEXT` `src/video-index/evidence-auditor.js:39-92`
- 复核计划必须显式确认：`planHash`(sha256 前 24/32 hex) + 参数白名单 + `maxRefineWindows` 上限，`confirmation` 缺省即拒 `src/video-index/evidence-auditor.js:7-11,144-182`, `src/video-index/refinement-plan.js:96-167`
- 不写假 ready：capability 六态 `disabled/skipped/unavailable/pending/degraded/ready`；抽帧没落盘就是 `degraded`，视觉查询明确报 `storyboard_missing_images` `src/video-index/schema.js:7-9`, `src/video-index/visual-need-router.js:44-57`
- 防「只看开头」：泛问不取 Top-N，而按时间覆盖选代表块（开头/中段/结尾硬覆盖 + 主题价值 + 均匀补齐，上限 24）`src/video-index/index-retriever.js:222-278,280-304`
- 评测集/对照数据：**未见**公开评测集或基准对照；只有合成 bench 与手写 smoke 文档（`scripts/smoke-subtitle-first.md` 等），README 自述「单元测试与合成 benchmark 不能解读为实机验证」`README.md:27-28,627-649`

## 7. 依赖与环境
- OS：Windows-first，采集依赖 ddagrab/gdigrab；索引跨平台，CI 跑 windows-latest + ubuntu-latest `README.md:22,581`
- 运行时：Node ≥20；FFmpeg/ffprobe **必需**；yt-dlp 仅 B 站；Python 组件全可选（faster-whisper、pyannote.audio、soundcard/pyaudiowpatch 环回）`README.md:168-175,452-490`
- GPU：**未见**硬性要求；Whisper 示例走 `cpu` + `int8`，pyannote 用 `DSH_PYANNOTE_DEVICE=auto` `README.md:462-479`
- API key：无（不发模型请求）；仅 pyannote 需 `HF_TOKEN`，且明确「凭据不是功能开关」`README.md:142,471-472`
- 体积：插件运行时约 2–3MB（`npm pack` 122 条目 / 2.25MB）；早期误拷 2,190MB，修 SKIP 后 2.3MB/134 文件 `README.md:192-193,583`, `docs/端到端跑通报告-2026-11-03.md:29-34`

## 8. 明确局限与未实现项
- Windows-first；OCR 与 VAD 只有「生产适配协议」，仓库**不默认携带模型**，未注入即 `unavailable` `README.md:734-735`
- B 站不支持付费番剧、DRM、直播、b23.tv 短链；抓播崩溃后不能无缝恢复，只能留 gap + URL `refine` 补洞 `README.md:736-737`
- active-speaker / face-tracker / 人物—音色绑定仍是实验能力 `README.md:738-739`；视觉回退在无文本命中时偏向靠前 chunk `README.md:740`, `src/video-index/index-retriever.js:320-330`
- 实时筛帧能力边界（参数无解）：小面积变化（一个图标/一个字）分数仅 0.5~2；语义没变但换了排版会被当成「换画面」；跨帧去重只跟上一张比 `docs/调参与实测.md:131-133`
- 真实长视频端到端耗时与内存曲线、真实 CDP、真实 B 站 URL 均**未实测**；测试不访问公网 `README.md:639-646`, `docs/超长视频实施复验.md:269-270`
- 已知未修缺陷：chunk 抽帧尺寸不匹配时写 1×1 占位 PNG 仍算 `ready` `docs/端到端跑通报告-2026-11-03.md:163-169`

## 9. 与「下载→ASR→抽帧→识图→产出」模板的差异
- 没有「ASR 先行」：默认 `asr.mode=off`，主路径是**字幕/OCR 先行**，ASR 只是缺口兜底且需显式授权 `README.md:385-395`
- 没有「每帧都识图」：图像只在命中时给（文本问题默认 0 张图，视觉问题先复用 storyboard、不足才 zoom）`src/video-index/visual-need-router.js:19-82`
- 没有「一次性生成总结」：产出是**可检索的证据库 + 按问题装配的上下文**，摘要由宿主模型在 query 时写 `README.md:143-148`
