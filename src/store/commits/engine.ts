/**
 * The only module that calls an engine write method (AD-4, AD-15).
 *
 * Every write in the process funnels through here, which is what lets the
 * static gate say "`commitTransaction` appears in `store/commits/**` and
 * nowhere else". The engine reports a broken uniqueness rule as a *typed*
 * exception whose `details` quote two node ids; those ids never leave the
 * process (AD-3), so the failure is translated here into a shape the caller can
 * act on without string matching.
 *
 * A transaction that fails is not retried. `write.outcome` says whether the
 * batch landed (`committed`), certainly did not (`not_committed`), or cannot be
 * known (`unknown`); a caller that retried an `unknown` batch could write twice,
 * so the outcome is carried out verbatim and the queue stops instead.
 *
 * This module imports nothing from `src/core/`: the store layer below it may
 * not depend on the domain layer above (AD-15), so a failure is a *value* here
 * and `src/core/tool-errors.ts` turns it into the closed tool vocabulary.
 * @module
 */
import type { TransactionOperation, Vector } from 'triviumdb'
import type { Database } from '../db.ts'

/** Fields the engine names in a uniqueness violation. */
export interface UniqueConflictDetails {
  readonly fields: readonly string[]
  /**
   * The node already holding the key, when the engine said so.
   *
   * Optional because an id is evidence, not a reason to fail: a violation
   * whose id this build cannot read is still a violation, and throwing here
   * would escape a function that only ever returns an outcome.
   */
  readonly existingId?: number
  readonly conflictingId?: number
}

/** Why a write could not be committed. */
export type WriteFailure =
  | {
    /** A live version of this `mem_key` already exists. */
    readonly kind: 'unique'
    readonly details: UniqueConflictDetails
  }
  | {
    /** The handle is read-only: this installation cannot write at all. */
    readonly kind: 'read-only'
    readonly operation: string
  }
  | {
    /** The handle is closed: the runtime is shutting down or gate-down. */
    readonly kind: 'closed'
  }
  | {
    /** Anything else the engine refused, carried without its message. */
    readonly kind: 'engine'
    readonly code: string
    /** Whether the batch landed; `undefined` when the engine did not say. */
    readonly outcome: 'not_committed' | 'unknown' | 'committed' | undefined
  }

/** A write that either produced a value or failed a named way. */
export type WriteOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: WriteFailure }

/** Codes that mean "this installation is not writable", not "this write is bad". */
const GATE_DOWN_CODES = new Set<unknown>(['TDB_READ_ONLY', 'TDB_DATABASE_CLOSED', 'TDB_SHUTDOWN_FAILED'])

/** The engine's error shape, as far as this module reads it. */
interface EngineError {
  readonly code?: unknown
  readonly details?: unknown
  readonly write?: { readonly outcome?: unknown }
}

/**
 * Narrow one thrown value to the engine's error shape.
 * @param thrown - whatever the engine threw.
 * @returns the error, or `undefined` when it is not shaped like one.
 */
function asEngineError(thrown: unknown): EngineError | undefined {
  if (typeof thrown !== 'object' || thrown === null) return undefined
  return thrown as EngineError
}

/**
 * Read a non-negative integer the engine may have stringified.
 *
 * `ErrorInteger` is `number | string` because a node id can exceed 2^53; an id
 * this store wrote came from `insert` and therefore fits, but the conversion is
 * still explicit so a malformed value fails loudly instead of becoming `NaN`.
 * The id is read, not kept: the failure only reports that two nodes collided.
 * @param raw - the value from the engine.
 * @returns the id.
 * @throws when the value is not a non-negative safe integer.
 */
function toErrorId(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return raw
  if (typeof raw === 'string' && /^(?:0|[1-9]\d*)$/.test(raw)) {
    const parsed = Number(raw)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  return undefined
}

/**
 * Translate one engine exception into a failure.
 *
 * The engine message is not copied: it names node ids, and a message that is
 * merely *likely* to be scrubbed is not the same as one that never carried an
 * id. Only the code and the write outcome survive, and the outcome is what
 * decides whether a caller may retry.
 * @param thrown - whatever the engine threw.
 * @param operation - the engine method that threw, for the message.
 * @returns the failure.
 */
function translate(thrown: unknown, operation: string): WriteFailure {
  const error = asEngineError(thrown)
  const code = typeof error?.code === 'string' ? error.code : 'TDB_ERROR'
  const outcome = error?.write?.outcome
  const writeOutcome = outcome === 'not_committed' || outcome === 'unknown' || outcome === 'committed'
    ? outcome
    : undefined
  if (code === 'TDB_UNIQUE_CONSTRAINT') {
    const details = (error?.details ?? {}) as {
      fields?: unknown;
      existing_id?: unknown;
      conflicting_id?: unknown;
    }
    const fields = Array.isArray(details.fields)
      ? details.fields.filter((field): field is string => typeof field === 'string')
      : []
    return {
      kind: 'unique',
      details: {
        fields,
        existingId: toErrorId(details.existing_id),
        conflictingId: toErrorId(details.conflicting_id),
      },
    }
  }
  if (code === 'TDB_READ_ONLY') return { kind: 'read-only', operation }
  if (GATE_DOWN_CODES.has(code)) return { kind: 'closed' }
  return { kind: 'engine', code, outcome: writeOutcome }
}

/** The write side of one open handle, plus the zero vector it writes. */
export interface CommitEngine {
  /** The zero vector every pending assertion is written with (AD-19). */
  readonly zeroVector: Vector
  /**
   * Commit one batch, or fail whole.
   * @param operations - the batch, in write order.
   * @returns the node ids the engine assigned.
   */
  commit(operations: readonly TransactionOperation[]): WriteOutcome<readonly number[]>
  /**
   * Replace one node's payload.
   * @param nodeId - the node to update.
   * @param payload - the complete new payload.
   */
  replacePayload(nodeId: number, payload: Record<string, unknown>): WriteOutcome<void>
  /**
   * Close the handle, reporting why when the engine refuses.
   * @returns the failure, or `undefined` when the handle closed.
   */
  close(): WriteFailure | undefined
}

/**
 * Wrap one open handle in the commit engine.
 *
 * Preparation is per handle: the zero vector is allocated once, so a write path
 * does not allocate a 1024-element array per assertion.
 * @param db - an open, writable handle.
 * @param dim - the vector dimension of the handle.
 * @returns the engine.
 */
export function createCommitEngine(db: Database, dim: number): CommitEngine {
  const zeroVector: Vector = new Array<number>(dim).fill(0)
  return {
    zeroVector,
    commit(operations: readonly TransactionOperation[]): WriteOutcome<readonly number[]> {
      // An empty batch is a caller bug, not an empty success: the engine would
      // reject it, and reporting it as a write would hide the bug.
      if (operations.length === 0) {
        return { ok: false, failure: { kind: 'engine', code: 'TDB_INVALID_INPUT', outcome: 'not_committed' } }
      }
      try {
        return { ok: true, value: db.commitTransaction([...operations]) }
      } catch (thrown) {
        return { ok: false, failure: translate(thrown, 'commitTransaction') }
      }
    },
    replacePayload(nodeId: number, payload: Record<string, unknown>): WriteOutcome<void> {
      try {
        db.updatePayload(nodeId, payload)
        return { ok: true, value: undefined }
      } catch (thrown) {
        return { ok: false, failure: translate(thrown, 'updatePayload') }
      }
    },
    close(): WriteFailure | undefined {
      try {
        db.close()
        return undefined
      } catch (thrown) {
        return translate(thrown, 'close')
      }
    },
  }
}

/**
 * Build the write operations for one planned batch.
 *
 * Retirement precedes insertion: a `pred` node and its flag come before the
 * assertion that needs them, and a superseded version is retired before the
 * replacement is inserted, so the unique index never sees two live versions of
 * one key inside the batch.
 * @param input - the nodes and updates a plan produced.
 * @returns the engine batch.
 */
export function toTransactionOperations(input: {
  readonly zeroVector: Vector;
  readonly inserts: readonly { readonly payload: Record<string, unknown> }[];
  readonly updates: readonly { readonly nodeId: number; readonly payload: Record<string, unknown> }[];
}): TransactionOperation[] {
  const operations: TransactionOperation[] = []
  for (const update of input.updates) {
    operations.push({ type: 'updatePayload', id: update.nodeId, payload: update.payload })
  }
  for (const insert of input.inserts) {
    operations.push({ type: 'insert', vector: [...input.zeroVector], payload: insert.payload })
  }
  return operations
}
