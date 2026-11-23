/**
 * The single assembly point (AD-1, AD-13, AD-18).
 *
 * Startup order is fixed and observable:
 *
 *   1. resolve `<dataDir>` paths from config,
 *   2. open the database,
 *   3. make sure today's snapshot exists and verifies,
 *   4. compare `db.dim` and the stored contract version,
 *   5. decide the state from those four probes,
 *   6. register the identity section — in every state,
 *   7. register the four tools — only when the state is `ok`,
 *   8. hand back a disposer.
 *
 * Injection and tool registration each sit in their own try/catch: a failure in
 * one never rolls back the other (AD-18). Nothing here starts a process, binds a
 * port, or spawns anything (AD-1).
 * @module
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DegradeMachine, type DegradeDetail, type DegradeState, type OmwCode } from '../core/degrade.ts'
import { decideGates, type ContractProbe, type DbOpenProbe, type DimProbe, type SnapshotProbe } from '../core/gates.ts'
import { ensureDailySnapshot } from '../ops/snapshots.ts'
import { closeDatabase, databaseDim, openDatabase, type Database } from '../store/db.ts'
import {
  SUPPORTED_CONTRACT_VERSION,
  contractVersionSupported,
  readContractVersion,
  writeContractVersion,
} from '../store/meta.ts'
import { resolvePaths, type Config, type HomePath, type Paths } from './config.ts'
import { createAppendFileSink, createLogger, type Logger } from './logger.ts'
import { PromptComposer, type PersonaState, type SystemPromptLike } from './prompt-composer.ts'
import { registerPlaceholderTools, type ToolRegistryLike } from './tools.ts'
import { createVectorPolicy, type VectorPolicy } from './vector.ts'

/**
 * Diagnostic log codes for registration problems.
 *
 * These are *not* degradation codes: the eight runtime degradation codes stay
 * closed, and a failed registration does not move the state machine. They exist
 * so a failure is still a structured, greppable line in `omw.log`.
 */
export const OPERATIONAL_LOG_CODES = {
  /** `systemPrompt.section()` was rejected or threw. */
  sectionRegistrationFailed: 'OMW_SECTION_NOT_REGISTERED',
  /** `tools.register()` was rejected or threw. */
  toolRegistrationFailed: 'OMW_TOOL_NOT_REGISTERED',
  /** The contract version could not be recorded on a brand-new database. */
  contractWriteFailed: 'OMW_CONTRACT_NOT_RECORDED',
} as const

/** The slice of `ctx` the plugin actually uses. */
export interface RuntimeContext {
  /** The injection seam. Required: without it there is nothing to attach to. */
  readonly systemPrompt: SystemPromptLike
  /**
   * The tool registry, when the caller already holds it (test doubles do).
   *
   * A live Cordis context must not be read through this property: accessing an
   * un-injected service throws `cannot get property "tools" without inject`, and
   * declaring `inject: ['tools']` would tie this plugin's activation to a surface
   * it is supposed to survive without (AD-18). The host path therefore goes
   * through {@link RuntimeContext.get}.
   */
  readonly tools?: ToolRegistryLike
  /**
   * Optional-service accessor (`ctx.get(name)`), which resolves without the
   * injection requirement. Present on every real context.
   */
  readonly get?: (name: string) => unknown
  /** Host-provided home-path joiner (`ctx.dshHomePath`). */
  readonly dshHomePath?: HomePath
}

/** What the caller needs in order to announce the load and to report state. */
export interface LoadedInfo {
  readonly state: DegradeState
  readonly dataDir: string
  readonly sectionRegistered: boolean
  readonly tools: readonly string[]
}

/** The assembled plugin. */
export interface Runtime {
  readonly state: DegradeState
  readonly code?: OmwCode
  readonly detail?: DegradeDetail
  readonly paths: Paths
  readonly db?: Database
  /**
   * The vector side, present only while the plugin is fully assembled (`ok`).
   *
   * Epic 1 exposes it so the failure mapping is reachable in production code and
   * observable in tests; the write tools themselves stay placeholders.
   */
  readonly vector?: VectorPolicy
  readonly logger: Logger
  /** Validated configuration this instance mounted with (read-only view). */
  readonly config: Config
  /** Character count of the identity section as registered, for diagnostics. */
  readonly sectionChars: number
  readonly loaded: LoadedInfo
  /** Close the database and release both injection registrations. Idempotent. */
  dispose(): void
}

/** Inputs of {@link startRuntime}. */
export interface RuntimeDeps {
  readonly ctx: RuntimeContext
  readonly config: Config
  readonly now?: () => Date
  readonly env?: Record<string, string | undefined>
  /** Logger override; defaults to the append-file logger at `<dataDir>/omw.log`. */
  readonly logger?: Logger
  /** Identity text override; defaults to `assets/persona.md` beside the built output. */
  readonly personaText?: string
  /** Identity text path override. */
  readonly personaPath?: string
  /** Mutable state-tail inputs. Epic 1 leaves this absent: no state, no tail. */
  readonly readState?: () => PersonaState | undefined
  /** Embedding transport override (tests only); production uses the global `fetch`. */
  readonly fetchImpl?: typeof fetch
}

/**
 * Absolute path of the shipped identity file.
 *
 * `lib/seams/runtime.js` sits two levels below the package root, so the asset is
 * found in both a checkout (`src/` and `lib/`) and an installed package.
 * @returns the absolute path of `assets/persona.md`.
 */
export function defaultPersonaPath(): string {
  return fileURLToPath(new URL('../../assets/persona.md', import.meta.url))
}

/**
 * Read the identity text.
 * @param path - file to read; defaults to {@link defaultPersonaPath}.
 * @returns the file's UTF-8 contents.
 * @throws when the asset is missing, because a plugin without an identity has not loaded.
 */
export function loadPersonaText(path: string = defaultPersonaPath()): string {
  return readFileSync(path, 'utf8')
}

/**
 * Fallback home resolver for harnesses that do not provide `dshHomePath`.
 *
 * The real host always provides the seam (`ctx.provide('dshHomePath', …)`); this
 * exists so an embedding harness or a test double cannot accidentally resolve
 * paths against the process CWD.
 * @param env - environment to read `DSH_HOME` from.
 * @returns a joiner rooted at `$DSH_HOME` or `~/.dsh`.
 */
export function fallbackHomePath(env: Record<string, string | undefined> = process.env): HomePath {
  const override = env['DSH_HOME']?.trim()
  const root = override !== undefined && override !== '' ? override : join(homedir(), '.dsh')
  return (...segments: string[]) => join(root, ...segments)
}

/** Turn an unknown thrown value into a readable one-line reason. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' && code !== '' ? `${code}: ${error.message}` : error.message
  }
  return String(error)
}

/**
 * Assemble the plugin.
 *
 * Synchronous on purpose: the whole registration happens inside `apply`, which
 * the host calls at mount time, and a partially registered plugin is exactly the
 * "half-alive" outcome AD-13 forbids.
 * @param deps - context, config, and test seams.
 * @returns the runtime handle.
 */
export function startRuntime(deps: RuntimeDeps): Runtime {
  const { config, ctx } = deps
  const home = ctx.dshHomePath ?? fallbackHomePath(deps.env)
  const paths = resolvePaths(config, home)
  const logger = deps.logger ?? createLogger(createAppendFileSink(paths.logFile))
  const machine = new DegradeMachine()
  const composer = new PromptComposer({
    personaText: deps.personaText ?? loadPersonaText(deps.personaPath),
    personaMaxChars: config.inject.personaMaxChars,
    tailMaxTokens: config.inject.tailMaxTokens,
    ...(deps.readState === undefined ? {} : { readState: deps.readState }),
  })

  let db: Database | undefined
  let sectionRegistered = false
  let tools: readonly string[] = []
  let vector: VectorPolicy | undefined
  let disposed = false

  const registerSection = (): void => {
    try {
      const outcome = composer.register(ctx.systemPrompt)
      sectionRegistered = outcome.personaRegistered || composer.composePersona().text.length > 0
    } catch (error) {
      sectionRegistered = false
      logger.warn(OPERATIONAL_LOG_CODES.sectionRegistrationFailed, { reason: describeError(error) })
    }
  }

  const registerTools = (): void => {
    const registry = resolveToolRegistry(ctx)
    if (registry === undefined) return
    try {
      tools = registerPlaceholderTools(registry)
    } catch (error) {
      tools = []
      logger.warn(OPERATIONAL_LOG_CODES.toolRegistrationFailed, { reason: describeError(error) })
    }
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    composer.dispose()
    if (db !== undefined) {
      closeDatabase(db)
      db = undefined
    }
  }

  const snapshot: DegradeSnapshotResult = (() => {
    const opened = openDatabase({
      file: paths.dbFile,
      dim: config.db.dim,
      memoryLimitMb: config.db.memoryLimitMb,
    })
    if (!opened.ok) {
      return {
        ok: false,
        mode: 'db',
        reason: opened.reason,
        ...(opened.errorCode === undefined ? {} : { errorCode: opened.errorCode }),
        ...(opened.fileDim === undefined ? {} : { fileDim: opened.fileDim }),
      }
    }
    db = opened.db
    try {
      const ensured = ensureDailySnapshot({
        db: opened.db,
        snapshotsDir: paths.snapshotsDir,
        keep: config.snapshot.keep,
        ...(deps.now === undefined ? {} : { now: deps.now }),
      })
      return ensured.ok ? { ok: true } : { ok: false, mode: 'snapshot', reason: ensured.reason, path: ensured.path }
    } catch (error) {
      return { ok: false, mode: 'snapshot', reason: describeError(error) }
    }
  })()

  // Every probe is constructed, including the failing ones: "which check failed
  // first" belongs to {@link decideGates}, not to this function, so the gate's
  // own branches stay reachable in production and worth unit-testing.
  const dbOpenProbe: DbOpenProbe = snapshot.ok === false && snapshot.mode === 'db'
    && snapshot.errorCode !== 'TDB_DIMENSION_MISMATCH'
    ? { ok: false, reason: snapshot.reason }
    : { ok: true }

  // A dimension mismatch surfaces at open time — the engine refuses to open a file
  // at a width other than its own — but it is still the DIM gate, not a corrupt
  // database, so the open is reported as successful and the width probe fails.
  const snapshotProbe: SnapshotProbe = snapshot.ok || snapshot.mode === 'db'
    ? { ok: true }
    : (snapshot.path === undefined
      ? { ok: false, reason: snapshot.reason }
      : { ok: false, reason: snapshot.reason, snapshot: snapshot.path })

  const dimProbe: DimProbe = (() => {
    if (snapshot.ok === false && snapshot.mode === 'db') {
      const mismatch = snapshot.errorCode === 'TDB_DIMENSION_MISMATCH'
      return { ok: mismatch === false, expected: config.db.dim, actual: mismatch ? snapshot.fileDim ?? null : null }
    }
    const actual = db === undefined ? null : safeDim(db)
    return { ok: actual !== null && actual === config.db.dim, expected: config.db.dim, actual }
  })()

  const contractProbe: ContractProbe = (() => {
    if (db === undefined) return { ok: false, supported: 0, stored: null }
    const read = readContractVersion(db)
    if (!read.ok) return { ok: false, supported: -1, stored: null }
    return contractVersionSupported(read.value)
  })()

  const decision = decideGates({ dbOpen: dbOpenProbe, snapshot: snapshotProbe, dim: dimProbe, contract: contractProbe })

  if (decision.state === 'no-op') {
    logger.error(decision.code, decision.detail)
    machine.enterNoOp(decision.code, decision.detail)
    // Step aside completely: a `no-op` plugin holds no database lease, because the
    // single-file engine takes an exclusive one and a leaked handle would block
    // snapshots, restores and the doctor's own open.
    if (db !== undefined) {
      closeDatabase(db)
      db = undefined
    }
    registerSection()
    return finish()
  }

  // ADR-19: the gate can only reject a version it can compare, so a database
  // without the flag node is stamped once — here, on the first healthy boot.
  if (db !== undefined && contractProbe.stored === null) {
    try {
      writeContractVersion(db, SUPPORTED_CONTRACT_VERSION, deps.now)
    } catch (error) {
      logger.warn(OPERATIONAL_LOG_CODES.contractWriteFailed, { reason: describeError(error) })
    }
  }

  registerSection()
  registerTools()
  if (db !== undefined) {
    vector = createVectorPolicy({
      machine,
      logger,
      db,
      options: {
        endpoint: config.embedding.endpoint,
        model: config.embedding.model,
        apiKeyEnv: config.embedding.apiKeyEnv,
        env: deps.env ?? process.env,
        timeoutMs: config.embedding.timeoutMs,
        dim: config.db.dim,
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      },
    })
  }
  return finish()

  /** Assemble the handle from the current locals. */
  function finish(): Runtime {
    return {
      // Live reads: a vector failure after load must be visible on the handle.
      get state() {
        return machine.state
      },
      get code() {
        return machine.snapshot.code
      },
      get detail() {
        return machine.snapshot.detail
      },
      paths,
      db,
      logger,
      config,
      get sectionChars() {
        return composer.composePersona().text.length
      },
      get loaded(): LoadedInfo {
        return { state: machine.state, dataDir: paths.dataDir, sectionRegistered, tools }
      },
      ...(vector === undefined ? {} : { vector }),
      dispose,
    }
  }
}

/** Intermediate startup outcome, kept internal to {@link startRuntime}. */
type DegradeSnapshotResult =
  | { readonly ok: true }
  | {
    readonly ok: false
    readonly mode: 'db' | 'snapshot'
    readonly reason: string
    readonly path?: string
    /** Engine error code, when the open itself failed. */
    readonly errorCode?: string
    /** Width stored in the file, when the open failed on a dimension mismatch. */
    readonly fileDim?: number
  }

/**
 * Find the tool registry without triggering Cordis's injection guard.
 * @param ctx - the context slice the plugin holds.
 * @returns the registry, or `undefined` when this harness has no tool surface.
 */
function resolveToolRegistry(ctx: RuntimeContext): ToolRegistryLike | undefined {
  if (typeof ctx.get === 'function') {
    // `ctx.get` is the non-injecting accessor, but the host may still throw —
    // resolving an optional surface must never take the whole plugin down.
    try {
      const service = ctx.get('tools')
      if (isToolRegistry(service)) return service
    } catch {
      // Fall through to the direct property: a harness may expose one or the other.
    }
  }
  // A real Cordis context throws on an un-injected property ("cannot get property
  // "tools" without inject"), so the direct property is only usable behind a guard.
  // Test doubles and embedding harnesses expose it as a plain value.
  try {
    return ctx.tools
  } catch {
    return undefined
  }
}

/** Whether a value looks like a Cordis tool registry. */
function isToolRegistry(value: unknown): value is ToolRegistryLike {
  return typeof value === 'object' && value !== null
    && typeof (value as { register?: unknown }).register === 'function'
}

/** Read the database dimension without letting a probe crash startup. */
function safeDim(db: Database): number | null {
  try {
    return databaseDim(db)
  } catch {
    return null
  }
}
