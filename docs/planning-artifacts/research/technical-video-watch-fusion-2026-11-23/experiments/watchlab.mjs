#!/usr/bin/env node
// watchlab.mjs — 论证用测量脚本（不是产品代码，未来会以 TS 重写进插件，见 §8）。
//
// 目的：在真实素材上验证 FUSION-DESIGN.md §0/§2/§6 的密度驱动采样到底成不成立。
// 它只回答一个问题：给定一支真实视频，按「先量测、再按信息密度采样、最后去重」的办法，
// 需要多少帧、多少视觉 token、留下多大盲区；与现有技能「每 15 秒一帧、整帧送模型」相比如何。
//
// 它不做什么：
//   - 不调模型、不写观后感、不生成图版（只算图版张数与 token）
//   - 不下载视频、不做 ASR（素材目录里已有 video.mp4 与可选 asr.srt）
//   - 不碰 DSH 运行时，纯独立 Node 进程，跑完只留 JSON
//
// 迁移到产品模块时的对应关系（src/watch/*，见 FUSION-DESIGN.md §8）：
//   probeTimeline  → src/watch/probe.ts    ffmpeg 走 src/seams/ffmpeg.ts，只读 metadata=print 文本日志
//   danmaku        → src/watch/social.ts   弹幕/评论/热区
//   parseSrt       → src/watch/social.ts   文本侧密度（字幕由技能阶段产出，这里只消费）
//   buildWindows   → src/watch/shotlist.ts dens 打分
//   chunkUp        → src/watch/shotlist.ts 自然断点分块
//   planFrames     → src/watch/shotlist.ts 档位映射 + 切点锚定 + 覆盖率补帧
//   dhash/dedupe   → src/watch/frames.ts   去重三约束（闸门 G-w-12）
//   coverage 等    → src/watch/audit.ts    覆盖率与审计口径（闸门 G-w-9）
//   图版与笔记     → src/watch/sheets.ts / notes.ts（本脚本未实现，只算张数）
//
// 流水线（V0→V2；V1 文本侧在本脚本里退化为「只统计字幕字数」）：
//   ffprobe ─┬─ probeTimeline   单遍 ffmpeg：scdet + freezedetect + signalstats，0 帧落盘
//            ├─ danmaku         B 站弹幕（可选，失败降级）
//            └─ asr.srt         字幕字数
//        ↓ 5s 窗口聚合 → 按全片分位归一 → 加权成 dens ∈ [0,1]
//   buildWindows → chunkUp → planFrames → dhash 去重 → coverage / spearman / sheetsOf
//
// 用法：
//   node watchlab.mjs run <BV号|all> [--hamming 6] [--chunk 480] [--danmaku 0.15] [--no-danmaku]
//   node watchlab.mjs sweep <BV号>      六个参数变体，看哪个旋钮真的改成本
//   WL_DEBUG=1                          打印窗口级中间量（dens / iv / 选中帧）
//
// 素材约定：D:/Videos/<BV号>/{video.mp4, meta.json, asr.srt?}
// 产物：experiments/data/<BV号>.danmaku.json（弹幕缓存）、experiments/data/run-<时间戳>.json
//
// 口径（全篇统一，改这里等于改所有结论，改前回看 §1.3 实测表）：
//   sheets   = Σ 每块 ceil(帧数 / 9)      一张 3×3 图版装 9 帧
//   tokens   = sheets × 346              756px 图版实测单价（see-now / sense-now 口径）
//   baseline = ceil(时长 / 15) 帧 × 559   现技能做法：每 15s 一帧、每帧整图送模型
//   cov      = 1 − (所有 >60s 缺口超出 60s 的部分之和) / 时长
//
// 已知识量局限（写结论时要一起说）：
//   - 2h/3h 是按时长外推，没真跑两小时真实素材（只有 20 分钟合成片验证线性）
//   - motion 是 signalstats YAVG 的跨帧变化，不是光流；镜头内的大幅运动会被低估
//   - 弹幕接口单次约 1200 条，非全量
//   - 本脚本不产图：token 便宜不等于看得清，画质与可读性需另测（G-w-8）
//
// 运行环境：Node >= 20，ffmpeg/ffprobe 在 PATH。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";

const T0 = Date.now();
const FF = "ffmpeg";
const FP = "ffprobe";
const DATA = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "data");
fs.mkdirSync(DATA, { recursive: true });

// 阶段日志只走 stderr：stdout 留给结果 JSON，方便重定向或管道。
// 这些 [watchlab +Ns] 行是诊断生命线 —— 后台作业里 node 一声不响时，只能靠它们定位卡在哪一步。
function note(msg) { console.error("[watchlab +" + ((Date.now() - T0) / 1000).toFixed(1) + "s] " + msg); }
// 统一子进程封装。用 spawn + 数组参数而不是 exec：路径带空格、参数带引号时，
// shell 拼接会变成一连串转义事故；数组形式只有「参数」一个概念，没有 shell 语义。
// 超时是硬要求：ffmpeg 碰到损坏容器会安静挂住，而测量脚本没有结果就无法判断对错。
function run(cmd, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    const out = [], err = [];
    let killer = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, timeoutMs);
    let timedOut = false;
    killer.unref?.();
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => err.push(d));
    p.on("close", (code) => { clearTimeout(killer); resolve({ code, timedOut, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }); });
    p.on("error", (e) => { clearTimeout(killer); resolve({ code: -1, timedOut, stdout: Buffer.concat(out), stderr: String(e) }); });
  });
}

// 只取 format.duration 与流信息。用 JSON 输出而非解析人类可读文本：
// 后者随 ffprobe 版本改格式，而本脚本要在别人的机器上跑。
async function ffprobeJson(file) {
  const r = await run(FP, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  return JSON.parse(r.stdout.toString("utf8"));
}

// ---------- 1. 全片量测（0 解码到模型） ----------
// V0 量测：一遍 ffmpeg 扫完全片，只留每秒的标量统计，一帧都不解码到模型。
// 这是整个方案的成本前提 —— 抽帧与场景检测近乎免费（实测 21–26× 实时），
// 唯一贵的是把图送进模型，所以「多看」只能靠先看懂哪里值得看。
//
// 滤镜各管一件事：
//   scdet=t=10       场景切换打分 0–100，t 只是记录阈值，真正判定见下面的 cut
//   freezedetect     静止画面（长时间不动 = 信息量低）
//   signalstats      YAVG/YMAX：平均亮度与最亮像素，用来近似「画面在动」与「有没有高对比变化」
//   metadata=print   把上述元数据打到文本日志（file=- 即 stdout）
// 静音另起一遍扫描：它只写 stderr，且与视频滤镜共用一次调用需要 filter_complex，不划算。
//
// 三处曾经踩空的坑（改动前务必看）：
//   1) 输出必须写 NUL/devnull。写 "-" 时空 muxer 会占用 stdout，metadata=print 的文本全部丢失
//      —— 第一轮六支素材 cuts 全 0、motion 全 0 就是这里。
//   2) frame 行的真实形态是 frame:0    pts:0       pts_time:0，中间有 pts 字段，
//      正则必须容忍 pts:\S+；匹配不上则 cur 恒为 -1，后面所有 lavfi.* 行被跳过。
//   3) 键名含大写（signalstats.YAVG/YMAX），字符类 [a-z.]+ 永远匹配不到。
async function probeTimeline(file, duration) {
  const t0 = Date.now();
  const vf = "scdet=t=10,freezedetect=n=-60dB:d=2,signalstats,metadata=print:file=-";
  // 输出必须写 NUL/devnull：若写 "-"，空 muxer 会占用 stdout，metadata=print 的文本全部丢失
  // （这正是第一轮六支素材 cuts 全为 0、motion 全为 0 的原因）
  const NUL = process.platform === "win32" ? "NUL" : "/dev/null";
  const r = await run(FF, ["-v", "error", "-nostdin", "-i", file, "-an", "-vf", vf, "-f", "null", NUL]);
  const lines = r.stdout.toString("utf8").split(/\r?\n/);
  const secs = new Map();
  let cur = -1;
  const bump = (s) => { let o = secs.get(s); if (!o) { o = { t: s, yavg: [], ymax: 0, scd: 0, cuts: 0, freeze: 0 }; secs.set(s, o); } return o; };
  for (const ln of lines) {
    // 实际行是 "frame:0    pts:0       pts_time:0"，中间的 pts 字段必须容忍
    const m = ln.match(/^frame:\s*(\d+)\s+pts:\S+\s+pts_time:([0-9.]+)/);
    if (m) { cur = Math.floor(parseFloat(m[2])); continue; }
    if (cur < 0) continue;
    // 键名含大写（signalstats.YAVG/YMAX），字符类必须带 A-Z
    const kv = ln.match(/^lavfi\.([A-Za-z0-9_.]+)=(.+)$/);
    if (!kv) continue;
    const [, key, val] = kv;
    const o = bump(cur);
    if (key === "signalstats.YAVG") o.yavg.push(parseFloat(val));
    else if (key === "signalstats.YMAX") o.ymax = Math.max(o.ymax, parseFloat(val));
    else if (key === "scd.score") { const v = parseFloat(val); if (v > o.scd) o.scd = v; }
    else if (key.startsWith("freezedetect.freeze_start")) o.freeze = 1;
  }
  // 按整秒压平成 {t, motion, ymax, scd, cut, freeze}：
  //   motion = 该秒内所有帧 YAVG 的均值（画面平均多亮，相邻秒之差近似变化多少）
  //   cut    = scd 到 10 即算硬切（与 scdet=t=10 对齐；t 只影响记录不影响阈值）
  // 缺失的秒补 0 而不是跳过：稀疏数组会让后续「任意窗口都有帧」的统计凭空成立。
  const arr = [];
  const n = Math.ceil(duration);
  for (let s = 0; s < n; s++) {
    const o = secs.get(s);
    arr.push({ t: s, motion: o && o.yavg.length ? o.yavg.reduce((a, b) => a + b, 0) / o.yavg.length : 0, ymax: o ? o.ymax : 0, scd: o ? o.scd : 0, cut: o && o.scd >= 10 ? 1 : 0, freeze: o ? o.freeze : 0 });
  }
  // 静音单独一遍扫描：silencedetect 只写 stderr（所以这里要 -v info），
  // 本趟不解析 stdout，所以 -f null - 是安全的。
  // 静音只作为「这里可能没在说事」的弱信号，不断言无信息 —— 白板书写、纯音乐段很常见。
  // 音频静音段
  const ra = await run(FF, ["-v", "info", "-nostdin", "-i", file, "-af", "silencedetect=n=-35dB:d=1.5", "-f", "null", "-"]);
  const sil = [];
  const starts = [...ra.stderr.matchAll(/silence_start:\s*([0-9.]+)/g)].map((m) => parseFloat(m[1]));
  const ends = [...ra.stderr.matchAll(/silence_end:\s*([0-9.]+)/g)].map((m) => parseFloat(m[1]));
  for (let i = 0; i < starts.length; i++) sil.push({ start: starts[i], end: ends[i] ?? duration });
  return { seconds: arr, silences: sil, ms: Date.now() - t0, bytes: r.stdout.length };
}

// ---------- 2. 弹幕 ----------
// 读 netscape 格式 cookie（本机在 ~/.dsh/cookies/bilibili.txt）。
// 注意 #HttpOnly_ 开头的行是真 cookie，被浏览器标了 HttpOnly；不能当注释跳过。
// 缺 cookie 不致命，只是部分接口会返回空（登录态相关内容）。
function biliCookie() {
  const f = path.join(os.homedir(), ".dsh", "cookies", "bilibili.txt");
  if (!fs.existsSync(f)) return "";
  const jar = [];
  for (const ln of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    if (ln.startsWith("#") && !ln.startsWith("#HttpOnly_")) continue;
    const p = ln.split("\t");
    if (p.length >= 7) jar.push(p[5] + "=" + p[6]);
  }
  return jar.join("; ");
}
// Node 的 fetch 走 undici，不吃系统代理；本机必须经 127.0.0.1:7897，改用 curl.exe。
async function getBili(url, cookie) {
  const args = ["-s", "--compressed", "-m", "30",
    "-H", "Referer: https://www.bilibili.com",
    "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/150.0.0.0 Safari/537.36"];
  if (cookie) args.push("-H", "Cookie: " + cookie);
  args.push(url);
  const r = await run("curl.exe", args);
  if (r.code !== 0 || !r.stdout.length) throw new Error("curl exit " + r.code + " " + r.stderr.slice(0, 120));
  return r.stdout;
}
// 弹幕两步：view 接口拿 cid → dm/list.so 拉 XML。结果按 BV 号永久缓存，弹幕不随播放变化。
// 失败也写缓存（{total:0,error}），避免每次重跑都去撞同一个墙。
// 局限：该接口单次约返回 1200 条，不是全量；当「热点在哪」的信号够用，当「观众原话」不够。
async function danmaku(bvid) {
  const cache = path.join(DATA, bvid + ".danmaku.json");
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, "utf8"));
  const ck = biliCookie();
  const view = JSON.parse((await getBili("https://api.bilibili.com/x/web-interface/view?bvid=" + bvid, ck)).toString("utf8"));
  if (view.code !== 0) { const e = { total: 0, list: [], error: view.message }; fs.writeFileSync(cache, JSON.stringify(e)); return e; }
  const cid = view.data.cid;
  const xml = (await getBili("https://api.bilibili.com/x/v1/dm/list.so?oid=" + cid, ck)).toString("utf8");
  const list = [];
  for (const m of xml.matchAll(/<d p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g)) {
    const t = parseFloat(m[1].split(",")[0]);
    if (!isFinite(t)) continue;
    list.push({ t: Math.round(t * 10) / 10, text: m[2].trim() });
  }
  const e = { total: list.length, list };
  fs.writeFileSync(cache, JSON.stringify(e));
  return e;
}

// ---------- 3. 字幕文本密度 ----------
// 只看字数，不留文本。V1 文本侧在本脚本里退化成「这个窗口有多少字在说」一个标量，
// 用来给密度加权；真正的文本理解留给后续 V3 由模型读字幕。
// 这也是本脚本不需要 ASR 的原因：字幕是技能阶段的产物，这里只是消费者。
function parseSrt(file) {
  if (!fs.existsSync(file)) return [];
  const txt = fs.readFileSync(file, "utf8");
  const out = [];
  for (const blk of txt.split(/\r?\n\r?\n/)) {
    const m = blk.match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) continue;
    const s = +m[1] * 3600 + +m[2] * 60 + +m[3];
    const e = +m[5] * 3600 + +m[6] * 60 + +m[7];
    const text = blk.split(/\r?\n/).slice(1).join(" ").replace(/<[^>]+>/g, "").trim();
    out.push({ start: s, end: e, chars: text.length });
  }
  return out;
}

// ---------- 4. 密度与计划 ----------
function pct(arr, q) { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]; }
function clip01(x) { return Math.max(0, Math.min(1, x)); }

// 5 秒是「密度分辨率」与「窗口数量」的折中：更细（1s）会被单帧噪声主导 p95 归一化，
// 更粗（30s）会抹平快剪视频的局部高峰、让采样点错位。六支素材实测都够用。
const W5 = 5;
function buildWindows(duration, tl, dan, srt, w) {
  const n = Math.ceil(duration / W5);
  const wins = [];
  for (let i = 0; i < n; i++) {
    const a = i * W5, b = Math.min(duration, a + W5);
    const secs = tl.seconds.filter((s) => s.t >= a && s.t < b);
    const motion = secs.length ? secs.reduce((x, s) => x + s.motion, 0) / secs.length : 0;
    let dmax = 0;
    for (let k = 1; k < secs.length; k++) dmax = Math.max(dmax, Math.abs(secs[k].ymax - secs[k - 1].ymax));
    const cuts = secs.reduce((x, s) => x + s.cut, 0);
    const dm = dan.filter((d) => d.t >= a && d.t < b).length;
    const chars = srt.filter((s) => s.start < b && s.end > a).reduce((x, s) => x + s.chars, 0);
    const silenced = tl.silences.some((s) => s.start < b && s.end > a);
    wins.push({ i, a, b, motion, dmax, cuts, dm, chars, silenced });
  }
  const pm = pct(wins.map((x) => x.motion), 0.95) || 1;
  const pd = pct(wins.map((x) => x.dmax), 0.95) || 1;
  const pcut = pct(wins.map((x) => x.cuts), 0.95) || 1;
  const pdm = pct(wins.map((x) => x.dm), 0.90) || 1;
  const pch = pct(wins.map((x) => x.chars), 0.95) || 1;
  // 归一化基准用 p95（弹幕 p90）而不是最大值：一次爆点会把 max 顶到天上，
  // 其余窗口全被压到 0.0x，密度信号退化成「只有一个点非零」。
  // 权重：运动 0.35 / 亮度突变 0.25 / 切点 0.15 / 弹幕 0.15（可调，封顶 0.3）/ 字幕字数 0.10。
  // 这组权重是设计先验而非拟合；§12 的 sweep 证明它对 token 不敏感，
  // 真正敏感的是档位边界 —— 所以别在这里调参期待改善，去动 TIERS。
  const wD = w.danmakuWeight ?? 0.15;
  const cap = w.danmakuWeightCap ?? 0.3;
  for (const x of wins) {
    x.dens = 0.35 * clip01(x.motion / pm) + 0.25 * clip01(x.dmax / pd) + 0.15 * clip01(x.cuts / pcut)
           + Math.min(cap, wD) * clip01(x.dm / pdm) + 0.10 * clip01(x.chars / pch);
  }
  return wins;
}

// 为什么要分块：图版按块拼（跨块的帧不能塞进同一张 3×3）、笔记按块写、
// 同时可见的图版数按块控制。块的边界因此不是美学问题，而是「读者在哪里换气」。
// 断点判据取 motion 局部最小：镜头切换处通常也是运动低谷，符合人的分段直觉。
// 480s 上限是「一块别太大，否则单块图版与笔记都失控」；尾块 <90s 并进前块，
// 否则一个 78s 的尾巴要单独凑满 9 格图版，纯浪费。
function chunkUp(wins, opts) {
  const maxS = opts.chunkMaxSec ?? 480, minS = opts.chunkMinSec ?? 90;
  const dur = wins.length ? wins[wins.length - 1].b : 0;
  const chunks = [];
  let start = 0;
  while (start < dur - 1) {
    let target = Math.min(dur, start + maxS);
    if (target - start < minS) { chunks.push({ a: start, b: dur }); break; }
    // 在目标前后 45s 内找 motion 局部最小（自然断点）
    const lo = Math.max(start + minS, target - 45), hi = Math.min(dur, target + 45);
    let best = target, bestV = Infinity;
    for (const x of wins) { if (x.a >= lo && x.a <= hi && x.motion < bestV) { bestV = x.motion; best = x.a; } }
    chunks.push({ a: start, b: Math.min(dur, best) });
    start = Math.min(dur, best);
  }
  // 尾块过短就并进前一块：一个 78s 的独立块要单独凑满 9 格图版，纯浪费。
  if (chunks.length > 1 && chunks[chunks.length - 1].b - chunks[chunks.length - 1].a < minS) {
    const tail = chunks.pop();
    chunks[chunks.length - 1].b = tail.b;
  }
  return chunks.map((c, idx) => {
    const ws = wins.filter((x) => x.a >= c.a && x.a < c.b);
    const mean = ws.length ? ws.reduce((s, x) => s + x.dens, 0) / ws.length : 0;
    return { idx, a: c.a, b: c.b, mean, wins: ws };
  });
}

// 每 5s 窗口按全片 dens 的分位取档：相对密度而非绝对阈值（不同体裁的绝对量级差太多）
const TIERS = [[0.90, 2], [0.70, 5], [0.40, 15], [0.15, 60], [0, 300]];
function intervalOfRank(rank) { for (const [th, iv] of TIERS) if (rank >= th) return iv; return 300; }

function chunkOf(chunks, t) {
  for (const c of chunks) if (t >= c.a && t < c.b) return c.idx;
  return chunks.length ? chunks[chunks.length - 1].idx : 0;
}

// 采样：把 dens 映射成「多久看一次」，再把各来源的候选帧合并成一份帧表。
//
// 这个函数重写过四次，每次都被实测数字逼的，别凭直觉改回去：
//   1) 块级分位档：只有 2 块时 rank 是 0.5 与 1.0，最密的块必吃 2s 档，96 秒片子抽出 48 帧。
//   2) 每 5s 窗口独立取档：15/60/300s 档在 5s 窗口里 floor(5/15)=0，短片被抽成 11 帧。
//   3) 现在的沿时间轴自适应扫描：间隔回答「下一次最早能在哪看」，不是「这个窗口切几刀」。
//   4) 两条硬规则兜底：硬切后 0.25s 必取一帧（内容边界不能靠密度碰运气）、每块至少一帧。
//
// 不变量：帧数由内容决定，不由预算决定。快剪发布会 322s 有 160 个切点就出 154 帧，
// 短剧 585s 只有 63 个切点就出 88 帧。任何「加上限砍掉一些」的改动都在破坏这条。
function planFrames(wins, chunks, duration, cutTimes = []) {
  const sorted = wins.map((w) => w.dens).sort((a, b) => a - b);
  const rankOf = (v) => sorted.filter((x) => x <= v).length / sorted.length;
  // 沿时间轴自适应扫描：间隔是"在这个密度下多久看一次"，不是"每个窗口切几刀"。
  // 若按窗口独立取 frame，5s 窗口配 15s/60s/300s 档会算出 0 帧，短片会被抽成几帧。
  const cands = [];
  let last = -1e9;
  for (const w of wins) {
    w.iv = intervalOfRank(rankOf(w.dens));
    let t = Math.max(w.a + w.iv / 2, last + w.iv);
    while (t < w.b) {
      cands.push({ t: +t.toFixed(1), dens: w.dens, iv: w.iv, chunk: chunkOf(chunks, w.a) });
      last = t;
      t += w.iv;
    }
  }
  // 切点锚定：每个硬切后 0.25s 必取一帧 —— 内容边界不能靠密度碰运气
  for (const c of cutTimes) {
    const t = +Math.min(duration - 0.2, c + 0.25).toFixed(1);
    if (t > 0) cands.push({ t, dens: 1, iv: 0, chunk: chunkOf(chunks, t), cut: true });
  }
  if (process.env.WL_DEBUG) console.error("WINS " + JSON.stringify(wins.map((w) => [w.a, +w.dens.toFixed(3), w.iv, +w.motion.toFixed(1), w.dm])));
  // 合并 + 0.6s 最小间隔（保留密度高的那个）
  cands.sort((a, b) => a.t - b.t);
  let merged = [];
  for (const c of cands) {
    const last = merged[merged.length - 1];
    if (last && c.t - last.t < 0.6) { if (c.dens > last.dens) merged[merged.length - 1] = c; continue; }
    merged.push(c);
  }
  // 覆盖率兜底：任何超过 60s 的空洞（含片头片尾）都要补帧，补在洞内密度最高的窗口。
  // 只按 60s 桶补是错的：桶内帧可能贴在一端，仍会留下 95s 的真空。
  const dur = duration || (wins.length ? wins[wins.length - 1].b : 0);
  // 每个窗口只能用一次：否则同一个窗口会在最大缺口里被反复选中，补出同一个点，缺口不变 → 空转到守卫上限。
  const usedWin = new Set();
  for (let guard = 0; guard < 400; guard++) {
    merged.sort((a, b) => a.t - b.t);
    const pts = [0].concat(merged.map((c) => c.t), [dur]);
    let worst = null;
    for (let i = 1; i < pts.length; i++) {
      const g = pts[i] - pts[i - 1];
      if (g > 60 && (!worst || g > worst.g)) worst = { g, a: pts[i - 1], b: pts[i] };
    }
    if (!worst) break;
    let bi = -1, best = null;
    wins.forEach((w, i) => {
      if (usedWin.has(i)) return;
      if (w.a < worst.a || w.a >= worst.b) return;
      if (!best || w.dens > best.dens) { best = w; bi = i; }
    });
    if (bi < 0) break;
    usedWin.add(bi);
    const t = +Math.max(worst.a + 0.5, Math.min(worst.b - 0.5, best.a + 2.5)).toFixed(1);
    merged.push({ t, dens: best.dens, iv: best.iv, chunk: chunkOf(chunks, best.a), fill: true });
  }
  // 每块至少一帧：逐块出笔记的前提
  for (const c of chunks) {
    if (merged.some((x) => x.t >= c.a && x.t < c.b)) continue;
    const ws = wins.filter((w) => w.a >= c.a && w.a < c.b);
    if (!ws.length) continue;
    const best = ws.reduce((x, y) => (y.dens > x.dens ? y : x));
    merged.push({ t: +(best.a + 2.5).toFixed(1), dens: best.dens, iv: best.iv, chunk: c.idx, fill: true });
  }
  merged.sort((a, b) => a.t - b.t);
  return merged.map((c) => ({ t: c.t, chunk: c.chunk, reason: (c.cut ? "cut " : "") + "dens=" + c.dens.toFixed(2) + " iv=" + c.iv + (c.fill ? " fill" : "") }));
}

// ---------- 5. dHash 去重 ----------
// 感知哈希：缩成 9×8 灰度，逐行比较左右像素大小，得 64 位指纹（BigInt 存）。
// 故意用 rawvideo 直读 72 字节，不落图片、不引图像库：换成 TS 时只需读一段二进制，
// 不必为去重把 jimp/sharp 拖进依赖。
// 三个已知盲区（合成素材实测）：纯色/平坦画面 hash 全同（灰度行内均匀 → 全 0）；
// 9×8 对局部小变化不敏感（字幕、小图标、指针移动看不出）；颜色信息完全丢失。
// 结论：去重只能当「省帧」用，含字幕带的帧必须放行，不能拿它判断「这两帧一样」。
async function dhash(file, t) {
  const r = await run(FF, ["-v", "error", "-nostdin", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=9:8:flags=area,format=gray", "-f", "rawvideo", "-"]);
  if (r.stdout.length < 72) return null;
  let h = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const a = r.stdout[y * 9 + x], b = r.stdout[y * 9 + x + 1];
    h = (h << 1n) | (a > b ? 1n : 0n);
  }
  return h;
}
function ham(a, b) { let x = a ^ b, c = 0; while (x) { c += Number(x & 1n); x >>= 1n; } return c; }
// span：只在「与上一张保留帧相距 ≤ span 秒」时才允许去重。
// 不设 span 会让同一场景在 100 秒后重现时被当成重复帧丢掉 —— 覆盖率闸门（G-w-9）就是被这件事打穿的。
// span 必须 < 覆盖率允许的最大缺口（60s），否则去重自己就能造出违规缺口。
async function dedupe(file, frames, thresh, span = 50, maxGapSec = 55) {
  const t0 = Date.now();
  let hashes = 0;
  const marked = [];
  let lastKept = null;
  for (const f of frames) {
    const h = await dhash(file, f.t);
    if (h === null) { marked.push({ f, h: null, dup: false }); continue; }
    hashes++;
    const dup = !!(lastKept && f.t - lastKept.t <= span && ham(h, lastKept.h) < thresh);
    marked.push({ f, h, dup });
    if (!dup) lastKept = { ...f, h };
  }
  // 丢弃不得自己造出大缺口：连续丢弃会累积到 2×span，所以逐帧看「丢下去之后到下一个保留帧有多远」。
  const kept = [];
  for (let i = 0; i < marked.length; i++) {
    const { f, h, dup } = marked[i];
    if (dup) {
      const prevT = kept.length ? kept[kept.length - 1].t : -1e9;
      let nextT = null;
      for (let j = i + 1; j < marked.length; j++) if (!marked[j].dup) { nextT = marked[j].f.t; break; }
      if (nextT !== null && nextT - prevT <= maxGapSec) continue;
    }
    kept.push({ ...f, h });
  }
  return { kept, ms: Date.now() - t0, hashed: hashes };
}

// ---------- 6. 指标 ----------
// 覆盖率按"任意 60s 窗口内都有帧"算，即覆盖率由缺口超过 60s 的那部分时长决定。
// 按 60s 桶计数会把片尾 1s 也算成整块失效（301s 的片子会凭空扣掉 16.7%）。
function coverage(frames, duration) {
  const ts = frames.map((x) => x.t).sort((a, b) => a - b);
  if (!ts.length) return { cov: 0, maxGap: duration, windows: Math.ceil(duration / 60), deficit: duration };
  let prev = 0, maxGap = 0, deficit = 0;
  for (const t of ts.concat([duration])) {
    const g = t - prev;
    if (g > maxGap) maxGap = g;
    if (g > 60) deficit += g - 60;
    prev = t;
  }
  return { cov: 1 - deficit / duration, maxGap, windows: Math.ceil(duration / 60), deficit: +deficit.toFixed(1) };
}
// 窗口级秩相关：帧数 vs 密度。为什么不用块级 —— 短片只有 2 个块，n=2 时公式恒为 0。
// 闸门 G-w-10 用它检查「采样没有退化成等间隔」；注意切点锚帧按内容边界摆放、与 dens 无关，
// 会把 ρ 压低，所以判据是 ρ>0.45 且只统计非锚帧（§9）。
function spearman(xs, ys) {
  const rank = (arr) => { const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const r = new Array(arr.length); idx.forEach(([, i], k) => (r[i] = k + 1)); return r; };
  const rx = rank(xs), ry = rank(ys), n = xs.length;
  const d2 = rx.reduce((s, v, i) => s + (v - ry[i]) ** 2, 0);
  return n > 2 ? 1 - (6 * d2) / (n * (n * n - 1)) : 0;
}
// 图版张数按块分别向上取整：每块最后一张不满 9 帧也要占一整张，
// 因为图版是「块」的产物，跨块拼图会让时间顺序与阅读顺序脱节。
// 单张 3×3 / 756px / 约 346 token —— 这是全篇成本口径的分母。
function sheetsOf(frames) {
  const byChunk = new Map();
  for (const f of frames) byChunk.set(f.chunk, (byChunk.get(f.chunk) || 0) + 1);
  let sheets = 0;
  for (const [, n] of byChunk) sheets += Math.ceil(n / 9);
  return sheets;
}

// ---------- 7. 单支视频全流程 ----------
const TL_CACHE = new Map();
// 单支视频的完整链路：量测 → 弹幕/字幕 → 窗口密度 → 分块 → 采样 → 去重 → 指标。
// 顺序不能换：采样要用密度，密度要用量测；去重必须发生在采样之后，
// 先去重再采样会把「哪里值得看」的信息一起丢掉。
async function analyse(bvid, opts = {}) {
  const dir = path.join("D:/Videos", bvid);
  const file = path.join(dir, "video.mp4");
  if (!fs.existsSync(file)) throw new Error("missing " + file);
  const meta = await ffprobeJson(file);
  const duration = parseFloat(meta.format.duration);
  note(bvid + " dur=" + duration.toFixed(1) + "s probing");
  // 同一支视频在一次进程内只探一次：sweep 要跑 6 个变体，探针占 60% 的时间。
  if (!TL_CACHE.has(file)) TL_CACHE.set(file, await probeTimeline(file, duration));
  const tl = TL_CACHE.get(file);
  note("probe done " + tl.ms + "ms cuts=" + tl.seconds.reduce((s, x) => s + x.cut, 0));
  let dan = { total: 0, list: [] };
  if (opts.danmaku !== false) { try { dan = await danmaku(bvid); } catch (e) { console.error("danmaku failed:", e.message); } }
  const srt = parseSrt(path.join(dir, "asr.srt"));
  const wins = buildWindows(duration, tl, dan.list, srt, opts);
  const chunks = chunkUp(wins, opts);
  const cutTimes = tl.seconds.filter((s) => s.cut).map((s) => s.t);
  const planned = planFrames(wins, chunks, duration, cutTimes);
  note("plan=" + planned.length);
  if (process.env.WL_DEBUG) console.error("PLANNED " + planned.map((p) => p.t + (p.reason.startsWith("cut") ? "*" : "")).join(","));
  note("plan=" + planned.length + " hashing");
  const ded = await dedupe(file, planned, opts.hamming ?? 6, opts.dedupSpan ?? 50, opts.dedupMaxGap ?? 55);
  note("hashed=" + ded.hashed + " kept=" + ded.kept.length + " hashMs=" + ded.ms);
  if (process.env.WL_DEBUG) console.error("KEPT " + ded.kept.map((p) => p.t + (p.reason.startsWith("cut") ? "*" : "")).join(","));
  const kept = ded.kept;
  const cv = coverage(kept, duration);
  const sheets = sheetsOf(kept);
  const perChunk = chunks.map((c) => ({
    idx: c.idx, min: +((c.b - c.a) / 60).toFixed(1), dens: +c.mean.toFixed(3),
    frames: kept.filter((f) => f.chunk === c.idx).length,
    fpm: +(kept.filter((f) => f.chunk === c.idx).length / ((c.b - c.a) / 60)).toFixed(1),
  }));
  // 窗口级相关性：帧数 vs 密度（块级在短片只有 2 个块，样本不够）
  const winFrames = wins.map((w) => kept.filter((k) => k.t >= w.a && k.t < w.b).length);
  const sp = spearman(wins.map((w) => w.dens), winFrames);
  // 基线口径 = 现技能做法：每 15 秒一帧、每帧整图送模型、559 token/帧（1280×720 实测）。
  // 这是我们所有「省了 N 倍」的分母。改它等于改结论，改前回看 §1.3 的实测表。
  const baselineFrames = Math.ceil(duration / 15);
  return {
    bvid, duration: +duration.toFixed(1), title: readTitle(dir),
    danmaku: dan.total, srtEntries: srt.length, cuts: tl.seconds.reduce((s, x) => s + x.cut, 0),
    maxScd: +Math.max(0, ...tl.seconds.map((s) => s.scd)).toFixed(1),
    cutAt: tl.seconds.filter((s) => s.cut).map((s) => s.t),
    cut8: tl.seconds.filter((s) => s.scd >= 8).length,
    probeMs: tl.ms, hashMs: ded.ms,
    planned: planned.length, hashed: ded.hashed, kept: kept.length, sheets,
    tokens: sheets * 346, cov: +(cv.cov * 100).toFixed(1), maxGap: +cv.maxGap.toFixed(1),
    chunks: chunks.length, spearman: +sp.toFixed(2),
    baselineFrames, baselineTokens: baselineFrames * 559,
    perChunk,
  };
}
function readTitle(dir) {
  try { const j = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")); return j.title || ""; } catch { return ""; }
}

// ---------- 8. CLI ----------
const [, , cmd, arg, ...rest] = process.argv;
function optOf(name, def) { const i = rest.indexOf("--" + name); return i >= 0 ? Number(rest[i + 1]) : def; }

if (cmd === "run") {
  const videos = arg === "all" ? ["BV1JRsw66E1s", "BV1kYsW6NE6E", "BV1p4WB6kEiK", "BV1zCWk67EkN", "BV11CWD6EEjf", "BV183Wm6CEiF"] : [arg];
  const out = [];
  for (const bv of videos) {
    const r = await analyse(bv, { hamming: optOf("hamming", 6), chunkMaxSec: optOf("chunk", 480), danmakuWeight: optOf("danmaku", 0.15), danmaku: rest.includes("--no-danmaku") ? false : true });
    out.push(r);
    console.log(JSON.stringify(r));
  }
  fs.writeFileSync(path.join(DATA, "run-" + Date.now() + ".json"), JSON.stringify(out, null, 1));
  console.log("## TABLE");
  console.log("bv\tmin\tplan\tkept\tsheets\ttok\tcov%\tgap\trho\tmaxScd\tcut8\tprobe_ms\thash_ms\tbase_tok");
  for (const r of out) console.log([r.bvid, r.duration / 60, r.planned, r.kept, r.sheets, r.tokens, r.cov, r.maxGap, r.spearman, r.maxScd, r.cut8, r.probeMs, r.hashMs, r.baselineTokens].join("\t"));
// sweep：六个变体跑同一支视频，看哪个旋钮真的改成本。
// 实测结论（三支素材）：弹幕权重 0/0.15/0.30 对 token 零影响（五分位档位量化所致）；
// hamming 是唯一明显改成本的参数（4→10 在短剧上 −18%）；chunk 只影响图版拼法。
} else if (cmd === "sweep") {
  const variants = [
    { label: "base", danmakuWeight: 0.15, hamming: 6, chunkMaxSec: 480 },
    { label: "no-danmaku", danmakuWeight: 0, hamming: 6, chunkMaxSec: 480 },
    { label: "danmaku-0.30", danmakuWeight: 0.30, hamming: 6, chunkMaxSec: 480 },
    { label: "hamming-4", danmakuWeight: 0.15, hamming: 4, chunkMaxSec: 480 },
    { label: "hamming-10", danmakuWeight: 0.15, hamming: 10, chunkMaxSec: 480 },
    { label: "chunk-300", danmakuWeight: 0.15, hamming: 6, chunkMaxSec: 300 },
  ];
  for (const v of variants) {
    const r = await analyse(arg, { danmakuWeight: v.danmakuWeight, hamming: v.hamming, chunkMaxSec: v.chunkMaxSec });
    console.log([v.label, r.planned, r.kept, r.sheets, r.tokens, r.cov, r.maxGap, r.chunks, r.spearman, r.hashMs].join("\t"));
  }
} else {
  console.log("usage: node watchlab.mjs run <BV|all> [--hamming 6] [--chunk 480] [--danmaku 0.15] [--no-danmaku]");
  console.log("       node watchlab.mjs sweep <BV>");
}
