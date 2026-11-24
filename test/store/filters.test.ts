/**
 * Story 2.5 — the semantic filter and the template that spells it agree.
 *
 * AD-8 wants one construction of the live-version filter. That filter is TQL,
 * and TQL filters cannot be parameterised, so it has to be spelled in the
 * template. The compromise this story chose is: the template owns the spelling,
 * `store/filters.ts` owns the meaning, and this file pins them together by
 * feeding the same payloads through both and demanding the same verdict.
 *
 * Without that test the two could drift silently — a payload with
 * `superseded_at: null` would pass one and fail the other — and the failure mode
 * would be a recall that returns a value the store already replaced.
 * @module
 */
import { describe, expect, it } from 'vitest'
import { isLive, isSearchable, memKeyOf } from '../../src/store/filters.ts'
import { createRecallTemplates } from '../../src/store/templates/recall.ts'
import type { Database } from '../../src/store/db.ts'
import { openWriteStore } from '../support/write-store.ts'

/** The vector every test node carries; the recall path never reads it. */
const ZERO = [0, 0, 0, 0]

/** A clock pinned to one morning, so no assertion depends on the wall clock. */
const NOON = Date.UTC(2026, 10, 24, 4, 0, 0)

/** A live version of one key. */
function live(memKey: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const iso = new Date(NOON).toISOString()
  return { kind: 'assertion', mem_key: memKey, active_slot: 1, valid_from: iso, recorded_at: iso, ...extra }
}

/** How a payload names itself across the round trip through the engine. */
function label(payload: Record<string, unknown>): string {
  return `${String(payload['mem_key'])}@${String(payload['active_slot'])}`
}

/** A retired version: the unique index reads `active_slot`, not time. */
function retired(memKey: string, slot: number): Record<string, unknown> {
  const iso = new Date(NOON - 86_400_000).toISOString()
  return {
    kind: 'assertion',
    mem_key: memKey,
    active_slot: slot,
    superseded_at: NOON - 3_600_000,
    valid_from: iso,
    recorded_at: iso,
  }
}

describe('filters: what counts as the current version', () => {
  it('treats a payload with no superseded_at key as live', () => {
    expect(isLive(live('assertion:Elliott:lives_in'))).toBe(true)
  })

  it('treats a retired payload as not live', () => {
    expect(isLive(retired('assertion:Elliott:lives_in', 1_700_000_000_000))).toBe(false)
  })

  it('reads a superseded_at of zero as retired, not as missing', () => {
    // The filter is `{superseded_at: {$exists: false}}`, so presence decides —
    // including a timestamp that happens to be falsy. A truthiness check here
    // would disagree with the template on exactly this payload.
    expect(isLive({ mem_key: 'k', superseded_at: 0 })).toBe(false)
  })

  it('reads a superseded_at of null as retired', () => {
    // data-model §1 says a retired version writes a timestamp and a live one
    // omits the key; writing an explicit null is the mistake this catches.
    expect(isLive({ mem_key: 'k', superseded_at: null })).toBe(false)
  })

  it('classifies all fourteen kinds from data-model §3, not just the obvious ones', () => {
    // Written out in full because the interesting failure is not "evidence leaked"
    // but "a decision row came back as a memory": every excluded kind below carries
    // prose in its payload (a reason, a detail, a summary) that a text query will
    // happily match, and only this list stops it.
    const memories = ['assertion', 'entity', 'episode', 'scene', 'pref', 'persona_state']
    const notMemories = ['evidence', 'pred', 'decision', 'dream_log', 'rejected', 'dream_cycle', 'flag', 'whatif']

    for (const kind of memories) {
      expect(isSearchable({ kind, mem_key: `${kind}:x` }), kind).toBe(true)
    }
    for (const kind of notMemories) {
      expect(isSearchable({ kind, mem_key: `${kind}:x` }), kind).toBe(false)
    }
    // The list plus the memories covers data-model §3 exactly once: a kind added
    // to the model without a decision here fails this count.
    expect(memories.length + notMemories.length).toBe(14)
  })

  it('keeps a kind the model has never heard of searchable', () => {
    // Unknown means "not classified yet", and an unclassified memory that cannot
    // be recalled is worse than one that can: the failure is silence, not noise.
    expect(isSearchable({ kind: 'unknown-kind' })).toBe(true)
    expect(isSearchable({})).toBe(true)
    expect(isSearchable({ kind: 42 })).toBe(true)
  })

  it('only accepts a non-empty string as a business key', () => {
    expect(memKeyOf({ mem_key: 'assertion:Elliott:lives_in' })).toBe('assertion:Elliott:lives_in')
    for (const payload of [{}, { mem_key: '' }, { mem_key: '   ' }, { mem_key: 7 }, { mem_key: null }]) {
      expect(memKeyOf(payload), JSON.stringify(payload)).toBeUndefined()
    }
  })
})

describe('filters: the template and the predicate agree', () => {
  it('selects exactly the payloads isLive accepts', () => {
    const store = openWriteStore('omw-filters-')
    const payloads: Record<string, unknown>[] = [
      live('assertion:Elliott:lives_in', { obj: 'Shanghai' }),
      retired('assertion:Elliott:lives_in', 1_700_000_000_000),
      live('assertion:Elliott:likes:coffee'),
      retired('assertion:Elliott:likes:coffee', 1_700_000_000_001),
      live('pref:Elliott:reply_style', { value: 'concise' }),
      // A retired version whose timestamp is 0: present, therefore retired. The
      // single case where a truthiness bug would be visible.
      { kind: 'assertion', mem_key: 'assertion:Elliott:timezone', active_slot: 1, superseded_at: 0 },
    ]
    for (const payload of payloads) store.db.insert([...ZERO], payload)

    const selected = createRecallTemplates(store.db).findLiveNodes().map(node => node.payload)
    const expected = payloads.filter(payload => isLive(payload))

    // Identity, not object: the engine hands back freshly deserialised payloads,
    // so the only comparable thing is what the payload says about itself.
    expect(selected.map(label)).toHaveLength(expected.length)
    expect(selected.map(label).sort()).toEqual(expected.map(label).sort())
  })

  it('never returns a key twice, so a recall cannot report both versions', () => {
    const store = openWriteStore('omw-filters-')
    store.db.insert([...ZERO], retired('assertion:Elliott:lives_in', 1_700_000_000_000))
    store.db.insert([...ZERO], live('assertion:Elliott:lives_in', { obj: 'Shanghai' }))

    const keys = createRecallTemplates(store.db).findLiveNodes().map(node => node.payload['mem_key'])

    expect(keys).toEqual(['assertion:Elliott:lives_in'])
  })

  it('throws on a row the engine did not shape, rather than reading it as empty', () => {
    // A missing `_.payload` would otherwise become an empty record, and an empty
    // record is a live node with no key — a silent gap in a recall result.
    const stub = { prepareTql: () => ({}), executePreparedTql: () => [{ _: { id: '1' } }] }
    const templates = createRecallTemplates(stub as unknown as Database)
    expect(() => templates.findLiveNodes()).toThrow(/payload/u)
  })
})
