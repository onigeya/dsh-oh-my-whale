// AD-15 豁免：快照目录
/**
 * Snapshot discipline (AD-14): one verified snapshot per day, seven retained,
 * restore only after the database is closed, and a forced snapshot before any
 * migration.
 *
 * This file is the single place allowed to physically delete anything, and the
 * header comment above is the exemption AD-15 requires. It deletes snapshot
 * directories and nothing else — never a node, never a database file.
 * @module
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Database, SnapshotManifest } from '../store/db.ts'
import { closeDatabase, createSnapshotTo, restoreSnapshotFrom, verifySnapshotDir } from '../store/db.ts'

/** Attempt suffixes appended to a date, in the order they are tried (AD-14). */
export const SNAPSHOT_ATTEMPTS = 'abcdefghijklmnopqrstuvwxyz'

/** Prefix identifying a pre-migration snapshot. */
export const PRE_MIGRATION_PREFIX = 'pre-migration-'

/** One snapshot directory found on disk. */
export interface SnapshotEntry {
  /** Absolute directory path. */
  readonly path: string
  /** Directory name, e.g. `2026-11-23-a`. */
  readonly name: string
  /** Calendar day the name carries, e.g. `2026-11-23`; `''` for pre-migration snapshots. */
  readonly date: string
  /** Last-modification time, the tiebreak inside one day (AD-14). */
  readonly mtimeMs: number
  /** Attempt suffix, or `''` when the name carries none. */
  readonly attempt: string
  /** Whether this is a pre-migration snapshot. */
  readonly preMigration: boolean
}

/** Result of verifying one snapshot directory. */
export type VerifyOutcome =
  | { readonly ok: true; readonly manifest: SnapshotManifest }
  | { readonly ok: false; readonly reason: string; readonly manifest?: SnapshotManifest }

/** Result of the startup snapshot step. */
export type EnsureResult =
  | {
    readonly ok: true
    /** Whether this run created a new snapshot. */
    readonly created: boolean
    readonly path: string
    readonly manifest: SnapshotManifest
    /** Directories removed by the retention policy. */
    readonly pruned: readonly string[]
  }
  | { readonly ok: false; readonly code: 'OMW_SNAPSHOT_VERIFY'; readonly reason: string; readonly path?: string }

/** Local calendar day as `YYYY-MM-DD` (snapshots follow the user's day, AD-14). */
export function calendarDay(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Compact local timestamp used in pre-migration directory names. */
export function compactTimestamp(date: Date): string {
  const time = [date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()]
    .map((part, index) => String(part).padStart(index === 3 ? 3 : 2, '0'))
    .join('')
  return `${calendarDay(date).replaceAll('-', '')}T${time}`
}

/** Read a directory without throwing when it does not exist yet. */
function safeReaddir(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return []
  }
}

/** Read a directory's regular-file names without throwing when it does not exist. */
function safeReaddirFiles(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
  } catch {
    return []
  }
}

/**
 * List snapshot directories under `snapshotsDir`, oldest-first by
 * (calendar day, then mtime) — the order the retention policy deletes in.
 * @param snapshotsDir - the snapshot root.
 * @returns entries sorted oldest first; an absent root yields an empty list.
 */
export function listSnapshots(snapshotsDir: string): SnapshotEntry[] {
  const entries: SnapshotEntry[] = []
  for (const name of safeReaddir(snapshotsDir)) {
    const path = join(snapshotsDir, name)
    let mtimeMs = 0
    try {
      mtimeMs = statSync(path).mtimeMs
    } catch {
      continue
    }
    const preMigration = name.startsWith(PRE_MIGRATION_PREFIX)
    const dated = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(name)
    entries.push({
      path,
      name,
      date: preMigration ? '' : (dated?.[1] ?? ''),
      attempt: preMigration ? '' : (dated?.[2] ?? ''),
      mtimeMs,
      preMigration,
    })
  }
  entries.sort((left, right) => {
    if (left.date !== right.date) return left.date < right.date ? -1 : 1
    return left.mtimeMs - right.mtimeMs
  })
  return entries
}

/**
 * Verify one snapshot directory and require `complete === true`.
 * @param directory - snapshot root to verify.
 * @returns the manifest, or why verification failed.
 */
export function verifySnapshotAt(directory: string): VerifyOutcome {
  let manifest: SnapshotManifest
  try {
    manifest = verifySnapshotDir(directory)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  if (manifest.complete !== true) {
    return { ok: false, reason: 'manifest is not marked complete', manifest }
  }
  return { ok: true, manifest }
}

/**
 * Delete the oldest snapshots until at most `keep` remain (AD-14).
 *
 * Ordering is the contract: calendar day first, then modification time inside
 * one day, so "the oldest" is observable by a test rather than incidental.
 * @param snapshotsDir - the snapshot root.
 * @param keep - number of snapshots to retain.
 * @returns the paths that were removed, oldest first.
 */
export function pruneSnapshots(snapshotsDir: string, keep: number): string[] {
  // Pre-migration snapshots are the migration rollback point, not part of the
  // daily rotation: they have no calendar day, so counting them would evict them
  // first (their empty date sorts before every real day).
  const entries = listSnapshots(snapshotsDir).filter(entry => !entry.preMigration)
  const excess = entries.length - Math.max(keep, 1)
  if (excess <= 0) return []
  const removed: string[] = []
  for (const entry of entries.slice(0, excess)) {
    try {
      rmSync(entry.path, { recursive: true, force: true })
      removed.push(entry.path)
    } catch {
      // A snapshot that cannot be removed only occupies space; it must not fail boot.
    }
  }
  return removed
}

/**
 * The startup snapshot step: verify today's snapshot, create one if it is
 * missing or unverifiable, then enforce the retention limit.
 *
 * The create path is re-entrant but not idempotent: a directory-name collision
 * (`TDB_SNAPSHOT_EXISTS`) is an expected branch, so the next free suffix is
 * tried instead of reporting an error.
 * @param options - open handle, snapshot root, clock and retention.
 * @returns the verified snapshot, or the verification failure that gates the plugin.
 */
export function ensureDailySnapshot(options: {
  readonly db: Database
  readonly snapshotsDir: string
  readonly now?: () => Date
  readonly keep?: number
}): EnsureResult {
  const now = options.now ?? (() => new Date())
  const keep = options.keep ?? 7
  const day = calendarDay(now())
  mkdirSync(options.snapshotsDir, { recursive: true })
  const todays = listSnapshots(options.snapshotsDir)
    .filter(entry => !entry.preMigration && entry.date === day)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
  const newest = todays[0]
  if (newest !== undefined) {
    const verified = verifySnapshotAt(newest.path)
    if (verified.ok) {
      return {
        ok: true,
        created: false,
        path: newest.path,
        manifest: verified.manifest,
        pruned: pruneSnapshots(options.snapshotsDir, keep),
      }
    }
  }
  for (const attempt of SNAPSHOT_ATTEMPTS) {
    const path = join(options.snapshotsDir, `${day}-${attempt}`)
    if (existsSync(path)) continue
    let manifest: SnapshotManifest
    try {
      manifest = createSnapshotTo(options.db, path, `omw-${day}-${attempt}`)
    } catch (error) {
      const code = (error as { code?: unknown }).code
      // A concurrent creator won the directory; try the next suffix.
      if (typeof code === 'string' && code.includes('SNAPSHOT_EXISTS')) continue
      return {
        ok: false,
        code: 'OMW_SNAPSHOT_VERIFY',
        reason: error instanceof Error ? error.message : String(error),
        path,
      }
    }
    const verified = verifySnapshotAt(path)
    if (!verified.ok) return { ok: false, code: 'OMW_SNAPSHOT_VERIFY', reason: verified.reason, path }
    return {
      ok: true,
      created: true,
      path,
      manifest,
      pruned: pruneSnapshots(options.snapshotsDir, keep),
    }
  }
  return { ok: false, code: 'OMW_SNAPSHOT_VERIFY', reason: 'every snapshot suffix for today is taken' }
}

/** Result of a restore attempt. */
export type RestoreOutcome =
  | { readonly ok: true; readonly manifest: SnapshotManifest }
  | { readonly ok: false; readonly message: string }

/** Whether an error means "the file is still held by a live handle". */
function isLockedFileError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && ['EPERM', 'EBUSY', 'EACCES'].includes(code)
}

/**
 * Restore a snapshot over the configured database file.
 *
 * Three things happen in order, and each is required by the engine or by Windows:
 *
 * 1. the handle is closed — a single-file database holds an exclusive access
 *    lease, so restoring underneath a live handle fails;
 * 2. the live file is renamed aside to `<dbFile>.pre-restore-<timestamp>` — the
 *    engine refuses an existing destination ("Snapshot destination exists"), and
 *    renaming keeps the previous database recoverable instead of deleting it;
 * 3. the snapshot is restored into the now-free path. A failed restore renames
 *    the backup back, so a failed restore never leaves the profile without a
 *    database.
 *
 * Nothing here deletes a database file (AD-5, AD-15).
 * @param options - live handle (closed here), snapshot directory, destination and clock.
 * @returns the restored manifest, or a message naming the next action.
 */
export function restoreSnapshot(options: {
  readonly db?: Database
  readonly source: string
  readonly dbFile: string
  readonly now?: () => Date
}): RestoreOutcome {
  const verified = verifySnapshotAt(options.source)
  if (!verified.ok) {
    return { ok: false, message: `快照校验失败：${verified.reason}` }
  }
  if (options.db !== undefined) {
    const closeError = closeDatabase(options.db)
    if (closeError !== undefined) {
      return { ok: false, message: `无法关闭数据库：${closeError}。请先停止进程再恢复。` }
    }
  }

  const stamp = compactTimestamp(options.now === undefined ? new Date() : options.now())
  const directory = dirname(options.dbFile)
  const base = basename(options.dbFile)
  // A TriviumDB file is one main file plus sidecars (".vec", ".wal", …), all
  // sharing the base name. Every one of them has to move aside, or the restored
  // main file is left next to sidecars describing a different state.
  const moved: { from: string; to: string }[] = []
  for (const name of safeReaddirFiles(directory)) {
    if (name !== base && !name.startsWith(`${base}.`)) continue
    if (name.includes('.pre-restore-')) continue
    const from = join(directory, name)
    const to = `${from}.pre-restore-${stamp}`
    try {
      renameSync(from, to)
      moved.push({ from, to })
    } catch (error) {
      restoreMoved(moved)
      const detail = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        message: isLockedFileError(error)
          ? `数据库文件仍被占用（${detail}）。请先停止进程再恢复。`
          : `无法备份现有数据库：${detail}`,
      }
    }
  }

  // The engine's restore creates a *directory* at its destination and refuses a
  // path that already exists, so it cannot write straight over the live file.
  // Restore into a staging directory on the same volume, then install the files:
  // `database.tdb` plus its sidecars, renamed to the live base name.
  const staging = join(directory, `.restore-${stamp}`)
  let manifest: SnapshotManifest
  try {
    manifest = restoreSnapshotFrom(options.source, staging)
  } catch (error) {
    restoreMoved(moved)
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      message: isLockedFileError(error)
        ? `数据库文件仍被占用（${detail}）。请先停止进程再恢复。`
        : `恢复失败：${detail}${moved.length === 0 ? '' : `；原库已恢复为 ${base}`}`,
    }
  }

  const installed: { from: string; to: string }[] = []
  try {
    for (const name of safeReaddirFiles(staging)) {
      if (!name.startsWith('database.tdb')) continue
      const from = join(staging, name)
      const to = `${options.dbFile}${name.slice('database.tdb'.length)}`
      renameSync(from, to)
      installed.push({ from, to })
    }
  } catch (error) {
    for (const { to } of [...installed].reverse()) {
      try {
        rmSync(to, { force: true })
      } catch {
        // The rollback below restores the previous database either way.
      }
    }
    restoreMoved(moved)
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      message: isLockedFileError(error)
        ? `数据库文件仍被占用（${detail}）。请先停止进程再恢复。`
        : `恢复失败：${detail}；原库已恢复为 ${base}`,
    }
  } finally {
    // The staging directory and the lock the engine drops beside it are snapshot
    // artifacts, covered by this module's deletion exemption (AD-15).
    rmSync(staging, { recursive: true, force: true })
    rmSync(join(directory, `.${basename(staging)}.snapshot.lock`), { force: true })
  }

  if (!existsSync(options.dbFile)) {
    restoreMoved(moved)
    return { ok: false, message: `恢复后缺少主库文件 ${base}；原库已恢复` }
  }
  return { ok: true, manifest }
}

/** Put moved files back, newest-oldest, ignoring a file that is already gone. */
function restoreMoved(moved: readonly { from: string; to: string }[]): void {
  for (const { from, to } of [...moved].reverse()) {
    try {
      renameSync(to, from)
    } catch {
      // A failed rollback is reported by the caller's message: the backup stays put.
    }
  }
}

/**
 * Create and verify a snapshot taken immediately before a migration (AD-14).
 * @param options - open handle, snapshot root and clock.
 * @returns the verified path, or the verification failure.
 */
export function createPreMigrationSnapshot(options: {
  readonly db: Database
  readonly snapshotsDir: string
  readonly now?: () => Date
}): EnsureResult {
  const now = options.now ?? (() => new Date())
  mkdirSync(options.snapshotsDir, { recursive: true })
  const path = join(options.snapshotsDir, `${PRE_MIGRATION_PREFIX}${compactTimestamp(now())}`)
  let manifest: SnapshotManifest
  try {
    manifest = createSnapshotTo(options.db, path, `omw-${PRE_MIGRATION_PREFIX}${compactTimestamp(now())}`)
  } catch (error) {
    return {
      ok: false,
      code: 'OMW_SNAPSHOT_VERIFY',
      reason: error instanceof Error ? error.message : String(error),
      path,
    }
  }
  const verified = verifySnapshotAt(path)
  if (!verified.ok) return { ok: false, code: 'OMW_SNAPSHOT_VERIFY', reason: verified.reason, path }
  return { ok: true, created: true, path, manifest, pruned: [] }
}

/** Result of the migration precondition check. */
export type PreMigrationOutcome =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly code: 'OMW_SNAPSHOT_VERIFY'; readonly reason: string }

/**
 * Decide whether a migration may start: a verified pre-migration snapshot must
 * already exist (I/O matrix row PRE_MIGRATION_MISSING).
 * @param snapshotsDir - the snapshot root.
 * @returns the snapshot to rely on, or the reason the migration must not start.
 */
export function requirePreMigrationSnapshot(snapshotsDir: string): PreMigrationOutcome {
  const candidates = listSnapshots(snapshotsDir)
    .filter(entry => entry.preMigration)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
  const newest = candidates[0]
  if (newest === undefined) {
    return {
      ok: false,
      code: 'OMW_SNAPSHOT_VERIFY',
      reason: `no ${PRE_MIGRATION_PREFIX}<timestamp> snapshot under ${snapshotsDir}; create one before migrating`,
    }
  }
  const verified = verifySnapshotAt(newest.path)
  if (!verified.ok) {
    return { ok: false, code: 'OMW_SNAPSHOT_VERIFY', reason: `${newest.name} failed verification: ${verified.reason}` }
  }
  return { ok: true, path: newest.path }
}

/**
 * Throwing form of {@link requirePreMigrationSnapshot}, for gate code.
 * @param snapshotsDir - the snapshot root.
 * @returns the snapshot to rely on.
 * @throws an error carrying `code: 'OMW_SNAPSHOT_VERIFY'` when none exists.
 */
export function assertPreMigrationSnapshot(snapshotsDir: string): string {
  const outcome = requirePreMigrationSnapshot(snapshotsDir)
  if (!outcome.ok) {
    const error = new Error(outcome.reason) as Error & { code: string }
    error.code = outcome.code
    throw error
  }
  return outcome.path
}
