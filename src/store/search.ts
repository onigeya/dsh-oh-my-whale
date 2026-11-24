/**
 * The non-vector retrieval path.
 *
 * It exists for two reasons: the vector path can be closed (`vector-off`) while
 * text retrieval must still return results, and the audit tests need a
 * retrieval that is deterministic and free of network or model calls.
 *
 * Which nodes it may see is not decided here. Story 2.5 moved that to
 * `store/templates/recall.ts`, which asks the engine for live versions only, so a
 * superseded value can no longer ride along with its replacement. This module
 * scores what it is handed and sorts it; it does not enumerate, filter for
 * liveness, or truncate. Truncation belongs to the recall reader, which applies
 * two separate gates (candidate pool, then result count).
 *
 * The scan stays schema-agnostic: payload shape is per-kind, so matching any
 * textual field is the only honest option until the vector path replaces it in
 * Epic 5.
 * @module
 */
import { isSearchable, memKeyOf } from './filters.ts'
import type { RecallTemplates } from './templates/recall.ts'
import type { StoredNode } from './templates/rows.ts'

/** One non-vector hit. */
export interface TextHit {
  /** Storage-local node id; never exported, never durable (AD-3). */
  readonly id: number
  /** Business identity; `undefined` for a node that carries none. */
  readonly memKey: string | undefined
  /** The node's payload, verbatim. */
  readonly payload: Readonly<Record<string, unknown>>
  /** Number of query tokens found in the payload's text fields. */
  readonly score: number
}

/** Result of one non-vector search. */
export interface TextSearchResult {
  /**
   * Every live hit, best first. No truncation.
   *
   * Deliberately not paired with a duration: timing belongs to the seam that owns
   * the call (`src/seams/recall-reader.ts`), which measures with an injected clock
   * and reports `elapsed_ms` in the answer. A second timer here would be a number
   * computed on every scan and read by nobody.
   */
  readonly hits: readonly TextHit[]
}

/** A prepared searcher; hold one per open handle. */
export interface TextSearch {
  /**
   * Score every live node against one query.
   * @param query - free-text query; callers refuse blank ones before this point.
   * @returns all matches in deterministic order.
   */
  search(query: string): TextSearchResult
}

/** Collect the textual values of a payload, one level deep. */
function textFields(payload: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = []
  for (const value of Object.values(payload)) {
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
 * Order hits so two identical runs produce the identical sequence.
 *
 * Score first (more matched tokens is better), then the business key, then the
 * node id. The last two carry no meaning — they exist so the order is total:
 * equal scores on equal keys would otherwise fall back to whatever order the
 * file happened to return, and AC⑥ compares two runs position by position.
 * @param left - one hit.
 * @param right - another hit.
 * @returns a signed comparison.
 */
function byRank(left: TextHit, right: TextHit): number {
  if (left.score !== right.score) return right.score - left.score
  const leftKey = left.memKey ?? ''
  const rightKey = right.memKey ?? ''
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1
  return left.id - right.id
}

/**
 * Build a searcher over the live-version query.
 *
 * The template is taken rather than a handle so the `prepareTql` parse is paid
 * once per runtime instead of once per recall (AD-8).
 * @param templates - the recall templates, already prepared.
 * @returns a searcher.
 */
export function createTextSearch(templates: RecallTemplates): TextSearch {
  return {
    search(query: string): TextSearchResult {
      const tokens = tokenize(query)
      const hits: TextHit[] = []
      // A blank token list would score every node 1 and turn a typo into a dump
      // of the whole store. Recall refuses a blank query before reaching here
      // (`checkRecallQuery`), so this is a guard, not a behaviour anyone sees.
      if (tokens.length > 0) {
        for (const node of templates.findLiveNodes()) {
          collect(node, tokens, hits)
        }
      }
      hits.sort(byRank)
      return { hits }
    },
  }
}

/**
 * Score one node and append it to `hits` when it matches at all.
 * @param node - a live node from the template.
 * @param tokens - the query's tokens, already lowercased.
 * @param hits - accumulator, appended in place.
 */
function collect(node: StoredNode, tokens: readonly string[], hits: TextHit[]): void {
  const { payload } = node
  if (!isSearchable(payload)) return
  const haystack = textFields(payload).join(' ').toLowerCase()
  if (haystack.length === 0) return
  let score = 0
  for (const token of tokens) if (haystack.includes(token)) score += 1
  if (score === 0) return
  hits.push({ id: node.id, memKey: memKeyOf(payload), payload, score })
}
