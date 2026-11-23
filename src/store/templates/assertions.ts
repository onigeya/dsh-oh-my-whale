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
import type { Database } from '../db.ts'

/** The single live version of one business key. */
export const LIVE_BY_KEY_QUERY =
  'FIND {superseded_at: {$exists: false}} WHERE mem_key == $mem_key RETURN *'

/** Every version of one business key, live or retired. */
export const VERSIONS_BY_KEY_QUERY =
  'FIND {active_slot: {$gte: 0}} WHERE mem_key == $mem_key RETURN *'

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

/** Business key of the registry entry for one predicate name. */
export function predicateMemKey(name: string): string {
  return `pred:${name}`
}

/** One unwrapped store row: the node id plus its payload. */
export interface StoredNode {
  readonly id: number
  readonly payload: Readonly<Record<string, unknown>>
}

/** Decimals only: `Number('')` is 0, `Number('0x10')` is 16 and `Number('1e3')` is 1000. */
const DECIMAL = /^(?:0|[1-9]\d*)$/

/**
 * Read a row's node id, rejecting every shape `Number()` would silently accept.
 * @param raw - the `_ .id` value as the engine returned it.
 * @param query - the template that produced the row, for the failure message.
 * @returns the id as a number.
 * @throws when the id is not a plain decimal integer.
 */
function toNodeId(raw: unknown, query: string): number {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return raw
  if (typeof raw === 'string' && DECIMAL.test(raw)) {
    const parsed = Number(raw)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  throw new Error(`omw: 模板返回的节点 id 不是十进制整数：${JSON.stringify(raw)}（${query}）`)
}

/**
 * Unwrap one engine row, or throw.
 * @param row - one element of the engine's result array.
 * @param query - the template that produced it.
 * @returns the id and payload.
 * @throws when the row does not carry `_ .id` and `_ .payload`.
 */
function toStoredNode(row: unknown, query: string): StoredNode {
  if (typeof row !== 'object' || row === null) {
    throw new Error(`omw: 模板返回的行不是对象：${JSON.stringify(row)}（${query}）`)
  }
  const meta = (row as { _?: unknown })._
  if (typeof meta !== 'object' || meta === null) {
    throw new Error(`omw: 模板返回的行缺少 _ 元数据：${JSON.stringify(row)}（${query}）`)
  }
  const id = toNodeId((meta as { id?: unknown }).id, query)
  const payload = (meta as { payload?: unknown }).payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`omw: 模板返回的行缺少 _ .payload 对象：${JSON.stringify(row)}（${query}）`)
  }
  return { id, payload: payload as Record<string, unknown> }
}

/** The four reads the write path needs, each over one literal template. */
export interface AssertionTemplates {
  /** The live version of one key, or `undefined` when the key is unused. */
  findLiveByKey(memKey: string): StoredNode | undefined
  /** Every version of one key, in engine order. */
  findAllVersionsByKey(memKey: string): readonly StoredNode[]
  /** The live registry entry for one predicate name, or `undefined`. */
  findPredByName(name: string): StoredNode | undefined
  /** Every model-proposed predicate decided at or after `sinceIso`. */
  findModelPredsSince(sinceIso: string): readonly StoredNode[]
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
  const pred = db.prepareTql(PRED_BY_NAME_QUERY)
  const since = db.prepareTql(MODEL_PREDS_SINCE_QUERY)
  const rows = (prepared: typeof live, parameters: Record<string, string>): readonly unknown[] =>
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
  }
}
