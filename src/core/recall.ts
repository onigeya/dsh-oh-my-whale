/**
 * Bounds for one recall call, decided before the store is touched.
 *
 * Three numbers were previously declared twice: `seams/config.ts` carried the
 * default, `store/search.ts` carried its own copy plus a cap, and the second copy
 * silently clamped an out-of-range `topK` with `Math.min`. Both are gone; this
 * module is the only declaration, and it sits in `core` because `store` may not
 * import `seams` and both sides need the same numbers (AD-26).
 *
 * Nothing here opens a query. A call that is out of bounds is refused here, so
 * AC② — "returns E_BOUNDARY and runs no query" — holds by construction rather
 * than by remembering to check the order of operations.
 * @module
 */

/** Result count when the caller names none (AD-8). */
export const DEFAULT_TOP_K = 5

/** Hard ceiling on the result count (AD-8). */
export const MAX_TOP_K = 8

/**
 * How many scored nodes enter the candidate pool (AD-8 tier ①).
 *
 * Distinct from {@link DEFAULT_TOP_K}: the pool is the outer gate that bounds
 * how much the (Epic 5) reranker may see, and the result count is the inner gate
 * that bounds what reaches the model. Collapsing the two is what made this
 * configuration key unreadable-by-accident: nothing consumed it.
 */
export const DEFAULT_CANDIDATE_POOL = 12

/**
 * Hard ceiling on the candidate pool.
 *
 * The pool is the outer gate: it bounds what the reranker may ever see, so its
 * ceiling is a cost ceiling, not a taste one. It is enforced at configuration
 * load and nowhere else — the reader is handed a pool it can trust, exactly as
 * it trusts the result count, because refusing to clamp meant also refusing to
 * leave the number unchecked (AD-26).
 */
export const MAX_CANDIDATE_POOL = 50

/**
 * Hard ceiling on the query text a recall accepts, in code points after trim.
 *
 * A query is a search phrase, not a document: the scan tests every token against
 * every live node's text fields, so cost grows with tokens × nodes × field
 * length. A caller that pastes a paragraph should split it into queries rather
 * than have the reader quietly spend the whole budget on one call. 200 is the
 * same ruler the evidence quote uses, so the two limits do not disagree.
 */
export const MAX_QUERY_CHARS = 200

/** A refusal or an accepted value, with the reason the caller can act on. */
export type Bounded<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string }

/**
 * Validate a `topK` argument.
 *
 * Refuses rather than clamps. `topK: 30` must not quietly become 8: the caller
 * cannot tell that from "only 8 matched", and AC② calls the difference an error.
 * A numeric string is refused too — the host does not validate tool arguments
 * against the advertised schema, so `'5'` reaches us as-is and coercion would be
 * us inventing a contract the schema does not state.
 * @param raw - the value the caller supplied, or `undefined` to accept the default.
 * @returns the accepted count, or why it was refused.
 */
export function checkRecallBounds(raw: unknown): Bounded<number> {
  if (raw === undefined) return { ok: true, value: DEFAULT_TOP_K }
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    return { ok: false, reason: `topK 必须是整数，收到 ${describe(raw)}` }
  }
  if (raw < 1) return { ok: false, reason: `topK 至少为 1，收到 ${raw}` }
  if (raw > MAX_TOP_K) return { ok: false, reason: `topK 最多为 ${MAX_TOP_K}，收到 ${raw}` }
  return { ok: true, value: raw }
}

/**
 * Validate the query argument.
 *
 * An empty or blank query is refused, not treated as "match everything". The
 * older scan scored an empty query as a hit on every node, which is defensible
 * for an internal probe and wrong for a tool the model can call: it would dump
 * the whole store into one answer.
 * @param raw - the value the caller supplied.
 * @returns the trimmed query, or why it was refused.
 */
export function checkRecallQuery(raw: unknown): Bounded<string> {
  if (typeof raw !== 'string') return { ok: false, reason: `query 必须是字符串，收到 ${describe(raw)}` }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'query 不能为空' }
  // Counted in code points, not UTF-16 units: a Chinese query of 200 characters
  // must not be refused for being 200 code points but 200 units — or accepted
  // for being 100 emoji that happen to occupy 200 units.
  const length = [...trimmed].length
  if (length > MAX_QUERY_CHARS) {
    return { ok: false, reason: `query 最多 ${MAX_QUERY_CHARS} 个字符，收到 ${length}` }
  }
  // Punctuation is not empty, so it survives the blank test, but the scanner
  // splits on it and gets no tokens at all: the answer would be `ok: true` with
  // zero hits, which a caller cannot tell from "no such memory". Refused here,
  // beside every other boundary, rather than left to a guard deeper in.
  if (!/[\p{L}\p{N}]/u.test(trimmed)) {
    return { ok: false, reason: 'query 至少要有一个字母或数字' }
  }
  return { ok: true, value: trimmed }
}

/**
 * Describe a value for a refusal message without dumping a large object.
 * @param value - whatever the caller passed.
 * @returns a short, type-bearing description.
 */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const type = typeof value
  if (type === 'string') {
    const text = value as string
    return `字符串 "${text.length > 20 ? `${text.slice(0, 20)}…` : text}"`
  }
  if (type === 'number' || type === 'boolean') return `${type} ${String(value)}`
  return type
}
