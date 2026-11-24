/**
 * The non-vector retrieval path.
 *
 * It exists for two reasons: the vector path can be closed (`vector-off`) while
 * text retrieval must still return results, and the audit tests need a
 * retrieval that is deterministic and free of network or model calls.
 *
 * This is a deliberately schema-agnostic scan: Epic 1 defines no business node
 * shape, so matching any textual payload field is the only honest option. Epic
 * 2 builds the real recall on top of `store/templates`.
 * @module
 */
import type { Database } from './db.ts'
import { allNodeIds, readPayload } from './db.ts'

/** One non-vector hit. */
export interface TextHit {
  /** Storage-local node id; never exported, never durable (AD-3). */
  readonly id: number
  /** Business identity when the payload carries one. */
  readonly memKey: string | null
  /** The node's payload, verbatim. */
  readonly payload: Readonly<Record<string, unknown>>
  /** Number of query tokens found in the payload's text fields. */
  readonly score: number
}

/** Result of one non-vector search. */
export interface TextSearchResult {
  readonly hits: readonly TextHit[]
  /** Wall-clock duration of the scan, for the audit row. */
  readonly elapsedMs: number
}

/** Options for {@link searchText}. */
export interface TextSearchOptions {
  /** Maximum hits returned (AD-8: default 5, hard cap 8). */
  readonly topK?: number
}

/** Default and maximum hit counts, mirroring AD-8. */
const DEFAULT_TOP_K = 5
const MAX_TOP_K = 8

/**
 * Node kinds this scan never returns.
 *
 * An evidence pointer is reached through the assertion it supports (AD-6 keeps
 * the edge as the only way in), and its text is a quotation of a host event,
 * not one of our memories. Scanning it would do two things at once: return the
 * same sentence twice — once as the assertion, once as its pointer — and put a
 * quoted message on a read path where the export rule (FR-24) is not applied.
 */
const UNSEARCHABLE_KINDS: ReadonlySet<string> = new Set(['evidence'])

/** Whether this payload may appear as a hit. */
function searchable(record: Record<string, unknown>): boolean {
  const kind = record['kind']
  return typeof kind !== 'string' || !UNSEARCHABLE_KINDS.has(kind)
}

/** Collect the textual values of a payload, one level deep. */
function textFields(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return []
  const out: string[] = []
  for (const value of Object.values(payload as Record<string, unknown>)) {
    if (typeof value === 'string') out.push(value)
    else if (Array.isArray(value)) {
      for (const entry of value) if (typeof entry === 'string') out.push(entry)
    }
  }
  return out
}

/** Split a query into lowercase tokens, dropping punctuation-only fragments. */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s\p{P}\p{S}]+/u)
    .map(token => token.trim())
    .filter(token => token.length > 0)
}

/**
 * Scan the file for nodes whose text mentions the query, best match first.
 *
 * An empty query matches everything: "no query" is not an error, and a caller
 * asking for recent items must not be given an empty list by accident. Every node
 * is examined: a scan cap would make every memory written after the cap
 * unreachable, which is the one failure a memory plugin cannot have.
 * @param db - an open handle.
 * @param query - free-text query.
 * @param options - hit and scan bounds.
 * @returns hits in descending score order, plus the scan duration.
 */
export function searchText(db: Database, query: string, options: TextSearchOptions = {}): TextSearchResult {
  const started = performance.now()
  const topK = Math.min(options.topK ?? DEFAULT_TOP_K, MAX_TOP_K)
  const tokens = tokenize(query)
  const scored: TextHit[] = []
  for (const id of allNodeIds(db)) {
    const payload = readPayload(db, id)
    if (typeof payload !== 'object' || payload === null) continue
    const record = payload as Record<string, unknown>
    if (!searchable(record)) continue
    const haystack = textFields(payload).join(' ').toLowerCase()
    const score = tokens.length === 0
      ? 1
      : tokens.reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0)
    if (score === 0) continue
    const memKey = typeof record['mem_key'] === 'string' ? record['mem_key'] : null
    scored.push({ id, memKey, payload: record, score })
  }
  scored.sort((left, right) => (right.score - left.score) || (left.id - right.id))
  return { hits: scored.slice(0, topK), elapsedMs: performance.now() - started }
}
