/**
 * The chat-facing surface: `/omw doctor` (FR-17, Story 1.2).
 *
 * The CLI `omw doctor` diagnoses a profile from the outside and therefore has to
 * open the database — which the running host already holds under an exclusive
 * lease. Inside the host there is no such problem: this command reuses the live
 * runtime's own handle, state machine and identity registration, so the five
 * checks run against exactly the instance the user is talking to.
 *
 * A slash command is not a model-facing tool: it is registered even in `no-op`,
 * because a plugin that stepped aside is precisely when the user needs to ask
 * why. Nothing here opens a network connection or registers a tool.
 *
 * Story 2.1 adds `/omw pred promote`: the one write the *user* may perform, and
 * the only way a predicate becomes single-valued (AD-27). It goes through the
 * same write service as `remember`, so the queue, the ledger and the audit row
 * are the same ones — a promotion is not a side door.
 *
 * Story 2.2 adds `/omw evidence`: the user's own way to ask where a fact came
 * from. It reads the pointers stored with the key and reports them verbatim,
 * plus whether the host can still resolve them. It writes nothing, and it is
 * not part of recall — asking a question is not remembering an answer.
 * @module
 */
import type { Config, Paths } from './config.ts'
import type { DegradeState, OmwCode } from '../core/degrade.ts'
import { ensureDailySnapshot } from '../ops/snapshots.ts'
import type { Database } from '../store/db.ts'
import { databaseDim, nodeCount } from '../store/db.ts'
import { PERSONA_SECTION_NAME } from './prompt-composer.ts'
import type { Logger } from './logger.ts'
import type { WritePort } from './write-port.ts'
import type { EvidenceReadAnswer, EvidenceReader } from './evidence-reader.ts'
import type { LedgerAnswer, VersionHistoryAnswer, VersionReader } from './version-reader.ts'
import type { Audit } from '../ops/audit.ts'
import { parseStatsWindow, renderStats, summarizeAudit } from '../ops/stats.ts'

/** Outcome of one invocation, as the host's command registry expects it. */
export type CommandResultLike =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/** The invocation slice this command reads. */
export interface CommandInvocationLike {
  /** Exact text after the command name, separator included. */
  readonly rawInput: string
}

/** One command definition, as the registry accepts it. */
export interface CommandDefinitionLike {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
  readonly handler: (invocation: CommandInvocationLike) => CommandResultLike | Promise<CommandResultLike>
}

/** The slice of `ctx.commands` this module needs. */
export interface CommandRegistryLike {
  register(definition: CommandDefinitionLike): () => void
}

/** Everything the in-process doctor reads from the live instance. */
export interface DoctorView {
  /** Current degradation state. */
  readonly state: DegradeState
  /** First failure behind a non-ok state. */
  readonly code?: OmwCode
  readonly config: Config
  readonly paths: Paths
  /** Live handle; absent in `no-op`. */
  readonly db?: Database
  readonly logger: Logger
  /** Whether the identity section is currently registered. */
  readonly sectionRegistered: boolean
  /** Identity text length, in characters. */
  readonly sectionChars: number
  readonly tools: readonly string[]
  readonly now?: () => Date
  readonly env?: Record<string, string | undefined>
}

/** One rendered check. */
export interface DoctorLine {
  readonly id: 'db' | 'snapshot' | 'dim' | 'credential' | 'section'
  readonly label: string
  readonly status: 'pass' | 'fail' | 'skip'
  readonly code?: string
  readonly detail: string
}

/** Rendered report: fixed-order lines plus the one-line summary. */
export interface DoctorReport {
  readonly lines: readonly DoctorLine[]
  readonly failures: number
  readonly text: string
}

/**
 * Render one check as a single terminal line.
 *
 * The denominator is the number of checks this run actually produced, not a
 * literal. Today that is five, but another install site adds its own check
 * without touching this file, and a hard-coded denominator would then report a
 * full pass for a run that printed more.
 * @param line - the check.
 * @param index - its 1-based position.
 * @param total - how many checks this run produced.
 * @returns the rendered line.
 */
function render(line: DoctorLine, index: number, total: number): string {
  const mark = line.status === 'pass' ? 'pass' : line.status === 'fail' ? 'FAIL' : 'skip'
  const code = line.code === undefined ? '' : ` [${line.code}]`
  return `${index}/${total} ${line.id.padEnd(10, ' ')} ${mark} ${line.detail}${code}`
}

/**
 * Run the five checks against the live instance.
 *
 * Order is the contract: database, snapshot, dimension, credential, identity
 * section. A check never mutates the store: the snapshot check reuses the live
 * handle, and pruning is disabled so a diagnosis cannot delete anything.
 * @param view - live instance facts.
 * @returns the ordered lines, the failure count and the text to show.
 */
export function inspectInProcess(view: DoctorView): DoctorReport {
  const now = view.now ?? (() => new Date())
  const env = view.env ?? process.env
  const lines: DoctorLine[] = []
  let db = view.db

  // 1/5 — the database is usable by this very instance.
  if (db === undefined) {
    lines.push({
      id: 'db',
      label: '库能开',
      status: 'fail',
      ...(view.code === undefined ? {} : { code: view.code }),
      detail: view.code === undefined ? '本实例没有可用的库句柄' : `本实例已整体退场：${view.code}`,
    })
  } else {
    let dim = -1
    let nodes = -1
    try {
      dim = databaseDim(db)
      nodes = nodeCount(db)
    } catch {
      dim = -1
    }
    lines.push({
      id: 'db',
      label: '库能开',
      status: 'pass',
      detail: `${view.paths.dbFile}（dim=${dim}，节点 ${nodes}）`,
    })
  }

  // 2/5 — today's snapshot verifies. Reuses the live handle; never prunes.
  if (db === undefined) {
    lines.push({ id: 'snapshot', label: '快照校验过', status: 'skip', detail: '依赖第 1 项，未执行' })
  } else {
    try {
      const ensured = ensureDailySnapshot({
        db,
        snapshotsDir: view.paths.snapshotsDir,
        keep: Number.MAX_SAFE_INTEGER,
        now,
      })
      lines.push(
        ensured.ok
          ? {
            id: 'snapshot',
            label: '快照校验过',
            status: 'pass',
            detail: ensured.created ? `已补做并校验：${ensured.path}` : `今日快照已校验：${ensured.path}`,
          }
          : {
            id: 'snapshot',
            label: '快照校验过',
            status: 'fail',
            code: 'OMW_SNAPSHOT_VERIFY',
            detail: `校验失败：${ensured.reason}`,
          },
      )
    } catch (error) {
      lines.push({
        id: 'snapshot',
        label: '快照校验过',
        status: 'fail',
        code: 'OMW_SNAPSHOT_VERIFY',
        detail: `校验失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  // 3/5 — configured dimension matches the live handle.
  if (db === undefined) {
    lines.push({ id: 'dim', label: '维度匹配', status: 'skip', detail: '依赖第 1 项，未执行' })
  } else {
    let actual: number | null = null
    try {
      actual = databaseDim(db)
    } catch {
      actual = null
    }
    lines.push(
      actual === view.config.db.dim
        ? { id: 'dim', label: '维度匹配', status: 'pass', detail: `db.dim=${view.config.db.dim} 与库一致` }
        : {
          id: 'dim',
          label: '维度匹配',
          status: 'fail',
          code: 'OMW_DIM_MISMATCH',
          detail: `db.dim=${view.config.db.dim}，库=${actual === null ? '未知' : actual}`,
        },
    )
  }

  // 4/5 — the credential's environment variable is present. No network, ever.
  const envName = view.config.embedding.apiKeyEnv
  const credential = env[envName]
  lines.push(
    typeof credential === 'string' && credential.trim() !== ''
      ? { id: 'credential', label: '凭据可用', status: 'pass', detail: `环境变量 ${envName} 已设置` }
      : {
        id: 'credential',
        label: '凭据可用',
        status: 'fail',
        code: 'OMW_EMBED_AUTH',
        detail: `环境变量 ${envName} 未设置（向量路径将关闭；值不会出现在任何输出中）`,
      },
  )

  // 5/5 — this instance registered the identity section.
  lines.push(
    view.sectionRegistered && view.sectionChars > 0
      ? {
        id: 'section',
        label: '注入段已注册',
        status: 'pass',
        detail: `已注册 ${PERSONA_SECTION_NAME}（${view.sectionChars} 字符，${view.tools.length} 个工具）`,
      }
      : {
        id: 'section',
        label: '注入段已注册',
        status: 'fail',
        code: 'OMW_SECTION_NOT_REGISTERED',
        detail: `未注册 ${PERSONA_SECTION_NAME}`,
      },
  )

  const passed = lines.filter(line => line.status === 'pass').length
  const skipped = lines.filter(line => line.status === 'skip').length
  const failures = lines.filter(line => line.status === 'fail').length
  const firstFailure = lines.find(line => line.status === 'fail')
  const summary = failures === 0
    ? `omw doctor: ${passed}/${lines.length} 通过${skipped === 0 ? '' : `、${skipped} 跳过（库不可用）`}`
    : `omw doctor: ${passed}/${lines.length} 通过、${failures} 失败；首个失败 ${firstFailure?.code ?? firstFailure?.id ?? 'unknown'}`
  const text = [
    ...lines.map((line, index) => render(line, index + 1, lines.length)),
    summary,
    `数据目录：${view.paths.dataDir}`,
  ].join('\n')
  return { lines, failures, text }
}

/** Usage text for `/omw-help`-less hosts: one line per registered command. */
export const OMW_USAGE = `/omw-doctor — 在本进程内跑五项体检（库、快照、维度、凭据、注入段），复用当前实例的库句柄
/omw-pred-promote <谓词名> --single|--multi --reason <理由> — 把谓词提升为单值或多值（只有用户能做这件事）
/omw-evidence <mem_key> — 列出该业务键的证据指针（会话、区间、引文、是否截断、是否脱敏）
/omw-history <mem_key> — 列出该业务键的全部版本（旧值、valid_from/valid_to、谁在什么时候退役了它）
/omw-ledger <mem_key> — 列出改动过该业务键的决策记录（动作、操作号、影响范围、理由）
/omw-stats --since 24h — 按时间窗聚合注入/召回/写事务三条路的 p50/p95 与降级计数
/omw-explain <mem_key> — 一次答清「谁改的、依据什么、为什么」（尚未交付）
/omw-flag-queue [--status open] — 列出待处理标记（尚未交付）
/omw-export [--include-quotes] — 导出全量为 JSONL（尚未交付）
/omw-brief — 出当天只读简报（尚未交付）`

/** One parsed `/omw pred promote` invocation. */
export interface PromoteRequest {
  readonly name: string
  readonly cardinality: 'single' | 'multi'
  readonly reason: string
}

/** Outcome of parsing a promote request: the request, or why it is unusable. */
export type PromoteParse =
  | { readonly ok: true; readonly request: PromoteRequest }
  | { readonly ok: false; readonly reason: string }

/**
 * Parse `<谓词名> --single|--multi --reason <文本>`.
 *
 * The command name is no longer part of the text: the host cuts it out, so the
 * predicate is `tokens[0]`. Two rules that are easy to get wrong and are decided
 * here:
 *
 * - the flag names are case-insensitive (`--SINGLE` works), but the reason keeps
 *   its original case, because it is prose the user wrote;
 * - everything after `--reason` is the reason, verbatim. A `--multi` inside the
 *   sentence is text, not a second cardinality — while an unrecognised token
 *   *before* `--reason` is an error rather than silently folded into the reason.
 * @param raw - the command text after the command name.
 * @returns the parsed request or a reason it cannot be used.
 */
export function parsePromote(raw: string): PromoteParse {
  const text = raw.trim()
  const tokens = [...text.matchAll(/\S+/gu)]
  const name = tokens[0]?.[0]
  if (name === undefined) return { ok: false, reason: '缺少谓词名：/omw-pred-promote <谓词名> --single|--multi --reason <理由>' }
  let cardinality: 'single' | 'multi' | undefined
  let reason: string | undefined
  for (let position = 1; position < tokens.length; position += 1) {
    const token = tokens[position]!
    const flag = token[0].toLowerCase()
    if (flag === '--reason') {
      reason = text.slice((token.index ?? 0) + token[0].length).trim()
      break
    }
    if (flag === '--single' || flag === '--multi') {
      const wanted = flag === '--single' ? 'single' : 'multi'
      if (cardinality !== undefined && cardinality !== wanted) {
        return { ok: false, reason: '--single 与 --multi 只能选一个' }
      }
      cardinality = wanted
      continue
    }
    return { ok: false, reason: `无法识别的参数 "${token[0]}"（参数必须写在 --reason 之前）` }
  }
  if (cardinality === undefined) return { ok: false, reason: '必须用 --single 或 --multi 指定基数' }
  if (reason === undefined || reason === '') return { ok: false, reason: '必须用 --reason 给出理由' }
  return { ok: true, request: { name, cardinality, reason } }
}

/**
 * Register the `/omw-*` command family on a command registry.
 *
 * Ten separate names, not one `/omw` with subcommands (P0-3). The host's parser
 * takes the first token as the command name, so a subcommand form is only ever
 * `name: 'omw'` plus a raw string — the文档 claimed separate registrations, and
 * this is that shape for real. `version-chain` folded into `history`: they were
 * the same reader under two names.
 *
 * The four commands whose stories have not landed yet are registered too, so the
 * surface and the documentation agree today; each answers with the story that
 * owns it instead of pretending to be absent.
 * @param registry - the host's command registry.
 * @param view - reads the live instance at invocation time.
 * @param write - reads the write side at invocation time, or `undefined` when it is not ready.
 * @param evidence - reads the evidence reader at invocation time.
 * @param version - reads the version reader at invocation time.
 * @returns one disposer releasing all ten registrations.
 */
export function registerOmwCommands(
  registry: CommandRegistryLike,
  view: () => DoctorView,
  write?: () => WritePort | undefined,
  evidence?: () => EvidenceReader | undefined,
  version?: () => VersionReader | undefined,
  audit?: () => Audit | undefined,
): () => void {
  const disposers = [
    register(registry, {
      name: 'omw-doctor',
      description: '在当前进程内跑五项体检（库、快照、维度、凭据、注入段），复用当前实例的库句柄',
      handler: () => {
        const report = inspectInProcess(view())
        return { kind: report.failures === 0 ? 'success' : 'error', text: report.text }
      },
    }),
    register(registry, {
      name: 'omw-pred-promote',
      description: '把谓词提升为单值或多值（只有用户能做这件事）',
      input: { hint: '<谓词名> --single|--multi --reason <理由>' },
      handler: (invocation) => promote(invocation.rawInput, write),
    }),
    register(registry, {
      name: 'omw-evidence',
      description: '列出该业务键的证据指针（会话、区间、引文、是否截断、是否脱敏）',
      input: { hint: '<mem_key>' },
      handler: (invocation) => readEvidence(invocation.rawInput, evidence),
    }),
    register(registry, {
      name: 'omw-history',
      description: '列出该业务键的全部版本（旧值、valid_from/valid_to、谁在什么时候退役了它）',
      input: { hint: '<mem_key>' },
      handler: (invocation) => readHistory(invocation.rawInput, version),
    }),
    register(registry, {
      name: 'omw-ledger',
      description: '列出改动过该业务键的决策记录（动作、操作号、影响范围、理由）',
      input: { hint: '<mem_key>' },
      handler: (invocation) => readLedger(invocation.rawInput, version),
    }),
    register(registry, {
      name: 'omw-stats',
      description: '按时间窗聚合注入/召回/写事务三条路的 p50/p95 与降级计数',
      input: { hint: '[--since 24h|7d|--all]' },
      handler: (invocation) => readStats(invocation.rawInput, audit),
    }),
    register(registry, undelivered('omw-explain', '一次答清「谁改的、依据什么、为什么」', 'Story 3.1')),
    register(registry, undelivered('omw-flag-queue', '列出待处理标记，只按 status 过滤', 'Story 3.3')),
    register(registry, undelivered('omw-export', '把全量记忆导出为纯文本 + JSONL', 'Story 3.5')),
    register(registry, undelivered('omw-brief', '出当天只读简报，只出文件、不进注入与召回', 'Story 3.8')),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** Register one definition and hand back its disposer. */
function register(registry: CommandRegistryLike, definition: CommandDefinitionLike): () => void {
  return registry.register(definition)
}

/**
 * A command that exists in the surface but whose story has not landed.
 *
 * It is a real registration on purpose: the architecture and the epics describe
 * ten commands, and a surface that silently lacks four of them is what let the
 * docs drift in the first place. The answer names who will fill it in, so an
 * operator learns why rather than guessing.
 * @param name - the command name.
 * @param description - what it will do.
 * @param owner - the story or spec that delivers it.
 * @returns a definition whose handler refuses clearly.
 */
function undelivered(name: string, description: string, owner: string): CommandDefinitionLike {
  return {
    name,
    description: `${description}（尚未交付，由 ${owner} 负责）`,
    handler: (): CommandResultLike => ({
      kind: 'error',
      text: `/${name} 尚未交付：由 ${owner} 交付。本版本只登记了命令名，避免命令面与文档再次不一致。`,
    }),
  }
}

/**
 * Run one `/omw-stats`.
 *
 * The window argument is parsed here rather than in `ops/stats.ts` so the
 * aggregation stays a pure function of rows and a window: a bad flag is a command
 * error, not an empty report.
 * @param raw - the command text after the command name.
 * @param audit - reads the audit facade at invocation time.
 * @returns the command result.
 */
async function readStats(raw: string, audit?: () => Audit | undefined): Promise<CommandResultLike> {
  const text = raw.trim()
  // `--since <value>` or `--all`; a bare value is read as the window itself,
  // because `omw-stats 24h` is what a person actually types.
  let windowRaw = ''
  const flag = /--since\s+(\S+)/u.exec(text)
  if (flag !== null) {
    windowRaw = flag[1] ?? ''
  } else if (text.startsWith('--all')) {
    windowRaw = 'all'
  } else if (text !== '' && !text.startsWith('-')) {
    windowRaw = text
  } else if (text.startsWith('-')) {
    return { kind: 'error', text: `无法识别的参数 "${text}"：只支持 --since <24h|7d> 或 --all` }
  }

  const parsed = parseStatsWindow(windowRaw)
  if (!parsed.ok) return { kind: 'error', text: parsed.reason }

  const facade = audit?.()
  if (facade === undefined) {
    return { kind: 'error', text: '审计面未就绪，本次没有读到任何审计行。' }
  }
  return { kind: 'success', text: renderStats(summarizeAudit(facade.rows, parsed.window)) }
}

/**
 * Run one `/omw-pred-promote`.
 *
 * A missing write side is reported as such rather than as a failure of the
 * request: the user asks "did it work", and the honest answer is "the store is
 * not writable on this start".
 * @param raw - the command text after the command name.
 * @param write - reads the write side at invocation time.
 * @returns the command result.
 */
async function promote(raw: string, write?: () => WritePort | undefined): Promise<CommandResultLike> {
  const parsed = parsePromote(raw)
  if (!parsed.ok) {
    return { kind: 'error', text: `${parsed.reason}\n\n${OMW_USAGE}` }
  }
  const port = write?.()
  if (port === undefined) {
    return { kind: 'error', text: '写面未就绪（schema 未安装或库句柄只读），本次没有改动谓词登记表。' }
  }
  const answer = await port.promote(parsed.request.name, parsed.request.cardinality, parsed.request.reason)
  const head = answer.ok ? '已更新谓词登记表' : `未能更新谓词登记表（${answer.code}）`
  return { kind: answer.ok ? 'success' : 'error', text: `${head}：${answer.message}` }
}

/** What an `evidence` invocation asked for, or why it cannot be read. */
export type EvidenceKeyParse =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly reason: string }

/**
 * Cut the business key out of an `evidence` invocation.
 *
 * Keys are case-sensitive and may contain any non-space character, so the key
 * is the token after the subcommand of the raw text — not the lowercased
 * dispatch string, which would silently rewrite `assertion:Elliott:lives_in`
 * into a key that does not exist.
 *
 * A key never contains whitespace, so a second token is always a mistake. It
 * is reported rather than dropped: keeping only the first token used to turn
 * `/omw evidence assertion:x:y please` into a confident "not found" about a
 * key the user never typed.
 * @param raw - the command text after `/omw`.
 * @returns the key as typed, or the reason it cannot be taken.
 */
export function parseEvidenceKey(raw: string): EvidenceKeyParse {
  return parseMemKeyArgument(raw, 'omw-evidence')
}

/**
 * Cut the business key out of `<command> <mem_key>`.
 *
 * Shared by every single-key read so the three commands cannot drift: a key is
 * case-sensitive, never contains whitespace, and a second token is a mistake
 * reported back rather than silently dropped. The command name is the host's, not
 * part of `raw`, so the key is `tokens[0]`.
 * @param raw - the command text after the command name.
 * @param command - the command name, used only in the usage hint.
 * @returns the key as typed, or the reason it cannot be taken.
 */
export function parseMemKeyArgument(raw: string, command: string): EvidenceKeyParse {
  const tokens = raw.trim().split(/\s+/u).filter(token => token !== '')
  const key = tokens[0] ?? ''
  if (key === '') return { ok: true, key }
  if (tokens.length > 1) {
    return {
      ok: false,
      reason: `/${command} 一次只查一个业务键，后面这些多写的词没有当作键：${tokens.slice(1).join(' ')}`,
    }
  }
  return { ok: true, key }
}

/**
 * Render one pointer as a single human-readable line.
 *
 * Every field the user asked about is present in the line, and no node id is:
 * AD-6 and AR-4 keep ids inside the store.
 * @param pointer - one pointer.
 * @param index - its position in the list.
 * @returns one line.
 */
function renderPointer(pointer: EvidenceReadAnswer['pointers'][number], index: number): string {
  const quote = pointer.quote === '' ? '（引文为空，原文不可解引用）' : `「${pointer.quote}」`
  const flags = [
    pointer.quote_truncated ? '已截断' : '未截断',
    pointer.deidentified ? '已脱敏' : '未脱敏',
  ].join('、')
  const range = pointer.seq_from === undefined || pointer.seq_to === undefined
    ? '#?-?'
    : `#${pointer.seq_from}-${pointer.seq_to}`
  return `${index + 1}. ${pointer.session_id} ${range} ${quote}（${flags}）`
}

/**
 * Run one `evidence` read and render it.
 *
 * The JSON line is not decoration: it is the machine-readable half of the same
 * answer, so a script can check what the human line says without parsing prose.
 * @param raw - the command text after `/omw`.
 * @param evidence - reads the reader at invocation time, or `undefined` when the store is unusable.
 * @returns the command result.
 */
async function readEvidence(
  raw: string,
  evidence?: () => EvidenceReader | undefined,
): Promise<CommandResultLike> {
  const parsed = parseEvidenceKey(raw)
  if (!parsed.ok) {
    return { kind: 'error', text: `${parsed.reason}\n\n${OMW_USAGE}` }
  }
  const memKey = parsed.key
  if (memKey === '') {
    return { kind: 'error', text: `需要给出一个业务键：/omw-evidence <mem_key>\n\n${OMW_USAGE}` }
  }
  const reader = evidence?.()
  if (reader === undefined) {
    return { kind: 'error', text: '记忆库本次启动不可读（schema 未就绪或句柄已关闭），没有可查的证据指针。' }
  }
  let answer: EvidenceReadAnswer
  try {
    answer = await reader.read(memKey)
  } catch (error) {
    // The reader is documented not to throw, but a handler that lets a
    // rejection escape takes the whole command surface down with it.
    const reason = error instanceof Error ? error.message : String(error)
    return { kind: 'error', text: `读取证据指针时出错：${reason}` }
  }
  if (answer.code === 'E_BOUNDARY') {
    return { kind: 'error', text: answer.message }
  }
  if (answer.code === 'E_GATE_DOWN') {
    return { kind: 'error', text: answer.message }
  }
  const lines = [answer.message]
  if (answer.pointers.length === 0) {
    lines.push('这条记忆没有证据指针（写入时没有声明来源区间）。')
  } else {
    lines.push(...answer.pointers.map((pointer, index) => renderPointer(pointer, index)))
  }
  if (answer.degraded !== undefined) {
    lines.push(`降级：${answer.degraded}（原文此刻未能全部回读，引文保持写入时的样子，未伪造）`)
  }
  // The degraded marker goes into the JSON too: a reader that only looked at
  // the structured half would otherwise believe the pointers resolve.
  const payload = {
    ok: answer.ok,
    code: answer.code,
    mem_key: answer.mem_key,
    message: answer.message,
    pointers: answer.pointers,
    ...(answer.degraded === undefined ? {} : { degraded: answer.degraded }),
  }
  lines.push(JSON.stringify(payload))
  return { kind: 'success', text: lines.join('\n') }
}

/**
 * Render one version as a single human-readable line.
 *
 * The old value is rendered whole rather than truncated: seeing what the memory
 * used to say is the whole point of asking for history.
 * @param version - one version.
 * @param index - its position in the chain.
 * @returns one line.
 */
function renderVersion(version: VersionHistoryAnswer['versions'][number], index: number): string {
  const value = version.obj ?? version.value ?? version.status ?? '（无值字段）'
  const state = version.live ? '当前版本' : '已退役'
  const from = version.valid_from ?? '?'
  const to = version.valid_to ?? (version.live ? '至今' : '?')
  const retiredAt = millisecondLabel(version.superseded_at)
  const retired = retiredAt === undefined ? '' : `，退休于 ${retiredAt}`
  const actor = version.actor === undefined ? '' : `，写入者 ${version.actor}`
  return `${index + 1}. [${state}] ${value}（valid_from ${from} → valid_to ${to}${retired}${actor}）`
}

/**
 * Render a millisecond timestamp as ISO text, or give up on it.
 *
 * `new Date(x).toISOString()` throws for a value outside the representable
 * range, and one corrupt row must not reject the whole command: the field is
 * printed as the raw number instead of taking the answer down with it.
 * @param ms - milliseconds since the epoch, or `undefined` when absent.
 * @returns the ISO text, the raw number for an unrepresentable value, or `undefined`.
 */
function millisecondLabel(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined
  const when = new Date(ms)
  return Number.isNaN(when.getTime()) ? String(ms) : when.toISOString()
}

/**
 * Render one ledger entry as a single human-readable line.
 *
 * `affected` is shown because it is what makes an operation reversible (AD-22):
 * a revert names these keys, not the node ids.
 * @param entry - one ledger entry.
 * @param index - its position in the list.
 * @returns one line.
 */
function renderDecision(entry: LedgerAnswer['entries'][number], index: number): string {
  const from = entry.from === undefined ? '' : `（从 ${JSON.stringify(entry.from)}）`
  const to = entry.to === undefined ? '' : `（到 ${JSON.stringify(entry.to)}）`
  const affected = entry.affected.length === 0 ? '无' : entry.affected.join('、')
  return `${index + 1}. ${entry.ts} ${entry.kind} by ${entry.actor}${from}${to}：${entry.reason}；操作号 ${entry.op_id}；影响 ${affected}`
}

/**
 * Run one `history` read and render it.
 *
 * The JSON line is the machine-readable half of the same answer, so a script can
 * check the versions without parsing prose.
 * @param raw - the command text after `/omw`.
 * @param version - reads the reader at invocation time, or `undefined` when the store is unusable.
 * @returns the command result.
 */
function readHistory(
  raw: string,
  version?: () => VersionReader | undefined,
): CommandResultLike {
  const parsed = parseMemKeyArgument(raw, 'omw-history')
  if (!parsed.ok) return { kind: 'error', text: `${parsed.reason}\n\n${OMW_USAGE}` }
  const memKey = parsed.key
  if (memKey === '') {
    return { kind: 'error', text: `需要给出一个业务键：/omw-history <mem_key>\n\n${OMW_USAGE}` }
  }
  const reader = version?.()
  if (reader === undefined) {
    return { kind: 'error', text: '记忆库本次启动不可读（schema 未就绪或句柄已关闭），没有可查的版本链。' }
  }
  let answer: VersionHistoryAnswer
  try {
    answer = reader.history(memKey)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { kind: 'error', text: `读取版本链时出错：${reason}` }
  }
  if (!answer.ok) return { kind: 'error', text: answer.message }
  // No fallback sentence for the empty list: the reader's own message already
  // says why it is empty, and adding one would say it twice.
  const lines = [answer.message, ...answer.versions.map((entry, index) => renderVersion(entry, index))]
  lines.push(JSON.stringify({ ok: answer.ok, code: answer.code, mem_key: answer.mem_key, message: answer.message, versions: answer.versions }))
  return { kind: 'success', text: lines.join('\n') }
}

/**
 * Run one `ledger` read and render it.
 * @param raw - the command text after `/omw`.
 * @param version - reads the reader at invocation time, or `undefined` when the store is unusable.
 * @returns the command result.
 */
function readLedger(
  raw: string,
  version?: () => VersionReader | undefined,
): CommandResultLike {
  const parsed = parseMemKeyArgument(raw, 'omw-ledger')
  if (!parsed.ok) return { kind: 'error', text: `${parsed.reason}\n\n${OMW_USAGE}` }
  const memKey = parsed.key
  if (memKey === '') {
    return { kind: 'error', text: `需要给出一个业务键：/omw-ledger <mem_key>\n\n${OMW_USAGE}` }
  }
  const reader = version?.()
  if (reader === undefined) {
    return { kind: 'error', text: '记忆库本次启动不可读（schema 未就绪或句柄已关闭），没有可查的决策账本。' }
  }
  let answer: LedgerAnswer
  try {
    answer = reader.ledger(memKey)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { kind: 'error', text: `读取决策账本时出错：${reason}` }
  }
  if (!answer.ok) return { kind: 'error', text: answer.message }
  const lines = [answer.message, ...answer.entries.map((entry, index) => renderDecision(entry, index))]
  lines.push(JSON.stringify({ ok: answer.ok, code: answer.code, mem_key: answer.mem_key, message: answer.message, entries: answer.entries }))
  return { kind: 'success', text: lines.join('\n') }
}
