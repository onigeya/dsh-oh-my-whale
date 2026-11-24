/**
 * Story 2.5 — the recall read path, one acceptance criterion at a time.
 *
 * Two properties are worth naming because they are easy to lose silently: a
 * refused call must not have read the store at all (AC②), and a successful call
 * must not have written anything (AC④). Neither is checked by reading the answer
 * — both are asserted against a counting proxy around the handle, so the code
 * could not satisfy them by reporting the right thing after doing the wrong one.
 * @module
 */
import { mkdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEGRADED_REASONS, isDegradedReason } from '../../src/core/degrade.ts'
import { DEFAULT_CANDIDATE_POOL, DEFAULT_TOP_K, MAX_TOP_K } from '../../src/core/recall.ts'
import { closeDatabase, openDatabase, type Database } from '../../src/store/db.ts'
import { createRecallReader, RECALL_DEGRADED_REASONS } from '../../src/seams/recall-reader.ts'
import { tempHome } from '../support/fake-ctx.ts'
import { TEST_DIM, openWriteStore } from '../support/write-store.ts'

/**
 * The only handle methods a recall may call.
 *
 * An allowlist, not a denylist. Listing the write methods meant a handle method
 * added later (`truncate`, a second mutate entry point) was silently permitted by
 * this test — the one property AC④ rests on would have gone on passing.
 */
const READ_METHODS = ['prepareTql', 'executePreparedTql', 'getPayload', 'getEdges', 'getIncomingEdges']

/** The vector every node carries; the recall path never reads it. */
const ZERO = [0, 0, 0, 0]

/** A clock pinned to one morning, so no assertion depends on the wall clock. */
const NOON = Date.UTC(2026, 10, 24, 4, 0, 0)

/**
 * A handle that records every method it was asked to run.
 *
 * The proxy forwards to the real handle with `apply(target, …)` rather than an
 * extracted function, because a bare method call on the engine loses its
 * receiver and throws `Illegal invocation`.
 * @param db - the real handle.
 * @param calls - the list to append method names to.
 * @returns a handle that behaves the same and reports what ran.
 */
function counting(db: Database, calls: string[]): Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown
      if (typeof value !== 'function' || typeof property !== 'string') return value
      return (...args: unknown[]): unknown => {
        calls.push(property)
        return (value as (...rest: unknown[]) => unknown).apply(target, args)
      }
    },
  }) as Database
}

/** A live assertion node whose `obj` contains `text`. */
function assertion(memKey: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const iso = new Date(NOON).toISOString()
  return {
    kind: 'assertion',
    mem_key: memKey,
    obj: text,
    active_slot: 1,
    valid_from: iso,
    recorded_at: iso,
    ...extra,
  }
}

/** A retired version of the same key: `superseded_at` present, so not live. */
function retiredVersion(memKey: string, text: string): Record<string, unknown> {
  const iso = new Date(NOON - 86_400_000).toISOString()
  return {
    kind: 'assertion',
    mem_key: memKey,
    obj: text,
    active_slot: NOON - 3_600_000,
    superseded_at: NOON - 3_600_000,
    valid_from: iso,
    recorded_at: iso,
  }
}

describe('recall: the result count', () => {
  it('defaults to the configured count and never exceeds it', () => {
    const store = openWriteStore('omw-recall-')
    for (let index = 0; index < 7; index += 1) {
      store.db.insert([...ZERO], assertion(`assertion:E:likes:whale${index}`, 'whale watching'))
    }
    const reader = createRecallReader({ db: store.db, topK: DEFAULT_TOP_K, candidatePool: DEFAULT_CANDIDATE_POOL })

    const answer = reader.recall('whale')

    expect(answer.ok).toBe(true)
    expect(answer.top_k).toBe(5)
    expect(answer.hits).toHaveLength(5)
    expect(answer.candidates).toBe(7)
    // Seven matched, five were kept: the sentence has to say so, or a caller
    // cannot tell "five is all there is" from "five is all you get".
    expect(answer.message).toBe('找到 7 条未失效记忆，返回前 5 条。')
  })

  it('takes the default from the configuration rather than a hard-coded 5', () => {
    const store = openWriteStore('omw-recall-')
    for (let index = 0; index < 4; index += 1) {
      store.db.insert([...ZERO], assertion(`assertion:E:likes:whale${index}`, 'whale watching'))
    }
    const reader = createRecallReader({ db: store.db, topK: 2, candidatePool: DEFAULT_CANDIDATE_POOL })

    expect(reader.recall('whale').hits).toHaveLength(2)
  })

  it('accepts both ends of the legal range', () => {
    const store = openWriteStore('omw-recall-')
    for (let index = 0; index < 9; index += 1) {
      store.db.insert([...ZERO], assertion(`assertion:E:likes:whale${index}`, 'whale watching'))
    }
    const reader = createRecallReader({ db: store.db, topK: DEFAULT_TOP_K, candidatePool: 20 })

    expect(reader.recall('whale', MAX_TOP_K).hits).toHaveLength(MAX_TOP_K)
    expect(reader.recall('whale', 1).hits).toHaveLength(1)
  })

  it('gives back fewer rather than padding the list', () => {
    const store = openWriteStore('omw-recall-')
    store.db.insert([...ZERO], assertion('assertion:E:likes:whale', 'whale watching'))
    store.db.insert([...ZERO], assertion('assertion:E:likes:whale2', 'whale song'))
    const reader = createRecallReader({ db: store.db, topK: DEFAULT_TOP_K, candidatePool: DEFAULT_CANDIDATE_POOL })

    const answer = reader.recall('whale')

    expect(answer.hits).toHaveLength(2)
    expect(answer.message).toBe('找到 2 条未失效记忆，全部返回。')
    expect(answer.degraded).toBe(false)
    expect(answer.degraded_reason).toEqual([])
  })
})

describe('recall: a refusal reads nothing', () => {
  /** The refusals that must happen before the store is touched. */
  const refusals: { readonly name: string; readonly topK?: unknown; readonly query?: unknown }[] = [
    { name: 'topK above the ceiling', topK: MAX_TOP_K + 1, query: 'whale' },
    { name: 'topK of zero', topK: 0, query: 'whale' },
    { name: 'a negative topK', topK: -1, query: 'whale' },
    { name: 'a fractional topK', topK: 5.5, query: 'whale' },
    { name: 'a string topK', topK: '5', query: 'whale' },
    { name: 'a null topK', topK: null, query: 'whale' },
    { name: 'a missing query' },
    { name: 'an empty query', query: '' },
    { name: 'a blank query', query: '   \t ' },
    { name: 'a non-string query', query: 42 },
  ]

  for (const refusal of refusals) {
    it(`refuses ${refusal.name} without reading the store`, () => {
      const store = openWriteStore('omw-recall-')
      store.db.insert([...ZERO], assertion('assertion:E:likes:whale', 'whale watching'))
      const calls: string[] = []
      const reader = createRecallReader({
        db: counting(store.db, calls),
        topK: DEFAULT_TOP_K,
        candidatePool: DEFAULT_CANDIDATE_POOL,
      })
      // Construction prepares the one statement it will use; from here on any
      // entry in `calls` was caused by the call under test.
      calls.length = 0

      const answer = reader.recall(refusal.query, refusal.topK)

      expect(answer.ok).toBe(false)
      expect(answer.code).toBe('E_BOUNDARY')
      expect(answer.hits).toEqual([])
      expect(answer.candidates).toBe(0)
      expect(calls).toEqual([])
      // The widths are still reported, so a caller can see what it asked for.
      expect(answer.top_k).toBe(DEFAULT_TOP_K)
      expect(answer.candidate_pool).toBe(DEFAULT_CANDIDATE_POOL)
    })
  }

  it('names the ceiling in the refusal instead of clamping to it', () => {
    const store = openWriteStore('omw-recall-')
    const reader = createRecallReader({ db: store.db, topK: DEFAULT_TOP_K, candidatePool: DEFAULT_CANDIDATE_POOL })

    const answer = reader.recall('whale', MAX_TOP_K + 1)

    expect(answer.message).toContain(String(MAX_TOP_K))
  })
})

describe('recall: what may be returned', () => {
  it('never returns a superseded version alongside its replacement', () => {
    const store = openWriteStore('omw-recall-')
    store.db.insert([...ZERO], assertion('assertion:E:lives_in', 'Shanghai harbour'))
    store.db.insert([...ZERO], retiredVersion('assertion:E:lives_in', 'Shanghai harbour'))
    // The unique index is what makes this state impossible in production; the
    // recall must not depend on that, because a template regression would not
    // trip any index.
    store.db.insert([...ZERO], assertion('assertion:E:lives_in:b', 'Shanghai harbour'))
    const reader = createRecallReader({ db: store.db, topK: DEFAULT_TOP_K, candidatePool: DEFAULT_CANDIDATE_POOL })

    const values = reader.recall('shanghai').hits.map(hit => hit.value)

    expect(values).toEqual(['Shanghai harbour', 'Shanghai harbour'])
    expect(reader.recall('shanghai').candidates).toBe(2)
  })

  it('keeps an evidence pointer out even when its quotation matches', () => {
    const store = openWriteStore('omw-recall-')
    store.db.insert([...ZERO], {
      kind: 'evidence',
      mem_key: 'evidence:session-a:10:12',
      quote: 'I watched a whale from the pier.',
      seq_from: 10,
      seq_to: 12,
      active_slot: 1,
    })
    const reader = createRecallReader({ db: store.db, topK: DEFAULT_TOP_K, candidatePool: DEFAULT_CANDIDATE_POOL })

    const answer = reader.recall('whale')

    expect(answer.hits).toEqual([])
    expect(answer.candidates).toBe(0)
    expect(answer.message).toBe('没有找到匹配的未失效记忆。')
  })

  it('drops a node without a business key, because the caller could not ask again', () => {
    const store = openWriteStore('omw-recall-')
    store.db.insert([...ZERO], { kind: 'scene', text: 'a whale surfaced near the ferry' })
    const reader = createRecallReader({ db: store.db, topK: DEFAULT_TOP_K, candidatePool: DEFAULT_CANDIDATE_POOL })

    expect(reader.recall('whale').hits).toEqual([])
  })

  it('reports the most specific field the payload carries', () => {
    const store = openWriteStore('omw-recall-')
    // No obj field at all: the engine rejects an explicit undefined, and the
    // omission is what makes the fallback to value the case under test.
    // Three memory kinds, each carrying a different display field: value, text,
    // summary. None of them is a ledger row, so each one is recallable.
    store.db.insert([...ZERO], { kind: 'pref', mem_key: 'pref:E:reply_style', value: 'concise whale notes', active_slot: 1 })
    store.db.insert([...ZERO], { kind: 'scene', mem_key: 'scene:whale', text: 'whale at dusk' })
    store.db.insert([...ZERO], { kind: 'episode', mem_key: 'episode:whale', summary: 'whale summary' })
    const reader = createRecallReader({ db: store.db, topK: DEFAULT_TOP_K, candidatePool: DEFAULT_CANDIDATE_POOL })

    const byKey = new Map(reader.recall('whale').hits.map(hit => [hit.mem_key, hit.value]))

    expect(byKey.get('pref:E:reply_style')).toBe('concise whale notes')
    expect(byKey.get('scene:whale')).toBe('whale at dusk')
    expect(byKey.get('episode:whale')).toBe('whale summary')
  })

  it('falls back to the key when the payload has no displayable field', () => {
    const store = openWriteStore('omw-recall-')
    // A field the reader does not know: the key itself has to answer.
    store.db.insert([...ZERO], { kind: 'pref', mem_key: 'pref:whale', note: 'whale' })
    const reader = createRecallReader({ db: store.db, topK: DEFAULT_TOP_K, candidatePool: DEFAULT_CANDIDATE_POOL })

    // `note` is not one of the display fields, so the last key segment answers.
    expect(reader.recall('whale').hits[0]?.value).toBe('whale')
  })

  it('recalls a memory whose kind is missing or is not a string, and names it unknown', () => {
    const store = openWriteStore('omw-recall-')
    // The exclusion list is a list of kinds, so a node without a readable kind
    // cannot be excluded. 2.5 chose to return it rather than go silently
    // unreachable: a memory the store cannot classify is still a memory the user
    // was told. The name it is reported under has to be a string all the same,
    // because `kind` is a tool-output field the model reads.
    store.db.insert([...ZERO], { mem_key: 'assertion:E:likes:whale', obj: 'whale watching', active_slot: 1 })
    store.db.insert([...ZERO], { kind: 42, mem_key: 'assertion:E:likes:orca', obj: 'orca watching', active_slot: 1 })
    const reader = createRecallReader({ db: store.db, topK: DEFAULT_TOP_K, candidatePool: DEFAULT_CANDIDATE_POOL })

    const hits = reader.recall('watching').hits

    expect(hits.map(hit => hit.mem_key).sort()).toEqual(['assertion:E:likes:orca', 'assertion:E:likes:whale'])
    expect(hits.map(hit => hit.kind)).toEqual(['unknown', 'unknown'])
  })
})

describe('recall: the two cuts are separate gates', () => {
  it('fills the pool first, then keeps only topK, and says both numbers', () => {
    const store = openWriteStore('omw-recall-')
    for (let index = 0; index < 30; index += 1) {
      store.db.insert([...ZERO], assertion(`assertion:E:likes:w${String(index).padStart(2, '0')}`, 'whale watching'))
    }
    const reader = createRecallReader({ db: store.db, topK: 5, candidatePool: 12 })

    const answer = reader.recall('whale')

    expect(answer.candidates).toBe(12)
    expect(answer.hits).toHaveLength(5)
    expect(answer.hits.map(hit => hit.mem_key)).toEqual([
      'assertion:E:likes:w00',
      'assertion:E:likes:w01',
      'assertion:E:likes:w02',
      'assertion:E:likes:w03',
      'assertion:E:likes:w04',
    ])
    expect(answer.message).toBe('找到 30 条未失效记忆，其中 12 条进入候选池，返回前 5 条。')
  })

  it('does not let one gate stand in for the other', () => {
    const store = openWriteStore('omw-recall-')
    for (let index = 0; index < 12; index += 1) {
      store.db.insert([...ZERO], assertion(`assertion:E:likes:w${String(index).padStart(2, '0')}`, 'whale watching'))
    }
    const reader = createRecallReader({ db: store.db, topK: 8, candidatePool: 12 })

    const answer = reader.recall('whale')

    // Pool 12 and count 8: if the two were one number, `candidates` would be 8.
    expect(answer.candidates).toBe(12)
    expect(answer.hits).toHaveLength(8)
  })
})

describe('recall: reads only, and only forwards', () => {
  it('runs no write method and no schema change during a successful recall', () => {
    const store = openWriteStore('omw-recall-')
    store.db.insert([...ZERO], assertion('assertion:E:likes:whale', 'whale watching'))
    const calls: string[] = []
    const reader = createRecallReader({
      db: counting(store.db, calls),
      topK: DEFAULT_TOP_K,
      candidatePool: DEFAULT_CANDIDATE_POOL,
    })
    calls.length = 0

    expect(reader.recall('whale').ok).toBe(true)

    const unexpected = calls.filter(name => !READ_METHODS.includes(name))
    expect(unexpected).toEqual([])
    // A write path would at least read through the prepared template; proving it
    // ran is what makes the assertion above mean 'read and did not write'.
    expect(calls).toContain('executePreparedTql')
  })

  it('answers the same question the same way twice', () => {
    const store = openWriteStore('omw-recall-')
    for (let index = 0; index < 6; index += 1) {
      store.db.insert([...ZERO], assertion(`assertion:E:likes:w${index}`, 'whale watching'))
    }
    const reader = createRecallReader({ db: store.db, topK: 4, candidatePool: DEFAULT_CANDIDATE_POOL })

    const first = reader.recall('whale')
    const second = reader.recall('whale')

    expect(first.hits.map(hit => hit.mem_key)).toEqual(second.hits.map(hit => hit.mem_key))
    expect(first.candidates).toBe(second.candidates)
  })

  it('refuses after the handle is released, and does not throw', () => {
    const store = openWriteStore('omw-recall-')
    const reader = createRecallReader({ db: store.db, topK: DEFAULT_TOP_K, candidatePool: DEFAULT_CANDIDATE_POOL })

    reader.dispose()
    const answer = reader.recall('whale')

    expect(answer.ok).toBe(false)
    expect(answer.code).toBe('E_GATE_DOWN')
    expect(answer.hits).toEqual([])
    // Disposing twice is allowed: the runtime's teardown must stay idempotent.
    expect(() => { reader.dispose() }).not.toThrow()
  })

  it('recalls from a store opened read-only, because the write face is not a dependency', () => {
    const home = tempHome('omw-recall-ro-')
    mkdirSync(home.path('oh-my-whale'), { recursive: true })
    const file = home.path('oh-my-whale', 'oh-my-whale.tdb')
    const writable = openDatabase({ file, dim: TEST_DIM, memoryLimitMb: 64 })
    if (!writable.ok) throw new Error(writable.reason)
    try {
      writable.db.insert([...ZERO], assertion('assertion:E:lives_in', 'Shanghai harbour whale'))
    } finally {
      closeDatabase(writable.db)
    }

    const readOnly = openDatabase({ file, dim: TEST_DIM, memoryLimitMb: 64, readOnly: true })
    if (!readOnly.ok) throw new Error(readOnly.reason)
    try {
      const reader = createRecallReader({ db: readOnly.db, topK: DEFAULT_TOP_K, candidatePool: DEFAULT_CANDIDATE_POOL })

      const answer = reader.recall('whale')

      expect(answer.ok).toBe(true)
      expect(answer.hits.map(hit => hit.mem_key)).toEqual(['assertion:E:lives_in'])
    } finally {
      closeDatabase(readOnly.db)
      home.remove()
    }
  })
})


describe('recall: the numbers the answer reports', () => {
  it('separates what matched from what entered the pool', () => {
    const store = openWriteStore('omw-recall-')
    for (let index = 0; index < 30; index += 1) {
      store.db.insert([...ZERO], assertion(`assertion:E:likes:w${String(index).padStart(2, '0')}`, 'whale watching'))
    }
    const reader = createRecallReader({ db: store.db, topK: 5, candidatePool: 12 })

    const answer = reader.recall('whale')

    // Three numbers, three questions: how many memories matched (30), how many
    // the pool admitted (12), how many came back (5). Reporting only the last
    // two would leave the model unable to tell a narrow store from a narrow cut.
    expect(answer.matched).toBe(30)
    expect(answer.candidates).toBe(12)
    expect(answer.hits).toHaveLength(5)
    expect(answer.message).toBe('找到 30 条未失效记忆，其中 12 条进入候选池，返回前 5 条。')
  })

  it('counts only memories it could name when deciding whether anything matched', () => {
    const store = openWriteStore('omw-recall-')
    // A live node with no business key: it matches the text, but there is no way
    // for a caller to ask about it again, so it is not an answer.
    store.db.insert([...ZERO], { kind: 'scene', text: 'a whale surfaced near the ferry' })
    const reader = createRecallReader({ db: store.db, topK: DEFAULT_TOP_K, candidatePool: DEFAULT_CANDIDATE_POOL })

    const answer = reader.recall('whale')

    expect(answer.matched).toBe(0)
    expect(answer.candidates).toBe(0)
    expect(answer.hits).toEqual([])
    // The sentence has to agree with the count; it used to report the pre-filter
    // number and say「找到 1 条…返回前 0 条」for a store with nothing recallable.
    expect(answer.message).toBe('没有找到匹配的未失效记忆。')
  })

  it('reports elapsed time from the injected clock, not the wall clock', () => {
    const store = openWriteStore('omw-recall-')
    store.db.insert([...ZERO], assertion('assertion:E:likes:whale', 'whale watching'))
    let now = 1_000
    const reader = createRecallReader({
      db: store.db,
      topK: DEFAULT_TOP_K,
      candidatePool: DEFAULT_CANDIDATE_POOL,
      now: () => {
        // Two readings per call: the start and the end. Advancing here is what
        // makes the duration a number the test can name instead of one it can
        // only check for being non-negative.
        const reading = now
        now += 7
        return reading
      },
    })

    expect(reader.recall('whale').elapsed_ms).toBe(7)
  })

  it('times a refusal with the same clock', () => {
    const store = openWriteStore('omw-recall-')
    let now = 0
    const reader = createRecallReader({
      db: store.db,
      topK: DEFAULT_TOP_K,
      candidatePool: DEFAULT_CANDIDATE_POOL,
      now: () => {
        const reading = now
        now += 3
        return reading
      },
    })

    const answer = reader.recall('whale', 99)

    expect(answer.ok).toBe(false)
    expect(answer.elapsed_ms).toBe(3)
  })
})

describe('recall: a handle that was closed underneath the reader', () => {
  it('refuses instead of throwing when the database is closed behind it', () => {
    const home = tempHome('omw-recall-closed-')
    mkdirSync(home.path('oh-my-whale'), { recursive: true })
    const file = home.path('oh-my-whale', 'oh-my-whale.tdb')
    const opened = openDatabase({ file, dim: TEST_DIM, memoryLimitMb: 64 })
    if (!opened.ok) throw new Error(opened.reason)
    try {
      opened.db.insert([...ZERO], assertion('assertion:E:likes:whale', 'whale watching'))
      const reader = createRecallReader({ db: opened.db, topK: DEFAULT_TOP_K, candidatePool: DEFAULT_CANDIDATE_POOL })
      expect(reader.recall('whale').ok).toBe(true)

      // The handle belongs to the runtime, and the runtime closes it on its own
      // schedule. The reader's own flag knows nothing about that, so the throw
      // from the engine is the only signal — and the I/O matrix promises a
      // refusal for a down store, not an exception in the host's tool result.
      closeDatabase(opened.db)
      const answer = reader.recall('whale')

      expect(answer.ok).toBe(false)
      expect(answer.code).toBe('E_GATE_DOWN')
      expect(answer.hits).toEqual([])
      expect(answer.message).toContain('记忆库不可读')
      expect(() => { reader.dispose() }).not.toThrow()
    } finally {
      home.remove()
    }
  })
})
describe('recall: the degradation vocabulary is closed', () => {
  it('re-exports the six values from one source instead of copying them', () => {
    expect(RECALL_DEGRADED_REASONS).toEqual(DEGRADED_REASONS)
  })

  it('rejects a reason that is not in the closed list', () => {
    expect(isDegradedReason('rerank_unavailable')).toBe(true)
    expect(isDegradedReason('rerank_fast')).toBe(false)
    expect(isDegradedReason('')).toBe(false)
    expect(isDegradedReason(undefined)).toBe(false)
  })

  it('reports nothing degraded on a plain success', () => {
    const store = openWriteStore('omw-recall-')
    store.db.insert([...ZERO], assertion('assertion:E:likes:whale', 'whale watching'))
    const reader = createRecallReader({ db: store.db, topK: DEFAULT_TOP_K, candidatePool: DEFAULT_CANDIDATE_POOL })

    const answer = reader.recall('whale')

    expect(answer.degraded).toBe(false)
    expect(answer.degraded_reason).toEqual([])
    expect(Number.isInteger(answer.elapsed_ms)).toBe(true)
    expect(answer.elapsed_ms).toBeGreaterThanOrEqual(0)
  })
})

describe('recall: the latency baseline AC⑦ asks for', () => {
  // A baseline, not a target: NFR-2's 900ms belongs to Epic 5, which adds rerank
  // and the 1024-dimension vectors. What 2.5 can promise is the text-only floor
  // the later work is measured against, so the number has to be printed rather
  // than only asserted — a budget nobody ever reads is how a regression hides.
  it('scans 200 live memories with a p95 well under a frame budget', () => {
    const store = openWriteStore('omw-recall-')
    for (let index = 0; index < 200; index += 1) {
      store.db.insert([...ZERO], assertion(`assertion:E:likes:w${String(index).padStart(3, '0')}`, `whale note ${index}`))
    }
    const reader = createRecallReader({ db: store.db, topK: DEFAULT_TOP_K, candidatePool: DEFAULT_CANDIDATE_POOL })

    for (let round = 0; round < 20; round += 1) reader.recall('whale')
    const samples: number[] = []
    for (let round = 0; round < 200; round += 1) {
      const started = performance.now()
      reader.recall('whale')
      samples.push(performance.now() - started)
    }
    samples.sort((left, right) => left - right)
    const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))] ?? 0
    const median = samples[Math.floor(samples.length / 2)] ?? 0
    process.stdout.write(`perf recall: median=${median.toFixed(3)}ms p95=${p95.toFixed(3)}ms n=${samples.length} live=200`)
    expect(p95).toBeLessThanOrEqual(50)
  })
})
