#!/usr/bin/env node
/**
 * Summarize the audit log: three kinds of row, one report (AC⑤).
 *
 * The audit files are local JSONL split by calendar day, so the report is a
 * plain read of whatever files fall inside the requested window — no database,
 * no service, no build step. It runs against a repository checkout as-is.
 *
 *   node scripts/audit-report.mjs --since 24h
 *   node scripts/audit-report.mjs --since 7d --dir /path/to/oh-my-whale --json
 *
 * The three metrics are the three things each kind of row can be slow or
 * expensive about: an injection is measured in the tokens it spent, a recall and
 * a write in the milliseconds they took. A number that a kind does not record is
 * reported as `null` rather than as 0.
 * @module
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const AUDIT_NAME = /^audit-(\d{4})(\d{2})(\d{2})\.jsonl$/
/** Kinds a row may declare; anything else is counted as `unknown` and ignored. */
const KINDS = ['injection', 'recall', 'write']
/** The largest instant `Date` can print; beyond it `toISOString` throws. */
const MAX_INSTANT = 8.64e15

const USAGE = [
  'usage: node scripts/audit-report.mjs [--since <24h|7d|30d|ISO>] [--dir <dataDir>] [--now <ISO>] [--json]',
  '',
  '  --since   window to report on, default 24h',
  '  --dir     directory holding audit-YYYYMMDD.jsonl, default OH_MY_WHALE_DATA_DIR',
  '            or <$DSH_HOME|~/.dsh>/oh-my-whale',
  '  --now     pin the end of the window instead of using the wall clock, so a',
  '            report of a past incident reads the same tomorrow',
  '  --json    print the report as JSON instead of text',
].join('\n')

main(process.argv.slice(2))

/**
 * Where the plugin keeps its data directory when nobody says otherwise.
 *
 * The plugin resolves `<dshHome>/oh-my-whale`, and the harness home is
 * `$DSH_HOME` or `~/.dsh` (`resolveDshHome`). Reading `$OH_MY_WHALE_DATA_DIR`
 * first keeps an override; falling back to `./data` would make a bare run print
 * "0 rows" against a directory the plugin never writes.
 * @returns an absolute directory path.
 */
function defaultDataDir() {
  const home = process.env.DSH_HOME?.trim()
  const root = home === undefined || home === '' ? join(homedir(), '.dsh') : home
  return join(root, 'oh-my-whale')
}
/** Parse arguments, read the window, print. Exits 2 on bad usage. */
function main(argv) {
  const options = parseArgs(argv)
  if (options === undefined) {
    process.stderr.write(`${USAGE}\n`)
    process.exit(2)
  }

  const now = options.now === undefined ? Date.now() : options.now
  const since = cutoffOf(options.since, now)
  if (since === undefined) {
    process.stderr.write(`omw: --since 看不懂 “${options.since}”，接受 24h / 7d / 30d 或 ISO 时间\n`)
    process.exit(2)
  }

  const dir = resolve(options.dir)
  // A directory that is not there is not the same fact as a directory with no
  // rows: the first means the report is pointed at the wrong place (a bare run
  // resolves the plugin default, which an install can move), and printing
  // "0 rows" with exit 0 reads like "nothing was ever audited".
  if (!existsSync(dir)) {
    process.stderr.write(`omw: 审计目录不存在 —— ${dir}\n      用 --dir 指到插件真正写入的目录（默认取 $OH_MY_WHALE_DATA_DIR 或 <$DSH_HOME|~/.dsh>/oh-my-whale）\n`)
    process.exit(2)
  }
  const read = readWindow(dir, since, now)
  const report = summarize(read.rows, { since, now, dir })
  const text = options.json ? `${JSON.stringify(report, null, 2)}\n` : format(report, read)
  process.stdout.write(text)
}

/**
 * Read `--since`, `--dir` and `--json`.
 * @returns the options, or `undefined` when an argument is unknown or a value is missing.
 */
function parseArgs(argv) {
  const options = { since: '24h', dir: process.env.OH_MY_WHALE_DATA_DIR ?? defaultDataDir(), json: false, now: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--json') {
      options.json = true
      continue
    }
    const value = argv[index + 1]
    // `--dir --json` means the directory was forgotten, not that the directory
    // is called "--json": without this the report reads a path that cannot exist
    // and reports an empty window with exit 0.
    if (value === undefined || value.startsWith('--')) return undefined
    if (flag === '--since') options.since = value
    else if (flag === '--dir') options.dir = value
    else if (flag === '--now') {
      const pinned = exactInstant(value)
      // A window end that silently rolls (2026-02-31 -> March 3) would shift
      // every number in the report without saying so, so it is a usage error.
      if (pinned === undefined) return undefined
      options.now = pinned
    } else return undefined
    index += 1
  }
  return options
}

/**
 * Turn `24h` / `7d` / `30d` / an ISO instant into a lower bound in epoch ms.
 *
 * A bare number would be ambiguous (seconds? days?), so the units are required.
 * @returns the bound, or `undefined` when the text is neither a window nor a date.
 */
function cutoffOf(since, now) {
  const window = /^(\d+)([hd])$/.exec(since)
  if (window !== null) {
    const size = Number(window[1])
    if (!Number.isFinite(size) || size <= 0) return undefined
    const bound = now - size * (window[2] === 'h' ? 3600000 : 86400000)
    // A window so wide it leaves the representable range would make the
    // report's own timestamps unprintable; refuse it as a usage error instead
    // of crashing halfway through formatting.
    return Number.isFinite(bound) && Math.abs(bound) <= MAX_INSTANT ? bound : undefined
  }
  return exactInstant(since)
}

/**
 * Parse an ISO instant, refusing dates the calendar does not have.
 *
 * `Date.parse('2026-11-31')` does not fail: it rolls forward to December 1st.
 * A window silently moved by a day reports the wrong rows with exit code 0,
 * which is the worst kind of wrong — so the parse is checked against its own
 * input rather than trusted.
 * @param text - a date or date-time string.
 * @returns epoch milliseconds, or `undefined` when the text is not a real instant.
 */
function exactInstant(text) {
  const parsed = Date.parse(text)
  if (!Number.isFinite(parsed)) return undefined
  if (Math.abs(parsed) > MAX_INSTANT) return undefined
  // A date-only string is the only shape whose canonical form differs from its
  // input (2026-11-31T00:00:00.000Z vs 2026-11-31). Comparing the day back is
  // what catches the roll; a full instant round-trips through toISOString.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text)
  // A date-only string is read as UTC, which is unambiguous. A string that names
  // a clock time but no zone is read in the machine's zone, so the same command
  // covers a different window on a laptop in another timezone and the report
  // silently shifts by the offset. Requiring the zone keeps a window portable.
  if (!dateOnly && !/(Z|[+-]\d{2}:?\d{2})$/.test(text)) return undefined
  const canonical = new Date(parsed).toISOString()
  if (dateOnly) return canonical.startsWith(text) ? parsed : undefined
  return parsed
}

/**
 * Read every audit line in `dir` whose `ts` falls inside `[since, until]`.
 *
 * The end of the window matters as much as the start: without it, a `--now`
 * pinned to reproduce a past incident would still pull in rows written after
 * that instant, and the report of the incident would keep changing.
 *
 * A line that is not JSON, or that has no parseable `ts`, is counted as a
 * malformed line instead of failing the report: a half-written last line is a
 * normal state for an append-only file, and the rest of the file is still true.
 * @returns the rows in window, plus how much was read and skipped.
 */
function readWindow(dir, since, until) {
  const rows = []
  let files = 0
  let lines = 0
  let malformed = 0
  let outside = 0
  let unreadable = 0
  let names = []
  try {
    names = readdirSync(dir).filter(name => AUDIT_NAME.test(name)).sort()
  } catch {
    // A missing directory is an empty window, not an error (REP_EMPTY).
    return { rows, files: 0, lines: 0, malformed, outside, unreadable }
  }
  for (const name of names) {
    files += 1
    let body
    try {
      body = readFileSync(join(dir, name), 'utf8')
    } catch {
      // A file that cannot be read is not a malformed line: counting it as one
      // makes the report claim a line was skipped that was never read at all.
      unreadable += 1
      continue
    }
    for (const raw of body.split('\n')) {
      if (raw.trim() === '') continue
      lines += 1
      let row
      try {
        row = JSON.parse(raw)
      } catch {
        malformed += 1
        continue
      }
      const at = typeof row?.ts === 'string' ? Date.parse(row.ts) : Number.NaN
      if (!Number.isFinite(at)) {
        malformed += 1
        continue
      }
      if (at < since || at > until) {
        outside += 1
        continue
      }
      rows.push(row)
    }
  }
  return { rows, files, lines, malformed, outside, unreadable }
}

/**
 * Reduce the rows in the window to per-kind counts.
 *
 * @param rows - parsed audit rows, already inside the window.
 * @param window - the resolved window, echoed into the report so a reader knows
 *   what the numbers cover.
 * @returns a plain object ready for JSON or {@link format}.
 */
function summarize(rows, window) {
  const byKind = new Map(KINDS.map(kind => [kind, []]))
  let unknown = 0
  for (const row of rows) {
    const bucket = byKind.get(row?.kind)
    if (bucket === undefined) {
      unknown += 1
      continue
    }
    bucket.push(row)
  }

  const injection = summarizeInjection(byKind.get('injection'))
  const recall = summarizeRecall(byKind.get('recall'))
  const write = summarizeWrite(byKind.get('write'))
  return {
    window: {
      dir: window.dir,
      since: isoOrRaw(window.since),
      until: isoOrRaw(window.now),
    },
    rows: rows.length,
    unknown,
    injection,
    recall,
    write,
  }
}

/**
 * An instant as ISO text, or the raw number when it is outside the printable range.
 *
 * The report is a diagnostic: a window it cannot format must still be printed,
 * because a stack trace from the report tells the operator nothing about the
 * audit rows, and exit 1 with a `RangeError` reads like the audit is broken.
 * @param value - epoch milliseconds.
 * @returns ISO text, or the decimal value as a string.
 */
function isoOrRaw(value) {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_INSTANT) return String(value)
  return new Date(value).toISOString()
}

/**
 * Injection rows: the metric is tokens, the extra signal is what got cut.
 *
 * Also the one number AD-20 defines over these rows — the cache hit rate,
 * `ΣcacheRead / (ΣcacheRead + ΣcacheWrite + Σuncached)`. It is a ratio of
 * token totals, not an average of per-row ratios: the totals are what the vendor
 * bills, and a row that spent 10 tokens must not weigh as much as one that spent
 * 10000. Rows with any bucket unknown are left out of the sum rather than
 * counted as zero, which would pull the rate down for a fact nobody measured.
 */
function summarizeInjection(rows) {
  const tokens = numeric(rows, 'tokens')
  const measured = rows.filter(row => [row.host_cache_read, row.host_cache_write, row.host_cache_uncached]
    .every(value => typeof value === 'number' && Number.isFinite(value)))
  const cached = measured.reduce((total, row) => total + row.host_cache_read, 0)
  const cacheTotal = measured.reduce(
    (total, row) => total + row.host_cache_read + row.host_cache_write + row.host_cache_uncached,
    0,
  )
  return {
    count: rows.length,
    metric: 'tokens',
    p50: percentile(tokens, 0.5),
    p95: percentile(tokens, 0.95),
    tier: histogram(rows, row => row.tier),
    truncated: rows.filter(row => row.truncated === true).length,
    prefix_unchanged: rows.filter(row => row.prefix_unchanged === true).length,
    // A `null` cache column means the host could not be asked, which is not the
    // same fact as a row that measured zero (AC①, Design Note 3). All three
    // columns are asked because they come from one reader and a row can have one
    // of them missing while the other two landed.
    cache_unknown: rows.filter(row => [row.host_cache_read, row.host_cache_write, row.host_cache_uncached]
      .some(value => value === null || value === undefined)).length,
    cache_measured: measured.length,
    // `null` when no row measured all three buckets: a rate over nothing is not
    // 0%, it is unknown, and printing 0% would read as "the cache never helps".
    cache_hit_rate: cacheTotal === 0 ? null : round(cached / cacheTotal),
  }
}

/** Four decimals, so a JSON report and a text report agree on the same number. */
function round(value) {
  return Math.round(value * 10000) / 10000
}

/** Recall rows: the metric is elapsed_ms, the extra signal is degradation. */
function summarizeRecall(rows) {
  const elapsed = numeric(rows, 'elapsed_ms')
  const reasons = new Map()
  let degraded = 0
  for (const row of rows) {
    if (row.degraded !== true) continue
    degraded += 1
    const list = Array.isArray(row.degraded_reason) ? row.degraded_reason : []
    if (list.length === 0) reasons.set('(none recorded)', (reasons.get('(none recorded)') ?? 0) + 1)
    for (const reason of list) reasons.set(String(reason), (reasons.get(String(reason)) ?? 0) + 1)
  }
  // A recall is the only channel through which a session reads memory, so the
  // session is what makes a hit rate attributable. Rows from a host that handed
  // the tool no session carry an empty string rather than a made-up id, and are
  // counted apart instead of being folded into one anonymous bucket.
  const attributed = rows.filter(row => typeof row.session_id === 'string' && row.session_id !== '')
  return {
    count: rows.length,
    metric: 'elapsed_ms',
    p50: percentile(elapsed, 0.5),
    p95: percentile(elapsed, 0.95),
    degraded,
    degraded_reason: Object.fromEntries([...reasons].sort((left, right) => left[0].localeCompare(right[0]))),
    hits: rows.reduce((total, row) => total + (Array.isArray(row.hits) ? row.hits.length : 0), 0),
    sessions: new Set(attributed.map(row => row.session_id)).size,
    unattributed: rows.length - attributed.length,
  }
}

/** Write rows: the metric is elapsed_ms, the extra signal is the outcome mix. */
function summarizeWrite(rows) {
  const elapsed = numeric(rows, 'elapsed_ms')
  return {
    count: rows.length,
    metric: 'elapsed_ms',
    p50: percentile(elapsed, 0.5),
    p95: percentile(elapsed, 0.95),
    outcome: histogram(rows, row => row.outcome),
    // A write row is a degradation when it did not commit, or when it committed
    // less than asked; `bootstrap` is the seed install, which is neither.
    degraded: rows.filter(row => row.outcome === 'rejected' || row.outcome === 'downgraded').length,
  }
}

/** Collect one numeric field, dropping rows that do not have a finite number there. */
function numeric(rows, field) {
  const values = []
  for (const row of rows) {
    const value = row?.[field]
    if (typeof value === 'number' && Number.isFinite(value)) values.push(value)
  }
  return values.sort((left, right) => left - right)
}

/**
 * Nearest-rank percentile over an already sorted list.
 *
 * Nearest-rank rather than interpolation: every number this reports is a real
 * observed value, so a p95 of 12 rows is the 12th row, never an average of two.
 * @returns the value, or `null` when there is nothing to rank.
 */
function percentile(sorted, fraction) {
  if (sorted.length === 0) return null
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(fraction * sorted.length)))
  return sorted[rank - 1]
}

/** Count rows by one string field, in descending count order then by name. */
function histogram(rows, read) {
  const counts = new Map()
  for (const row of rows) {
    const key = read(row)
    if (typeof key !== 'string') continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return Object.fromEntries([...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])))
}

/** Render the report as text, one block per kind. */
function format(report, read) {
  const out = []
  out.push(`omw audit — ${report.window.since} → ${report.window.until}`)
  out.push(`  dir ${report.window.dir}`)
  out.push(`  ${read.files} file(s), ${read.lines} line(s) read, ${report.rows} in window`)
  if (read.outside > 0) out.push(`  ${read.outside} line(s) before the window`)
  if (read.malformed > 0) out.push(`  ${read.malformed} unreadable line(s) skipped`)
  if (read.unreadable > 0) out.push(`  ${read.unreadable} file(s) could not be read`)
  if (report.unknown > 0) out.push(`  ${report.unknown} row(s) with an unknown kind skipped`)
  out.push('')
  out.push(...block('injection', report.injection, [
    ['tier', report.injection.tier],
    ['truncated', report.injection.truncated],
    ['prefix unchanged', report.injection.prefix_unchanged],
    ['cache unknown', report.injection.cache_unknown],
    ['cache hit rate', formatRate(report.injection.cache_hit_rate, report.injection.cache_measured)],
  ]))
  out.push(...block('recall', report.recall, [
    ['degraded', report.recall.degraded],
    ['reasons', report.recall.degraded_reason],
    ['hits', report.recall.hits],
    ['sessions', report.recall.sessions],
    ['unattributed', report.recall.unattributed],
  ]))
  out.push(...block('write', report.write, [
    ['outcome', report.write.outcome],
    ['degraded', report.write.degraded],
  ]))
  return `${out.join('\n')}\n`
}

/**
 * The hit rate as a percentage, with the sample size it was measured on.
 *
 * The count travels with the rate on purpose: "12.5%" over 3 rows and over 3000
 * rows are different facts, and the operator deciding whether the cache is
 * working needs to know which one they are reading.
 */
function formatRate(rate, rows) {
  if (rate === null) return '—'
  const percent = `${(rate * 100).toFixed(1)}%`
  return rows === 0 ? percent : `${percent} over ${rows} row(s)`
}

/** One kind's block: count, the two percentiles, then the extra fields. */
function block(kind, summary, extras) {
  const out = []
  out.push(`${kind}`)
  out.push(`  rows ${summary.count}   ${summary.metric} p50 ${show(summary.p50)}  p95 ${show(summary.p95)}`)
  for (const [label, value] of extras) {
    if (typeof value === 'number' || typeof value === 'string') {
      out.push(`  ${label} ${value}`)
      continue
    }
    const entries = Object.entries(value)
    if (entries.length === 0) continue
    out.push(`  ${label} ${entries.map(([key, count]) => `${key}=${count}`).join(' ')}`)
  }
  out.push('')
  return out
}

/** A percentile, or an explicit dash when there was nothing to measure. */
function show(value) {
  return value === null ? '—' : String(value)
}