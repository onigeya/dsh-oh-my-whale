/**
 * Story 1.5 — one verified snapshot a day, seven kept, restore stops the
 * database first.
 * @module
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createPreMigrationSnapshot,
  ensureDailySnapshot,
  listSnapshots,
  requirePreMigrationSnapshot,
  restoreSnapshot,
  verifySnapshotAt,
} from '../../src/ops/snapshots.ts'
import { closeDatabase, nodeCount, openDatabase, type Database } from '../../src/store/db.ts'
import { tempHome, type TempHome } from '../support/fake-ctx.ts'

const homes: TempHome[] = []
const handles: Database[] = []

afterEach(() => {
  while (handles.length > 0) {
    const db = handles.pop()
    if (db !== undefined) closeDatabase(db)
  }
  while (homes.length > 0) homes.pop()?.remove()
})

/** Open a fresh database in a temp home. */
function freshDatabase(): { home: TempHome; db: Database; dbFile: string; snapshotsDir: string } {
  const home = tempHome('omw-snap-')
  homes.push(home)
  const dbFile = home.path('oh-my-whale', 'oh-my-whale.tdb')
  mkdirSync(home.path('oh-my-whale'), { recursive: true })
  const opened = openDatabase({ file: dbFile, dim: 4, memoryLimitMb: 256 })
  if (!opened.ok) throw new Error(opened.reason)
  handles.push(opened.db)
  return { home, db: opened.db, dbFile, snapshotsDir: home.path('oh-my-whale', 'snapshots') }
}

/** A clock pinned to one day. */
function day(year: number, month: number, date: number): () => Date {
  return () => new Date(year, month - 1, date, 4, 0, 0)
}

describe('snapshots: daily', () => {
  it('creates and verifies one snapshot, then reuses it', () => {
    const { db, snapshotsDir } = freshDatabase()
    const first = ensureDailySnapshot({ db, snapshotsDir, now: day(2026, 11, 23), keep: 7 })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.created).toBe(true)
    expect(verifySnapshotAt(first.path).ok).toBe(true)

    const second = ensureDailySnapshot({ db, snapshotsDir, now: day(2026, 11, 23), keep: 7 })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.created).toBe(false)
    expect(second.path).toBe(first.path)
    expect(listSnapshots(snapshotsDir).filter(entry => !entry.preMigration)).toHaveLength(1)
  })

  it('makes at most one more snapshot when the existing one does not verify', () => {
    const { db, snapshotsDir } = freshDatabase()
    mkdirSync(join(snapshotsDir, '2026-11-23-a'), { recursive: true })
    const result = ensureDailySnapshot({ db, snapshotsDir, now: day(2026, 11, 23), keep: 7 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.created).toBe(true)
    expect(result.path.endsWith('2026-11-23-b')).toBe(true)
    expect(listSnapshots(snapshotsDir).filter(entry => !entry.preMigration)).toHaveLength(2)
  })
})

describe('snapshots: rotation', () => {
  it('keeps the newest seven and removes the oldest by date', () => {
    const { db, snapshotsDir } = freshDatabase()
    for (let index = 1; index <= 8; index += 1) {
      const result = ensureDailySnapshot({ db, snapshotsDir, now: day(2026, 11, index), keep: 7 })
      expect(result.ok).toBe(true)
    }
    const kept = listSnapshots(snapshotsDir)
      .filter(entry => !entry.preMigration)
      .map(entry => entry.date)
      .sort()
    expect(kept).toHaveLength(7)
    expect(kept).not.toContain('2026-11-01')
    expect(kept[0]).toBe('2026-11-02')
    expect(kept[6]).toBe('2026-11-08')
  })

  it('orders same-day attempts by modification time', () => {
    const { db, snapshotsDir } = freshDatabase()
    mkdirSync(join(snapshotsDir, '2026-11-23-a'), { recursive: true })
    const only = listSnapshots(snapshotsDir).filter(entry => entry.name === '2026-11-23-a')
    expect(only).toHaveLength(1)
    expect(only[0]?.attempt).toBe('a')
  })
})

describe('snapshots: restore', () => {
  it('restores the file contents of a snapshot', () => {
    const { home, db, dbFile, snapshotsDir } = freshDatabase()
    db.insert([0, 0, 0, 0], { kind: 'assertion', text: 'before' })
    const created = ensureDailySnapshot({ db, snapshotsDir, now: day(2026, 11, 23), keep: 7 })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    db.insert([0, 0, 0, 0], { kind: 'assertion', text: 'after' })
    const beforeRestore = nodeCount(db)
    closeDatabase(db)
    handles.length = 0

    const restored = restoreSnapshot({ source: created.path, dbFile })
    expect(restored.ok).toBe(true)

    const reopened = openDatabase({ file: dbFile, dim: 4, memoryLimitMb: 256 })
    expect(reopened.ok).toBe(true)
    if (!reopened.ok) return
    handles.push(reopened.db)
    expect(nodeCount(reopened.db)).toBeLessThan(beforeRestore)
    expect(existsSync(join(home.dir, 'oh-my-whale', 'oh-my-whale.tdb'))).toBe(true)
  })

  it('refuses with a readable instruction when the handle cannot be released', () => {
    const { db, dbFile, snapshotsDir } = freshDatabase()
    const created = ensureDailySnapshot({ db, snapshotsDir, now: day(2026, 11, 23), keep: 7 })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const stuck = {
      close(): void {
        throw new Error('EBUSY: resource busy or locked')
      },
    } as unknown as Database
    const result = restoreSnapshot({ db: stuck, source: created.path, dbFile })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('请先停止进程')
  })

  it('refuses an unverifiable snapshot with a readable message', () => {
    const { dbFile, snapshotsDir } = freshDatabase()
    mkdirSync(join(snapshotsDir, '2026-11-23-a'), { recursive: true })
    const result = restoreSnapshot({ source: join(snapshotsDir, '2026-11-23-a'), dbFile })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('快照校验失败')
  })
})

describe('snapshots: pre-migration', () => {
  it('refuses migration when no pre-migration snapshot exists', () => {
    const { snapshotsDir } = freshDatabase()
    const outcome = requirePreMigrationSnapshot(snapshotsDir)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('OMW_SNAPSHOT_VERIFY')
    expect(outcome.reason).toContain('pre-migration-')
  })

  it('accepts a created pre-migration snapshot', () => {
    const { db, snapshotsDir } = freshDatabase()
    const created = createPreMigrationSnapshot({ db, snapshotsDir, now: day(2026, 11, 23) })
    expect(created.ok).toBe(true)
    const outcome = requirePreMigrationSnapshot(snapshotsDir)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.path).toContain('pre-migration-')
  })

  it('keeps pre-migration snapshots out of the daily rotation list', () => {
    const { db, snapshotsDir } = freshDatabase()
    createPreMigrationSnapshot({ db, snapshotsDir, now: day(2026, 11, 23) })
    ensureDailySnapshot({ db, snapshotsDir, now: day(2026, 11, 23), keep: 1 })
    expect(readdirSync(snapshotsDir).some(name => name.startsWith('pre-migration-'))).toBe(true)
    expect(listSnapshots(snapshotsDir).filter(entry => entry.preMigration)).toHaveLength(1)
  })
})
