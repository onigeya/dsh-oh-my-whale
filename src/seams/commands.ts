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
 * why. Nothing here writes business nodes, opens a network connection, or
 * registers a tool.
 * @module
 */
import type { Config, Paths } from './config.ts'
import type { DegradeState, OmwCode } from '../core/degrade.ts'
import { ensureDailySnapshot } from '../ops/snapshots.ts'
import type { Database } from '../store/db.ts'
import { databaseDim, nodeCount } from '../store/db.ts'
import { PERSONA_SECTION_NAME } from './prompt-composer.ts'
import type { Logger } from './logger.ts'

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

/** Render one check as a single terminal line. */
function render(line: DoctorLine, index: number): string {
  const mark = line.status === 'pass' ? 'pass' : line.status === 'fail' ? 'FAIL' : 'skip'
  const code = line.code === undefined ? '' : ` [${line.code}]`
  return `${index}/5 ${line.id.padEnd(10, ' ')} ${mark} ${line.detail}${code}`
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
    ...lines.map((line, index) => render(line, index + 1)),
    summary,
    `数据目录：${view.paths.dataDir}`,
  ].join('\n')
  return { lines, failures, text }
}

/** Usage text for `/omw` with no or an unknown subcommand. */
export const OMW_USAGE = `/omw doctor — 在本进程内跑五项体检（库、快照、维度、凭据、注入段），复用当前实例的库句柄
/omw help — 显示这段说明`

/**
 * Register `/omw` on a command registry.
 * @param registry - the host's command registry.
 * @param view - reads the live instance at invocation time.
 * @returns the disposer.
 */
export function registerOmwCommand(registry: CommandRegistryLike, view: () => DoctorView): () => void {
  return registry.register({
    name: 'omw',
    description: '哦鲸鲸体检：/omw doctor 在当前进程内跑五项检查',
    input: { hint: 'doctor' },
    handler: (invocation: CommandInvocationLike): CommandResultLike => {
      const sub = invocation.rawInput.trim().toLowerCase()
      if (sub === 'doctor') {
        const report = inspectInProcess(view())
        return { kind: report.failures === 0 ? 'success' : 'error', text: report.text }
      }
      if (sub === '' || sub === 'help' || sub === '--help') {
        return { kind: 'success', text: OMW_USAGE }
      }
      return { kind: 'error', text: `未知子命令 "${sub}"\n\n${OMW_USAGE}` }
    },
  })
}
