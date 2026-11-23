# see-now（dsh-see-now 0.2.6）侦察 digest

## 1. 定位
- DSH 插件，工具名 `see_now`：把屏幕/摄像头/本地视频变成一串「按变化量筛选过」的帧，多帧拼成一张图交给宿主模型 `README.md:5`、`package.json:2-4`、`src/tool-spec.js:29-33`。
- 用户与安装：DSH 的 web/desktop profile，`dsh plugin --profile web add dsh-see-now`，装完须重启 DSH `README.md:157-166`。
- 宿主假设：`attachments`（交图）、`speechToText`（转写）、`sessions`/`sessionController`、`commands` 都是可选服务，缺了降级不崩 `src/index.js:455,750,795`、`src/listen.js:128`、`src/command.js:156`。
- 也自称可脱离 DSH 当 Node 库用（`capture`/`pipeline`/`png` 独立导出）`README.md:299-318`、`package.json:19-38`。
- **无下载步骤**：输入端只有 screen / camera / obs / file / rtmp，由 ffmpeg 直读 `src/capture.js:138-211`；不涉及任何站点抓取。

## 2. 完整处理管线
1. 采集：唯一 spawn ffmpeg 处，一根 `rawvideo rgb24` 管道，帧留在内存 `src/capture.js:1-6,271`；Windows `ddagrab`（探测失败退 `gdigrab`）、macOS `avfoundation`、Linux portal→PipeWire→gst `src/capture.js:135-200`、`src/portal-capture.js`、`README.md:210-214`。
2. 打分：每帧降到 64×36 网格，HSV 三通道加权绝对差 0–255 `src/cuts.js:9-80`；并行算运动补偿 mc（邻域半径 4）、稳定背景模型、变化包围盒 `src/cuts.js:219-444`。
3. 判据：切点 / 积分 / 兜底三条出口逐帧决定留不留，只延迟一帧 `src/pipeline.js:969-1077`。
4. 档位：按「过去 1 秒留了几帧」的 EMA 密度给 1..8 档，格子边长 1/k `src/tiers.js:163-209`。
5. 拼图：DP 装箱（rows/skyline），归一化方格、1px 缝、灰条补洞 `src/pack.js:190-421`、`src/sheet.js:266-340`。
6. 编码：自带 PNG 编码器，位图数字烧格号与缩略图徽标 `src/png.js`、`src/sheet.js:97-154`。
7. 交付：`attachments.saveImage` 交图 + 文本清单「过去 a–b 秒 n 个画面 / 每格时间码·像素·via·档位」，可附台词与变化日志 `src/index.js:397-433,454-480`。
8. 伴生：常驻循环唤醒（最小间隔 8s，连续 8 次无人应答收工）`src/loop.js:53-95`；听声音 WASAPI 回环→静音断句→wav→宿主 SenseVoice/OpenAI 兼容 ASR `src/listen.js:1-33`、`examples/floating-chat/listen.py`。
- **插件内没有「识图/理解」步骤**：只产图与清单，理解全在宿主模型；源码只取 `attachments`/`speechToText`/`sessions`/`commands`，不调 LLM `src/index.js:455`、`src/listen.js:128`。

## 3. 抽帧与采样算法（参数）
- 基础 12fps，采集与打分共用；三处按帧写的窗口按 `帧数/12×fps` 归一 `src/pipeline.js:32-49`。
- 切点：`score ≥ cutAbs=12`（calm 20 / dense 7 / game-economic 80）+ 尖峰 `s > 2.5×max(1,前,后)` 且 `mc ≥ 20` + 不应期 0.4s `src/pipeline.js:94-120`、`src/runner.js:105-121`。
- 运镜切机位：`mc ≥ 60 && score ≥ 6`；运动中台阶 `score ≥ 80 && 跳 ≥ 12 && ≥1.5×邻居` `src/pipeline.js:116-118,196-198`。
- 弱切点（相似构图）：`6 ≤ score < 12` 且 `>3×邻居`、`mc ≥ 8`、包围盒 ≥20、填充率 ≥0.2 `src/pipeline.js:132-136`。
- 前景抑制：6 帧稳定背景，`bg < 100`、变化格 ≤600、`mcSpanY/有效高 < 0.85` 判前景不切；高分候选再等 0.5s 未来帧确认（keep <100 判前景）`src/pipeline.js:148-186,1022-1056`。
- 积分：`need = REF_SCORE(4) × BASE_FPS(12) × integralSeconds(3) = 144`，固定绝对值、累够即留并清零，`markMinGap 0.5s` `src/pipeline.js:217-219,544-560`。
- 兜底：静止 20s 一帧；可改自适应 `clamp(k×近期间隔, 2s, 20s)`（calm 3 / normal 2 / dense 1.2）`src/pipeline.js:221-239`、`src/runner.js:105-107`。
- 去重：只与上一张留下的帧比，`dupMin=8` 以下丢弃，非全历史去重 `src/pipeline.js:241,562-571`。
- 截断：`maxWaitSec=15`（≥3 帧按时出；2 帧 15s 也发；单帧等到 30s）、`maxFrames=40`、`flushGain=0.015`、`queueDepth=1` `src/pipeline.js:332-365,700-720`。
- 档位公式：档 k 占 1/k²，`k ≈ sqrt(T·F)`（T≈16s）；阈值按「帧/秒」`[0.26,0.6,0.9,1.2,1.8,2.4,3.0]`，滞回 5%，另有 `perceptual` 表 `src/tiers.js:14-63,90-92`。
- 场景切分=纯像素差+运动补偿，**无**分割/音频事件/镜头元数据 `docs/cut-detection-limits.md:5-13`。

## 4. 成本控制
- token 公式：14px patch 对齐 → 42px 一格 → `rows×(cols+1)+2`，单图上限 1024 `src/tokens.js:1-35`。
- 每张实价：low 798×462=222 / standard 1050×630=392 / high 1260×756=560 / ultra 1596×924=860 `README.md:75-83`、`src/runner.js:42-47`。
- 宽度对齐 42（800→798）省 11~24 token/张；音轨条吃画面剩余行（450 余 12px），**不额外计费** `README.md:86-92`。
- 一张图 4 帧与 8 帧同价，故「多留一帧近免费、漏一帧才贵」`README.md:84`；`binCost=1000` 强制单箱 `src/pipeline.js:336-342`；`maxCrop=0`（裁 10% 只多 0.8% 帧）`src/pipeline.js:343-363`。
- 历史成本：单张 PNG ~130KB→base64 ~173KB；宿主 `maxRequestImageBytes` 20MiB ≈120 张，半小时到 1 小时撞线；省略会改历史→前缀缓存全量重算 `README.md:96-116`。
- 自带 `offload`：默认涨到 300 张时省略、保留最近 100（`imageTrigger`/`imageKeep`），代价一次性前缀重算 `src/tuning.js:56-70`、`src/offload.js:19-27`。
- 子代理账：一张宫格 222 token；子代理跑一轮 ≈22,000 token（≈99 张），结论是默认自己看 `README.md:118-128`、`docs/subagent-context.md:5`。
- **没有模型分级/路由**：插件不调模型，只有画质档（默认 low）、节奏档（calm/normal/dense/game-economic）、按需 `quality:"high"` 取一张清晰帧、`wakeBatch 1–4` 攒批 `src/tool-spec.js:82-83`、`src/runner.js:98-139`、`src/tuning.js:56`。
- 实测开销：12fps→800×450，ddagrab 0.28 核/首帧 370ms、gdigrab 0.45 核、avfoundation ~0.16 核/~700ms `README.md:669-687`；声音回环 0.3% 单核、3s 段转写 130–160ms、端到端约 0.6s `README.md:400-410`。

## 5. 质量保障
- 防漏两条腿：绝对地板防低分区尖峰误切，积分防一镜到底永不跳，缺一不可 `README.md:641-649`、`docs/调参与实测.md:59-75`。
- 自检通道：`status` 分行报采集/循环/听声音；`changeLog` 记被 `queueDepth` 挤掉的图；`pipeline.log` 每帧记 via/level/score/raw/gain/bar 供离线标定 `src/index.js:1637`、`src/pipeline.js:596-606`。
- 测试：`test/` 下 520 处顶层 `test(` 调用（`README.md:727` 写「181 条」，已过期）；CI 在 node 20/22 + ffmpeg 跑 `npm test` `.github/workflows/test.yml:52-53`。
- 离线回放：`scripts/sim.mjs` 用 `-r 12` 把视频喂进同一条管线并落盘，用于标定档位/截断 `scripts/sim.mjs:3-11`。
- 对照数据：`cutAbs` 命中矩阵（「每 2 秒换一张照片」6 刀，25/15/12/7 四档命中数）`docs/调参与实测.md:35-48`。
- 真实样本：180s B 站带货直播，旧逻辑 6 刀→当前 2 刀，被挡 4 点经人工分镜确认非换镜头 `docs/live-shopping-sample.md:22-45`。
- 覆盖率：兜底系数 k 由 1.5 改 2 时为「64.2→67.4（SHOT）/ 89.1→94.2（BBC），帧数 +8~10%」`src/runner.js:101-102`（数据集本身不在仓库内）。
- 自认缺口：强灯光直播真切点无样本，要求 30min 多机位直播+人工逐刀标注，指标为真切点召回/前景误切/固定外框误挡 `docs/cut-detection-limits.md:66-82`。
- 未见 ASR 质量评测（WER/CER 等）。

## 6. 依赖与环境
- Node ≥20；peer `@deepseek-ai/dsh-tools`（optional）`package.json:58-81`。
- ffmpeg 外置，按 `DSH_FFMPEG_PATH`/`FFMPEG_PATH`/`DSH_FFMPEG_DIR`/`~/.dsh/tools/ffmpeg/bin`/`~/.dsh/bin` 查找 `README.md:236-237`。
- 悬浮窗：Python ≥3.8 且带 `_tkinter` + Pillow/mss/numpy；Linux 另需 `gi`+gstreamer+pipewiresrc，指示框需 PySide6 `README.md:222-266`。
- 听声音：`pyaudiowpatch`+`numpy`，仅 Windows `README.md:382,446-447`。
- 无本地模型、无 GPU 必需（ddagrab 走 D3D11 采集，不做推理）；ASR 用宿主 SenseVoice 或 `~/.dsh/asr.json` 指的本地 OpenAI 兼容服务 `README.md:376-381`。
- 包体：发布文件 87 个、约 2.4 MB（含 `docs/images`，本地统计）；测试与调试窗不发布 `package.json:39-57`、`README.md:665`。

## 7. 局限与未实现项
- 只认「画面变了」不认「语义变了」；无跨帧全历史去重 `README.md:732-736`。
- 两类误判被定性为信息问题：整屏前景停住、外框固定近景误挡，在 0.5s 窗口内不可区分；0.5s 延迟不能免费消除 `docs/cut-detection-limits.md:15-64`。
- 听声音仅 Windows；抓整机输出（QQ/游戏音也进台词）；会听见自己的 TTS，用 `quiet-until.json` 整段丢弃 `README.md:444-453`。
- 只抓屏幕可见像素、只支持主屏；遮挡/最小化抓不到 `README.md:484-489`。
- Linux 无桌面环境不可用，反复 SIGKILL 可能卡住 xdg-desktop-portal；macOS 无录屏权限时不报错只全黑 `README.md:278-282,692-694`。
- 唤醒节流上限：不快于各 pace 的 `wakeGapSec`（calm 30 / normal 15 / dense 8 / game 20s）`src/runner.js:105-137`、`src/loop.js:53`。
- 未见：模型内部调用或多模型分级、ASR 评测集、mac/Linux 系统音频回环 `README.md:446-447`。
