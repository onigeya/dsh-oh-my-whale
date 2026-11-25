/**
 * Audit retention (AD-20, AD-5): 30 days kept, nothing else touched.
 *
 * The danger in this module is not deleting too little, it is deleting the
 * wrong file: a snapshot directory or a hand-made name that happens to look old.
 * Every case below pins one of those boundaries.
 * @module
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { auditFileName } from '../../src/seams/config.ts'
import { AUDIT_RETENTION_DAYS, createRetention } from '../../src/ops/retention.ts'
import { tempHome } from '../support/fake-ctx.ts'

/** The day the tests pretend it is. */
const TODAY = new Date(2026, 10, 24, 9, 30, 0)

/** Name of the audit file `daysAgo` local days before {@link TODAY}. */
function nameDaysAgo(daysAgo: number): string {
  return auditFileName(new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() - daysAgo))
}

/** One real audit row: rotation only deletes files whose first line is one of ours. */
function auditRow(): string {
  return `${JSON.stringify({ kind: 'injection', ts: TODAY.toISOString(), session_id: 's1' })}\n`
}

/** Make a temp data dir holding the named files, each with one audit row. */
function dirWith(names: readonly string[], content: string = auditRow()): { dir: string; remove(): void } {
  const home = tempHome('omw-retention-')
  for (const name of names) writeFileSync(join(home.dir, name), content, 'utf8')
  return { dir: home.dir, remove: () => home.remove() }
}

describe('retention: the window', () => {
  it('is thirty days, counting today', () => {
    expect(AUDIT_RETENTION_DAYS).toBe(30)
  })

  it('keeps today and the twenty-nine days before it, and deletes the thirtieth', () => {
    const names = [nameDaysAgo(0), nameDaysAgo(1), nameDaysAgo(29), nameDaysAgo(30), nameDaysAgo(31)]
    const store = dirWith(names)
    try {
      const result = createRetention({ dataDir: store.dir, now: () => TODAY }).rotate()
      expect(result.removed).toEqual([nameDaysAgo(31), nameDaysAgo(30)].sort())
      expect(result.kept).toEqual([nameDaysAgo(29), nameDaysAgo(1), nameDaysAgo(0)].sort())
      expect(result.scanned).toBe(5)
      for (const gone of [nameDaysAgo(30), nameDaysAgo(31)]) {
        expect(existsSync(join(store.dir, gone)), `${gone} should be gone`).toBe(false)
      }
      expect(existsSync(join(store.dir, nameDaysAgo(29)))).toBe(true)
    } finally {
      store.remove()
    }
  })

  it('crosses a month boundary by calendar day, not by subtracting milliseconds', () => {
    // 2026-03-01 minus 30 days is 2026-01-30 by calendar. A millisecond
    // subtraction would be fine here, but on a daylight-saving Sunday it lands a
    // day off, so the window is built from dates instead.
    const march = new Date(2026, 2, 1, 0, 30, 0)
    const young = auditFileName(new Date(2026, 1, 28))
    const old = auditFileName(new Date(2026, 0, 30))
    const boundary = auditFileName(new Date(2026, 0, 31))
    const store = dirWith([young, old, boundary])
    try {
      const result = createRetention({ dataDir: store.dir, now: () => march }).rotate()
      expect(result.removed).toEqual([old])
      expect([...result.kept].sort()).toEqual([young, boundary].sort())
    } finally {
      store.remove()
    }
  })
})

describe('retention: what it refuses to touch', () => {
  it('leaves every name that is not an audit day alone, however old it looks', () => {
    const ours = nameDaysAgo(40)
    const others = [
      'omw.log',
      'snapshots',
      auditFileName(new Date(2026, 10, 24)).replace('.jsonl', '.jsonl.bak'),
      'audit-2026-11-24.jsonl',
      'audit-20261124.jsonl.tmp',
    ]
    const store = dirWith([ours, ...others])
    try {
      const result = createRetention({ dataDir: store.dir, now: () => TODAY }).rotate()
      expect(result.removed).toEqual([ours])
      for (const name of others) {
        expect(existsSync(join(store.dir, name)), `${name} should survive`).toBe(true)
      }
    } finally {
      store.remove()
    }
  })

  it('treats a name holding an impossible date as somebody else\'s file', () => {
    // 2026-13-99 matches the shape and sorts far in the past, but no such day
    // exists; deleting it would mean trusting arithmetic on a name nobody wrote.
    const store = dirWith(['audit-20261399.jsonl', 'audit-20260231.jsonl'])
    try {
      const result = createRetention({ dataDir: store.dir, now: () => TODAY }).rotate()
      expect(result.removed).toEqual([])
      expect(readdirSync(store.dir).sort()).toEqual(['audit-20260231.jsonl', 'audit-20261399.jsonl'])
    } finally {
      store.remove()
    }
  })

  it('leaves a file dated after today alone, because a future date is not history', () => {
    // A wrong system clock can write tomorrow's name: the rows land in
    // audit-20261125 while the real day is still the 24th. Deleting it on the
    // next rotation would destroy the rows written after the clock was fixed,
    // so a name beyond today is treated exactly like somebody else's file.
    const tomorrow = nameDaysAgo(-1)
    const farFuture = 'audit-29990101.jsonl'
    const past = nameDaysAgo(40)
    const store = dirWith([tomorrow, farFuture, past])
    try {
      const result = createRetention({ dataDir: store.dir, now: () => TODAY }).rotate()
      expect(result.removed).toEqual([past])
      expect([...result.foreign].sort()).toEqual([farFuture, tomorrow].sort())
      expect(existsSync(join(store.dir, tomorrow)), `${tomorrow} should survive`).toBe(true)
      expect(existsSync(join(store.dir, farFuture)), `${farFuture} should survive`).toBe(true)
    } finally {
      store.remove()
    }
  })

  it('accounts for every entry it looked at, so a log line cannot read like a contradiction', () => {
    // `kept` alone used to look like a loss when the directory held names that
    // were not audit files: three entries scanned, one kept, nothing deleted.
    const store = dirWith([nameDaysAgo(0), nameDaysAgo(40), 'omw.log', nameDaysAgo(-1)])
    try {
      const result = createRetention({ dataDir: store.dir, now: () => TODAY }).rotate()
      expect(result.kept.length + result.removed.length + result.foreign.length + result.failed.length).toBe(result.scanned)
      expect(result.scanned).toBe(4)
      expect(result.kept).toEqual([nameDaysAgo(0)])
      expect(result.removed).toEqual([nameDaysAgo(40)])
    } finally {
      store.remove()
    }
  })

  it('reports an empty rotation when the directory does not exist', () => {
    const home = tempHome('omw-retention-')
    const missing = join(home.dir, 'nope')
    try {
      const result = createRetention({ dataDir: missing, now: () => TODAY }).rotate()
      expect(result).toEqual({ removed: [], kept: [], foreign: [], failed: [], scanned: 0 })
    } finally {
      home.remove()
    }
  })

  it('treats a directory wearing an audit name as somebody else\'s file', () => {
    // The name matches and the day is old, but a directory is not a day of rows.
    // Deleting it would take whatever the operator put inside it.
    const impostor = nameDaysAgo(45)
    const store = dirWith([])
    try {
      mkdirSync(join(store.dir, impostor))
      const result = createRetention({ dataDir: store.dir, now: () => TODAY }).rotate()
      expect(result.removed).toEqual([])
      expect(result.foreign).toEqual([impostor])
      expect(existsSync(join(store.dir, impostor)), `${impostor} should still be there`).toBe(true)
    } finally {
      store.remove()
    }
  })

  it.skipIf(process.platform === 'win32')('reports a file it cannot delete and still finishes the sweep', () => {
    // Aborting the whole rotation because one entry will not go would leave every
    // later file over the window: the sweep would stop working because of one
    // stubborn file. `unlink` on POSIX needs write permission on the *parent*
    // directory, which is the one portable way to force it to fail; on Windows a
    // read-only file is still deletable (the POSIX delete semantics Node asks
    // for), so there is no way to stage the failure and the case is pinned where
    // it can actually happen.
    const first = nameDaysAgo(45)
    const second = nameDaysAgo(40)
    const store = dirWith([first, second])
    try {
      chmodSync(store.dir, 0o555)
      const result = createRetention({ dataDir: store.dir, now: () => TODAY }).rotate()
      expect(result.removed).toEqual([])
      expect([...result.failed].sort()).toEqual([second, first].sort())
      expect(result.kept.length + result.removed.length + result.foreign.length + result.failed.length).toBe(result.scanned)
    } finally {
      chmodSync(store.dir, 0o755)
      store.remove()
    }
  })

  it('leaves a file alone whose first line is not an audit row, however old its name', () => {
    // The data directory can be shared (`config.db.path` may point somewhere the
    // operator keeps other things), and a file that merely looks like ours is not
    // ours to delete.
    const old = nameDaysAgo(40)
    const store = dirWith([old], '{"kind":"snapshot","id":7}\n')
    try {
      const result = createRetention({ dataDir: store.dir, now: () => TODAY }).rotate()
      expect(result.removed).toEqual([])
      expect(result.foreign).toEqual([old])
      expect(existsSync(join(store.dir, old))).toBe(true)
    } finally {
      store.remove()
    }
  })

  it('leaves an empty file alone, because an unreadable first line identifies nothing', () => {
    const old = nameDaysAgo(40)
    const store = dirWith([old], '')
    try {
      expect(createRetention({ dataDir: store.dir, now: () => TODAY }).rotate().removed).toEqual([])
      expect(existsSync(join(store.dir, old))).toBe(true)
    } finally {
      store.remove()
    }
  })

  it('decides nothing when the clock it was given is unusable', () => {
    // `new Date(NaN)` builds the keep-set name `audit-NaNNaNNaN.jsonl`, matches no
    // real file, and every comparison against NaN is false — so an unguarded
    // rotation deletes the whole directory. This is the one destructive path in
    // the story, so an unusable clock fails closed: nothing is decided.
    const store = dirWith([nameDaysAgo(0), nameDaysAgo(1), nameDaysAgo(400)])
    try {
      const result = createRetention({ dataDir: store.dir, now: () => new Date(Number.NaN) }).rotate()
      expect(result.removed).toEqual([])
      expect(result.kept).toEqual([])
      expect(result.scanned).toBe(3)
      expect(result.foreign).toHaveLength(3)
      expect(readdirSync(store.dir)).toHaveLength(3)
    } finally {
      store.remove()
    }
  })

  it('propagates a real directory error instead of reporting an empty rotation', () => {
    const home = tempHome('omw-retention-')
    const file = join(home.dir, 'not-a-dir')
    writeFileSync(file, 'x', 'utf8')
    try {
      expect(() => createRetention({ dataDir: file, now: () => TODAY }).rotate()).toThrow(/ENOTDIR|ENOENT/u)
    } finally {
      home.remove()
    }
  })
})

describe('retention: running twice', () => {
  it('is a no-op the second time and keeps the same file set', () => {
    const store = dirWith([nameDaysAgo(0), nameDaysAgo(45)])
    try {
      const retention = createRetention({ dataDir: store.dir, now: () => TODAY })
      expect(retention.rotate().removed).toEqual([nameDaysAgo(45)])
      const second = retention.rotate()
      expect(second.removed).toEqual([])
      expect(second.kept).toEqual([nameDaysAgo(0)])
      expect(second.scanned).toBe(1)
    } finally {
      store.remove()
    }
  })

  it('creates nothing: a rotation over an empty directory leaves it empty', () => {
    const home = tempHome('omw-retention-')
    try {
      mkdirSync(join(home.dir, 'keep'), { recursive: true })
      const result = createRetention({ dataDir: home.dir, now: () => TODAY }).rotate()
      expect(result.scanned).toBe(1)
      expect(readdirSync(home.dir)).toEqual(['keep'])
    } finally {
      home.remove()
    }
  })
})