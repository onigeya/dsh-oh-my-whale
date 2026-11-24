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
 *   7. install the seed registry and open the write side — only past the gate,
 *   8. register the four tools — only when the state is `ok`,
 *   9. hand back a disposer.
 *
 * Steps 7 and 8 fail independently of each other and of the identity section. A
 * database that opens but cannot take the seed registry still injects the
 * identity and still says `ok`; what it loses is the write side, and
 * `remember` then answers `E_GATE_DOWN` instead of pretending to write.
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
import { ensureSchema } from '../store/schema.ts'
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
import { createWriteAudit, createWritePort, type WritePort } from './write-port.ts'
import { asSessionQuery, createQuoteSource, type SessionQueryLike } from './evidence-source.ts'
import { createEvidenceReader, type EvidenceReader } from './evidence-reader.ts'

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
  /**
   * The seed registry or the indexes could not be installed.
   *
   * Not a degradation: the store still reads, the identity is still injected,
   * and the state stays `ok`. Only the write side is missing, which is why the
   * tools answer `E_GATE_DOWN` and why this line has to exist in `omw.log`.
   */
  schemaNotReady: 'OMW_SCHEMA_NOT_READY',
  /** The write queue could not be drained before the handle was closed. */
  writeCloseFailed: 'OMW_WRITE_CLOSE_FAILED',
  /** A write audit row could not be appended. The write itself already landed. */
  auditWriteFailed: 'OMW_AUDIT_WRITE_FAILED',
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
  /**
   * The write side, present only when the store accepted the seed registry.
   *
   * Absent is a fact the caller can act on: `remember` refuses with
   * `E_GATE_DOWN` and `/omw pred promote` reports that the write side is not
   * ready. It is never absent while `state` is `ok` *and* the store opened
   * writable — that combination is a bug, not a degraded mode.
   */
  readonly write?: WritePort
  /**
   * The read side of the same store, present whenever the handle is readable.
   *
   * Unlike the write side this does not depend on the seed registry having
   * installed: asking where a stored fact came from is a read, and a read-only
   * store still answers it. `/omw evidence` refuses only when this is absent.
   */
  readonly evidence?: EvidenceReader
  /**
   * Drain the write queue, then close the database and release both injection
   * registrations. Idempotent, and returns a promise the caller must await:
   * closing the handle under a queued write would lose it.
   */
  dispose(): Promise<void>
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
  // One clock for the whole start: the audit rows, the seed payloads and the
  // write timestamps have to agree about which instant this boot happened at.
  const nowMs = (): number => (deps.now?.() ?? new Date()).getTime()
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
  let write: WritePort | undefined
  let evidence: EvidenceReader | undefined
  let disposed = false
  let disposing: Promise<void> | undefined

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
      tools = registerPlaceholderTools(registry, write)
    } catch (error) {
      tools = []
      logger.warn(OPERATIONAL_LOG_CODES.toolRegistrationFailed, { reason: describeError(error) })
    }
  }

  const dispose = (): Promise<void> => {
    if (disposing !== undefined) return disposing
    disposed = true
    // Closing the queue first makes every later `remember` refuse instead of
    // queueing behind a drain that will never run; the drain itself is awaited
    // before the handle goes away, so an accepted write is never dropped.
    const port = write
    write = undefined
    evidence?.dispose()
    evidence = undefined
    disposing = (async () => {
      composer.dispose()
      let closedByPort = false
      if (port !== undefined) {
        try {
          await port.dispose()
          closedByPort = true
        } catch (error) {
          logger.warn(OPERATIONAL_LOG_CODES.writeCloseFailed, { reason: describeError(error) })
        }
      }
      // The write port's own dispose closes the handle it was given. Closing
      // it again here would report a failure the second time and hide a real
      // one, so the handle is only closed here when the port never ran.
      if (db !== undefined) {
        if (!closedByPort) closeDatabase(db)
        db = undefined
      }
    })()
    return disposing
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

  // Step 7: the store's own shape. Indexes and the seed registry are installed
  // once, idempotently, and only on a handle we may write through. A failure
  // here is not a degradation: reads still work, the identity is still injected,
  // and the only thing lost is the write side (AD-18 keeps the halves
  // independent).
  //
  // The audit object is built before the bootstrap because the bootstrap itself
  // is a write worth recording: installing the seed registry is the one write
  // that happens without a tool call behind it.
  const audit = createWriteAudit(paths.dataDir, deps.now)
  const auditWrite = (row: { outcome: 'bootstrap' | 'committed' | 'rejected' | 'downgraded'; code: string; mem_keys: readonly string[]; elapsed_ms: number }): void => {
    try {
      audit.append({ kind: 'write', ts: new Date(nowMs()).toISOString(), ...row })
    } catch (error) {
      logger.warn(OPERATIONAL_LOG_CODES.auditWriteFailed, { reason: describeError(error) })
    }
  }

  const bootstrap = db === undefined
    ? { ok: false as const, writable: false as const, code: 'OMW_DB_OPEN', reason: '数据库句柄不可用' }
    : ensureSchema(db, {
      now: nowMs,
      onEvent: event => {
        auditWrite({
          outcome: 'bootstrap',
          code: event.code,
          mem_keys: [],
          elapsed_ms: event.elapsed_ms,
        })
      },
    })

  const schemaWritable = bootstrap.ok && bootstrap.writable
  if (!schemaWritable) {
    logger.warn(OPERATIONAL_LOG_CODES.schemaNotReady, {
      code: bootstrap.ok ? 'OMW_SCHEMA_READ_ONLY' : bootstrap.code,
      reason: bootstrap.reason,
    })
  }

  registerSection()
  // The host's session log is optional (AD-6): a harness without it still writes
  // assertions, they simply carry pointers that cannot be resolved. Resolving it
  // never fails the start — an absent capability is a degradation of one field,
  // not of the plugin.
  const sessionQuery: SessionQueryLike | undefined = (() => {
    if (typeof ctx.get !== 'function') return undefined
    try {
      return asSessionQuery(ctx.get('sessionQuery'))
    } catch {
      return undefined
    }
  })()
  const readQuote = createQuoteSource(sessionQuery)
  // The write side is a single switch: either the store took the registry and we
  // can hand a port to the tools, or we hand them nothing and they refuse.
  if (db !== undefined && schemaWritable) {
    write = createWritePort({
      db,
      audit,
      logger,
      maxNewPredsPerDay: config.tbox.maxNewPredsPerDay,
      contractVersion: SUPPORTED_CONTRACT_VERSION,
      now: nowMs,
      readQuote,
    })
  }
  // The read side needs the handle, not the seed registry: a store that refused
  // the bootstrap still answers questions about what is in it.
  if (db !== undefined) {
    evidence = createEvidenceReader({ db, readQuote })
  }
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
      ...(write === undefined ? {} : { write }),
      ...(evidence === undefined ? {} : { evidence }),
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
    return ctx.tools
  }
  return ctx.tools
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