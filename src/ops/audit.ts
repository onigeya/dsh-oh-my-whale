/**
 * The audit surface: append-only JSONL, split by local calendar day (AD-20).
 *
 * Audit rows are evidence, never control flow — but they are not lossy either:
 * validation failures throw at append time, because a row naming an outcome, a
 * tier or a degraded reason this build does not define would be written and then
 * read back by something that cannot interpret it. File writes are a different
 * matter: they go through a serial queue ({@link createAppendAuditSink}), so an
 * injection never waits for a disk. {@link Audit.flush} is where a failed write
 * finally surfaces, and callers on a non-critical path log it and carry on
 * (AD-18 local degradation).
 * @module
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { auditFileName } from '../seams/config.ts'
import { DEGRADED_REASONS, isDegradedReason, type DegradedReason } from '../core/degrade.ts'

/**
 * The closed list of injection tiers (AD-7, AD-20).
 *
 * A tier names which channels actually landed in one assembly, not which ones
 * were attempted: `identity` means the identity section was the only thing on the
 * wire. Recall joined the list with P0-1 — until then it had no channel, so a
 * tier naming it described something nothing wrote.
 */
export const INJECTION_TIERS = ['identity', 'identity+state', 'identity+recall', 'identity+state+recall'] as const

/** One injection tier. */
export type InjectionTier = (typeof INJECTION_TIERS)[number]

/**
 * One row recording what was injected into a prompt (AD-20).
 *
 * The three `host_cache_*` fields are the host's own token accounting, taken as
 * a per-session delta: `null` means the host could not say, which is not the same
 * fact as `0` (that one round genuinely hit no cache). Mixing the two would make
 * the hit rate in `scripts/audit-report.mjs` look better than it is.
 *
 * `items[]` carries unit names (`identity`, `state:preference`), never `mem_key`s:
 * an injection is a set of prompt units, and a business key belongs to the recall
 * row that returned it. `session_id` is the host's session, not a node id.
 */
export interface InjectionAuditRow {
  readonly kind: 'injection'
  readonly ts: string
  readonly session_id: string
  readonly tier: InjectionTier
  readonly chars: number
  readonly tokens: number
  readonly items: readonly string[]
  readonly truncated: boolean
  readonly prefix_unchanged: boolean
  /**
   * Wall time of this assembly, whole milliseconds (P0-8).
   *
   * The injection tier is the one number `omw-stats` could not compute before:
   * every other row carries its own duration, and this one did not. The provider
   * that assembles the prompt is the only place both ends of the measurement are
   * visible, so it hands the number over rather than the row guessing.
   */
  readonly elapsed_ms: number
  readonly host_cache_read: number | null
  readonly host_cache_write: number | null
  readonly host_cache_uncached: number | null
}
/**
 * One row recording a recall, including why it was degraded (AD-20).
 *
 * `session_id` is here for one reason: a recall is the only channel through which
 * a session ever reads memory, so without the session a report cannot say which
 * conversation the hit rate belongs to. It is the host session, never a node id
 * (AD-3). Rows written by a host that hands the tool no execution context carry
 * the empty string rather than a made-up id.
 */
export interface RecallAuditRow {
  readonly kind: 'recall'
  readonly ts: string
  /** The host session the tool call came from; empty when the host gave none. */
  readonly session_id: string
  /** Digest of the query, never the query: a recall line may leave the machine (NFR-6). */
  readonly query_hash: string
  /** The result count that was applied. Snake case like every other key. */
  readonly top_k: number
  /** `mem_key`s of the returned hits; node ids never leave the store (AD-3). */
  readonly hits: readonly string[]
  readonly elapsed_ms: number
  readonly degraded: boolean
  readonly degraded_reason: readonly DegradedReason[]
}

/** How a write ended. */
export const WRITE_OUTCOMES = ['committed', 'rejected', 'downgraded', 'bootstrap'] as const

/** One write outcome. */
export type WriteOutcomeKind = (typeof WRITE_OUTCOMES)[number]

/**
 * One row recording a write (AD-20).
 *
 * The keys, never the node ids: a row is evidence that can leave the machine,
 * and an id is only meaningful inside one database file (AD-3). `outcome` says
 * whether anything landed, `code` says why when nothing did or when a fact was
 * kept in a degraded shape, and `mem_keys` is empty whenever the write failed —
 * a key listed here is a key a reader may rely on being present.
 */
export interface WriteAuditRow {
  readonly kind: 'write'
  readonly ts: string
  readonly outcome: WriteOutcomeKind
  readonly code: string
  readonly mem_keys: readonly string[]
  readonly elapsed_ms: number
}

/** Any row this module can write. */
export type AuditRow = InjectionAuditRow | RecallAuditRow | WriteAuditRow

/** Destination of rendered audit rows. */
export interface AuditSink {
  write(file: string, line: string): void
}

/** A sink that can say when its queue has drained. */
export interface FlushableAuditSink extends AuditSink {
  /**
   * Wait for every queued write to land.
   * @throws the first write error since the previous flush; those rows are lost.
   */
  flush(): Promise<void>
}

/**
 * A sink that appends to a file through a serial queue, creating directories as needed.
 *
 * `write` only enqueues, so the injection path never waits on a disk (AD-20 asks
 * for exactly that). Errors are held rather than thrown at the caller: there is
 * no caller left to catch them, and the queue must keep draining so one failed
 * append does not become a permanently broken audit. {@link FlushableAuditSink.flush}
 * is the single place a failure surfaces.
 */
export function createAppendAuditSink(): FlushableAuditSink {
  let queue: Promise<void> = Promise.resolve()
  let failures: unknown[] = []
  // One directory is created once, not once per row: the facade writes every row
  // of a day into the same file, so a second `mkdir` for the same path is a
  // wasted syscall on the hot path of a long-running mount.
  const ensured = new Set<string>()
  let ensuring: Promise<void> = Promise.resolve()
  const append = async (file: string, line: string): Promise<void> => {
    const directory = join(file, '..')
    if (!ensured.has(directory)) {
      // Serialised through the same queue as the writes, so two rows racing for
      // the same missing directory do not both call `mkdir`.
      ensuring = ensuring.then(() => mkdir(directory, { recursive: true })).then(() => { ensured.add(directory) })
      await ensuring
    }
    await appendFile(file, line, 'utf8')
  }
  return {
    write(file: string, line: string): void {
      queue = queue.then(() => append(file, line)).catch((error: unknown) => {
        failures.push(error)
      })
    },
    async flush(): Promise<void> {
      await queue
      const first = failures[0]
      failures = []
      if (first !== undefined) throw first
    },
  }
}

/** Create an in-memory audit sink, for tests. */
export function createMemoryAuditSink(): AuditSink & { readonly writes: { file: string; line: string }[] } {
  const writes: { file: string; line: string }[] = []
  return {
    writes,
    write(file: string, line: string): void { writes.push({ file, line }) },
  }
}

/**
 * Whether a sink can report the state of its queue.
 * @param sink - any sink.
 * @returns true when it has a `flush`.
 */
export function isFlushableSink(sink: AuditSink): sink is FlushableAuditSink {
  return typeof (sink as Partial<FlushableAuditSink>).flush === 'function'
}

/**
 * Reject any write row naming an outcome outside the closed vocabulary.
 * @param row - the candidate row.
 * @throws when `outcome` is not one of {@link WRITE_OUTCOMES}.
 */
export function assertClosedOutcome(row: WriteAuditRow): void {
  if (!(WRITE_OUTCOMES as readonly string[]).includes(row.outcome)) {
    throw new Error(`unknown write outcome ${JSON.stringify(row.outcome)}; closed set is ${WRITE_OUTCOMES.join(', ')}`)
  }
}

/**
 * Reject any row naming a reason outside the closed vocabulary.
 * @param row - the candidate row.
 * @throws when `degraded_reason` contains a value this epic does not define.
 */
export function assertClosedReasons(row: RecallAuditRow): void {
  for (const reason of row.degraded_reason) {
    if (!isDegradedReason(reason)) {
      throw new Error(`unknown degraded_reason ${JSON.stringify(reason)}; closed set is ${DEGRADED_REASONS.join(', ')}`)
    }
  }
}

/**
 * Reject any injection row naming a tier outside the closed vocabulary.
 * @param row - the candidate row.
 * @throws when `tier` is not one of {@link INJECTION_TIERS}.
 */
export function assertClosedTier(row: InjectionAuditRow): void {
  if (!(INJECTION_TIERS as readonly string[]).includes(row.tier)) {
    throw new Error(`unknown injection tier ${JSON.stringify(row.tier)}; closed set is ${INJECTION_TIERS.join(', ')}`)
  }
}

/** The audit facade. */
export interface Audit {
  /** Append one row to today's file. */
  append(row: AuditRow): { readonly file: string; readonly row: AuditRow }
  /** Absolute path of the file for one instant (defaults to now). */
  path(date?: Date): string
  /** Wait for queued writes; a no-op for a sink without a queue. */
  flush(): Promise<void>
  /**
   * The most recent rows appended through this facade, in order.
   *
   * Bounded by {@link AUDIT_ROWS_RETAINED}: the authoritative copy is the file,
   * and an observation window is not worth a leak.
   */
  readonly rows: readonly AuditRow[]
}

/**
 * How many recent rows {@link Audit.rows} keeps.
 *
 * The rows are also on disk; the in-memory copy exists so a test (and a live
 * handle) can look at what was just written without touching the filesystem.
 * A long-running mount appends one row per assembly, so keeping every row for
 * the life of the process would be a memory leak with a very slow fuse.
 */
export const AUDIT_ROWS_RETAINED = 1000

/** Options for {@link createAudit}. */
export interface AuditOptions {
  /** Directory holding `audit-YYYYMMDD.jsonl`. */
  readonly dataDir: string
  readonly now?: () => Date
  readonly sink?: AuditSink
}

/**
 * Create the audit facade.
 * @param options - directory, clock and sink.
 * @returns the facade; rows are also retained in memory for observation.
 */
export function createAudit(options: AuditOptions): Audit {
  const now = options.now ?? (() => new Date())
  const sink = options.sink ?? createAppendAuditSink()
  const rows: AuditRow[] = []
  const pathOf = (date: Date): string => join(options.dataDir, auditFileName(date))
  return {
    /**
     * A snapshot, not the live array: the caller must not be able to append by
     * pushing, and a retained row must not change under a reader that took it.
     */
    get rows(): readonly AuditRow[] {
      return rows.slice()
    },
    path: (date: Date = now()) => pathOf(date),
    append(row: AuditRow): { readonly file: string; readonly row: AuditRow } {
      if (row.kind === 'recall') assertClosedReasons(row)
      if (row.kind === 'write') assertClosedOutcome(row)
      if (row.kind === 'injection') assertClosedTier(row)
      // The file follows the row's own instant. Reading the clock again here
      // would file a row whose `ts` is 23:59:59.999 under the next day's name,
      // and the row would contradict the file it lives in.
      const file = pathOf(new Date(row.ts))
      rows.push(row)
      if (rows.length > AUDIT_ROWS_RETAINED) rows.shift()
      sink.write(file, `${JSON.stringify(row)}\n`)
      return { file, row }
    },
    async flush(): Promise<void> {
      if (isFlushableSink(sink)) await sink.flush()
    },
  }
}