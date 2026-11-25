// AD-15 豁免：审计轮转

/**
 * Audit retention: keep 30 days of `audit-YYYYMMDD.jsonl`, delete the rest (AD-20).
 *
 * Audit rows are evidence about what the plugin injected, recalled and wrote, and
 * evidence that is never rotated becomes a slow disk leak with a privacy cost:
 * rows name sessions and business keys. The retention rule is one directory scan,
 * run once at mount — there is no second scheduler in this plugin, and the
 * injection path must not grow a timer (AD-7).
 *
 * Only files that parse as an audit day are touched. A snapshot directory, the
 * operational log, or a name this module does not recognise is somebody else's
 * file, and deleting it because it looked old would be exactly the kind of
 * unrecoverable mistake AD-5 exists to prevent.
 * @module
 */
import { closeSync, openSync, readdirSync, readSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { auditFileName } from '../seams/config.ts'

/** How many days of audit rows are kept, counting today (AC③). */
export const AUDIT_RETENTION_DAYS = 30

/** `audit-YYYYMMDD.jsonl` and nothing else. */
const AUDIT_NAME = /^audit-(\d{4})(\d{2})(\d{2})\.jsonl$/

/** What {@link createRetention} needs. */
export interface RetentionOptions {
  /** Directory holding the audit files. */
  readonly dataDir: string
  /** Clock; one instant decides every comparison in one rotation. */
  readonly now?: () => Date
}

/** What one rotation did. */
export interface RetentionResult {
  /** Basenames deleted, oldest first. */
  readonly removed: readonly string[]
  /** Basenames kept because they are inside the window. */
  readonly kept: readonly string[]
  /**
   * Basenames this module left alone because they were not its decision: another
   * file in the data directory, a name that is not an audit file, a file whose
   * first line is not an audit row, or a date past today.
   * `kept + removed + foreign + failed` is always `scanned`.
   */
  readonly foreign: readonly string[]
  /**
   * Basenames past the window that could not be deleted (a file held open by
   * another process, a permission problem). Reported rather than thrown: one
   * locked file must not stop the rest of the window from shrinking, and the
   * caller can only tell the operator about it if the rotation survives.
   */
  readonly failed: readonly string[]
  /** How many directory entries were looked at, of any name. */
  readonly scanned: number
}

/** The retention seam. */
export interface Retention {
  /** Delete every audit file older than the window. Safe to call twice. */
  rotate(): RetentionResult
}

/**
 * The local day an audit file name stands for, if it is one of ours.
 * @param name - a basename.
 * @returns the day, or undefined when the name is not an audit file this module
 *   wrote. An impossible date (`audit-20261399.jsonl`) counts as not ours,
 *   because arithmetic on a name nobody wrote would decide whether to delete a
 *   file by accident.
 */
function dayOf(name: string): Date | undefined {
  const match = AUDIT_NAME.exec(name)
  if (match === null) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return undefined
  }
  return date
}

/** How much of a file is read to decide whether this plugin wrote it. */
const AUDIT_HEADER_BYTES = 4096

/** The kinds this plugin writes; a first line naming anything else is not ours. */
const OWN_ROW_KINDS = new Set(['injection', 'recall', 'write'])

/**
 * Whether a file past the window carries an audit row this plugin wrote.
 *
 * The check is one bounded read of the first line. A file that cannot be read at
 * all counts as not ours: rotation must never delete something it could not
 * identify, and an unreadable file is unidentified by definition.
 * @param file - absolute path.
 * @returns true when the first line parses as a row of a known kind.
 */
function looksLikeAuditFile(file: string): boolean {
  let handle: number | undefined
  try {
    handle = openSync(file, 'r')
    const buffer = Buffer.alloc(AUDIT_HEADER_BYTES)
    const read = readSync(handle, buffer, 0, AUDIT_HEADER_BYTES, 0)
    const head = buffer.subarray(0, read).toString('utf8')
    const firstLine = head.split('\n', 1)[0] ?? ''
    const parsed: unknown = JSON.parse(firstLine)
    if (typeof parsed !== 'object' || parsed === null) return false
    const kind = (parsed as { kind?: unknown }).kind
    return typeof kind === 'string' && OWN_ROW_KINDS.has(kind)
  } catch {
    return false
  } finally {
    if (handle !== undefined) {
      try { closeSync(handle) } catch { /* a failed close changes no decision */ }
    }
  }
}

/**
 * Create the retention seam.
 * @param options - directory and clock.
 * @returns the seam; `rotate()` reports what it did rather than logging it.
 */
export function createRetention(options: RetentionOptions): Retention {
  const now = options.now ?? (() => new Date())
  return {
    rotate(): RetentionResult {
      const at = now()
      let entries: string[]
      try {
        entries = readdirSync(options.dataDir)
      } catch (error) {
        // A directory that does not exist holds nothing to rotate. Anything else
        // (permissions, a file where a directory should be) is a real problem and
        // must not be reported as a successful empty rotation.
        if ((error as { code?: string }).code === 'ENOENT') return { removed: [], kept: [], foreign: [], failed: [], scanned: 0 }
        throw error
      }
      // An unusable clock must not become an empty keep-set. `new Date(NaN)`
      // yields the name `audit-NaNNaNNaN.jsonl`, no real file matches it, and the
      // comparison below then decides every file is old and deletes the lot —
      // rotation is the one destructive path here, so it fails closed instead:
      // nothing is decided, every entry is reported as not ours to judge.
      if (!Number.isFinite(at.getTime())) {
        return { removed: [], kept: [], foreign: entries.sort(), failed: [], scanned: entries.length }
      }
      // Built as calendar days rather than `at - 30 * 86400000`: a daylight-saving
      // change makes that subtraction land on the wrong date once a year.
      const keep = new Set<string>()
      // `back < AUDIT_RETENTION_DAYS`, not `<=`: the constant counts days of
      // history including today (AC③ says 30 days), so today plus 29 yesterdays
      // is the window. `<=` keeps 31 days, which is a different promise than the
      // one the constant makes.
      for (let back = 0; back < AUDIT_RETENTION_DAYS; back += 1) {
        keep.add(auditFileName(new Date(at.getFullYear(), at.getMonth(), at.getDate() - back)))
      }
      const removed: string[] = []
      const kept: string[] = []
      const foreign: string[] = []
      const failed: string[] = []
      for (const name of entries.sort()) {
        if (keep.has(name)) { kept.push(name); continue }
        const day = dayOf(name)
        // Not ours: another file in the data directory, or a name no one wrote.
        if (day === undefined) { foreign.push(name); continue }
        // A future date is not history. Deleting it would let a wrong system
        // clock destroy the rows written after the clock was corrected, so a
        // name beyond today is treated the same as one we did not write.
        if (day.getTime() > at.getTime()) { foreign.push(name); continue }
        // The name alone is not ownership: `config.db.path` may point at a
        // directory the operator shares with something else, and an empty
        // `audit-20250101.jsonl` someone else wrote must not be deleted because
        // it matches our pattern. Only a file whose first line is one of our rows
        // is ours to expire.
        if (!looksLikeAuditFile(join(options.dataDir, name))) { foreign.push(name); continue }
        // One file that will not go (a reader holding it open, a permissions
        // problem) must not abort the rest of the sweep: the other expired days
        // are independent, and a rotation that threw would leave every one of
        // them in place until the next mount.
        try {
          unlinkSync(join(options.dataDir, name))
        } catch {
          failed.push(name)
          continue
        }
        removed.push(name)
      }
      // `scanned` counts every entry, `foreign` says how many were not ours to
      // decide about, and `failed` keeps the ones the filesystem refused, so
      // `kept + removed + foreign + failed === scanned` always holds and a log line
      // cannot read like `kept` alone contradicts the directory.
      return { removed, kept, foreign, failed, scanned: entries.length }
    },
  }
}
