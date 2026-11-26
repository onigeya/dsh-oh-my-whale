/**
 * `/omw-stats` — the three roads, summarised by their own criteria (P0-8).
 *
 * The point of these tests is that each road's numbers answer a different
 * question. A shared shape would let a mutation "make all three count
 * `truncated`" pass, so every case asserts the road-specific criterion and the
 * absence of the others'.
 * @module
 */
import { describe, expect, it } from 'vitest'
import type { InjectionAuditRow, RecallAuditRow, WriteAuditRow } from '../../src/ops/audit.ts'
import { parseStatsWindow, percentiles, renderStats, summarizeAudit } from '../../src/ops/stats.ts'

const NOW = new Date('2026-11-26T12:00:00.000Z')

/** One injection row, `hoursAgo` before {@link NOW}. */
function injection(overrides: Partial<InjectionAuditRow> = {}): InjectionAuditRow {
  return {
    kind: 'injection',
    ts: NOW.toISOString(),
    session_id: 'session-alpha',
    tier: 'identity',
    chars: 100,
    tokens: 30,
    items: ['identity'],
    truncated: false,
    prefix_unchanged: true,
    elapsed_ms: 1,
    host_cache_read: null,
    host_cache_write: null,
    host_cache_uncached: null,
    ...overrides,
  }
}

/** One recall row. */
function recall(overrides: Partial<RecallAuditRow> = {}): RecallAuditRow {
  return {
    kind: 'recall',
    ts: NOW.toISOString(),
    session_id: 'session-alpha',
    query_hash: 'abc',
    top_k: 5,
    hits: [],
    elapsed_ms: 10,
    degraded: false,
    degraded_reason: [],
    ...overrides,
  }
}

/** One write row. */
function write(overrides: Partial<WriteAuditRow> = {}): WriteAuditRow {
  return {
    kind: 'write',
    ts: NOW.toISOString(),
    outcome: 'committed',
    code: 'OK',
    mem_keys: [],
    elapsed_ms: 5,
    ...overrides,
  }
}

describe('stats: percentiles', () => {
  it('reports an empty sample as nulls rather than zeros', () => {
    // Zero would read as "instantaneous", which is a different claim.
    expect(percentiles([])).toEqual({ count: 0, p50: null, p95: null })
  })

  it('uses nearest-rank, so a percentile is a duration something actually took', () => {
    expect(percentiles([5])).toEqual({ count: 1, p50: 5, p95: 5 })
    // 1..10: p50 is the 5th value, p95 the 10th — no interpolated 9.55.
    expect(percentiles([10, 1, 9, 2, 8, 3, 7, 4, 6, 5])).toEqual({ count: 10, p50: 5, p95: 10 })
  })
})

describe('stats: the window', () => {
  it('reads hours, days and milliseconds', () => {
    expect(parseStatsWindow('24h')).toEqual({ ok: true, window: { sinceMs: 86_400_000 } })
    expect(parseStatsWindow('7d')).toEqual({ ok: true, window: { sinceMs: 604_800_000 } })
    expect(parseStatsWindow('30m'.replace('m', 'ms'))).toEqual({ ok: true, window: { sinceMs: 30 } })
  })

  it('reads an absent flag as the whole file', () => {
    expect(parseStatsWindow('')).toEqual({ ok: true, window: { all: true } })
    expect(parseStatsWindow('all')).toEqual({ ok: true, window: { all: true } })
  })

  it('refuses a value it cannot read, instead of guessing at a unit', () => {
    for (const bad of ['yesterday', '24', 'h', '-1h']) {
      const parsed = parseStatsWindow(bad)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.reason).toContain('无法识别的窗口')
    }
  })

  it('refuses a zero window, which can only ever be an empty report', () => {
    const parsed = parseStatsWindow('0h')
    expect(parsed.ok).toBe(false)
  })

  it('keeps a row whose timestamp it cannot parse rather than dropping it', () => {
    // Silently losing a malformed row is worse than counting it once.
    const report = summarizeAudit([injection({ ts: 'not a date' })], { sinceMs: 1 }, NOW)
    expect(report.rows).toBe(1)
  })

  it('scopes by the row timestamp, not by how long ago the command ran', () => {
    const old = new Date(NOW.getTime() - 2 * 86_400_000).toISOString()
    const report = summarizeAudit(
      [injection({ ts: NOW.toISOString() }), injection({ ts: old, truncated: true })],
      { sinceMs: 86_400_000 },
      NOW,
    )
    expect(report.rows).toBe(1)
    // The recent row is not truncated, and the old one is out of scope.
    expect(report.injection.truncated).toBe(0)
    expect(report.since).toBe('2026-11-25T12:00:00.000Z')
  })
})

describe('stats: each road uses its own criterion', () => {
  it('counts truncated injections, not degraded ones', () => {
    const report = summarizeAudit([
      injection({ truncated: true }),
      injection({ truncated: false }),
      injection({ truncated: true, tier: 'identity+state+recall' }),
    ], { all: true }, NOW)

    expect(report.injection.truncated).toBe(2)
    expect(report.injection.latency.count).toBe(3)
    expect(report.injection.tiers).toEqual([
      { name: 'identity', count: 2 },
      { name: 'identity+state+recall', count: 1 },
    ])
  })

  it('groups recalls by reason, and counts a two-reason recall in both', () => {
    const report = summarizeAudit([
      recall({ degraded: true, degraded_reason: ['rerank_unavailable'] }),
      recall({ degraded: true, degraded_reason: ['rerank_unavailable', 'recall_timeout'] }),
      recall({ degraded: false, degraded_reason: [] }),
    ], { all: true }, NOW)

    expect(report.recall.degraded).toBe(2)
    expect(report.recall.reasons).toEqual([
      { name: 'rerank_unavailable', count: 2 },
      { name: 'recall_timeout', count: 1 },
    ])
  })

  it('counts only downgraded and rejected writes as not clean', () => {
    const report = summarizeAudit([
      write({ outcome: 'committed' }),
      write({ outcome: 'bootstrap' }),
      write({ outcome: 'downgraded', code: 'E_DEGRADED' }),
      write({ outcome: 'rejected', code: 'E_CONFLICT' }),
      write({ outcome: 'rejected', code: 'E_CONFLICT' }),
    ], { all: true }, NOW)

    expect(report.write.notClean).toBe(3)
    expect(report.write.outcomes).toEqual([
      { name: 'rejected', count: 2 },
      { name: 'bootstrap', count: 1 },
      { name: 'committed', count: 1 },
      { name: 'downgraded', count: 1 },
    ])
    // Codes come from the not-clean rows only: a clean commit's OK is not a code.
    expect(report.write.codes).toEqual([
      { name: 'E_CONFLICT', count: 2 },
      { name: 'E_DEGRADED', count: 1 },
    ])
  })

  it('reports a latency per road, not one shared number', () => {
    const report = summarizeAudit([
      injection({ elapsed_ms: 2 }),
      recall({ elapsed_ms: 40 }),
      recall({ elapsed_ms: 60 }),
      write({ elapsed_ms: 7 }),
    ], { all: true }, NOW)

    expect(report.injection.latency).toEqual({ count: 1, p50: 2, p95: 2 })
    expect(report.recall.latency).toEqual({ count: 2, p50: 40, p95: 60 })
    expect(report.write.latency).toEqual({ count: 1, p50: 7, p95: 7 })
  })
})

describe('stats: rendering', () => {
  it('ends with one parseable JSON line', () => {
    const text = renderStats(summarizeAudit([injection({ elapsed_ms: 3 })], { all: true }, NOW))
    const json = JSON.parse(text.split('\n').at(-1) ?? '{}') as {
      ok: boolean
      tool: string
      report: { injection: { latency: { p50: number } } }
    }
    expect(json.ok).toBe(true)
    expect(json.tool).toBe('omw-stats')
    expect(json.report.injection.latency.p50).toBe(3)
  })

  it('says a window was empty instead of printing zeros as if they were data', () => {
    const text = renderStats(summarizeAudit([], { sinceMs: 3_600_000 }, NOW))
    expect(text).toContain('窗口内没有审计行')
    expect(text).toContain('无样本')
  })

  it('names the scope it covered', () => {
    expect(renderStats(summarizeAudit([], { all: true }, NOW))).toContain('全量')
    expect(renderStats(summarizeAudit([], { sinceMs: 3_600_000 }, NOW))).toContain('自 2026-11-26T11:00:00.000Z')
  })
})