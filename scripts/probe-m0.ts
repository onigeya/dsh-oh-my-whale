#!/usr/bin/env node
/**
 * M0 探针：把架构 Open Questions 里两件"必须实测"的事变成可复跑的命令。
 *
 *   node scripts/probe-m0.ts --seq        # OQ2  压缩后旧 seq 是否仍可达
 *   node scripts/probe-m0.ts --dim        # OQ1  bge-m3 的真实向量维度
 *   node scripts/probe-m0.ts --all        # 两条都跑
 *
 * 选项
 *   --log <path>      指定会话日志（默认自动挑 ~/.dsh/sessions 下最新的 *.jsonl.zstd）
 *   --session-id <id> 只报这一个会话
 *   --json            机器可读输出
 *
 * 退出码
 *   0 全部探针得出确定结论
 *   2 有探针因缺少前置条件（如 API key）而未能执行 —— 这不是失败，是"还没测"
 *   1 探针自身出错
 *
 * 设计约束：零依赖。Node 24 原生跑 .ts、原生 zstd 解压、原生 fetch。
 * 探针只读，不写库、不改配置、不动会话日志。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

// ─── 文档当前的主张（探针要校验的就是它） ────────────────────────────────
// 骨架 OQ2 原文写的是 listEvents({surface:['log-only','shadowed']})。
// 探针会把它和实际 .d.ts 签名对照，不一致就报 MISMATCH。
const DOC_CLAIM = "listEvents({surface:['log-only','shadowed']})";

type Args = {
  seq: boolean; dim: boolean; json: boolean;
  log?: string; sessionId?: string;
};

function parseArgs(argv: string[]): Args {
  const a: Args = { seq: false, dim: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--seq') a.seq = true;
    else if (v === '--dim') a.dim = true;
    else if (v === '--all') { a.seq = true; a.dim = true; }
    else if (v === '--json') a.json = true;
    else if (v === '--log') a.log = argv[++i];
    else if (v === '--session-id') a.sessionId = argv[++i];
    else if (v === '--help' || v === '-h') { printHelp(); process.exit(0); }
    else { console.error('未知参数: ' + v); printHelp(); process.exit(1); }
  }
  if (!a.seq && !a.dim) { a.seq = true; a.dim = true; }
  return a;
}

function printHelp() {
  console.log([
    'M0 探针',
    '  --seq            压缩后旧 seq 可达性（架构 OQ2）',
    '  --dim            bge-m3 向量维度（架构 OQ1）',
    '  --all            两条都跑（默认）',
    '  --log <path>     指定会话日志',
    '  --session-id <id> 只看这一个会话',
    '  --json           机器可读输出',
  ].join('\n'));
}

// ─── 定位 DSH 安装（探针要读它真实的类型声明） ──────────────────────────
function dshCandidateRoots(): string[] {
  const out: string[] = [];
  const env = process.env.DSH_CHECKOUT;
  if (env) out.push(env);
  const appData = process.env.APPDATA;
  if (appData) out.push(join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
  out.push(join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
  out.push('/usr/local/lib/node_modules/@deepseek-ai/dsh');
  out.push('/usr/lib/node_modules/@deepseek-ai/dsh');
  return out;
}

function findSessionQueryPackage(): { root: string; dts: string; impl: string } | null {
  for (const base of dshCandidateRoots()) {
    const root = join(base, 'node_modules', '@deepseek-ai', 'dsh-session-query');
    const dts = join(root, 'lib', 'types', 'index.d.ts');
    const impl = join(root, 'lib', 'index.js');
    if (existsSync(dts) && existsSync(impl)) return { root, dts, impl };
  }
  return null;
}

// ─── 探针一：契约校验（文档主张 vs 实际签名） ────────────────────────────
function checkContract(pkg: { root: string; dts: string }) {
  const dts = readFileSync(pkg.dts, 'utf8');
  const typesPath = join(pkg.root, 'lib', 'types', 'types.d.ts');
  const types = existsSync(typesPath) ? readFileSync(typesPath, 'utf8') : '';

  const listMatch = dts.match(/listEvents\(([^)]*)\)\s*:\s*Promise<([^>]+)>/);
  const readMatch = dts.match(/readEvent\(([^)]*)\)\s*:\s*Promise<([^>]+)>/);
  const surfaceField = /surface:\s*SessionEventSurface/.test(types);

  const actualList = listMatch ? 'listEvents(' + listMatch[1].trim() + ')' : '(未找到 listEvents)';
  const actualRead = readMatch ? 'readEvent(' + readMatch[1].trim() + ')' : '(未找到 readEvent)';

  // 文档主张带对象参数 {surface:[...]}；实际若首参是 sessionId，就是形状不符。
  const claimUsesFilterArg = /\{/.test(DOC_CLAIM);
  const actualUsesFilterArg = listMatch ? /\{/.test(listMatch[1]) : false;
  const mismatch = claimUsesFilterArg !== actualUsesFilterArg;

  return {
    docClaim: DOC_CLAIM,
    actualList,
    actualRead,
    surfaceIsRecordField: surfaceField,
    verdict: mismatch ? 'MISMATCH' : 'MATCH',
    note: mismatch
      ? 'surface 不是 listEvents 的筛选参数，而是 SessionEventRecord 上的字段；调用方要自己按 surface 分组过滤。'
      : '文档主张与实际签名一致。',
  };
}

// ─── 探针二：真实会话日志里的 surface 分布 ──────────────────────────────
function newestSessionLogs(limit: number): string[] {
  const roots = [process.env.DSH_HOME || join(homedir(), '.dsh')].map(p => join(p, 'sessions')).filter(p => existsSync(p));
  const found: { path: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (name.endsWith('.jsonl.zstd')) found.push({ path: p, mtime: st.mtimeMs });
    }
  };
  for (const r of roots) walk(r, 0);
  found.sort((a, b) => b.mtime - a.mtime);
  return found.slice(0, limit).map(f => f.path);
}

// DSH 的会话日志是"追加式多帧 zstd"：每次写入一个独立帧，一个文件里有上百个帧。
// zstdDecompressSync 只解第一帧（会静默丢掉其余全部内容），所以必须按魔数切帧逐个解。
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function decodeZstdFrames(buf: Buffer): string {
  const offsets: number[] = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] &&
        buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) offsets.push(i);
  }
  if (offsets.length === 0) return zstdDecompressSync(buf).toString('utf8');
  const parts: string[] = [];
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try { parts.push(zstdDecompressSync(buf.subarray(start, end)).toString('utf8')); }
    catch { /* 单个坏帧不影响其余帧 */ }
  }
  return parts.join('');
}

type ParsedLog = { header: any | null; events: any[]; frames: number; badLines: number };

function parseLogEvents(path: string): ParsedLog {
  const buf = readFileSync(path);
  const text = path.endsWith('.zstd') ? decodeZstdFrames(buf) : buf.toString('utf8');
  let frames = 0;
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] &&
        buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) frames++;
  }
  let header: any | null = null;
  const events: any[] = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj: any;
    try { obj = JSON.parse(t); } catch { badLines++; continue; }
    // 首行是会话头（没有 seq），其余每行才是一个事件。
    if (typeof obj?.seq === 'number') events.push(obj);
    else if (obj?.type === 'session' && header === null) header = obj;
  }
  return { header, events, frames, badLines };
}

async function probeSeq(opts: Args) {
  const pkg = findSessionQueryPackage();
  const contract = pkg ? checkContract(pkg) : null;

  const logs = opts.log ? [resolve(opts.log)] : newestSessionLogs(3);
  const sessions: any[] = [];

  for (const logPath of logs) {
    if (!existsSync(logPath)) {
      sessions.push({ log: logPath, error: '文件不存在' });
      continue;
    }
    let parsed: ParsedLog;
    try { parsed = parseLogEvents(logPath); }
    catch (e) { sessions.push({ log: logPath, error: '解析失败: ' + (e as Error).message }); continue; }
    const events = parsed.events;

    const sessionId = opts.sessionId || /session-([0-9a-f-]{16,})/i.exec(logPath)?.[1] || dirname(logPath).split(/[\\/]/).pop() || 'unknown';
    const byType: Record<string, number> = {};
    for (const ev of events) {
      const t = String(ev?.type ?? ev?.kind ?? 'unknown');
      byType[t] = (byType[t] ?? 0) + 1;
    }

    // 用宿主的纯函数做 surface 折叠，得到与宿主一致的判定。
    let surfaceDist: Record<string, number> | null = null;
    let foldError: string | null = null;
    if (pkg) {
      try {
        const mod: any = await import(pathToFileURL(pkg.impl).href);
        const build = mod.buildSessionEventRecords;
        if (typeof build === 'function') {
          const records = build(sessionId, events);
          surfaceDist = {};
          for (const r of records) surfaceDist[r.surface] = (surfaceDist[r.surface] ?? 0) + 1;
        } else {
          foldError = 'buildSessionEventRecords 未导出';
        }
      } catch (e) {
        foldError = (e as Error).message.slice(0, 300);
      }
    }

    // 可达性的判据：被折叠（shadowed）或已退出模型面的（log-only）seq，是否仍存在于原始日志中。
    const seqs = events.map((e: any) => e?.seq).filter((s: any) => typeof s === 'number') as number[];
    const minSeq = seqs.length ? Math.min(...seqs) : null;
    const maxSeq = seqs.length ? Math.max(...seqs) : null;
    let gaps = 0;
    if (minSeq !== null && maxSeq !== null) {
      const set = new Set(seqs);
      for (let s = minSeq; s <= maxSeq; s++) if (!set.has(s)) gaps++;
    }

    sessions.push({
      log: logPath,
      sessionId,
      bytes: statSync(logPath).size,
      headerSeqless: parsed.header !== null,
      zstdFrames: parsed.frames,
      badLines: parsed.badLines,
      eventCount: events.length,
      seqRange: [minSeq, maxSeq],
      missingSeqs: gaps,
      byType,
      surfaceDist,
      foldError,
      rawStillHoldsCompacted:
        surfaceDist && (surfaceDist['shadowed'] || surfaceDist['log-only'])
          ? '是 —— 原始日志里仍有非 current 面的记录，readEvent 可回读'
          : '未观察到（本会话没发生过折叠，或日志只留 current 面）',
    });
  }

  return { probe: 'seq', contract, sessions };
}

// ─── 探针三：bge-m3 维度 ────────────────────────────────────────────────
function readDotEnvKey(name: string): string | undefined {
  const env = process.env[name];
  if (env) return env;
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  for (const f of [join(home, '.env'), join(homedir(), '.dsh', '.env')]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, '');
    }
  }
  return undefined;
}

async function probeDim() {
  const model = process.env.OMW_EMBED_MODEL || 'BAAI/bge-m3';
  const key = readDotEnvKey('SILICONFLOW_API_KEY');
  if (!key) {
    return {
      probe: 'dim', model, status: 'SKIPPED',
      reason: '找不到 SILICONFLOW_API_KEY（环境变量与 ~/.dsh/.env 都没有）。维度未实测，建库前必须补。',
    };
  }
  const started = Date.now();
  try {
    const res = await fetch('https://api.siliconflow.cn/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, input: 'M0 维度探针：这句话只用来数向量长度。' }),
    });
    const text = await res.text();
    if (!res.ok) return { probe: 'dim', model, status: 'ERROR', httpStatus: res.status, body: text.slice(0, 400) };
    const json: any = JSON.parse(text);
    const vec = json?.data?.[0]?.embedding;
    return {
      probe: 'dim', model, status: 'OK',
      dim: Array.isArray(vec) ? vec.length : null,
      latencyMs: Date.now() - started,
      usage: json?.usage ?? null,
    };
  } catch (e) {
    return { probe: 'dim', model, status: 'ERROR', reason: (e as Error).message.slice(0, 300) };
  }
}

// ─── 输出 ──────────────────────────────────────────────────────────────
function render(report: any, json: boolean) {
  if (json) { console.log(JSON.stringify(report, null, 2)); return; }

  const line = (s = '') => console.log(s);
  line('M0 探针 · ' + new Date().toISOString());
  line('');

  if (report.seq) {
    const c = report.seq.contract;
    line('── OQ2 压缩后旧 seq 可达性 ──');
    if (!c) {
      line('  契约校验：跳过（找不到 @deepseek-ai/dsh-session-query）');
    } else {
      line('  文档主张：' + c.docClaim);
      line('  实际签名：' + c.actualList);
      line('            ' + c.actualRead);
      line('  surface 是记录字段：' + (c.surfaceIsRecordField ? '是' : '否'));
      line('  结论：' + c.verdict + ' — ' + c.note);
    }
    line('');
    for (const s of report.seq.sessions) {
      if (s.error) { line('  日志 ' + s.log + ' → ' + s.error); continue; }
      line('  日志 ' + s.log);
      line('    会话 ' + s.sessionId + ' · ' + (s.bytes / 1024).toFixed(1) + ' KB · ' + s.zstdFrames + ' 帧 · ' + s.eventCount + ' 事件 · seq ' + s.seqRange[0] + '–' + s.seqRange[1] + ' · 缺号 ' + s.missingSeqs + (s.badLines ? ' · 坏行 ' + s.badLines : ''));
      line('    类型分布 ' + Object.entries(s.byType).map(([k, v]) => k + '=' + v).join(' '));
      if (s.surfaceDist) line('    surface 分布 ' + Object.entries(s.surfaceDist).map(([k, v]) => k + '=' + v).join(' ') + '  ← 宿主折叠结果');
      if (s.foldError) line('    折叠失败 ' + s.foldError);
      line('    原始日志是否仍持有非 current 面记录：' + s.rawStillHoldsCompacted);
    }
    line('');
  }

  if (report.dim) {
    const d = report.dim;
    line('── OQ1 bge-m3 向量维度 ──');
    line('  模型 ' + d.model);
    if (d.status === 'OK') line('  维度 ' + d.dim + '（' + d.latencyMs + 'ms）');
    else if (d.status === 'SKIPPED') line('  未执行：' + d.reason);
    else line('  失败：HTTP ' + (d.httpStatus ?? '-') + ' ' + (d.reason || d.body || ''));
    line('');
  }
}

// ─── main ──────────────────────────────────────────────────────────────
(async () => {
  const opts = parseArgs(process.argv.slice(2));
  const report: any = {};
  let skipped = false;

  if (opts.seq) report.seq = await probeSeq(opts);
  if (opts.dim) {
    report.dim = await probeDim();
    if (report.dim.status === 'SKIPPED') skipped = true;
  }

  render(report, opts.json);
  process.exit(skipped ? 2 : 0);
})().catch(err => {
  console.error('探针自身出错：', err);
  process.exit(1);
});
