/**
 * Injection audit rows (Story 2.6, AD-20).
 *
 * The row is the only record of what actually rode into a prompt, so every field
 * here is a claim someone will later count: which tier, how many tokens, whether
 * the prefix was stable, and what the host's own cache accounting said. The
 * dangerous field is `prefix_unchanged` — a row that says `true` when nothing was
 * compared would make a cache argument out of nothing.
 * @module
 */
import { describe, expect, it } from 'vitest'
import { createAudit, createMemoryAuditSink, type InjectionAuditRow } from '../../src/ops/audit.ts'
import { createInjectionAuditor, type HostUsage } from '../../src/ops/injection-audit.ts'
import type { InjectionPlan, TailPlan } from '../../src/seams/prompt-composer.ts'
import { tempHome } from '../support/fake-ctx.ts'

const NOW = new Date(Date.UTC(2026, 10, 24, 4, 0, 0))

/** A tail plan with the given segments and text. */
function tail(overrides: Partial<TailPlan> = {}): TailPlan {
  return {
    text: '关系：同事。\n偏好：简洁。',
    kept: ['relationship', 'preference'],
    dropped: [],
    chars: 18,
    tokens: 12,
    truncated: false,
    ...overrides,
  }
}

/** A plan with only the identity section on the wire. */
function identityOnly(overrides: Partial<InjectionPlan> = {}): InjectionPlan {
  return {
    persona: {
      name: 'harness:identity',
      order: -1000,
      text: 'You are the whale.',
      hash: 'a'.repeat(64),
      chars: 19,
      truncated: false,
    },
    tail: { text: undefined, kept: [], dropped: [], chars: 0, tokens: 0, truncated: false },
    recall: { kept: [], chars: 0, overCount: 0, overBudget: 0, tokens: 0, truncated: false },
    identityTokens: 4,
    budget: 154,
    tokens: 4,
    truncatedItems: [],
    truncated: false,
    prefixUnchanged: false,
    ...overrides,
  }
}

/** A plan carrying the state tail. */
function withTail(overrides: Partial<InjectionPlan> = {}): InjectionPlan {
  return identityOnly({
    tail: tail(),
    tokens: 16,
    truncatedItems: [],
    ...overrides,
  })
}

/** Build an auditor over a fresh memory sink. */
function harness(options: { hostUsage?: (sessionId: string) => HostUsage | undefined } = {}) {
  const home = tempHome('omw-inject-audit-')
  const sink = createMemoryAuditSink()
  const audit = createAudit({ dataDir: home.dir, now: () => NOW, sink })
  const auditor = createInjectionAuditor({
    audit,
    now: () => NOW,
    ...(options.hostUsage === undefined ? {} : { hostUsage: options.hostUsage }),
  })
  return { home, sink, audit, auditor }
}

describe('injection audit: a session it cannot name', () => {
  it('writes nothing at all rather than a fabricated session_id', () => {
    const { home, audit, auditor } = harness()
    try {
      expect(auditor.record({ sessionId: undefined, elapsedMs: 1, plan: identityOnly() })).toBeUndefined()
      expect(auditor.record({ sessionId: '', elapsedMs: 1, plan: identityOnly() })).toBeUndefined()
      expect(audit.rows).toEqual([])
    } finally {
      home.remove()
    }
  })
})

describe('injection audit: what the row says was injected', () => {
  it('reports the identity tier when there is no tail', () => {
    const { home, auditor } = harness()
    try {
      const row = auditor.record({ sessionId: 's1', elapsedMs: 1, plan: identityOnly() }) as InjectionAuditRow
      expect(row.tier).toBe('identity')
      expect(row.items).toEqual(['identity'])
      expect(row.chars).toBe(19)
      expect(row.tokens).toBe(4)
    } finally {
      home.remove()
    }
  })

  it('reports identity+state and names every kept segment when the tail rode along', () => {
    const { home, auditor } = harness()
    try {
      const row = auditor.record({ sessionId: 's1', elapsedMs: 1, plan: withTail() }) as InjectionAuditRow
      expect(row.tier).toBe('identity+state')
      expect(row.items).toEqual(['identity', 'state:relationship', 'state:preference'])
      expect(row.chars).toBe(19 + 18)
      expect(row.tokens).toBe(4 + 12)
    } finally {
      home.remove()
    }
  })

  it('takes the tier from the segments that rode along, not from the text', () => {
    // A host that refuses to replace its section leaves the old registration in
    // place, so a plan can carry tail text whose kept list is empty. Naming a
    // state tier there would claim a state section the prompt does not have.
    const { home, auditor } = harness()
    try {
      const stale = identityOnly({ tail: tail({ kept: [], chars: 0, tokens: 0 }) })
      const row = auditor.record({ sessionId: 's1', elapsedMs: 1, plan: stale }) as InjectionAuditRow
      expect(row.tier).toBe('identity')
      expect(row.items).toEqual(['identity'])
    } finally {
      home.remove()
    }
  })

  it('counts recall tokens, because recall now has a channel into the prompt', () => {
    const { home, auditor } = harness()
    try {
      const plan = withTail({
        recall: { kept: [{ memKey: 'assertion:Elliott:likes:coffee', text: '喜欢咖啡' }], chars: 4, overCount: 0, overBudget: 0, tokens: 99, truncated: false },
        tokens: 16 + 99,
      })
      const row = auditor.record({ sessionId: 's1', elapsedMs: 1, plan }) as InjectionAuditRow
      expect(row.tokens).toBe(16 + 99)
      expect(row.tier).toBe('identity+state+recall')
      // The business key never reaches the row: an injection names units, and a
      // `mem_key` belongs to the recall row that returned it.
      expect(row.items).toEqual(['identity', 'state:relationship', 'state:preference', 'recall:1'])
    } finally {
      home.remove()
    }
  })

  it('counts a cut on whichever tier was cut, recall included', () => {
    const { home, auditor } = harness()
    try {
      const recallCut: InjectionPlan = withTail({
        recall: { kept: [], chars: 0, overCount: 0, overBudget: 2, tokens: 0, truncated: true },
        truncatedItems: ['recall'],
        truncated: true,
      })
      expect((auditor.record({ sessionId: 's1', elapsedMs: 1, plan: recallCut }) as InjectionAuditRow).truncated).toBe(true)
      const tailCut: InjectionPlan = withTail({
        tail: tail({ kept: ['relationship'], dropped: ['preference'], truncated: true }),
        truncatedItems: ['state:preference'],
        truncated: true,
      })
      expect((auditor.record({ sessionId: 's2', elapsedMs: 1, plan: tailCut }) as InjectionAuditRow).truncated).toBe(true)
    } finally {
      home.remove()
    }
  })

  it('names the tier from the kept lists, so it can never contradict the items', () => {
    const { home, auditor } = harness()
    try {
      const recallOnly = identityOnly({
        recall: { kept: [{ memKey: 'assertion:a:b:c', text: 'x' }], chars: 1, overCount: 0, overBudget: 0, tokens: 1, truncated: false },
      })
      expect((auditor.record({ sessionId: 's1', elapsedMs: 1, plan: recallOnly }) as InjectionAuditRow).tier).toBe('identity+recall')
      const neither = identityOnly()
      expect((auditor.record({ sessionId: 's2', elapsedMs: 1, plan: neither }) as InjectionAuditRow).tier).toBe('identity')
    } finally {
      home.remove()
    }
  })

  it('carries the assembly duration it was handed, and invents nothing when none was measured', () => {
    const { home, auditor } = harness()
    try {
      const row = auditor.record({ sessionId: 's1', elapsedMs: 7, plan: identityOnly() }) as InjectionAuditRow
      expect(row.elapsed_ms).toBe(7)
      // Zero is a real measurement (an assembly that took under a millisecond),
      // and it must survive as zero rather than be replaced by a placeholder.
      expect((auditor.record({ sessionId: 's2', elapsedMs: 0, plan: identityOnly() }) as InjectionAuditRow).elapsed_ms).toBe(0)
    } finally {
      home.remove()
    }
  })
})

describe('injection audit: prefix_unchanged', () => {
  it('is false on the first assembly, because nothing was compared', () => {
    const { home, auditor } = harness()
    try {
      const row = auditor.record({ sessionId: 's1', elapsedMs: 1, plan: identityOnly() }) as InjectionAuditRow
      expect(row.prefix_unchanged).toBe(false)
    } finally {
      home.remove()
    }
  })

  it('is true on the second identical assembly and false once the text differs', () => {
    const { home, auditor } = harness()
    try {
      auditor.record({ sessionId: 's1', elapsedMs: 1, plan: identityOnly() })
      expect((auditor.record({ sessionId: 's1', elapsedMs: 1, plan: identityOnly() }) as InjectionAuditRow).prefix_unchanged).toBe(true)
      const changed = identityOnly({ tail: tail({ text: '关系：同事。' }) })
      expect((auditor.record({ sessionId: 's1', elapsedMs: 1, plan: changed }) as InjectionAuditRow).prefix_unchanged).toBe(false)
    } finally {
      home.remove()
    }
  })

  it('keeps one history per session, so two sessions never compare against each other', () => {
    const { home, auditor } = harness()
    try {
      auditor.record({ sessionId: 's1', elapsedMs: 1, plan: identityOnly() })
      expect((auditor.record({ sessionId: 's2', elapsedMs: 1, plan: identityOnly() }) as InjectionAuditRow).prefix_unchanged).toBe(false)
      expect((auditor.record({ sessionId: 's1', elapsedMs: 1, plan: identityOnly() }) as InjectionAuditRow).prefix_unchanged).toBe(true)
    } finally {
      home.remove()
    }
  })

  it('treats a forgotten session as new', () => {
    const { home, auditor } = harness()
    try {
      auditor.record({ sessionId: 's1', elapsedMs: 1, plan: identityOnly() })
      auditor.forget('s1')
      expect((auditor.record({ sessionId: 's1', elapsedMs: 1, plan: identityOnly() }) as InjectionAuditRow).prefix_unchanged).toBe(false)
    } finally {
      home.remove()
    }
  })

  it('tells a shifted identity/tail boundary apart from an identical prompt', () => {
    const { home, auditor } = harness()
    try {
      // Same concatenated text, different split: the host sees the same bytes, but
      // a row claiming they are the same prefix would hide that the identity section
      // changed length. The digest separates them with a NUL.
      auditor.record({ sessionId: 's1', elapsedMs: 1, plan: identityOnly({ persona: { name: 'harness:identity', order: -1000, text: 'AB', hash: 'b'.repeat(64), chars: 2, truncated: false }, tail: tail({ text: 'C', kept: ['relationship'], chars: 1, tokens: 1 }) }) })
      const row = auditor.record({ sessionId: 's1', elapsedMs: 1, plan: identityOnly({ persona: { name: 'harness:identity', order: -1000, text: 'A', hash: 'c'.repeat(64), chars: 1, truncated: false }, tail: tail({ text: 'BC', kept: ['relationship'], chars: 2, tokens: 2 }) }) }) as InjectionAuditRow
      expect(row.prefix_unchanged).toBe(false)
    } finally {
      home.remove()
    }
  })
})

describe('injection audit: the host cache columns', () => {
  it('are null when the host cannot say', () => {
    const { home, auditor } = harness()
    try {
      const row = auditor.record({ sessionId: 's1', elapsedMs: 1, plan: identityOnly() }) as InjectionAuditRow
      expect(row.host_cache_read).toBeNull()
      expect(row.host_cache_write).toBeNull()
      expect(row.host_cache_uncached).toBeNull()
    } finally {
      home.remove()
    }
  })

  it('reports the delta between two readings, not the reading', () => {
    const readings: HostUsage[] = [
      { read: 1000, write: 200, uncached: 3000 },
      { read: 1500, write: 250, uncached: 3500 },
    ]
    let index = 0
    const { home, auditor } = harness({ hostUsage: () => readings[index++] })
    try {
      const first = auditor.record({ sessionId: 's1', elapsedMs: 1, plan: identityOnly() }) as InjectionAuditRow
      // The first row is measured from zero: everything the session spent is this
      // session's, and there is no earlier observation to subtract.
      expect([first.host_cache_read, first.host_cache_write, first.host_cache_uncached]).toEqual([1000, 200, 3000])
      const second = auditor.record({ sessionId: 's1', elapsedMs: 1, plan: identityOnly() }) as InjectionAuditRow
      expect([second.host_cache_read, second.host_cache_write, second.host_cache_uncached]).toEqual([500, 50, 500])
    } finally {
      home.remove()
    }
  })

  it('reports null when a bucket went backwards, and re-baselines anyway', () => {
    const readings: HostUsage[] = [
      { read: 1000, write: 200, uncached: 3000 },
      { read: 10, write: 5, uncached: 20 },
      { read: 30, write: 15, uncached: 60 },
    ]
    let index = 0
    const { home, auditor } = harness({ hostUsage: () => readings[index++] })
    try {
      auditor.record({ sessionId: 's1', elapsedMs: 1, plan: identityOnly() })
      const reset = auditor.record({ sessionId: 's1', elapsedMs: 1, plan: identityOnly() }) as InjectionAuditRow
      expect([reset.host_cache_read, reset.host_cache_write, reset.host_cache_uncached]).toEqual([null, null, null])
      // The baseline moved to the post-reset reading, so the next delta is real.
      const after = auditor.record({ sessionId: 's1', elapsedMs: 1, plan: identityOnly() }) as InjectionAuditRow
      expect([after.host_cache_read, after.host_cache_write, after.host_cache_uncached]).toEqual([20, 10, 40])
    } finally {
      home.remove()
    }
  })

  it('does not move the baseline when the row never left the auditor', () => {
    // If the append is refused, the assembly that produced the delta is not on
    // disk. Advancing the baseline there would make the next row measure from an
    // assembly nobody can look up, and the cached tokens would vanish silently.
    const readings: HostUsage[] = [
      { read: 1000, write: 200, uncached: 3000 },
      { read: 1500, write: 250, uncached: 3500 },
    ]
    let index = 0
    const home = tempHome('omw-inject-audit-')
    let refused = false
    const refusing = createAudit({
      dataDir: home.dir,
      now: () => NOW,
      // The first append is the one that fails; the retry is the case under test.
      sink: {
        write() {
          if (refused) return
          refused = true
          throw new Error('disk full')
        },
      },
    })
    const auditor = createInjectionAuditor({ audit: refusing, now: () => NOW, hostUsage: () => readings[index++] })
    try {
      expect(() => auditor.record({ sessionId: 's1', elapsedMs: 1, plan: identityOnly() })).toThrow('disk full')
      // The retry is measured from zero, as if the refused row had never happened.
      const row = auditor.record({ sessionId: 's1', elapsedMs: 1, plan: identityOnly() }) as InjectionAuditRow
      expect([row.host_cache_read, row.host_cache_write, row.host_cache_uncached]).toEqual([1500, 250, 3500])
      // The digest did not advance either, so nothing was compared.
      expect(row.prefix_unchanged).toBe(false)
    } finally {
      home.remove()
    }
  })

  it('treats a fresh session as having spent nothing yet', () => {
    const readings: Record<string, HostUsage> = {
      s1: { read: 500, write: 100, uncached: 900 },
      s2: { read: 7, write: 3, uncached: 11 },
    }
    const { home, auditor } = harness({ hostUsage: (sessionId: string) => readings[sessionId] })
    try {
      auditor.record({ sessionId: 's1', elapsedMs: 1, plan: identityOnly() })
      const row = auditor.record({ sessionId: 's2', elapsedMs: 1, plan: identityOnly() }) as InjectionAuditRow
      expect([row.host_cache_read, row.host_cache_write, row.host_cache_uncached]).toEqual([7, 3, 11])
    } finally {
      home.remove()
    }
  })
})

describe('injection audit: the row it lands', () => {
  it('is a closed-tier row with the auditor clock and the session', () => {
    const { home, audit } = harness()
    try {
      const spot = createInjectionAuditor({ audit, now: () => NOW })
      spot.record({ sessionId: 'session-alpha', elapsedMs: 1, plan: withTail() })
      expect(audit.rows).toHaveLength(1)
      const row = audit.rows[0] as InjectionAuditRow
      expect(row.kind).toBe('injection')
      expect(row.session_id).toBe('session-alpha')
      expect(row.ts).toBe(NOW.toISOString())
    } finally {
      home.remove()
    }
  })
})
