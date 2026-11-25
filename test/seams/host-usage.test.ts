/**
 * The host token accounting reader (Story 2.6, AD-20).
 *
 * This module exists because the host services are optional. Every test here is
 * really one question: when the host cannot say, does the reader answer unknown
 * instead of inventing a number? A zero would be indistinguishable from the host
 * measuring nothing, and the audit row would then claim a cache saving that never
 * happened.
 * @module
 */
import { describe, expect, it } from 'vitest'
import { createHostUsageReader } from '../../src/seams/host-usage.ts'

/** A session store whose get answers from a map and records the calls. */
function store(sessions: Record<string, unknown>, calls: string[] = []) {
  return {
    get(id: string) {
      calls.push(id)
      return sessions[id]
    },
  }
}

/** A projection registry answering one values object. */
function projections(values: Record<string, unknown>) {
  return { snapshot: () => ({ values }) }
}

/**
 * A well-shaped host pair with one session.
 * @param usage - whatever the tokenUsage projection should hold.
 */
function host(usage: unknown) {
  return {
    sessions: store({ s1: { id: 's1' } }),
    projections: projections(usage === undefined ? {} : { tokenUsage: usage }),
  }
}

describe('host usage: reading one session', () => {
  it('returns the three buckets when the host has all of them', () => {
    const { sessions, projections: registry } = host({ cacheReadTokens: 900, cacheWriteTokens: 100, uncachedInputTokens: 3000 })
    const read = createHostUsageReader(sessions, registry)
    expect(read('s1')).toEqual({ read: 900, write: 100, uncached: 3000 })
  })

  it('returns undefined for a session the store does not know', () => {
    const { sessions, projections: registry } = host({ cacheReadTokens: 1, cacheWriteTokens: 2, uncachedInputTokens: 3 })
    const read = createHostUsageReader(sessions, registry)
    expect(read('missing')).toBeUndefined()
  })

  it('reports a missing bucket as null and keeps the buckets the host did land', () => {
    // The projection fills in as the host measures, so one bucket can be written
    // before another. Blanking all three because one is absent would throw away
    // two numbers the row can honestly report.
    const registry = projections({ tokenUsage: { cacheReadTokens: 900, cacheWriteTokens: 100 } })
    const read = createHostUsageReader(store({ s1: { id: 's1' } }), registry)
    expect(read('s1')).toEqual({ read: 900, write: 100, uncached: null })
  })

  it('treats a non-finite or negative bucket as that bucket being unknown', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, '900', null]) {
      const registry = projections({ tokenUsage: { cacheReadTokens: bad, cacheWriteTokens: 100, uncachedInputTokens: 3000 } })
      const read = createHostUsageReader(store({ s1: { id: 's1' } }), registry)
      expect(read('s1'), String(bad)).toEqual({ read: null, write: 100, uncached: 3000 })
    }
  })

  it('accepts zero, because zero is a measurement', () => {
    const { sessions, projections: registry } = host({ cacheReadTokens: 0, cacheWriteTokens: 0, uncachedInputTokens: 0 })
    const read = createHostUsageReader(sessions, registry)
    expect(read('s1')).toEqual({ read: 0, write: 0, uncached: 0 })
  })

  it('passes the session id to the store, so it reads the session it names', () => {
    const calls: string[] = []
    const { projections: registry } = host({ cacheReadTokens: 1, cacheWriteTokens: 2, uncachedInputTokens: 3 })
    const read = createHostUsageReader(store({ s7: { id: 's7' } }, calls), registry)
    expect(read('s7')).toEqual({ read: 1, write: 2, uncached: 3 })
    expect(calls).toEqual(['s7'])
  })
})

describe('host usage: a host that cannot answer', () => {
  it('answers undefined for every session when either service is absent or not the right shape', () => {
    const present = host({ cacheReadTokens: 1, cacheWriteTokens: 2, uncachedInputTokens: 3 })
    const pairs: readonly (readonly [unknown, unknown])[] = [
      [undefined, present.projections],
      [present.sessions, undefined],
      [{}, present.projections],
      [present.sessions, {}],
      [null, present.projections],
      [{ get: 1 }, present.projections],
    ]
    for (const [sessions, registry] of pairs) {
      expect(createHostUsageReader(sessions, registry)('s1')).toBeUndefined()
    }
  })

  it('answers undefined when the projection itself throws', () => {
    const throwing = { snapshot: () => { throw new Error('session forked away') } }
    const read = createHostUsageReader(store({ s1: { id: 's1' } }), throwing)
    expect(read('s1')).toBeUndefined()
  })

  it('answers undefined when the tokenUsage projection is missing or not an object', () => {
    for (const values of [{}, { tokenUsage: null }, { tokenUsage: 42 }]) {
      const read = createHostUsageReader(store({ s1: { id: 's1' } }), projections(values))
      expect(read('s1'), JSON.stringify(values)).toBeUndefined()
    }
  })

  it('answers undefined when the store throws', () => {
    const throwing = { get: () => { throw new Error('store is gone') } }
    const registry = projections({ tokenUsage: { cacheReadTokens: 1, cacheWriteTokens: 2, uncachedInputTokens: 3 } })
    const read = createHostUsageReader(throwing, registry)
    expect(read('s1')).toBeUndefined()
  })
})
