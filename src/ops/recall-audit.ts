/**
 * Recall audit rows: one line per query that actually ran (AD-20, Story 2.6).
 *
 * The row cannot carry the query. A recall line is written to a file that may
 * leave the machine, and a query is whatever the model typed — possibly a name,
 * a phone number, something the user only ever said once (NFR-6). So the row keeps
 * a digest, which is enough to tell two searches apart in a report and useless to
 * anyone reading the file afterwards.
 *
 * A refused call writes nothing: nothing was read, so a row would record a recall
 * that never happened. That decision lives in the reader (only the accepted path
 * calls back), and this module is not allowed to invent one.
 * @module
 */
import { createHash } from 'node:crypto'
import type { Audit, RecallAuditRow } from './audit.ts'
import type { RecallEvent } from '../seams/recall-reader.ts'

/** What an auditor needs. */
export interface RecallAuditorOptions {
  /** Where rows go. */
  readonly audit: Audit
  /** Clock; the row's `ts` and nothing else. */
  readonly now?: () => Date
}

/** The recall-audit seam. */
export interface RecallAuditor {
  /**
   * Append one row for one completed recall.
   * @param event - what the reader reported.
   * @returns the row written.
   * @throws when the audit refuses the row; the reader catches it, because a
   *   bookkeeping failure may never fail an answer that is already correct.
   */
  record(event: RecallEvent): RecallAuditRow
}

/**
 * Create the recall auditor.
 * @param options - audit target and clock.
 * @returns the seam.
 */
export function createRecallAuditor(options: RecallAuditorOptions): RecallAuditor {
  const now = options.now ?? (() => new Date())
  return {
    record(event: RecallEvent): RecallAuditRow {
      const row: RecallAuditRow = {
        kind: 'recall',
        ts: now().toISOString(),
        session_id: event.sessionId ?? '',
        query_hash: queryHash(event.query),
        top_k: event.topK,
        hits: event.memKeys,
        elapsed_ms: event.elapsedMs,
        degraded: event.degraded,
        degraded_reason: event.degradedReason,
      }
      options.audit.append(row)
      return row
    },
  }
}

/**
 * Digest of a query, for a row that must not contain it.
 *
 * SHA-256 rather than a cheaper hash, for one reason: this is the same primitive
 * the decision ledger already uses for patch digests, and a second hash function is
 * a second thing to get wrong. It is truncated to 16 hex characters, which is
 * enough to distinguish queries and short enough to read.
 * @param query - the text as typed.
 * @returns 16 hex characters.
 */
export function queryHash(query: string): string {
  return createHash('sha256').update(query, 'utf8').digest('hex').slice(0, 16)
}