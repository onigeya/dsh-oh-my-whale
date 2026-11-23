/**
 * The audit surface: append-only JSONL, split by local calendar day (AD-20).
 *
 * Audit rows are evidence, never control flow — but they are not lossy either:
 * {@link createAudit} lets an append failure propagate, because a silently
 * dropped row is worse than a loud one. Callers on a non-critical path catch it;
 * the injection path never depends on the audit write. The `degraded_reason`
 * vocabulary is validated here, which is what makes "no fourth reason" a
 * checked fact rather than a convention.
 * @module
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { auditFileName } from '../seams/config.ts'
import { DEGRADED_REASONS, isDegradedReason, type DegradedReason } from '../core/degrade.ts'

/** One row recording what was injected into a prompt (AD-20). */
export interface InjectionAuditRow {
  readonly kind: 'injection'
  readonly ts: string
  readonly session_id: string
  readonly tier: string
  readonly chars: number
  readonly tokens: number
  readonly items: readonly string[]
  readonly truncated: boolean
  readonly prefix_unchanged: boolean
  readonly host_cache_read: number
  readonly host_cache_write: number
  readonly host_uncached: number
}

/** One row recording a recall, including why it was degraded (AD-20). */
export interface RecallAuditRow {
  readonly kind: 'recall'
  readonly ts: string
  readonly query_hash: string
  readonly topK: number
  /** `mem_key`s of the returned hits; node ids never leave the store (AD-3). */
  readonly hits: readonly string[]
  readonly elapsed_ms: number
  readonly degraded: boolean
  readonly degraded_reason: readonly DegradedReason[]
}

/** Any row this module can write. */
export type AuditRow = InjectionAuditRow | RecallAuditRow

/** Destination of rendered audit rows. */
export interface AuditSink {
  write(file: string, line: string): void
}

/** The audit facade. */
export interface Audit {
  /** Append one row to today's file. */
  append(row: AuditRow): { readonly file: string; readonly row: AuditRow }
  /** Absolute path of the file for one instant (defaults to now). */
  path(date?: Date): string
  /** Rows appended through this facade, in order. */
  readonly rows: readonly AuditRow[]
}

/** Options for {@link createAudit}. */
export interface AuditOptions {
  /** Directory holding `audit-YYYYMMDD.jsonl`. */
  readonly dataDir: string
  readonly now?: () => Date
  readonly sink?: AuditSink
}

/** A sink that appends to a file, creating directories as needed. */
export function createAppendAuditSink(): AuditSink {
  return {
    write(file: string, line: string): void {
      mkdirSync(join(file, '..'), { recursive: true })
      appendFileSync(file, line, 'utf8')
    },
  }
}

/** Create an in-memory audit sink, for tests. */
export function createMemoryAuditSink(): AuditSink & { readonly writes: { file: string; line: string }[] } {
  const writes: { file: string; line: string }[] = []
  return {
    writes,
    write(file: string, line: string): void { writes.push({ file, line }) },
  }
}

/**
 * Reject any row naming a reason outside the closed vocabulary.
 * @param row - the candidate row.
 * @throws when `degraded_reason` contains a value this epic does not define.
 */
export function assertClosedReasons(row: RecallAuditRow): void {
  for (const reason of row.degraded_reason) {
    if (!isDegradedReason(reason)) {
      throw new Error(`unknown degraded_reason ${JSON.stringify(reason)}; closed set is ${DEGRADED_REASONS.join(', ')}`)
    }
  }
}

/**
 * Create the audit facade.
 * @param options - directory, clock and sink.
 * @returns the facade; rows are also retained in memory for observation.
 */
export function createAudit(options: AuditOptions): Audit {
  const now = options.now ?? (() => new Date())
  const sink = options.sink ?? createAppendAuditSink()
  const rows: AuditRow[] = []
  const pathOf = (date: Date): string => join(options.dataDir, auditFileName(date))
  return {
    rows,
    path: (date: Date = now()) => pathOf(date),
    append(row: AuditRow): { readonly file: string; readonly row: AuditRow } {
      if (row.kind === 'recall') assertClosedReasons(row)
      const file = pathOf(now())
      rows.push(row)
      sink.write(file, `${JSON.stringify(row)}\n`)
      return { file, row }
    },
  }
}
