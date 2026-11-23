# video-watch-plus — 技术侦察 digest（只读本地仓库）

## 1. 定位
- 一句话：给「能读文件、能跑命令、能看图」的 agent 用的**技能包**，把视频翻译成「可核算的图版序列 + 经检验的音轨结论」，产出带时间戳的观看报告。`README.md:9-16` `SKILL.md:6-16`
- 不解决：**不下载视频、不做剪辑、不是新视频模型**；视频必须先在本地。`README.md:19-20` `README.md:381-382`
- 宿主假设：本地 CLI + 本地文件 + 具备单帧视觉能力的 agent；无服务端/API/UI，全部能力经 `python vendor/vw.py <子命令>` 暴露。`vendor/vw.py:1469-1582`
- 血缘：上游 `CFITCorporation/video-watch-skill`（MIT），本仓库只加两处 Windows 修补 + 声学/幻觉/验收脚本。`README.md:548-556` `vendor/vw.py:1-10`

## 2. 处理管线（下载 → 字幕/ASR → 抽帧 → 识图 → 产出）
- **下载**：未见实现且明确排除；文档建议外部 `yt-dlp` 落盘后再喂。`references/with-browser-skill.md:49-55`
- **量测 probe（零 token）**：一次 ffmpeg 遍历，滤镜链 `scdet=t=10,freezedetect=n=-60dB:d=2,tblend=difference,signalstats,metadata=print` 逐帧写 `analysis_v.txt`；另跑 `silencedetect=n=-35dB:d=1`。`vendor/vw.py:372-384`
- 逐秒聚合：`YAVG` 均值 = motion、`YMAX` = 像素突变、`scd.score ≥ 10` = 切点，输出 `timeline.json`。`vendor/vw.py:390-421`
- **采样 plan**：骨架 + 事件两级，输出 `shotlist.json`（含 `max_gap`、`tokens_est`）。`vendor/vw.py:489-613`
- **图版 sheet**：按 shotlist 抽帧 → drawtext 烧序号 → `magick montage` 拼 3×3/4×4/5×5/6×6 → `manifest.json`（第几行第几列 = 第几秒）。`vendor/vw.py:627-733`
- **读字 read**：整帧或 `--region` 切成 620×170 面板、放大 2×、每图 1–4 块；这是唯一可信读字通道，不用 OCR。`vendor/vw.py:1048-1135`
- **读动作 seq**：同一区域按帧号纵排，默认 0.1s 间隔、3× 放大，只能读 0.1–0.5s 级动作。`vendor/vw.py:975-1045`
- **ASR**：`faster-whisper`，`device="cpu", compute_type="int8"`、`vad_filter=True`、`beam_size=5` → `asr.json`。`vendor/vw.py:1148-1168`
- **声学前置**：`audio_probe.py` 只用 numpy（16kHz 单声道、N=2048、hop=512）算谱平坦度/节拍自相关/响度波动/滚降/单音集中度，给判型。`scripts/audio_probe.py:50-52` `scripts/audio_probe.py:106-197`
- **幻觉证伪**：同素材跑「VAD 开」与「拆掉全部拒识门槛」两组，比对 unique 比与 `no_speech`。`scripts/asr_hallucination_check.py:53-71`
- **产出**：`report` 生成 Markdown 骨架（结论/段落表/转写/图版映射/不确定项），带 ※ 的段落留给人填。`vendor/vw.py:1337-1466`
- **GIF 支线**：PIL 按帧延迟累计真实时间轴（不按帧号），超 18 帧等间隔抽，再走同一图版逻辑。`vendor/vw.py:745-795`

## 3. 抽帧与采样算法（`vendor/vw.py:489-613`）
- **骨架**：`t_i = i·(dur/16) + dur/32`，i=0…15，默认 `--skeleton 16`；盲区上界 = `dur/16`（20s→1.26s，143s→8.95s）。`vendor/vw.py:495` `vendor/vw.py:1483`
- **两端补帧**：`edge = max(0.05, 1/fps)`，开头/末尾各 1 帧，故「共 N 帧」= 骨架 + 事件 + 2。`vendor/vw.py:497-500`
- **帧预算**：`--max 36`；事件预算 `= (36 − 18) / burst(3) = 6 处`。`vendor/vw.py:524-526` `vendor/vw.py:1484`
- **事件三级优先**：① 切点 `t` 与 `t+0.4s`；② `YMAX ≥ 128` 或 `motion_max ≥ max(p95, 1.0)`；③ `dynamic` 时 `motion ≤ p10` 的谷底、活跃段起止。`vendor/vw.py:504-522`
- `dynamic := motion_p95 ≥ 2.0 或 mean ≥ 0.8`，仅决定是否启用「运动谷底」一级。`vendor/vw.py:510`
- **分配**：事件按 `--window 120s` 分窗、逐窗轮转各取 1（先到先得）；与已选点距离 `< MIN_GAP=0.6s` 则丢弃。`vendor/vw.py:527-552` `vendor/vw.py:55`
- **成组**：事件点再取 3 帧、间隔 `--burst-dt 0.12s`，0.04s 内去重，超出时长的丢弃。`vendor/vw.py:554-571`
- **文档/代码不一致**：`--burst` 帮助称「0=按内容自动（高运动 3，低运动 1）」，代码默认恒为 3，未见低运动分支。`vendor/vw.py:1489-1490` vs `vendor/vw.py:525`
- **图版几何**：`SHEET_PX=756`，`cols={9:3,16:4,25:5,36:6}`，`tile_w=756/cols−2`（5×5 时 149px），单图按 `TOKENS_PER_IMAGE=346` 估算。`vendor/vw.py:51-53` `vendor/vw.py:638`
- **未见**：场景切分/关键帧检测（唯一来源是 `scdet` 阈值 10.0）、感知哈希去重、按内容自适应帧数、光流/显著性选帧。`vendor/vw.py:1477`

## 4. 成本控制
- **先便宜后贵**：ffmpeg 全帧量测（0 token）→ 只看 ≤36 帧；音频 numpy 声学（0 token）→ 才跑 ASR。`README.md:33-34` `SKILL.md:11-12`
- **硬上限**：36 帧 → 最多 4 张 9 格图版 ≈ **1384 token**；18 帧 2 张 ≈ **692 token**；`plan` 直接打印 `sheets`/`tokens_est`。`vendor/vw.py:18` `vendor/vw.py:576-587`
- 实测：20.19s / 545 帧 → 骨架 16（间隔 1.26s）+ 事件 0 = 18 帧 / 2 图版 ≈ 692 token。`README.md:182-193`
- 实测：143s → 骨架 16（8.95s）+ 事件 6 处 = 36 帧 / 4 图版 ≈ 1384 token，封顶不变。`README.md:503-508`
- 公式：两小时素材骨架仍 16 帧 ⇒ **每 7.5 分钟一帧**；成本不随长度增长，代价是盲区线性变大。`README.md:393-396`
- **模型选择**：ASR 默认 `base`、实测 `small`，全 CPU int8；代码不选云端 LLM，看图由宿主 agent 的视觉模型完成（未见 API 调用）。`vendor/vw.py:1558` `README.md:512`
- **批处理**：9 帧/图版；`read --pack 1..4` 用清晰度换 token；`grid` 默认 25 帧/张。`vendor/vw.py:1107-1116` `vendor/vw.py:1515`
- **跳过**：`read` 中标准差 `< 0.005` 的空白面板直接删；冻结/低运动段不额外采样，只由骨架覆盖。`vendor/vw.py:1094-1098`
- **缓存**：未见抽帧复用、哈希缓存或增量分析，重跑即重抽。`vendor/vw.py`（全文无 cache 逻辑）
- 读字另计：无 `--region` 时 720×720 切 10 块/时刻，实测 2 个时刻出 20 张图；1080p 为 28 块/时刻。`README.md:389-391`

## 5. 质量保障
- **盲区可量化**：`max_gap`/`skeleton_gap` 写进 shotlist 与报告，不假装全覆盖。`vendor/vw.py:484-486` `vendor/vw.py:1443`
- **三路互校 + 权威边界**：时间只信 manifest；文字冲突以画面为准；有无语音看声学 + ASR VAD；都没证据就写「我没有可读信息」。`SKILL.md:105-121` `references/verification.md:55-62`
- **铁律：图版文字不采信**，必须原分辨率裁切放大；实测两次在图版里「读」出画面上不存在的字。`SKILL.md:22-27` `references/verification.md:79-85`
- **ASR 幻觉两判据**（共同前提：VAD 无输出）：① 互不重叠窗口输出完全相同文本；② `no_speech ≥ 0.4`。`scripts/asr_hallucination_check.py:113-129`
- **声学判型只是候选**：仅静音/纯音/音乐/未达判据四档，**没有「这是语音」**；78s 素材上把人声+配乐误判为纯音。`README.md:263-312`
- **自检**：`doctor` 逐项验 7 滤镜/libfreetype/IM 子命令；`build_testclip.py` 造 9s/640×360/24fps 带 `ground_truth.json` 的素材。`vendor/vw.py:1239-1293` `scripts/build_testclip.py:128-146`
- **可复算对账**：合成素材画面内烧源时间码，`seq` 读到的 3.208s 与 manifest 的 3.2s 逐帧吻合。`SKILL.md:123-135`
- **验收结果**：切点 3.0/6.0、冻结 0.0/6.0、静音 0.0→3.66 全精确命中（216 帧 / 9.00s）。`verification/record-2026-09-30.md:40-46`
- **评测集**：仅 1 条合成 + 3 条真实素材（纯 BGM 48.27s、有人声 20.16s、纯正弦），无标注集、无漏检率/召回率。`verification/record-2026-09-30.md:126-145`

## 6. 依赖与环境
- 实测：Windows 11、ffmpeg `N-126965 win64-gpl`、ImageMagick `7.1.2-32 Q16 x64 portable`、Python 3.13.14。`references/windows-setup.md:10-15`
- 必需：ffmpeg 完整构建（`scdet/freezedetect/silencedetect/tblend/signalstats/tile/drawtext`）、ffprobe、ImageMagick、字体。`vendor/vw.py:35-36` `vendor/vw.py:1290-1291`
- 体积：ffmpeg 包约 **190MB**；ImageMagick portable `.7z` + `7zr.exe`（588KB）；总量未见。`scripts/setup-windows.ps1:77` `scripts/setup-windows.ps1:103-111`
- 可选：Pillow（gif）、numpy（声学）、`faster-whisper` + `av<19`、`rapidocr-onnxruntime`（ocr）。`vendor/vw.py:1280-1283`
- **API key**：未见云端 key；仅 ASR 从 HuggingFace 拉模型，国内设 `HF_ENDPOINT`/`HF_HUB_DISABLE_XET`。`scripts/asr_hallucination_check.py:38-40`
- **本地模型**：Whisper（faster-whisper CPU int8）；无本地视觉模型，看图靠宿主 agent。`vendor/vw.py:1149`
- **GPU**：不需要；`device="cuda"` 本机因缺 `cublas64_12.dll` 失败，全部实测 CPU。`README.md:512`
- 配置：`vw.config.json`（`--config > VW_CONFIG > ./ > ~/.config/video-watch/`），路径可用 `VW_FFMPEG` 等覆盖。`vendor/vw.py:69-78`

## 7. 明确局限与未实现
- 不下载、不剪辑、不做识别（声学不认曲名/说话人）；不能替代浏览器实时语境（弹幕/标签/评论）。`README.md:479-501`
- 长素材：事件预算先到先得，2 小时时间轴上 6 处事件全落在**前 12 分钟**。`README.md:498-501`
- 实测覆盖：最长 143s（验收记录 48.27s），两小时级未测；macOS/Linux 未验收；OCR 未验收。`README.md:503-513` `verification/record-2026-09-30.md:148-155`
- 覆盖与清晰不可兼得；`read` 无 region 时面板数随分辨率爆炸。`README.md:389-391` `README.md:491-493`
- 无去重/缓存/增量、无场景关键帧检测、无自适应帧数；346 token 是常量估算而非计费校准。`vendor/vw.py:51-52`
- 报告只是骨架，结论段必须人工/agent 填；工具本身不产出自然语言结论。`vendor/vw.py:1349-1354`
