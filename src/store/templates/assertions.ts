/**
 * The only place TQL literals live (AD-8, AD-15).
 *
 * A prepared TQL statement's first argument must be a literal, so the live
 * filter cannot be composed at run time: it is repeated in each template here
 * and the static gate restricts `$exists` to this directory. Parameters may
 * only appear to the right of `WHERE`, and a prepared statement rejects any
 * parameter it does not reference — so each reader passes exactly its own
 * parameter list, never a superset.
 *
 * Rows come back as `{_: {id, numEdges, payload}}` with a *string* id. A row
 * that does not have that shape is a read fault and is thrown, never skipped:
 * a store that returns a partial answer would let a caller believe a key is
 * absent and write a second live version of it.
 * @module
 */
import { toStoredNode, type StoredNode } from './rows.ts'
import type { Database } from '../db.ts'

/** The single live version of one business key. */
export const LIVE_BY_KEY_QUERY =
  'FIND {superseded_at: {$exists: false}} WHERE mem_key == $mem_key RETURN *'

/** Every version of one business key, live or retired. */
export const VERSIONS_BY_KEY_QUERY =
  'FIND {active_slot: {$gte: 0}} WHERE mem_key == $mem_key RETURN *'

/**
 * The versions of one key whose slot is at or above an instant.
 *
 * A retirement slot is the millisecond of the rewrite, so every slot below the
 * instant in hand was spent by a rewrite that already happened and cannot
 * constrain the next one: the next slot is `nowMs` whatever those slops were. Only
 * the slots at or above `since` can force a bump past the clock, and there are at
 * most as many of them as rewrites landed inside the current millisecond. Asking
 * for those few keeps the write path flat however long the version chain grows.
 */
export const VERSIONS_SINCE_SLOT_QUERY =
  'FIND {active_slot: {$gte: 0}} WHERE mem_key == $mem_key AND active_slot >= $since RETURN *'

/** The live registry entry naming one predicate. */
export const PRED_BY_NAME_QUERY =
  'FIND {kind: "pred", superseded_at: {$exists: false}} WHERE mem_key == $mem_key RETURN *'

/**
 * Every live model-proposed predicate decided at or after one instant.
 *
 * Live-only on purpose: the daily budget bounds how many registry entries the
 * model keeps, and an entry this installation already retired must not go on
 * consuming that budget after it stopped existing.
 */
export const MODEL_PREDS_SINCE_QUERY =
  'FIND {kind: "pred", decided_by: "model", superseded_at: {$exists: false}} WHERE decided_at >= $since RETURN *'

/**
 * Every ledger entry in the store.
 *
 * Not one query per key on purpose: a decision names its target *and* every key
 * it touched in `affected`, and TQL has no containment operator, so a pointer
 * written alongside an assertion is only reachable through the array. Reading
 * the ledger whole and filtering in memory keeps one code path for both
 * questions; the ledger is append-only and only a person asking `/omw ledger`
 * ever reads it, so the scan is not on any write or recall path.
 */
export const DECISIONS_ALL_QUERY = 'FIND {kind: "decision"} RETURN *'

/** Business key of the registry entry for one predicate name. */
export function predicateMemKey(name: string): string {
  return `pred:${name}`
}

/** Re-exported so callers of this module need not know where rows are unwrapped. */
export type { StoredNode }

/** The four reads the write path needs, each over one literal template. */
export interface AssertionTemplates {
  /** The live version of one key, or `undefined` when the key is unused. */
  findLiveByKey(memKey: string): StoredNode | undefined
  /** Every version of one key, in engine order. */
  findAllVersionsByKey(memKey: string): readonly StoredNode[]
  /** The versions of one key whose `active_slot` is at or above `sinceMs`. */
  findVersionsSinceSlot(memKey: string, sinceMs: number): readonly StoredNode[]
  /** The live registry entry for one predicate name, or `undefined`. */
  findPredByName(name: string): StoredNode | undefined
  /** Every model-proposed predicate decided at or after `sinceIso`. */
  findModelPredsSince(sinceIso: string): readonly StoredNode[]
  /** Every ledger entry in the store. */
  findAllDecisions(): readonly StoredNode[]
}

/**
 * Prepare the four templates against a live handle.
 *
 * Preparation happens once per handle: the engine stores the parsed query, and
 * re-preparing per call would put the parser on the write path.
 * @param db - an open handle.
 * @returns the readers.
 */
export function createAssertionTemplates(db: Database): AssertionTemplates {
  const live = db.prepareTql(LIVE_BY_KEY_QUERY)
  const versions = db.prepareTql(VERSIONS_BY_KEY_QUERY)
  const versionsSince = db.prepareTql(VERSIONS_SINCE_SLOT_QUERY)
  const pred = db.prepareTql(PRED_BY_NAME_QUERY)
  const since = db.prepareTql(MODEL_PREDS_SINCE_QUERY)
  const decisions = db.prepareTql(DECISIONS_ALL_QUERY)
  const rows = (
    prepared: typeof live,
    parameters: Record<string, string | number>,
  ): readonly unknown[] =>
    db.executePreparedTql(prepared, parameters) as readonly unknown[]
  return {
    findLiveByKey(memKey: string): StoredNode | undefined {
      const found = rows(live, { mem_key: memKey }).map(row => toStoredNode(row, LIVE_BY_KEY_QUERY))
      if (found.length > 1) {
        throw new Error(`omw: 业务键 ${memKey} 有 ${found.length} 条未失效版本，唯一索引被绕过`)
      }
      return found[0]
    },
    findAllVersionsByKey(memKey: string): readonly StoredNode[] {
      return rows(versions, { mem_key: memKey }).map(row => toStoredNode(row, VERSIONS_BY_KEY_QUERY))
    },
    findVersionsSinceSlot(memKey: string, sinceMs: number): readonly StoredNode[] {
      const found = rows(versionsSince, { mem_key: memKey, since: sinceMs })
        .map(row => toStoredNode(row, VERSIONS_SINCE_SLOT_QUERY))
      return found
    },
    findPredByName(name: string): StoredNode | undefined {
      const found = rows(pred, { mem_key: predicateMemKey(name) })
        .map(row => toStoredNode(row, PRED_BY_NAME_QUERY))
      if (found.length > 1) {
        throw new Error(`omw: 谓词 ${name} 有 ${found.length} 条未失效登记，唯一索引被绕过`)
      }
      return found[0]
    },
    findModelPredsSince(sinceIso: string): readonly StoredNode[] {
      return rows(since, { since: sinceIso }).map(row => toStoredNode(row, MODEL_PREDS_SINCE_QUERY))
    },
    findAllDecisions(): readonly StoredNode[] {
      return rows(decisions, {}).map(row => toStoredNode(row, DECISIONS_ALL_QUERY))
    },
  }
}
