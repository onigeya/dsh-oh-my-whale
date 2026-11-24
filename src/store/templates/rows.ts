/**
 * The one place a TQL result row becomes a stored node.
 *
 * Every template module reads the same row shape and would otherwise carry its
 * own copy of the id regex and the two coercions. A second copy is a second
 * place for an id to be read as a float or for a null payload to slip through,
 * so the conversion lives here once and names the query it came from.
 * @module
 */

/** A node as a template reads it: an engine id and an opaque payload. */
export interface StoredNode {
  /** The engine id. Stays inside the store: AR-4 keeps it out of every output. */
  readonly id: number
  /** The stored payload, unvalidated. */
  readonly payload: Record<string, unknown>
}

/** Decimals only: `Number('')` is 0, `Number('0x10')` is 16 and `Number('1e3')` is 1000. */
const DECIMAL = /^(?:0|[1-9]\d*)$/u

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
 *
 * The row shape is `{_: {id, numEdges, payload}}` with a string id. A row that
 * does not have it is a broken query or a changed engine, and reading a payload
 * out of the wrong place would turn that into a silently empty record.
 * @param row - one element of the engine's result array.
 * @param query - the template that produced it.
 * @returns the id and payload.
 * @throws when the row does not carry `_ .id` and `_ .payload`.
 */
export function toStoredNode(row: unknown, query: string): StoredNode {
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
