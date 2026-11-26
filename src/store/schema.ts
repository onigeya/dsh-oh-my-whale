/**
 * Idempotent schema bootstrap: the two indexes and the ten seed predicates.
 *
 * Bootstrap runs on every writable start, so it must be a no-op the second
 * time: an index the store already has is not created again, and a predicate
 * whose registry entry is live is not written again. The seeds go in as *one*
 * transaction, which is what makes a half-installed registry impossible — a
 * failure leaves the store with no new predicate at all, so the next start
 * simply retries the whole set.
 *
 * This module never reports a tool error: it is below the domain layer, so it
 * answers `{ok, writable}` and lets the caller decide whether to bring the write
 * surface up.
 * @module
 */
import { databaseDim, type Database } from './db.ts'
import { createAssertionTemplates } from './templates/assertions.ts'
import { NORM_VERSION, SEED_PREDICATES, buildPredicatePayload } from './tbox.ts'
import { createCommitEngine } from './commits/engine.ts'

/** The unique index that gives a business key one live version (AD-3). */
export const UNIQUE_KEY_INDEX = ['mem_key', 'active_slot'] as const

/** The history index every version scan uses. */
export const HISTORY_KEY_INDEX = ['mem_key', 'valid_from'] as const

/** What the bootstrap tells the caller. */
export type SchemaOutcome =
  | {
    /** The schema is in place and this handle may write. */
    readonly ok: true;
    readonly writable: true;
    /** Predicates this run installed; `0` on every run after the first. */
    readonly seeded: number;
    /** Time the bootstrap took, in milliseconds. */
    readonly elapsedMs: number;
  }
  | {
    /** The handle is read-only: nothing was examined beyond that fact. */
    readonly ok: true;
    readonly writable: false;
    readonly reason: string;
  }
  | {
    /** Bootstrap failed: the write surface must stay down. */
    readonly ok: false;
    readonly writable: false;
    readonly code: string;
    readonly reason: string;
    readonly elapsedMs: number;
  }

/** One bootstrap event, for the caller's audit row. */
export interface SchemaEvent {
  readonly outcome: 'bootstrap';
  readonly code: 'seed_install';
  readonly seeded: number;
  readonly elapsed_ms: number;
}

/**
 * Engine codes that mean "this handle may not write".
 *
 * A read-only handle is not a failure of the bootstrap: nothing is broken, the
 * store simply was not opened for writing. The engine reports it as an error
 * because the caller asked it to mutate, so the bootstrap has to read the code
 * to tell the two apart.
 */
const READ_ONLY_CODES = new Set(['TDB_READ_ONLY'])

/** Options for {@link ensureSchema}. */
export interface SchemaOptions {
  /** Instant of the run, injectable so a test can pin the seed timestamps. */
  readonly now?: () => number;
  /**
   * Whether the handle was opened read-only.
   *
   * A fast path, not the only detection: the engine reports a read-only handle
   * itself, and the bootstrap honours that too, because the access mode is not
   * readable from an open handle.
   */
  readonly readOnly?: boolean;
  /** Receives one event when the bootstrap actually wrote something. */
  readonly onEvent?: (event: SchemaEvent) => void;
}

/**
 * Read the failure code of a thrown engine error.
 * @param thrown - whatever the engine threw.
 * @returns its `code`, or `OMW_SCHEMA_FAILED` for an untyped failure.
 */
function failureCode(thrown: unknown): string {
  const code = (thrown as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'OMW_SCHEMA_FAILED'
}

/**
 * Read the message of a thrown engine error.
 * @param thrown - whatever the engine threw.
 * @returns the message, or the stringified value.
 */
function failureMessage(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown)
}

/**
 * Create the two indexes, skipping the ones already present.
 *
 * The engine's own creators are idempotent, but the pre-check is still worth the
 * two calls: `createUniqueCompositeIndex` on a store that already holds a
 * duplicate would fail bootstrap, and an index this bootstrap did not create is
 * an index whose shape this build should not assume.
 * @param db - an open, writable handle.
 */
function ensureIndexes(db: Database): void {
  const unique = db.listUniqueIndexes()
  const wantsUnique = unique.some(fields =>
    fields.length === UNIQUE_KEY_INDEX.length
    && fields.every((field, position) => field === UNIQUE_KEY_INDEX[position]),
  )
  if (!wantsUnique) db.createUniqueCompositeIndex([...UNIQUE_KEY_INDEX])

  const plain = db.indexInfo()
  const wantsHistory = plain.some(info =>
    info.kind === 'composite'
    && info.fields.length === HISTORY_KEY_INDEX.length
    && info.fields.every((field, position) => field === HISTORY_KEY_INDEX[position]),
  )
  if (!wantsHistory) db.createCompositeIndex([...HISTORY_KEY_INDEX])
}

/**
 * Bring one writable handle to the schema this story needs.
 *
 * The order is indexes first, seeds second: the seed insert is the only place a
 * duplicate `mem_key` could exist, and the unique index is what refuses it. A
 * read-only handle writes nothing and answers `{ok: true, writable: false}`,
 * which is how the caller learns to leave the write surface down.
 *
 * The access mode is not readable from an open handle, so this function does not
 * rely on the flag alone: the engine refuses the first mutation with a read-only
 * code, and that refusal is translated into the same answer.
 * @param db - the open handle.
 * @param options - clock, access mode and event sink.
 * @returns whether the handle may write, and how much this run installed.
 */
export function ensureSchema(db: Database, options: SchemaOptions = {}): SchemaOutcome {
  if (options.readOnly === true) {
    return { ok: true, writable: false, reason: '只读句柄：不建索引、不写种子' }
  }
  const now = options.now ?? Date.now
  const startedAt = now()
  try {
    ensureIndexes(db)
  } catch (thrown) {
    // A handle that may not write is not a broken schema: report the read-only
    // case, so the caller skips the write surface for the reason it actually
    // has instead of logging an index failure that never happened.
    if (READ_ONLY_CODES.has(failureCode(thrown))) {
      return { ok: true, writable: false, reason: '只读句柄：不建索引、不写种子' }
    }
    return {
      ok: false,
      writable: false,
      code: failureCode(thrown),
      reason: `建索引失败：${failureMessage(thrown)}`,
      elapsedMs: now() - startedAt,
    }
  }
  const templates = createAssertionTemplates(db)
  const nowMs = now()
  const nowIso = new Date(nowMs).toISOString()
  /** Seeds whose registry entry is absent; a live entry is left alone. */
  const missing = SEED_PREDICATES.filter(seed => templates.findPredByName(seed.name) === undefined)
  if (missing.length === 0) {
    return { ok: true, writable: true, seeded: 0, elapsedMs: now() - startedAt }
  }
  const engine = createCommitEngine(db, databaseDim(db))
  const operations = missing.map(seed => ({
    type: 'insert' as const,
    vector: [...engine.zeroVector],
    payload: buildPredicatePayload({
      name: seed.name,
      cardinality: seed.cardinality,
      status: 'active',
      aliases: [],
      decidedBy: 'seed',
      decidedAt: nowIso,
      normVersion: NORM_VERSION,
      activeSlot: 1,
      recordedAt: nowIso,
      validFrom: nowIso,
    }),
  }))
  const committed = engine.commit(operations)
  const elapsedMs = now() - startedAt
  if (!committed.ok) {
    const failure = committed.failure
    if (failure.kind === 'read-only') {
      return { ok: true, writable: false, reason: '只读句柄：不建索引、不写种子' }
    }
    return {
      ok: false,
      writable: false,
      code: failure.kind === 'engine' ? failure.code : `OMW_SCHEMA_${failure.kind.toUpperCase()}`,
      reason: `写种子谓词失败（${failure.kind}），注册表保持为空`,
      elapsedMs,
    }
  }
  options.onEvent?.({ outcome: 'bootstrap', code: 'seed_install', seeded: missing.length, elapsed_ms: elapsedMs })
  return { ok: true, writable: true, seeded: missing.length, elapsedMs }
}
