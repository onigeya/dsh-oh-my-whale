/**
 * The only TQL literal the evidence read path needs (AD-8, AD-15).
 *
 * Evidence is written once and never superseded, so it carries no
 * `active_slot` and is not governed by the unique business-key index. Its
 * identity is the business key itself, which the write path derives from the
 * session and the seq range, and this reader looks it up by that key alone.
 *
 * Rows come back as `{_: {id, numEdges, payload}}` with a *string* id. A row
 * that does not have that shape is a read fault and is thrown, never skipped:
 * a caller that believed a key was absent would write a second pointer to the
 * same range and lose the first one's edge.
 * @module
 */
import { toStoredNode, type StoredNode } from './rows.ts'
import type { Database } from '../db.ts'

/** One evidence pointer, by its business key. */
export const EVIDENCE_BY_KEY_QUERY =
  'FIND {kind: "evidence"} WHERE mem_key == $mem_key RETURN *'

/** The edge label that points an evidence node at the assertion it supports. */
export const SUPPORTS_LABEL = 'supports'

/** One pointer as this module reports it: the engine id plus its payload. */
export type StoredEvidenceNode = StoredNode

/** The reads the evidence path needs, over one literal template plus the edge index. */
export interface EvidenceTemplates {
  /** The evidence node with one business key, or `undefined` when the range is unreferenced. */
  findByKey(memKey: string): StoredEvidenceNode | undefined
  /** Every evidence node whose `supports` edge points at one assertion node. */
  listSupporting(assertionId: number): readonly StoredEvidenceNode[]
}

/**
 * Prepare the template against a live handle.
 *
 * Preparation happens once per handle: the engine stores the parsed query, and
 * re-preparing per call would put the parser on the read path.
 * @param db - an open handle.
 * @returns the readers.
 */
export function createEvidenceTemplates(db: Database): EvidenceTemplates {
  const byKey = db.prepareTql(EVIDENCE_BY_KEY_QUERY)
  return {
    findByKey(memKey: string): StoredEvidenceNode | undefined {
      const found = (db.executePreparedTql(byKey, { mem_key: memKey }) as readonly unknown[])
        .map(row => toStoredNode(row, EVIDENCE_BY_KEY_QUERY))
      if (found.length > 1) {
        throw new Error(`omw: 证据键 ${memKey} 有 ${found.length} 条节点，写入路径去重被绕过`)
      }
      return found[0]
    },
    listSupporting(assertionId: number): readonly StoredEvidenceNode[] {
      const incoming = db.getIncomingEdges(assertionId, SUPPORTS_LABEL)
      const nodes: StoredEvidenceNode[] = []
      for (const edge of incoming) {
        const payload = db.getPayload(edge.sourceId)
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          throw new Error(`omw: 证据节点 ${edge.sourceId} 缺少载荷对象`)
        }
        nodes.push({ id: edge.sourceId, payload: payload as Record<string, unknown> })
      }
      return nodes
    },
  }
}
