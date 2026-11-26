/**
 * `/omw-stats` — one time window over the three audit roads (P0-8, Story 2.7).
 *
 * The three roads answer different questions and are therefore summarised by
 * different criteria; forcing one shared shape on them would produce a number
 * that means nothing:
 *
 * - **injection** counts `truncated = true`, because the question is "did the
 *   prompt get cut this round";
 * - **recall** groups by `degraded_reason`, because a degraded recall is not
 *   uniformly bad — a 250ms timeout and a missing reranker are different facts;
 * - **write** groups by `outcome ∈ {downgraded, rejected}` plus `code`, because
 *   a `downgraded` write still landed something while a `rejected` one did not.
 *
 * All three report p50/p95 over `elapsed_ms`: the one column every road always
 * carries, and the only way an operator can tell "slow" from "wrong".
 *
 * This module reads rows, never the store. It is a pure function of the audit
 * rows it is handed, so the command can pass retained rows from a live handle or
 * parse a file — and a test can hand it a fixture with no filesystem at all.
 * @module
 */
import type { AuditRow, InjectionAuditRow, RecallAuditRow, WriteAuditRow } from './audit.ts'

/** The window a report covers. */
export type StatsWindow = { readonly sinceMs: number } | { readonly all: true }

/** Percentile pair, whole milliseconds. */
export interface LatencySummary {
  readonly count: number
  /** `null` when the sample is empty: zero would read as "instant". */
  readonly p50: number | null
  readonly p95: number | null
}

/** One named tally. */
export interface NamedCount {
  readonly name: string
  readonly count: number
}

/** The injection road's summary. */
export interface InjectionStats {
  readonly latency: LatencySummary
  /** Assemblies whose text was cut to fit the budget. */
  readonly truncated: number
  /** Per-tier counts, in the closed tier vocabulary's order. */
  readonly tiers: readonly NamedCount[]
}

/** The recall road's summary. */
export interface RecallStats {
  readonly latency: LatencySummary
  /** Recalls that came back with at least one degraded reason. */
  readonly degraded: number
  /** One row per distinct reason; a recall with two reasons counts in both. */
  readonly reasons: readonly NamedCount[]
}

/** The write road's summary. */
export interface WriteStats {
  readonly latency: LatencySummary
  /** `downgraded` + `rejected` — the two outcomes that are not a clean commit. */
  readonly notClean: number
  readonly outcomes: readonly NamedCount[]
  /** One row per distinct failure code among the not-clean writes. */
  readonly codes: readonly NamedCount[]
}

/** One report. */
export interface StatsReport {
  /** How many rows were in scope; the file may hold more, outside the window. */
  readonly rows: number
  /** The ISO instant the window opens at, or `null` for "everything". */
  readonly since: string | null
  readonly injection: InjectionStats
  readonly recall: RecallStats
  readonly write: WriteStats
}

/**
 * Compute p50/p95 by nearest-rank.
 *
 * Nearest-rank rather than interpolation: every number here is a whole
 * millisecond count, and an interpolated percentile would report a duration that
 * no assembly actually took. With one sample both percentiles are that sample.
 * @param values - the durations, in any order.
 * @returns the pair, or nulls when there is nothing to summarise.
 */
export function percentiles(values: readonly number[]): LatencySummary {
  if (values.length === 0) return { count: 0, p50: null, p95: null }
  const sorted = [...values].sort((left, right) => left - right)
  const at = (fraction: number): number => {
    const rank = Math.ceil(fraction * sorted.length)
    return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!
  }
  return { count: sorted.length, p50: at(0.5), p95: at(0.95) }
}

/**
 * Tally values into named counts, largest first, ties broken by name.
 *
 * Sorting is part of the contract, not cosmetics: a report whose row order
 * changes between two runs of the same window cannot be diffed.
 * @param values - one entry per occurrence.
 * @returns the tallies.
 */
function tally(values: readonly string[]): readonly NamedCount[] {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
}

/**
 * Whether a row falls inside the window.
 *
 * `sinceMs` is subtracted from the row's own timestamp, not from "now": the
 * caller decides what the window means, and a row with an unparseable `ts` is
 * kept rather than dropped — losing a malformed row silently is worse than
 * counting it once.
 * @param row - the row to test.
 * @param sinceMs - window length, or `undefined` for everything.
 * @param now - the instant the window ends.
 * @returns true when the row belongs in the report.
 */
function inWindow(row: AuditRow, sinceMs: number | undefined, now: Date): boolean {
  if (sinceMs === undefined) return true
  const at = Date.parse(row.ts)
  if (Number.isNaN(at)) return true
  return at >= now.getTime() - sinceMs
}

/**
 * Parse a `--since` argument into a window.
 *
 * The accepted forms are deliberately few: an operator typing this by hand will
 * write `24h` or `7d`, and everything else is a mistake worth reporting rather
 * than guessing at. A bare number is read as hours, which is the unit the docs
 * use everywhere else.
 * @param raw - the flag value, or the empty string when the flag was absent.
 * @returns the window, or why the value cannot be read.
 */
export function parseStatsWindow(raw: string): { ok: true; window: StatsWindow } | { ok: false; reason: string } {
  const text = raw.trim().toLowerCase()
  if (text === '' || text === 'all') return { ok: true, window: { all: true } }
  const match = /^(\d+)(ms|h|d|w)$/u.exec(text)
  if (match === null) {
    return { ok: false, reason: `无法识别的窗口 "${raw}"：请写 24h、7d、30m 这类形式，或 --all` }
  }
  const amount = Number(match[1])
  const unit = match[2]
  const factor = unit === 'ms' ? 1 : unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 7 * 86_400_000
  if (amount === 0) return { ok: false, reason: `窗口不能是 0，那一定会是空报告` }
  return { ok: true, window: { sinceMs: amount * factor } }
}

/**
 * Aggregate audit rows into one report.
 * @param rows - every row the caller can see, in any order.
 * @param window - the time window to apply.
 * @param now - the instant the window ends; defaults to the clock.
 * @returns the report.
 */
export function summarizeAudit(
  rows: readonly AuditRow[],
  window: StatsWindow,
  now: Date = new Date(),
): StatsReport {
  const sinceMs = 'all' in window ? undefined : window.sinceMs
  const scoped = rows.filter(row => inWindow(row, sinceMs, now))
  const injections = scoped.filter((row): row is InjectionAuditRow => row.kind === 'injection')
  const recalls = scoped.filter((row): row is RecallAuditRow => row.kind === 'recall')
  const writes = scoped.filter((row): row is WriteAuditRow => row.kind === 'write')

  const notClean = writes.filter(row => row.outcome === 'downgraded' || row.outcome === 'rejected')
  return {
    rows: scoped.length,
    since: sinceMs === undefined ? null : new Date(now.getTime() - sinceMs).toISOString(),
    injection: {
      latency: percentiles(injections.map(row => row.elapsed_ms)),
      truncated: injections.filter(row => row.truncated).length,
      tiers: tally(injections.map(row => row.tier)),
    },
    recall: {
      latency: percentiles(recalls.map(row => row.elapsed_ms)),
      degraded: recalls.filter(row => row.degraded).length,
      reasons: tally(recalls.flatMap(row => row.degraded_reason)),
    },
    write: {
      latency: percentiles(writes.map(row => row.elapsed_ms)),
      notClean: notClean.length,
      outcomes: tally(writes.map(row => row.outcome)),
      codes: tally(notClean.map(row => row.code)),
    },
  }
}

/** One line of the human-readable body. */
function lineOf(label: string, latency: LatencySummary, extra: string): string {
  const timing = latency.count === 0
    ? '无样本'
    : `n=${latency.count} p50=${String(latency.p50)}ms p95=${String(latency.p95)}ms`
  return `${label} ${timing}${extra === '' ? '' : ' | ' + extra}`
}

/**
 * Render one report as message text: a human body plus one JSON line.
 *
 * The JSON line is the last line so a caller can split on `\n` and parse the
 * tail, which is the convention every other `/omw-*` read in this build follows.
 * @param report - the report to render.
 * @returns the text.
 */
export function renderStats(report: StatsReport): string {
  const scope = report.since === null ? '全量' : `自 ${report.since}`
  const lines = [`omw-stats: ${scope}，共 ${report.rows} 行审计`]

  lines.push(lineOf('注入', report.injection.latency,
    `截断 ${report.injection.truncated} 次；档位 ${report.injection.tiers.map(entry => `${entry.name}×${entry.count}`).join('、') || '无'}`))
  lines.push(lineOf('召回', report.recall.latency,
    `降级 ${report.recall.degraded} 次；原因 ${report.recall.reasons.map(entry => `${entry.name}×${entry.count}`).join('、') || '无'}`))
  lines.push(lineOf('写入', report.write.latency,
    `未干净 ${report.write.notClean} 次；结果 ${report.write.outcomes.map(entry => `${entry.name}×${entry.count}`).join('、') || '无'}`
    + (report.write.codes.length === 0 ? '' : `；错误码 ${report.write.codes.map(entry => `${entry.name}×${entry.count}`).join('、')}`)))

  if (report.rows === 0) {
    lines.push('窗口内没有审计行。审计是追加写的，先确认这个窗口里确实装配过、召回过或写入过。')
  }
  lines.push(JSON.stringify({ ok: true, tool: 'omw-stats', report }))
  return lines.join('\n')
}
