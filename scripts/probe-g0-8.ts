#!/usr/bin/env node
/**
 * G0-8 探针：把骨架里「两个模型 id 可用 + token 用量可读 + 核验模型必须判掉证据缺失产物」
 * 这条判据变成可复跑的命令。
 *
 *   node scripts/probe-g0-8.ts --discover   # 只列 SiliconFlow 目录里与两个模型相关的 id
 *   node scripts/probe-g0-8.ts --all        # 全跑（默认）
 *
 * 四条判定
 *   J1 提炼模型（骨架写 Qwen3.5-4B）可调用，HTTP 200，返回里 usage 可读（total>0）
 *   J2 核验模型（骨架写 DeepSeek-R1-0528-Qwen3-8B）同上
 *   J3 核验模型对「完整证据」的产物判 pass —— 假阳性哨兵，不算闸门（判 fail 说明核验过敏）
 *   J4 核验模型对「证据被删」的产物判 fail —— 闸门本体（requirements.md:86）
 *   J5（参考项）证据指针还在、引文被伪造的产物是否判 fail —— 记录，不计闸门
 *
 * 选项
 *   --discover            只做目录发现
 *   --json                机器可读输出
 *   --out <path>          把 JSON 报告写到文件
 *   --timeout <ms>        单次请求超时，默认 180000（R1 会思考）
 *   --max-tokens <n>      提炼段 max_tokens，默认 900；核验段自动 x2
 *
 * 退出码
 *   0 闸门通过（J1 J2 J4 全绿）
 *   2 缺前置条件（无 SILICONFLOW_API_KEY）—— 不是失败，是"还没测"
 *   4 实测判定为不通过（模型不可用 / usage 不可读 / 核验没判掉坏产物）
 *   1 探针自身出错
 *
 * 设计约束：零依赖，Node 24 直跑 .ts，原生 fetch。探针只读，不写库、不改配置。
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

const API = 'https://api.siliconflow.cn/v1';

// 骨架 Stack 表里写的名字（ARCHITECTURE-SPINE.md:290-291），G0-8 要落地的就是它
// 默认按 G0-8 的实测结论取模型：原定 `Qwen3.5-4B` 三次探测全无响应（2026-11-23），
// 按闸门预案换同族 `Qwen/Qwen3.5-9B`；想复现 4B 的失败用 `--extract-model Qwen/Qwen3.5-4B`。
const SPINE_EXTRACT = 'Qwen/Qwen3.5-9B';
const SPINE_VERIFY = 'DeepSeek-R1-0528-Qwen3-8B';

type Args = {
  discover: boolean; ping: boolean; json: boolean; out?: string;
  timeoutMs: number; maxTokens: number;
  pingModels: string[]; extractModel?: string; verifyModel?: string; noThink: boolean;
};

function parseArgs(argv: string[]): Args {
  const a: Args = { discover: false, ping: false, json: false, timeoutMs: 180000, maxTokens: 900, pingModels: [], noThink: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--discover') a.discover = true;
    else if (v === '--ping') a.ping = true;
    else if (v === '--ping-model') a.pingModels.push(argv[++i]);
    else if (v === '--no-think') a.noThink = true;
    else if (v === '--extract-model') a.extractModel = argv[++i];
    else if (v === '--verify-model') a.verifyModel = argv[++i];
    else if (v === '--all') { /* 默认就是全跑 */ }
    else if (v === '--json') a.json = true;
    else if (v === '--out') a.out = argv[++i];
    else if (v === '--timeout') a.timeoutMs = Number(argv[++i]);
    else if (v === '--max-tokens') a.maxTokens = Number(argv[++i]);
    else if (v === '--help' || v === '-h') { printHelp(); process.exit(0); }
    else { console.error('未知参数: ' + v); printHelp(); process.exit(1); }
  }
  return a;
}

function printHelp() {
  console.log([
    'G0-8 探针',
    '  --discover        只列目录里与两个模型相关的 id',
    '  --ping            只用一句短话各打一发，量延迟（不含 JSON 模式）',
    '  --ping-model <id> 只 ping 这个模型 id（可重复）',
    '  --no-think        关掉思考（先试 enable_thinking:false，不被接受再试 chat_template_kwargs）',
    '  --extract-model <id>  覆盖提炼模型 id',
    '  --verify-model <id>   覆盖核验模型 id',
    '  --all             全跑（默认）',
    '  --json            机器可读输出',
    '  --out <path>      写 JSON 报告到文件',
    '  --timeout <ms>    单次请求超时（默认 180000）',
    '  --max-tokens <n>  提炼段 max_tokens（默认 900）',
  ].join('\n'));
}

// ─── 密钥：与 probe-m0.ts 同口径（env 优先，其次 ~/.dsh/.env） ────────────
function readDotEnvKey(name: string): string | undefined {
  const env = process.env[name];
  if (env) return env;
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  for (const f of [join(home, '.env'), join(homedir(), '.dsh', '.env')]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  return undefined;
}

// ─── 目录发现：短名可能缺 org 前缀，先把真实 id 找出来 ────────────────────
function ownerGuesses(short: string): string[] {
  const l = short.toLowerCase();
  if (l.startsWith('deepseek')) return ['deepseek-ai'];
  if (l.startsWith('qwen')) return ['Qwen'];
  if (l.startsWith('baai')) return ['BAAI'];
  return [];
}

function candidates(short: string): string[] {
  const envKey = 'OMW_' + short.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const out: string[] = [];
  const override = process.env[envKey];
  if (override) out.push(override);
  for (const o of ownerGuesses(short)) out.push(o + '/' + short);
  out.push(short);
  return Array.from(new Set(out));
}

type Catalog = { ok: boolean; status: number; ids: string[]; error?: string; bodySnippet?: string };

async function fetchCatalog(key: string, timeoutMs: number): Promise<Catalog> {
  const urls = [API + '/models?sub_type=chat', API + '/models'];
  let last: Catalog = { ok: false, status: 0, ids: [], error: '未发起请求' };
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { authorization: 'Bearer ' + key },
        signal: AbortSignal.timeout(Math.min(timeoutMs, 30000)),
      });
      const text = await res.text();
      if (!res.ok) { last = { ok: false, status: res.status, ids: [], bodySnippet: text.slice(0, 300) }; continue; }
      const json: any = JSON.parse(text);
      const ids: string[] = Array.isArray(json?.data)
        ? json.data.map((m: any) => String(m?.id ?? '')).filter(Boolean)
        : [];
      if (ids.length === 0) { last = { ok: false, status: res.status, ids: [], error: '目录为空' }; continue; }
      return { ok: true, status: res.status, ids };
    } catch (e) {
      last = { ok: false, status: 0, ids: [], error: (e as Error).message.slice(0, 200) };
    }
  }
  return last;
}

type Resolution = {
  short: string; id: string; how: string; inCatalog: boolean; nearMisses: string[];
};

function resolveModel(short: string, cat: Catalog): Resolution {
  const norm = (s: string) => s.toLowerCase();
  const wanted = norm(short);
  const tail = (id: string) => norm(id.split('/').pop() || id);
  const near = (id: string) => {
    const t = tail(id);
    return t.includes(wanted) || wanted.includes(t) ||
      (norm(id).includes('qwen3.5') && wanted.includes('qwen3.5')) ||
      (norm(id).includes('deepseek-r1') && wanted.includes('deepseek-r1'));
  };

  if (cat.ok) {
    const exact = cat.ids.find(id => norm(id) === wanted);
    if (exact) return { short, id: exact, how: '目录精确匹配', inCatalog: true, nearMisses: [] };
    for (const c of candidates(short)) {
      const hit = cat.ids.find(id => norm(id) === norm(c));
      if (hit) return { short, id: hit, how: '目录匹配候选 ' + c, inCatalog: true, nearMisses: [] };
    }
    const nearMisses = cat.ids.filter(near).slice(0, 12);
    return {
      short,
      id: candidates(short)[0],
      how: nearMisses.length ? '目录里没有同名 id，按最近族名尝试' : '目录里无可疑近邻，直接尝试',
      inCatalog: false,
      nearMisses,
    };
  }
  return { short, id: candidates(short)[0], how: '目录不可用，直接尝试（前缀猜测）', inCatalog: false, nearMisses: [] };
}

// ─── chat completions ───────────────────────────────────────────────────
type Usage = { prompt?: number; completion?: number; total?: number; raw: any };

type ChatResult = {
  ok: boolean; httpStatus: number; latencyMs: number;
  content: string; reasoning: string; finishReason: string | null;
  usage: Usage | null; error?: string; bodySnippet?: string;
};

const PROGRESS = process.env.PROBE_PROGRESS || '';
function stage(msg: string) {
  if (!PROGRESS) return;
  try { appendFileSync(PROGRESS, new Date().toISOString().slice(11, 19) + ' ' + msg + '\n'); } catch { /* 诊断通道，失败不打断判据 */ }
}

async function chat(opts: {
  key: string; model: string; messages: any[]; maxTokens: number;
  timeoutMs: number; temperature: number; jsonMode?: boolean; noThink?: boolean;
}): Promise<ChatResult> {
  const started = Date.now();
  const attempt = async (withJsonMode: boolean, thinkMode: 'on' | 'off-flat' | 'off-kwargs' = 'on'): Promise<ChatResult> => {
    const body: any = {
      model: opts.model,
      messages: opts.messages,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      stream: false,
    };
    if (withJsonMode) body.response_format = { type: 'json_object' };
    if (thinkMode === 'off-flat') body.enable_thinking = false;
    if (thinkMode === 'off-kwargs') body.chat_template_kwargs = { enable_thinking: false };
    stage('→ ' + opts.model + ' think=' + thinkMode + ' max_tokens=' + opts.maxTokens + ' timeout=' + opts.timeoutMs);
    try {
      // 硬超时兜底：AbortSignal 偶尔拉不住连接池排队或 body 读阻塞，再用 race 压一层
      const killer = new Promise<never>((_, rej) => {
        const t = setTimeout(() => rej(new Error('请求超时 ' + opts.timeoutMs + 'ms')), opts.timeoutMs + 3000);
        if (typeof (t as any).unref === 'function') (t as any).unref();
      });
      const res = await Promise.race([
        fetch(API + '/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + opts.key },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs),
        }),
        killer,
      ]);
      const text = await Promise.race([res.text(), killer]);
      const latencyMs = Date.now() - started;
      stage('← ' + opts.model + ' ' + res.status + ' ' + latencyMs + 'ms ' + text.length + 'B');
      if (!res.ok) {
        return {
          ok: false, httpStatus: res.status, latencyMs, content: '', reasoning: '',
          finishReason: null, usage: null, bodySnippet: text.slice(0, 500),
        };
      }
      let json: any;
      try { json = JSON.parse(text); }
      catch (e) {
        return {
          ok: false, httpStatus: res.status, latencyMs, content: '', reasoning: '',
          finishReason: null, usage: null, error: '响应不是 JSON: ' + (e as Error).message.slice(0, 120),
        };
      }
      const choice = json?.choices?.[0];
      const msg = choice?.message ?? {};
      const u = json?.usage ?? null;
      const usage: Usage | null = u
        ? {
            prompt: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined,
            completion: typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined,
            total: typeof u.total_tokens === 'number'
              ? u.total_tokens
              : (typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number'
                  ? u.prompt_tokens + u.completion_tokens : undefined),
            raw: u,
          }
        : null;
      return {
        ok: true, httpStatus: res.status, latencyMs,
        content: typeof msg.content === 'string' ? msg.content : '',
        reasoning: typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '',
        finishReason: choice?.finish_reason ?? null,
        usage,
      };
    } catch (e) {
      const err = e as Error;
      const timeout = err.name === 'TimeoutError' || /timed? ?out|abort/i.test(err.message);
      return {
        ok: false, httpStatus: 0, latencyMs: Date.now() - started, content: '', reasoning: '',
        finishReason: null, usage: null,
        error: timeout ? '请求超时 ' + opts.timeoutMs + 'ms' : err.message.slice(0, 300),
      };
    }
  };

  const wantThinkOff = opts.noThink === true;
  const first = await attempt(opts.jsonMode !== false, wantThinkOff ? 'off-flat' : 'on');
  // 有些部署只认 chat_template_kwargs 里的开关
  if (wantThinkOff && !first.ok && first.httpStatus === 400) {
    const kw = await attempt(opts.jsonMode !== false, 'off-kwargs');
    if (kw.ok || !(first.bodySnippet || '').includes('enable_thinking')) return kw;
  }
  // 有的模型不接受 response_format，400 时去掉再打一次
  if (!first.ok && first.httpStatus === 400 && /response_format|json_object/i.test(first.bodySnippet || '')) {
    const second = await attempt(false);
    return { ...second, bodySnippet: second.bodySnippet ? '[已回退：去掉 response_format] ' + second.bodySnippet : undefined };
  }
  return first;
}

// 核验段重试：只重试网络层失败（httpStatus 0），模型给出的 verdict 一次就是一次
async function verifyChat(opts: Parameters<typeof chat>[0], tries = 2): Promise<ChatResult> {
  let c = await chat(opts);
  for (let i = 1; i < tries && !c.ok && c.httpStatus === 0; i++) {
    stage('retry verify (' + (i + 1) + '/' + tries + ') ' + (c.error ?? ''));
    c = await chat(opts);
  }
  return c;
}

// ─── JSON 抽取（模型偶尔包一层 fenced block 或带前言） ──────────────────
const FENCE = String.fromCharCode(96).repeat(3);

function extractJson(text: string): any | null {
  const tryParse = (s: string) => { try { return JSON.parse(s); } catch { return null; } };
  const direct = tryParse(text.trim());
  if (direct) return direct;
  const start = text.indexOf(FENCE);
  if (start >= 0) {
    const end = text.indexOf(FENCE, start + FENCE.length);
    if (end > start) {
      const inner = text.slice(start + FENCE.length, end).replace(/^\s*json\s*/i, '').trim();
      const v = tryParse(inner);
      if (v) return v;
    }
  }
  const b = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (b >= 0 && e > b) { const v = tryParse(text.slice(b, e + 1)); if (v) return v; }
  return null;
}

// ─── 样例材料：一段小会话（seq 写死在文本里，证据指针才有可核对的对象） ──
const SESSION_ID = 'probe-g0-8';
const ANCHOR_LOG: string[] = [
  'session_id=' + SESSION_ID + '（下面每行是一个 seq；seq 号即该行前缀）',
  '[seq=101] user: 我下周三要去杭州出差三天，周报得提前，本来周五交的。',
  '[seq=104] assistant: 好，这周的周报我先按周二给你。',
  '[seq=118] user: 等一下，其实我更喜欢把周报放在周五下午，周二太赶了，别改了。',
  '[seq=131] user: 还有一件事，我不喝咖啡，别给我推荐咖啡馆。',
  '[seq=147] user: 出差那几天住西湖边就行。',
];

// 提炼段不可用时的等价产物：三条断言，引文逐字摘自上面的片段
const FIXTURE_ARTIFACT = {
  assertions: [
    {
      text: '用户把周报放在周五下午，不要再改到周二',
      kind: 'preference', subj: '用户', pred: '周报时间', obj: '周五下午',
      evidence: [{ session_id: SESSION_ID, seq_from: 118, seq_to: 118, quote: '其实我更喜欢把周报放在周五下午' }],
    },
    {
      text: '用户不喝咖啡',
      kind: 'preference', subj: '用户', pred: '饮品偏好', obj: '不喝咖啡',
      evidence: [{ session_id: SESSION_ID, seq_from: 131, seq_to: 131, quote: '我不喝咖啡' }],
    },
    {
      text: '用户下周三去杭州出差三天',
      kind: 'plan', subj: '用户', pred: '出差计划', obj: '杭州三天',
      evidence: [{ session_id: SESSION_ID, seq_from: 101, seq_to: 101, quote: '我下周三要去杭州出差三天' }],
    },
  ],
};

const EXTRACT_SYSTEM = [
  '你是一个只做「文本提炼」的组件：输入是一段带 seq 编号的会话片段，输出是结构化断言。',
  '硬规则：',
  '1. 每条断言必须带至少一条证据指针，指针只能指向输入里真实存在的 seq。',
  '2. quote 必须逐字摘自该 seq 那一行（不超过 200 字符），不得改写、不得拼接、不得编造。',
  '3. 只写输入支持得了的断言；输入里没有的，不要写。被后文推翻的旧说法不要当成现状。',
  '4. 只输出 JSON，不要解释，不要 markdown 代码块。',
].join('\n');

const EXTRACT_USER = [
  '会话片段（每行前缀是 [seq=编号] 角色: 内容）：',
  ANCHOR_LOG.join('\n'),
  '',
  '输出 JSON，形状：',
  '{"assertions":[{"text":"一句话断言","kind":"preference|fact|plan","subj":"主体","pred":"谓词","obj":"值",',
  '"evidence":[{"session_id":"' + SESSION_ID + '","seq_from":118,"seq_to":118,"quote":"逐字引文"}]}]}',
].join('\n');

const VERIFY_SYSTEM = [
  '你是固化流程的「核验」组件：给定一段会话片段与一份提炼产物，判断产物能不能提交。',
  '判 pass 必须同时满足：',
  'a) 产物至少有一条断言——零断言不是「全部合规」，是没有产出，直接判 fail；',
  'b) 每条断言都至少有一条证据指针；',
  'c) 每条指针的 session_id、seq 区间、quote 都能在给定片段里逐字核对上（引文必须是该 seq 行的原文子串）；',
  'd) 结论不与证据矛盾（被后文推翻的旧说法不能作为现状断言）。',
  '任何一条不满足就判 fail，并在 defects 里指出是哪条断言、缺什么。',
  '只输出 JSON，不要解释，不要 markdown 代码块。',
].join('\n');

function verifyUser(artifact: any): string {
  return [
    '会话片段（每行前缀是 [seq=编号] 角色: 内容）：',
    ANCHOR_LOG.join('\n'),
    '',
    '待核验的提炼产物：',
    JSON.stringify(artifact, null, 2),
    '',
    '输出 JSON，形状：',
    '{"verdict":"pass|fail","reasons":["…"],"defects":[{"type":"missing_evidence|quote_not_found|contradiction|unsupported","assertion_index":0,"detail":"…"}]}',
  ].join('\n');
}

type VerdictParse = { verdict: 'pass' | 'fail' | 'unparsed'; reasons: string[]; defects: any[]; parsed: any | null };

function parseVerdict(text: string): VerdictParse {
  const j = extractJson(text);
  if (j && typeof j.verdict === 'string') {
    const v = String(j.verdict).toLowerCase();
    const verdict: 'pass' | 'fail' | 'unparsed' = /pass|通过|ok|approve/.test(v) ? 'pass'
      : /fail|不通过|reject/.test(v) ? 'fail' : 'unparsed';
    return {
      verdict,
      reasons: Array.isArray(j.reasons) ? j.reasons.map(String) : [],
      defects: Array.isArray(j.defects) ? j.defects : [],
      parsed: j,
    };
  }
  const m = /"verdict"\s*:\s*"?(pass|fail)/i.exec(text);
  if (m) return { verdict: m[1].toLowerCase() === 'pass' ? 'pass' : 'fail', reasons: [], defects: [], parsed: null };
  if (/不通过|不予提交|证据缺失/.test(text) && !/判\s*通过/.test(text)) {
    return { verdict: 'fail', reasons: ['（未解析出 JSON，按中文关键词判定）'], defects: [], parsed: null };
  }
  return { verdict: 'unparsed', reasons: ['没能从回答里读出 verdict'], defects: [], parsed: null };
}

type Judgment = { id: string; question: string; verdict: 'PASS' | 'FAIL' | 'UNPARSED' | 'SKIPPED'; required: boolean; detail: string };

function judgeUsage(u: Usage | null): string {
  if (!u) return '返回里没有 usage';
  if (typeof u.total !== 'number' || u.total <= 0) return 'usage 里 total_tokens 不可读: ' + JSON.stringify(u.raw).slice(0, 160);
  return 'usage 可读: prompt=' + (u.prompt ?? '?') + ' completion=' + (u.completion ?? '?') + ' total=' + u.total;
}

function usageOk(u: Usage | null): boolean {
  return !!u && typeof u.total === 'number' && u.total > 0;
}

// ─── 主流程 ────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report: any = { probe: 'g0-8', at: new Date().toISOString(), api: API };

  const key = readDotEnvKey('SILICONFLOW_API_KEY');
  if (!key) {
    report.status = 'SKIPPED';
    report.reason = '找不到 SILICONFLOW_API_KEY（环境变量与 ~/.dsh/.env 都没有），G0-8 未实测';
    emit(report, opts, 2);
    return;
  }

  const cat = await fetchCatalog(key, opts.timeoutMs);
  report.catalog = {
    ok: cat.ok, status: cat.status, count: cat.ids.length,
    error: cat.error, bodySnippet: cat.bodySnippet,
    qwen35: cat.ids.filter(id => /qwen3\.5|qwen-3\.5/i.test(id)).slice(0, 20),
    deepseekR1: cat.ids.filter(id => /deepseek-r1/i.test(id)).slice(0, 20),
  };

  const ex = opts.extractModel
    ? { short: SPINE_EXTRACT, id: opts.extractModel, how: '命令行指定（--extract-model）', inCatalog: cat.ids.some(i => i.toLowerCase() === opts.extractModel!.toLowerCase()), nearMisses: [], }
    : resolveModel(SPINE_EXTRACT, cat);
  const ve = opts.verifyModel
    ? { short: SPINE_VERIFY, id: opts.verifyModel, how: '命令行指定（--verify-model）', inCatalog: cat.ids.some(i => i.toLowerCase() === opts.verifyModel!.toLowerCase()), nearMisses: [], }
    : resolveModel(SPINE_VERIFY, cat);
  report.extractModel = ex;
  report.verifyModel = ve;

  if (opts.discover) {
    report.status = 'DISCOVER';
    emit(report, opts, 0);
    return;
  }

  if (opts.ping) {
    const targets = opts.pingModels.length
      ? opts.pingModels.map(id => ({ label: 'ping', model: id }))
      : [{ label: 'extract', model: ex.id }, { label: 'verify', model: ve.id }];
    report.status = 'PING';
    report.ping = [];
    for (const t of targets) {
      const call = await chat({
        key, model: t.model, timeoutMs: Math.min(opts.timeoutMs, 60000), maxTokens: 48, temperature: 0,
        jsonMode: false, noThink: opts.noThink,
        messages: [
          { role: 'system', content: '只回答一个词。' },
          { role: 'user', content: '说「好」。' },
        ],
      });
      report.ping.push({
        label: t.label, model: t.model,
        ok: call.ok, httpStatus: call.httpStatus, latencyMs: call.latencyMs,
        usage: call.usage?.raw ?? null, usageReadable: usageOk(call.usage),
        finishReason: call.finishReason,
        content: call.content.slice(0, 200), reasoningChars: call.reasoning.length,
        error: call.error, bodySnippet: call.bodySnippet,
      });
    }
    emit(report, opts, 0);
    return;
  }

  const judgments: Judgment[] = [];
  stage('judgments start extract=' + ex.id + ' verify=' + ve.id + ' noThink=' + opts.noThink);

  // J1 提炼段
  const exCall = await chat({
    key, model: ex.id, timeoutMs: opts.timeoutMs, maxTokens: opts.maxTokens, temperature: 0.2, noThink: opts.noThink,
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user', content: EXTRACT_USER },
    ],
  });
  const exArtifact = exCall.ok ? extractJson(exCall.content) : null;
  const exAssertions: any[] = Array.isArray(exArtifact?.assertions) ? exArtifact.assertions : [];

  judgments.push({
    id: 'J1',
    question: '提炼模型可调用，且返回里能读 token 用量',
    verdict: exCall.ok && usageOk(exCall.usage) ? 'PASS' : 'FAIL',
    required: true,
    detail: [
      exCall.ok ? 'HTTP ' + exCall.httpStatus + ' · ' + exCall.latencyMs + 'ms' : 'HTTP ' + exCall.httpStatus + ' · ' + (exCall.error || exCall.bodySnippet || ''),
      judgeUsage(exCall.usage),
      exArtifact ? '产物可解析，' + exAssertions.length + ' 条断言' : '产物没能解析成 JSON（内容长度 ' + exCall.content.length + '，思考长度 ' + exCall.reasoning.length + '）',
    ].join(' | '),
  });

  report.extract = {
    model: ex.id, ok: exCall.ok, httpStatus: exCall.httpStatus, latencyMs: exCall.latencyMs,
    usage: exCall.usage?.raw ?? null, finishReason: exCall.finishReason,
    contentChars: exCall.content.length, reasoningChars: exCall.reasoning.length,
    artifact: exArtifact, error: exCall.error, bodySnippet: exCall.bodySnippet,
  };

  // 好产物 / 坏产物 / 伪造引文产物
  // 提炼段挂了也要验核验段：用人工 fixture 顶上（引文逐字来自片段），报告里标明来源。
  const usingFixture = exAssertions.length === 0;
  const goodArtifact = usingFixture ? FIXTURE_ARTIFACT : exArtifact;
  const badArtifact = JSON.parse(JSON.stringify(goodArtifact));
  const forgedArtifact = JSON.parse(JSON.stringify(goodArtifact));
  let stripped = 0;
  for (const a of badArtifact.assertions ?? []) {
    if (Array.isArray(a.evidence)) { stripped += a.evidence.length; a.evidence = []; }
  }
  let forged = 0;
  for (const a of forgedArtifact.assertions ?? []) {
    if (Array.isArray(a.evidence) && a.evidence.length) {
      a.evidence[0].quote = '我每周三上午都要开一个跨部门评审会，任何人都不能改。';
      forged++;
    }
  }
  report.artifactSource = usingFixture
    ? 'fixture（提炼段没产出可用断言，改用人工构造的等价产物）'
    : 'model（提炼模型真实产出）';
  report.cases = {
    artifactSource: report.artifactSource,
    goodAssertions: (goodArtifact.assertions ?? []).length,
    bad: '证据数组被清空（共删掉 ' + stripped + ' 条指针）',
    forged: '每条断言的第一条引文被换成片段里不存在的句子（' + forged + ' 处）',
  };

  // J2 核验段（用好产物打一发，同时当 J3 的输入）
  const veCall = await verifyChat({
    key, model: ve.id, timeoutMs: opts.timeoutMs, maxTokens: opts.maxTokens * 2, temperature: 0.1,
    messages: [
      { role: 'system', content: VERIFY_SYSTEM },
      { role: 'user', content: verifyUser(goodArtifact) },
    ],
  });
  const goodVerdict = veCall.ok
    ? parseVerdict(veCall.content)
    : { verdict: 'unparsed' as const, reasons: [], defects: [], parsed: null };

  judgments.push({
    id: 'J2',
    question: '核验模型可调用，且返回里能读 token 用量',
    verdict: veCall.ok && usageOk(veCall.usage) ? 'PASS' : 'FAIL',
    required: true,
    detail: [
      veCall.ok ? 'HTTP ' + veCall.httpStatus + ' · ' + veCall.latencyMs + 'ms' : 'HTTP ' + veCall.httpStatus + ' · ' + (veCall.error || veCall.bodySnippet || ''),
      judgeUsage(veCall.usage),
      '对完整产物判定：' + goodVerdict.verdict,
    ].join(' | '),
  });

  judgments.push({
    id: 'J3',
    question: '对证据齐全的产物判 pass（假阳性哨兵，非闸门）',
    verdict: goodVerdict.verdict === 'pass' ? 'PASS' : goodVerdict.verdict === 'fail' ? 'FAIL' : 'UNPARSED',
    required: false,
    detail: goodVerdict.verdict === 'fail'
      ? '核验过敏：' + (goodVerdict.reasons.slice(0, 3).join(' / ') || '没给理由')
      : (goodVerdict.reasons.slice(0, 2).join(' / ') || '—'),
  });

  report.verifyOnGood = {
    model: ve.id, ok: veCall.ok, httpStatus: veCall.httpStatus, latencyMs: veCall.latencyMs,
    usage: veCall.usage?.raw ?? null, finishReason: veCall.finishReason,
    verdict: goodVerdict.verdict, reasons: goodVerdict.reasons, defects: goodVerdict.defects,
    contentChars: veCall.content.length, reasoningChars: veCall.reasoning.length,
    content: veCall.content.slice(0, 1200), error: veCall.error, bodySnippet: veCall.bodySnippet,
  };

  // J4 闸门本体：证据被删必须判 fail
  const badCall = await verifyChat({
    key, model: ve.id, timeoutMs: opts.timeoutMs, maxTokens: opts.maxTokens * 2, temperature: 0.1,
    messages: [
      { role: 'system', content: VERIFY_SYSTEM },
      { role: 'user', content: verifyUser(badArtifact) },
    ],
  });
  const badVerdict = badCall.ok
    ? parseVerdict(badCall.content)
    : { verdict: 'unparsed' as const, reasons: [], defects: [], parsed: null };

  judgments.push({
    id: 'J4',
    question: '对「证据缺失」的产物必须判不通过（闸门本体，requirements.md:86）',
    verdict: badVerdict.verdict === 'fail' ? 'PASS' : badVerdict.verdict === 'pass' ? 'FAIL' : 'UNPARSED',
    required: true,
    detail: [
      badCall.ok
        ? 'HTTP ' + badCall.httpStatus + ' · ' + badCall.latencyMs + 'ms · 判定 ' + badVerdict.verdict
        : 'HTTP ' + badCall.httpStatus + ' · ' + (badCall.error || badCall.bodySnippet || ''),
      badVerdict.reasons.slice(0, 3).join(' / '),
      badVerdict.defects.length ? '指出 ' + badVerdict.defects.length + ' 处缺陷' : '',
    ].filter(Boolean).join(' | '),
  });

  report.verifyOnBad = {
    model: ve.id, ok: badCall.ok, httpStatus: badCall.httpStatus, latencyMs: badCall.latencyMs,
    usage: badCall.usage?.raw ?? null, finishReason: badCall.finishReason,
    verdict: badVerdict.verdict, reasons: badVerdict.reasons, defects: badVerdict.defects,
    contentChars: badCall.content.length, reasoningChars: badCall.reasoning.length,
    content: badCall.content.slice(0, 1200), error: badCall.error, bodySnippet: badCall.bodySnippet,
  };

  // J5 参考项：引文伪造
  if (forged > 0) {
    const forgedCall = await verifyChat({
      key, model: ve.id, timeoutMs: opts.timeoutMs, maxTokens: opts.maxTokens * 2, temperature: 0.1,
      messages: [
        { role: 'system', content: VERIFY_SYSTEM },
        { role: 'user', content: verifyUser(forgedArtifact) },
      ],
    });
    const forgedVerdict = forgedCall.ok
      ? parseVerdict(forgedCall.content)
      : { verdict: 'unparsed' as const, reasons: [], defects: [], parsed: null };
    judgments.push({
      id: 'J5',
      question: '对「引文与片段对不上」的产物判 fail（参考项，不计闸门）',
      verdict: forgedVerdict.verdict === 'fail' ? 'PASS' : forgedVerdict.verdict === 'pass' ? 'FAIL' : 'UNPARSED',
      required: false,
      detail: '判定 ' + forgedVerdict.verdict + ' · ' + forgedVerdict.reasons.slice(0, 2).join(' / '),
    });
    report.verifyOnForged = {
      model: ve.id, ok: forgedCall.ok, httpStatus: forgedCall.httpStatus, latencyMs: forgedCall.latencyMs,
      usage: forgedCall.usage?.raw ?? null, finishReason: forgedCall.finishReason,
      verdict: forgedVerdict.verdict, reasons: forgedVerdict.reasons, defects: forgedVerdict.defects,
      content: forgedCall.content.slice(0, 1200), error: forgedCall.error,
    };
  } else {
    report.verifyOnForged = { verdict: 'skipped', reason: '好产物里没有可用引文，跳过伪造用例' };
  }

  // J6 参考项：一条断言都没有的产物——零断言会让「每条都有证据」真空成立
  const emptyCall = await verifyChat({
    key, model: ve.id, timeoutMs: opts.timeoutMs, maxTokens: opts.maxTokens * 2, temperature: 0.1,
    messages: [
      { role: 'system', content: VERIFY_SYSTEM },
      { role: 'user', content: verifyUser({ assertions: [] }) },
    ],
  });
  const emptyVerdict = emptyCall.ok
    ? parseVerdict(emptyCall.content)
    : { verdict: 'unparsed' as const, reasons: [], defects: [], parsed: null };
  judgments.push({
    id: 'J6',
    question: '对「零断言」的空产物判 fail（参考项：真空也算证据缺失）',
    verdict: emptyVerdict.verdict === 'fail' ? 'PASS' : emptyVerdict.verdict === 'pass' ? 'FAIL' : 'UNPARSED',
    required: false,
    detail: '判定 ' + emptyVerdict.verdict + ' · ' + emptyVerdict.reasons.slice(0, 2).join(' / '),
  });
  report.verifyOnEmpty = {
    model: ve.id, ok: emptyCall.ok, httpStatus: emptyCall.httpStatus, latencyMs: emptyCall.latencyMs,
    usage: emptyCall.usage?.raw ?? null, verdict: emptyVerdict.verdict,
    reasons: emptyVerdict.reasons, content: emptyCall.content.slice(0, 800),
  };

  const gatePass = judgments.filter(j => j.required).every(j => j.verdict === 'PASS');
  report.judgments = judgments;
  report.status = gatePass ? 'PASS' : 'FAIL';
  report.gatePass = gatePass;

  emit(report, opts, gatePass ? 0 : 4);
}

// ─── 输出 ──────────────────────────────────────────────────────────────
function emit(report: any, opts: Args, exitCode: number) {
  if (opts.out) {
    const p = resolve(opts.out);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(exitCode);
  }

  const line = (s = '') => console.log(s);
  line('G0-8 探针 · ' + report.at);
  line('');

  if (report.status === 'SKIPPED') {
    line('未执行：' + report.reason);
    process.exit(exitCode);
  }

  const c = report.catalog;
  line('── 目录发现 ──');
  line('  目录 ' + (c.ok ? '可读，' + c.count + ' 个模型' : '不可读：HTTP ' + c.status + ' ' + (c.error || c.bodySnippet || '')));
  if (c.ok) {
    line('  Qwen3.5 族：' + (c.qwen35.length ? c.qwen35.join(', ') : '（无）'));
    line('  DeepSeek-R1 族：' + (c.deepseekR1.length ? c.deepseekR1.join(', ') : '（无）'));
  }
  line('  提炼模型 ' + report.extractModel.short + ' → ' + report.extractModel.id + '（' + report.extractModel.how + '）');
  if (report.extractModel.nearMisses?.length) line('    目录近邻：' + report.extractModel.nearMisses.join(', '));
  line('  核验模型 ' + report.verifyModel.short + ' → ' + report.verifyModel.id + '（' + report.verifyModel.how + '）');
  if (report.verifyModel.nearMisses?.length) line('    目录近邻：' + report.verifyModel.nearMisses.join(', '));
  line('');

  if (report.status === 'DISCOVER') { process.exit(exitCode); }

  if (report.status === 'PING') {
    for (const x of report.ping) {
      line((x.ok ? '[OK] ' : '[FAIL] ') + x.label + ' ' + x.model + ' · ' + (x.ok ? 'HTTP ' + x.httpStatus + ' · ' + x.latencyMs + 'ms' : (x.error || 'HTTP ' + x.httpStatus + ' ' + (x.bodySnippet || ''))));
      line('    内容=' + JSON.stringify(x.content) + ' 思考长度=' + x.reasoningChars + ' finish=' + x.finishReason);
      line('    usage 可读=' + (x.usageReadable ? '是' : '否') + ' ' + JSON.stringify(x.usage ?? null).slice(0, 220));
    }
    process.exit(exitCode);
  }

  for (const j of report.judgments) {
    const mark = j.verdict === 'PASS' ? '[OK]' : j.verdict === 'FAIL' ? '[FAIL]' : '[?]';
    line(mark + ' ' + j.id + ' ' + j.question + (j.required ? '' : '（参考项）'));
    line('    ' + j.detail);
  }
  line('');
  line('  样例：' + report.cases.artifactSource + ' · 好产物 ' + report.cases.goodAssertions + ' 条断言 · 坏产物=' + report.cases.bad + ' · 伪造=' + report.cases.forged);
  line('');
  line('结论：' + report.status + (report.status === 'PASS'
    ? ' —— 两个模型在 SiliconFlow 上可用、usage 可读、核验会判掉证据缺失的产物'
    : ' —— 见上面 [FAIL] 项，按骨架 G0-8 的「不过怎么办」处理'));
  process.exit(exitCode);
}

main().catch(err => {
  console.error('探针自身出错：', err);
  process.exit(1);
});
