/**
 * The read-only store surface (AD-6, AD-15).
 *
 * A read surface must not build the write gateway: that gateway prepares a
 * commit engine, and an engine owns the handle it was built on. A reader that
 * held one would either leak it or close a handle the rest of the plugin is
 * still using. This module therefore prepares the two templates a read needs and
 * nothing else, and exposes no `close` at all — there is nothing to close.
 * @module
 */
import type { Database } from '../db.ts'
import { createAssertionTemplates, type StoredNode } from '../templates/assertions.ts'
import { createEvidenceTemplates, type StoredEvidenceNode } from '../templates/evidence.ts'

/** How much of a pointer's payload a read surface is allowed to see. */
export interface EvidenceReadOptions {
  /** Include pointers whose quote was redacted. Export paths leave this off (AD-6). */
  readonly includeSensitive?: boolean
}

/** What a read surface may ask the store. */
export interface ReadGateway {
  /** The live version of one business key, or `undefined` when the key is unused. */
  findLive(memKey: string): StoredNode | undefined
  /**
   * Every pointer whose `supports` edge lands on one assertion.
   *
   * The assertion is named by its business key: ids never leave the store layer
   * (AR-4), so a read surface above cannot name one.
   * @param assertionMemKey - the assertion's business key.
   * @param options - whether redacted quotes are included.
   * @returns the pointers, empty when the assertion is absent or unsupported.
   */
  listEvidenceFor(assertionMemKey: string, options?: EvidenceReadOptions): readonly StoredEvidenceNode[]
  /**
   * Every version of one business key, live and retired.
   *
   * A retired version is not deleted state (AD-5): it is the same key under a
   * higher `active_slot`, which is why this read does not filter on
   * `superseded_at` at all.
   * @param memKey - the business key.
   * @returns the versions, empty when the key was never written.
   */
  findVersions(memKey: string): readonly StoredNode[]
  /**
   * Every ledger entry that names one business key, as its target or as part of
   * what the change touched.
   *
   * Both halves matter: a decision's `target_mem_key` is the key the change was
   * about, while `affected` also carries the keys written in the same batch —
   * including the evidence pointers a fact was given. Asking `/omw ledger` about
   * a pointer key must therefore find the decision that linked it, or the ledger
   * would report that nothing ever happened to a key a person can see in the
   * store.
   * @param memKey - the business key to explain.
   * @returns the entries, empty when nothing ever named the key.
   */
  listDecisionsFor(memKey: string): readonly StoredNode[]
}

/** Whether one ledger payload names a key, as its target or in what it touched. */
function names(payload: Readonly<Record<string, unknown>>, memKey: string): boolean {
  if (payload['target_mem_key'] === memKey) return true
  const affected = payload['affected']
  return Array.isArray(affected) && affected.includes(memKey)
}

/**
 * Wire the read gateway around one open handle.
 *
 * Both templates are prepared once per handle: preparing one compiles a query,
 * and that does not belong on a per-read path.
 * @param db - an open handle; never closed by this module.
 * @returns the read surface.
 */
export function createReadGateway(db: Database): ReadGateway {
  const assertions = createAssertionTemplates(db)
  const evidence = createEvidenceTemplates(db)
  return {
    findLive(memKey: string): StoredNode | undefined {
      return assertions.findLiveByKey(memKey)
    },
    listEvidenceFor(assertionMemKey: string, options?: EvidenceReadOptions): readonly StoredEvidenceNode[] {
      const assertion = assertions.findLiveByKey(assertionMemKey)
      // A retired assertion keeps its edges, but a read surface asks about the
      // key, not about which version is live: a retired key answers with nothing
      // rather than with edges that no longer describe the live fact.
      if (assertion === undefined) return []
      const pointers = evidence.listSupporting(assertion.id)
      // The export rule is applied in exactly one place (AD-6, FR-24): a
      // redacted quote leaves the store only when the caller asked for it in so
      // many words. Filtering here rather than in each projection means a new
      // read surface cannot forget the rule.
      if (options?.includeSensitive === true) return pointers
      return pointers.filter(pointer => pointer.payload['deidentified'] !== true)
    },
    findVersions(memKey: string): readonly StoredNode[] {
      return assertions.findAllVersionsByKey(memKey)
    },
    listDecisionsFor(memKey: string): readonly StoredNode[] {
      // Filtered in memory rather than in TQL: the query language has no
      // containment operator, so `affected` cannot be asked about, and the
      // ledger is only ever read by a person asking for its reasons.
      return assertions.findAllDecisions().filter(node => names(node.payload, memKey))
    },
  }
}
