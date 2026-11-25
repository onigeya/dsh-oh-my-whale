/**
 * Story 2.6 — the report an operator runs (AC⑤).
 *
 * These launch the script the way a person would, against files shaped the way
 * the runtime writes them. A unit test of the arithmetic would not have caught
 * the failures that matter here: a wrong file name, a window that reads nothing,
 * or a bad line that takes the whole report down.
 * @module
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { auditFileName } from '../../src/seams/config.ts'
import { tempHome } from '../support/fake-ctx.ts'

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'audit-report.mjs')
/** One instant inside the window the fixtures below are written for. */
const NOW = new Date(Date.UTC(2026, 10, 24, 12, 0, 0))

/**
 * The wall clock every window is pinned to.
 *
 * The fixtures are written for 2026-11-24. A `--since 7d` window measured from
 * the real clock silently stops covering them seven days later, and the test
 * then fails for a reason that has nothing to do with the code — so the window
 * is pinned, exactly as an operator reproducing a past incident would pin it.
 */
const PINNED_NOW = '2026-11-24T12:00:00.000Z'

/** A temp home holding the given audit rows under their calendar-day files. */
function auditDir(rows: readonly Record<string, unknown>[], extra = ''): string {
  const home = tempHome('omw-audit-report-')
  const dir = join(home.dir, 'oh-my-whale')
  mkdirSync(dir, { recursive: true })
  const byDay = new Map<string, string[]>()
  for (const row of rows) {
    const day = auditFileName(new Date(String(row['ts'])))
    const bucket = byDay.get(day) ?? []
    bucket.push(JSON.stringify(row))
    byDay.set(day, bucket)
  }
  for (const [name, lines] of byDay) writeFileSync(join(dir, name), `${lines.join('\n')}\n`, 'utf8')
  if (extra !== '') writeFileSync(join(dir, auditFileName(NOW)), extra, 'utf8')
  return dir
}

/** Run the report script and return its exit code and parsed output. */
function report(dir: string, args: readonly string[] = []) {
  const result = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--json', ...args], { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** The three kinds, with the numbers the assertions below expect. */
const ROWS: Record<string, unknown>[] = [
  { kind: 'injection', ts: '2026-11-24T09:00:00.000Z', tier: 'identity', chars: 10, tokens: 100, items: ['identity'], truncated: false, prefix_unchanged: false, host_cache_read: null, host_cache_write: null, host_cache_uncached: null },
  { kind: 'injection', ts: '2026-11-24T09:00:01.000Z', tier: 'identity+state', chars: 20, tokens: 300, items: ['identity', 'state:preference'], truncated: true, prefix_unchanged: true, host_cache_read: 100, host_cache_write: 20, host_cache_uncached: 400 },
  { kind: 'recall', ts: '2026-11-24T09:00:02.000Z', session_id: 'session-alpha', query_hash: 'aaa', top_k: 5, hits: ['assertion:a:b:c', 'assertion:a:b:d'], elapsed_ms: 4, degraded: true, degraded_reason: ['vec_unavailable'] },
  { kind: 'recall', ts: '2026-11-24T09:00:03.000Z', session_id: '', query_hash: 'bbb', top_k: 5, hits: [], elapsed_ms: 9, degraded: false, degraded_reason: [] },
  { kind: 'write', ts: '2026-11-24T09:00:04.000Z', outcome: 'committed', code: 'OK', mem_keys: ['assertion:a:b:c'], elapsed_ms: 2 },
  { kind: 'write', ts: '2026-11-24T09:00:05.000Z', outcome: 'rejected', code: 'E_BOUNDARY', mem_keys: [], elapsed_ms: 3 },
]

describe('audit-report: the three kinds in one window', () => {
  it('reports both percentiles per kind, measured on what each kind records', () => {
    const result = report(auditDir(ROWS), ['--since', '7d', '--now', PINNED_NOW])
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.rows).toBe(6)
    expect(parsed.injection).toMatchObject({ count: 2, metric: 'tokens', p50: 100, p95: 300 })
    expect(parsed.recall).toMatchObject({ count: 2, metric: 'elapsed_ms', p50: 4, p95: 9 })
    expect(parsed.write).toMatchObject({ count: 2, metric: 'elapsed_ms', p50: 2, p95: 3 })
  })

  it('counts degradation in the vocabulary each kind has', () => {
    const parsed = JSON.parse(report(auditDir(ROWS), ['--since', '7d', '--now', PINNED_NOW]).stdout)
    expect(parsed.injection.tier).toEqual({ identity: 1, 'identity+state': 1 })
    expect(parsed.injection.truncated).toBe(1)
    expect(parsed.injection.prefix_unchanged).toBe(1)
    expect(parsed.injection.cache_unknown).toBe(1)
    expect(parsed.recall.degraded).toBe(1)
    expect(parsed.recall.degraded_reason).toEqual({ vec_unavailable: 1 })
    expect(parsed.recall.hits).toBe(2)
    // One row names a session, the other does not: two facts, counted apart.
    expect(parsed.recall.sessions).toBe(1)
    expect(parsed.recall.unattributed).toBe(1)
    expect(parsed.write.outcome).toEqual({ committed: 1, rejected: 1 })
    // A rejected write is the write-side degradation; `bootstrap` is not.
    expect(parsed.write.degraded).toBe(1)
  })

  it('reports the cache hit rate AD-20 defines, over the rows that measured it', () => {
    // Only the second injection row has all three buckets, so the rate is that
    // row's 100 / (100 + 20 + 400): one row measured, one left out.
    const parsed = JSON.parse(report(auditDir(ROWS), ['--since', '7d', '--now', PINNED_NOW]).stdout)
    expect(parsed.injection.cache_measured).toBe(1)
    expect(parsed.injection.cache_hit_rate).toBe(0.1923)
  })

  it('reports no hit rate at all when no row measured the cache', () => {
    // A rate over nothing is unknown, not 0%: printing 0 would read as "the
    // cache never helps" for a host that simply was never asked.
    const row = { kind: 'injection', ts: '2026-11-24T09:00:00.000Z', tier: 'identity', chars: 10, tokens: 100, items: ['identity'], truncated: false, prefix_unchanged: false, host_cache_read: null, host_cache_write: null, host_cache_uncached: null }
    const parsed = JSON.parse(report(auditDir([row]), ['--since', '7d', '--now', PINNED_NOW]).stdout)
    expect(parsed.injection.cache_measured).toBe(0)
    expect(parsed.injection.cache_hit_rate).toBeNull()
  })

  it('prints the same numbers as text when --json is absent', () => {
    const dir = auditDir(ROWS)
    const result = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--since', '7d', '--now', PINNED_NOW], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('injection')
    expect(result.stdout).toContain('tokens p50 100  p95 300')
    expect(result.stdout).toContain('elapsed_ms p50 4  p95 9')
    expect(result.stdout).toContain('tier identity=1 identity+state=1')
    expect(result.stdout).toContain('cache unknown 1')
    expect(result.stdout).toContain('cache hit rate 19.2% over 1 row(s)')
    expect(result.stdout).toContain('sessions 1')
    expect(result.stdout).toContain('unattributed 1')
    expect(result.stdout).toContain('1 file(s)')
  })
})

describe('audit-report: a window that is not clean', () => {
  it('skips a half-written line and a row of an unknown kind, and says how many', () => {
    // Append, not write: the point is a last line cut mid-object, and a whole
    // file replaced by that fragment would test nothing but an empty window.
    const dir = auditDir(ROWS)
    appendFileSync(join(dir, auditFileName(NOW)), '{"kind":"injection","ts":"2026-11-24T09:0\n', 'utf8')
    const dir2 = auditDir([...ROWS, { kind: 'dream_cycle', ts: '2026-11-24T09:00:06.000Z' }])
    const first = report(dir, ['--since', '7d', '--now', PINNED_NOW])
    expect(first.status).toBe(0)
    expect(JSON.parse(first.stdout).rows).toBe(6)
    const second = report(dir2, ['--since', '7d', '--now', PINNED_NOW])
    expect(second.status).toBe(0)
    expect(JSON.parse(second.stdout).unknown).toBe(1)
    const text = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--since', '7d', '--now', PINNED_NOW], { encoding: 'utf8' })
    expect(text.stdout).toContain('1 unreadable line(s) skipped')
  })

  it('leaves out rows from before the window instead of failing on them', () => {
    const dir = auditDir([...ROWS, { kind: 'write', ts: '2026-01-02T09:00:00.000Z', outcome: 'committed', code: 'OK', mem_keys: [], elapsed_ms: 1 }])
    const parsed = JSON.parse(report(dir, ['--since', '7d', '--now', PINNED_NOW]).stdout)
    expect(parsed.rows).toBe(6)
    expect(parsed.write.count).toBe(2)
    const text = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--since', '7d', '--now', PINNED_NOW], { encoding: 'utf8' })
    expect(text.stdout).toContain('1 line(s) before the window')
  })

  it('refuses a directory it cannot find instead of reporting an empty window', () => {
    // "0 rows, exit 0" is the report saying "nothing was ever audited". A wrong
    // directory produces exactly the same output, so the two cases cannot share
    // one answer: the operator who mistyped --dir has to be told, not reassured.
    const home = tempHome('omw-audit-report-')
    const result = report(join(home.dir, 'never-created'), ['--since', '7d', '--now', PINNED_NOW])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('审计目录不存在')
    expect(result.stderr).toContain('--dir')
  })

  it('reports an empty directory it can read as an empty window', () => {
    // The other half of the pair: a directory that exists and holds no audit
    // file is a real answer, and it must stay exit 0.
    const home = tempHome('omw-audit-report-')
    mkdirSync(join(home.dir, 'oh-my-whale'), { recursive: true })
    const parsed = JSON.parse(report(join(home.dir, 'oh-my-whale'), ['--since', '7d', '--now', PINNED_NOW]).stdout)
    expect(parsed.rows).toBe(0)
    expect(parsed.injection.p50).toBeNull()
    expect(parsed.write.outcome).toEqual({})
  })
})

describe('audit-report: usage', () => {
  it('refuses a window it cannot read, and says what it accepts', () => {
    const result = report(auditDir(ROWS), ['--since', 'yesterday'])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('24h / 7d / 30d')
  })

  it('refuses a flag it does not know', () => {
    const result = report(auditDir(ROWS), ['--everything'])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage: node scripts/audit-report.mjs')
  })

  it('refuses a date the calendar does not have instead of rolling it forward', () => {
    // Date.parse('2026-11-31') yields December 1st without complaining, so a
    // report asked for November 31st would silently cover a different day.
    const result = report(auditDir(ROWS), ['--since', '2026-11-31'])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('ISO')
  })

  it('refuses a window so wide its own timestamps cannot be printed', () => {
    // The bound leaves the representable range; formatting it would throw a
    // RangeError and the operator would read a stack instead of a usage error.
    const result = report(auditDir(ROWS), ['--since', '99999999999999999d'])
    expect(result.status).toBe(2)
    expect(result.stderr).not.toContain('RangeError')
    expect(result.stderr).toContain('24h / 7d / 30d')
  })
})

describe('audit-report: a window whose end is pinned', () => {
  it('measures the window backwards from --now instead of from the wall clock', () => {
    // Without --now the same command reads differently every day, so a report of
    // a past incident cannot be reproduced. Both ends are asserted: the far end
    // is where the wall clock would leak in, the near end is where rows fall out.
    const result = report(auditDir(ROWS), ['--since', '1h', '--now', '2026-11-24T09:00:06.000Z'])
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.window.until).toBe('2026-11-24T09:00:06.000Z')
    expect(parsed.window.since).toBe('2026-11-24T08:00:06.000Z')
    expect(parsed.rows).toBe(6)
  })

  it('refuses a --now that would roll, like --since does', () => {
    const result = report(auditDir(ROWS), ['--since', '1h', '--now', '2026-02-31'])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage: node scripts/audit-report.mjs')
  })

  it('stops at --now instead of counting rows written after it', () => {
    // A pinned window has two ends. With only the near end enforced, a report
    // reproducing an incident keeps absorbing rows written after the incident,
    // so the same command answers differently every day.
    const result = report(auditDir(ROWS), ['--since', '7d', '--now', '2026-11-24T09:00:02.000Z'])
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.rows).toBe(3)
    expect(parsed.write.count).toBe(0)
  })
})

describe('audit-report: arguments that are not what they look like', () => {
  it('treats a flag followed by another flag as a missing value', () => {
    // `--dir --json` is a forgotten directory, not a directory called "--json".
    // Reading it as a path produced an empty window with exit 0.
    const result = report('', ['--dir', '--json'])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage: node scripts/audit-report.mjs')
  })

  it('refuses a clock time with no time zone instead of reading it in the local one', () => {
    // The same command on a laptop in another zone would cover a different
    // window and report different rows, with nothing in the output saying so.
    const result = report(auditDir(ROWS), ['--since', '2026-11-24 09:00:00'])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('ISO')
  })

  it('accepts the same instant once it names its zone', () => {
    const result = report(auditDir(ROWS), ['--since', '2026-11-24T09:00:00Z'])
    expect(result.status).toBe(0)
    // Every fixture row is at or after 09:00:00Z, so naming the zone no longer
    // shifts the window and the whole set is in it.
    expect(JSON.parse(result.stdout).rows).toBe(6)
  })
})