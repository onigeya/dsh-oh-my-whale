/**
 * The one TQL query a recall runs.
 *
 * AD-8 says a query may only be issued through a named template that caches its
 * compiled form, and that the live-only filter is spelled here rather than
 * pasted into a caller. `store/filters.ts` holds what "live" *means*; this file
 * holds the one string the engine parses, and a semantic test pins the two
 * together by running both over the same payloads.
 *
 * The filter is applied by the engine, not after the fact, so a caller cannot
 * forget it and retired rows never cross into JavaScript. It does not make the
 * scan cheaper: the query returns every live node, and the caller receives all
 * of them. Bounding that scan is Epic 5's vector path (see the deferred note in
 * spec-2-5-recall-read-only.md); reading this as an already-bounded scan would
 * be wrong.
 * @module
 */
import type { Database } from '../db.ts'
import { toStoredNode, type StoredNode } from './rows.ts'

/**
 * Every node whose version is still current.
 *
 * Retirement writes `superseded_at`; a live version never carries the key, so
 * absence is the whole test (data-model §1 forbids writing null). The engine's
 * `$exists` operator is what expresses absence, and this exact spelling is the
 * only shape the `exists-owner` gate accepts inside `store/templates/`.
 */
export const LIVE_NODES_QUERY = 'FIND {superseded_at: {$exists: false}} RETURN *'

/** The queries one recall needs, prepared once per open handle. */
export interface RecallTemplates {
  /**
   * Every current version in the file, filtered and ordered by nothing.
   * @returns the live nodes, unsorted; scoring and ordering belong to the caller.
   */
  findLiveNodes(): readonly StoredNode[]
}

/**
 * Compile the recall query against one handle.
 *
 * `prepareTql` is called here, at construction, so the parse cost is paid once
 * per runtime rather than per recall (AD-8).
 * @param db - an open handle.
 * @returns the template set.
 */
export function createRecallTemplates(db: Database): RecallTemplates {
  const live = db.prepareTql(LIVE_NODES_QUERY)
  return {
    findLiveNodes(): readonly StoredNode[] {
      const rows = db.executePreparedTql(live, {}) as readonly unknown[]
      return rows.map(row => toStoredNode(row, LIVE_NODES_QUERY))
    },
  }
}
