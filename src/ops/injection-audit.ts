/**
 * Injection audit rows: one line per assembly (AD-20, Story 2.6).
 *
 * The row cannot be written at mount, because the three numbers that matter most
 * in it — the host's cache accounting — are per *session*, and a plugin mounted
 * once serves every session. It cannot be written by the section provider either,
 * because the provider knows the session but not what was composed. So this module
 * sits between them and joins the two facts: the provider reports "a session
 * assembled just now", and the plan says what was in it.
 *
 * It keeps one small map per session (the last digest and the last cumulative
 * usage) and nothing else; the rows themselves live in {@link Audit}.
 * @module
 */
import { createHash } from 'node:crypto'
import type { Audit, InjectionAuditRow, InjectionTier } from './audit.ts'
import type { InjectionPlan } from '../seams/prompt-composer.ts'

/**
 * The host's cumulative token accounting for one session, in the three input buckets.
 *
 * A bucket is `null` when the host could not say: the projection is filled in as
 * the host measures, so one bucket can land before another. The three are judged
 * one by one — a missing write bucket says nothing about the read bucket, and
 * blanking all three because one is absent would throw away a number the row
 * could have reported.
 */
export interface HostUsage {
  readonly read: number | null
  readonly write: number | null
  readonly uncached: number | null
}

/** What an auditor needs. */
export interface InjectionAuditorOptions {
  /** Where rows go. */
  readonly audit: Audit
  /** Clock; the row's `ts` and nothing else. */
  readonly now?: () => Date
  /**
   * The host's cumulative usage for a session, or `undefined` when it cannot say.
   *
   * Cumulative, not per-call: the row wants a delta, and a delta needs a previous
   * reading. Returning `undefined` is a normal answer — a host without a token
   * meter, or one that has not measured this session yet — and produces `null`s.
   */
  readonly hostUsage?: (sessionId: string) => HostUsage | undefined
}

/** One assembly to record. */
export interface InjectionRecord {
  /** The host's session; `undefined` when the host assembled outside a session. */
  readonly sessionId: string | undefined
  /** The plan that was registered. */
  readonly plan: InjectionPlan
  /**
   * Wall time the assembly took, in whole milliseconds (P0-8).
   *
   * Supplied by the composer, which is the only place that sees both the start
   * and the end of one assembly. A row that measured nothing of its own would
   * put a zero in the p50/p95 pool and drag the percentiles down.
   */
  readonly elapsedMs: number
}

/** The injection-audit seam. */
export interface InjectionAuditor {
  /**
   * Append one row for one assembly.
   * @param record - the session and the plan.
   * @returns the row written, or `undefined` when the assembly cannot be named
   *   (a host that assembled with no session has no `session_id` to record, and a
   *   row claiming one would be a fabricated fact).
   * @throws when the audit refuses the row; callers on the injection path catch it.
   */
  record(record: InjectionRecord): InjectionAuditRow | undefined
  /**
   * Forget what this session looked like.
   *
   * Called when a session ends, so the maps do not grow for the life of the
   * process. A forgotten session that assembles again is treated as new: its
   * first row reports `prefix_unchanged: false`, which is true — from this
   * auditor's point of view the prefix did change.
   * @param sessionId - the session to drop.
   */
  forget(sessionId: string): void
}

/**
 * How many sessions this auditor remembers at once.
 *
 * The runtime mounts once and sees every session the host opens, so two maps
 * keyed by session id would grow for the life of the process. `forget()` exists
 * for a host that says when a session ends, but nothing in this plugin is told
 * that today, so the bound is what actually keeps it finite: past this many
 * sessions the oldest one is dropped, and a dropped session that assembles
 * again is measured from a fresh baseline (its `prefix_unchanged` is `false` and
 * its cache delta starts over, both of which are true statements).
 */
export const AUDITOR_SESSIONS_RETAINED = 500

/** The zero baseline: a session that has spent nothing under our observation. */
const ZERO: HostUsage = { read: 0, write: 0, uncached: 0 }

/**
 * How many sessions the auditor remembers having lost a baseline for.
 *
 * When the session bound evicts a session, its digest and baseline both go, so a
 * session that comes back looks brand new. It is not: the host's numbers are
 * cumulative for the session, not for our observation of it, so treating the
 * first reading after eviction as a delta would attribute a whole conversation's
 * spend to one assembly. Remembering that this session was evicted (for as many
 * sessions as the auditor tracks at all) lets the next row say `null` — unknown —
 * and start measuring from there.
 */
const EVICTED_SESSIONS_RETAINED = AUDITOR_SESSIONS_RETAINED

/**
 * Create the injection auditor.
 * @param options - audit target, clock and the optional host usage reader.
 * @returns the seam.
 */
export function createInjectionAuditor(options: InjectionAuditorOptions): InjectionAuditor {
  const now = options.now ?? (() => new Date())
  const digests = new Map<string, string>()
  const baselines = new Map<string, HostUsage>()
  const evicted = new Set<string>()
  return {
    record(record: InjectionRecord): InjectionAuditRow | undefined {
      const { sessionId, plan, elapsedMs } = record
      if (sessionId === undefined || sessionId === '') return undefined
      const digest = digestOf(plan)
      const previous = digests.get(sessionId)
      const delta = readDelta(sessionId)
      // One clock read for the row: the audit facade derives the file name from
      // `ts`, so reading again there would let a row whose instant straddles
      // midnight land in a file the row's own timestamp contradicts.
      const at = now()
      const row: InjectionAuditRow = {
        kind: 'injection',
        ts: at.toISOString(),
        session_id: sessionId,
        tier: tierOf(plan),
        // All three tiers are on the wire now that recall has a channel, so the
        // row counts all three. Until P0-1 it deliberately excluded recall —
        // counting text the model never saw would have been a lie.
        chars: plan.persona.chars + plan.tail.chars + plan.recall.chars,
        tokens: plan.identityTokens + plan.tail.tokens + plan.recall.tokens,
        items: itemsOf(plan),
        truncated: plan.persona.truncated || plan.tail.truncated || plan.recall.truncated,
        prefix_unchanged: previous !== undefined && previous === digest,
        elapsed_ms: elapsedMs,
        host_cache_read: delta.usage.read,
        host_cache_write: delta.usage.write,
        host_cache_uncached: delta.usage.uncached,
      }
      options.audit.append(row)
      // The baseline moves only once the row is on its way to disk. A refused
      // append must not consume the window: the next row would then report a
      // delta measured from an assembly nobody can look up.
      if (delta.current !== undefined) baselines.set(sessionId, delta.current)
      remember(sessionId, digest)
      return row
    },
    forget(sessionId: string): void {
      digests.delete(sessionId)
      baselines.delete(sessionId)
      // A host that says the session ended is telling us the next reading really
      // is a fresh start, so the eviction doubt goes with the baseline.
      evicted.delete(sessionId)
    },
  }

  /**
   * Record what this session's text looked like, evicting the oldest session.
   *
   * A `Map` iterates in insertion order, so the first key is the least recently
   * *first seen* session, not the least recently used. Re-inserting on every
   * assembly is what makes eviction follow use rather than age: a chatty session
   * that has been open for hours is the one a report is most likely to want.
   * @param sessionId - the session.
   * @param digest - the text digest for this assembly.
   */
  function remember(sessionId: string, digest: string): void {
    digests.delete(sessionId)
    digests.set(sessionId, digest)
    evicted.delete(sessionId)
    while (digests.size > AUDITOR_SESSIONS_RETAINED) {
      const oldest = digests.keys().next()
      if (oldest.done === true) break
      digests.delete(oldest.value)
      baselines.delete(oldest.value)
      evicted.delete(oldest.value)
      evicted.add(oldest.value)
      while (evicted.size > EVICTED_SESSIONS_RETAINED) {
        const stale = evicted.values().next()
        if (stale.done === true) break
        evicted.delete(stale.value)
      }
    }
  }

  /**
   * The three cache numbers for this assembly, as a delta.
   *
   * Each bucket is `null` on its own when it cannot be attributed: the host could
   * not say, the previous reading was itself unknown, the bucket went backwards
   * (the buckets are cumulative, so a smaller reading means the host reset its
   * accounting or restarted), or this session's baseline was evicted. A bucket
   * that did land is still reported — one unknown column does not make the other
   * two unknown, and a fabricated zero would claim this assembly genuinely hit no
   * cache. The baseline still moves to the new reading, so the next row is
   * measured from what the host now believes.
   * @param sessionId - the session.
   * @returns the delta for this row, plus the reading the baseline should hold
   *   afterwards (`undefined` when the host cannot say). The caller advances the
   *   baseline, because only the caller knows whether the row was written.
   */
  function readDelta(sessionId: string): { usage: HostUsage; current: HostUsage | undefined } {
    const unknown: HostUsage = { read: null, write: null, uncached: null }
    const current = options.hostUsage?.(sessionId)
    if (current === undefined) return { usage: unknown, current: undefined }
    // A session whose baseline was evicted is not new, however much it looks it:
    // the host keeps counting across our forgetting, so its first reading here
    // already includes everything it spent while we were not watching. There is
    // no honest delta, and the next row — measured from this reading — is the
    // first one that can be attributed to a single assembly.
    if (evicted.has(sessionId)) return { usage: unknown, current }
    const previous = baselines.get(sessionId) ?? ZERO
    return { usage: deltaOf(current, previous), current }
  }
}

/**
 * Which channels landed, as the closed vocabulary asks for it.
 * @param plan - the assembly.
 * @returns the tier.
 */
function tierOf(plan: InjectionPlan): InjectionTier {
  // Derived from the kept lists -- the very lists itemsOf() names -- so a row can
  // never claim a tier while listing units it did not carry. tail.text is not the
  // same source: a host that kept an earlier registration leaves a plan whose text
  // and kept list can disagree, and the tier would then contradict the items
  // printed on the same line.
  const state = plan.tail.kept.length > 0
  const recall = plan.recall.kept.length > 0
  if (state && recall) return 'identity+state+recall'
  if (recall) return 'identity+recall'
  return state ? 'identity+state' : 'identity'
}

/**
 * The prompt units this assembly carried.
 *
 * Unit names, never `mem_key`s: an injection is a set of units, and a business key
 * belongs to the recall row that returned it. Recall contributes one unit per kept
 * item, under the `recall` prefix — the names are what a reader groups by, and a
 * bare `mem_key` would put a business identity on the wrong row.
 * @param plan - the assembly.
 * @returns the unit names, identity first.
 */
function itemsOf(plan: InjectionPlan): readonly string[] {
  return [
    'identity',
    ...plan.tail.kept.map(segment => `state:${segment}`),
    ...plan.recall.kept.map((_item, index) => `recall:${index + 1}`),
  ]
}

/**
 * Digest of the injected text, for `prefix_unchanged`.
 *
 * Two assemblies are "the same prefix" when the bytes the host will see are the
 * same; the separator keeps a tail that merely shifts the boundary from looking
 * identical to a different split between identity and tail.
 * @param plan - the assembly.
 * @returns the hex digest.
 */
function digestOf(plan: InjectionPlan): string {
  return createHash('sha256').update(plan.persona.text, 'utf8').update('\u0000', 'utf8').update(plan.tail.text ?? '', 'utf8').digest('hex')
}

/**
 * The per-bucket difference between two readings, judged bucket by bucket.
 *
 * A bucket that went backwards (the host reset its accounting, or restarted) is
 * not attributable to this assembly, so it is `null`; the other buckets are still
 * differences of real readings and are reported. One bad bucket does not make the
 * other two unknown, and a fabricated zero for the bad one would claim this
 * assembly genuinely hit no cache.
 * @param current - the reading now.
 * @param previous - the reading the baseline holds.
 * @returns one delta, with `null` where a bucket cannot be attributed.
 */
function deltaOf(current: HostUsage, previous: HostUsage): HostUsage {
  return {
    read: difference(current.read, previous.read),
    write: difference(current.write, previous.write),
    uncached: difference(current.uncached, previous.uncached),
  }
}

/**
 * One bucket's difference, or null when it cannot be attributed.
 * @param current - the reading now, or null when the host could not say.
 * @param previous - the baseline, or null when it was unknown.
 * @returns the difference, or null.
 */
function difference(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null
  const delta = current - previous
  return delta < 0 ? null : delta
}