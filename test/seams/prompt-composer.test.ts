/**
 * Story 2.4 — one injection exit, one budget, three tiers (AD-7, FR-6).
 *
 * Every row of the spec's I/O matrix has a case here, plus the two claims that
 * are only meaningful over many rounds: the 100-round byte-identity check and
 * the 1000-assembly latency test (NFR-1).
 * @module
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TOP_K, RECALL_ITEM_BUDGET_TOKENS } from '../../src/seams/config.ts'
import {
  PromptComposer,
  PERSONA_SECTION_NAME,
  PERSONA_STATE_CONTEXT_NAME,
  composeStateTail,
  estimateTokens,
  normalizePersona,
  planStateTail,
  type PersonaState,
  type PromptComposerOptions,
  type RecallItem,
  type SystemPromptLike,
} from '../../src/seams/prompt-composer.ts'

/** One call the host received, kept so a test can inspect what landed. */
interface HostCall {
  readonly kind: 'section' | 'context'
  readonly name: string
  readonly order: number
  readonly text: string
}

interface RecordingHost {
  readonly host: SystemPromptLike
  readonly calls: HostCall[]
  /** Text currently registered, by name: a disposed entry is gone, not stale. */
  readonly live: ReadonlyMap<string, string>
}

/**
 * A copy of the registry with one name set to `text`, or removed when `text` is
 * undefined. Rebuilt rather than mutated: the repository-wide deletion gate
 * forbids any `.delete(` call, including one on a Map (AD-5).
 */
function withName(
  source: ReadonlyMap<string, string>,
  name: string,
  text: string | undefined,
): ReadonlyMap<string, string> {
  const next = new Map<string, string>()
  for (const [key, value] of source) {
    if (key === name) continue
    next.set(key, value)
  }
  if (text !== undefined) next.set(name, text)
  return next
}

/** A host seam that records registrations and honours disposal. */
function recordingHost(): RecordingHost {
  const calls: HostCall[] = []
  let live: ReadonlyMap<string, string> = new Map<string, string>()
  const record = (kind: 'section' | 'context') =>
    (registration: { name: string; order: number; text: string | (() => string) }): (() => void) => {
      const text = typeof registration.text === 'function' ? registration.text() : registration.text
      calls.push({ kind, name: registration.name, order: registration.order, text })
      live = withName(live, registration.name, text)
      return () => {
        if (live.get(registration.name) === text) live = withName(live, registration.name, undefined)
      }
    }
  return {
    host: { section: record('section'), context: record('context') },
    calls,
    get live(): ReadonlyMap<string, string> {
      return live
    },
  }
}

/**
 * A host that keeps the provider a section was registered with, and renders it
 * on demand.
 *
 * `recordingHost` renders once at registration and stores the string, which
 * cannot express the thing this seam has to guarantee: the provider is called
 * again on every assembly, so whatever it reads at that moment is what the model
 * receives. A host that refuses a replacement therefore has to leave the older
 * provider returning the older text.
 */
interface ProviderHost {
  readonly host: SystemPromptLike
  /** When true, `section()` throws: the host refuses the replacement. */
  refuse: boolean
  /** Render a registered name the way an assembly would, or undefined. */
  render(name: string): string | undefined
}

function providerHost(): ProviderHost {
  const state = { refuse: false, live: new Map<string, string | (() => string)>() }
  const register = (registration: { name: string; text: string | (() => string) }): (() => void) => {
    state.live.set(registration.name, registration.text)
    return () => {
      // Rebuilt, not deleted: the deletion gate forbids `.delete(` on any object.
      const next = new Map<string, string | (() => string)>()
      for (const [key, value] of state.live) {
        if (key !== registration.name) next.set(key, value)
      }
      state.live = next
    }
  }
  return {
    host: {
      section(registration) {
        if (state.refuse) throw new Error('host refused the replacement')
        return register(registration)
      },
      context: register,
    },
    get refuse(): boolean {
      return state.refuse
    },
    set refuse(next: boolean) {
      state.refuse = next
    },
    render(name: string): string | undefined {
      const registered = state.live.get(name)
      return typeof registered === 'function' ? registered() : registered
    },
  }
}

/** Build a composer with the AD-7 defaults unless the case says otherwise. */
function composerOf(overrides: Partial<PromptComposerOptions> = {}): PromptComposer {
  return new PromptComposer({
    personaText: '我是鲸鲸。',
    personaMaxChars: 1200,
    tailMaxTokens: 30,
    ...overrides,
  })
}

/** A CJK string whose token count equals its character count. */
function cjk(chars: number): string {
  return '敏'.repeat(chars)
}

describe('injection: the identity section', () => {
  it('registers harness:identity at the host slot, ahead of every other section', () => {
    const recorder = recordingHost()
    const composer = composerOf()
    const outcome = composer.register(recorder.host)
    expect(outcome.personaRegistered).toBe(true)
    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0]?.kind).toBe('section')
    expect(recorder.calls[0]?.name).toBe(PERSONA_SECTION_NAME)
    expect(PERSONA_SECTION_NAME).toBe('harness:identity')
    expect(recorder.calls[0]?.order).toBe(-1000)
  })

  // INJ_TWO_ROUNDS
  it('re-registers nothing when two rounds compose the same bytes', () => {
    const recorder = recordingHost()
    const composer = composerOf()
    const first = composer.register(recorder.host)
    const second = composer.register(recorder.host)
    expect(first.personaRegistered).toBe(true)
    expect(second.personaRegistered).toBe(false)
    expect(second.plan.prefixUnchanged).toBe(true)
    expect(recorder.calls).toHaveLength(1)
    expect(first.plan.persona.hash).toBe(second.plan.persona.hash)
    expect(composer.compose().prefixUnchanged).toBe(true)
  })

  // INJ_100_ROUNDS
  it('composes one hash across 100 rounds, whatever the store is doing', () => {
    const recorder = recordingHost()
    // The store is not an input to the composer at all, so the round-dependent
    // part of a real mount — readState — is what this test varies. A round where
    // the database is unavailable composes the same identity bytes either way.
    const states: Array<PersonaState | undefined> = [undefined, { preference: '简洁' }, { flag: '待确认' }]
    let round = 0
    const composer = composerOf({ readState: () => states[round % states.length] })
    const hashes = new Set<string>()
    const texts = new Set<string>()
    for (round = 0; round < 100; round += 1) {
      const outcome = composer.register(recorder.host)
      hashes.add(outcome.plan.persona.hash)
      texts.add(recorder.live.get(PERSONA_SECTION_NAME) ?? '')
    }
    expect(hashes.size).toBe(1)
    expect(texts.size).toBe(1)
    const expected = createHash('sha256').update(composer.composePersona().text, 'utf8').digest('hex')
    expect([...hashes]).toEqual([expected])
    // One section registration for the whole run: the other 99 found the hash.
    expect(recorder.calls.filter(call => call.kind === 'section')).toHaveLength(1)
  })

  // INJ_IDENTITY_OVER
  it('cuts the identity text at 1200 characters and says so', () => {
    const composer = composerOf({ personaText: cjk(1201) })
    const plan = composer.compose()
    expect([...plan.persona.text]).toHaveLength(1200)
    expect(plan.persona.truncated).toBe(true)
    expect(plan.truncatedItems).toContain('identity')
    expect(plan.truncated).toBe(true)
  })

  // INJ_IDENTITY_EXACT
  it('keeps a text of exactly 1200 characters without calling it truncated', () => {
    const composer = composerOf({ personaText: cjk(1200) })
    const plan = composer.compose()
    expect([...plan.persona.text]).toHaveLength(1200)
    expect(plan.persona.truncated).toBe(false)
    expect(plan.truncatedItems).not.toContain('identity')
    expect(plan.truncated).toBe(false)
  })

  it('counts code points, so a cut never splits a surrogate pair', () => {
    const { text } = normalizePersona('🐋'.repeat(5), 3)
    expect(text).toBe('🐋🐋🐋')
  })

  it('replaces the registration when the identity text changes, and reports the change', () => {
    const recorder = recordingHost()
    let text = '我是鲸鲸。'
    const composer = composerOf({ personaText: () => text })
    expect(composer.register(recorder.host).plan.prefixUnchanged).toBe(false)
    text = '我是鲸鲸，也是你的同伴。'
    const second = composer.register(recorder.host)
    expect(second.personaRegistered).toBe(true)
    expect(second.plan.prefixUnchanged).toBe(false)
    // Two calls, and the older one is gone: the live section is the new text.
    expect(recorder.live.get(PERSONA_SECTION_NAME)).toBe(text)
    expect(recorder.calls.filter(call => call.kind === 'section')).toHaveLength(2)
    // Back to the first text is another change, not a cache hit on the first one.
    text = '我是鲸鲸。'
    expect(composer.register(recorder.host).personaRegistered).toBe(true)
    expect(recorder.live.get(PERSONA_SECTION_NAME)).toBe('我是鲸鲸。')
  })

  it('reports the identity tier characters the audit row needs', () => {
    const plan = composerOf({ personaText: cjk(1201) }).compose()
    // Truncated text and its character count describe the same bytes.
    expect(plan.persona.chars).toBe([...plan.persona.text].length)
    expect(plan.persona.chars).toBe(1200)
    expect(plan.tail.chars).toBe(0)
  })
})

describe('injection: the state tail', () => {
  it('registers the tail with the host context channel and its own name', () => {
    const recorder = recordingHost()
    const composer = composerOf({ readState: () => ({ preference: '简洁' }) })
    const outcome = composer.register(recorder.host)
    expect(outcome.tailRegistered).toBe(true)
    expect(PERSONA_STATE_CONTEXT_NAME).toBe('omw:persona-state')
    const registered = recorder.calls.find(call => call.kind === 'context')
    expect(registered?.name).toBe(PERSONA_STATE_CONTEXT_NAME)
    expect(registered?.text).toBe('简洁')
  })

  // INJ_TAIL_OVER
  it('drops whole segments from the least important end when the cap binds', () => {
    const state: PersonaState = { relationship: cjk(20), preference: cjk(10), flag: cjk(8) }
    const plan = planStateTail(state, 30)
    // relationship alone costs 20; adding preference reaches 31 and must not be
    // cut mid-sentence, so preference and everything after it lose outright.
    expect(plan.kept).toEqual(['relationship'])
    expect(plan.dropped).toEqual(['preference', 'flag'])
    expect(plan.text).toBe(cjk(20))
    expect(plan.tokens).toBe(20)
    const composed = composerOf({ readState: () => state }).compose()
    expect(composed.truncatedItems).toEqual(['state:preference', 'state:flag'])
    expect(composed.truncated).toBe(true)
  })

  it('keeps all three segments when they fit', () => {
    const state: PersonaState = { relationship: cjk(5), preference: cjk(5), flag: cjk(5) }
    // Each segment is 5 tokens; the two ' · ' separators add two more.
    expect(composeStateTail(state, 20)).toBe('敏敏敏敏敏 · 敏敏敏敏敏 · 敏敏敏敏敏')
    expect(planStateTail(state, 20).dropped).toEqual([])
  })

  // INJ_TAIL_EMPTY
  it('registers no tail at all when nothing is known, and reports zero tokens', () => {
    const recorder = recordingHost()
    const outcome = composerOf().register(recorder.host)
    expect(outcome.tailRegistered).toBe(false)
    expect(recorder.calls.filter(call => call.kind === 'context')).toHaveLength(0)
    expect(outcome.plan.tail).toEqual({
      text: undefined,
      kept: [],
      dropped: [],
      chars: 0,
      tokens: 0,
      truncated: false,
    })
  })

  it('treats an object of empty strings as nothing known', () => {
    const plan = planStateTail({ relationship: '', preference: '   ', flag: '' }, 30)
    expect(plan.text).toBeUndefined()
    expect(plan.tokens).toBe(0)
    expect(plan.dropped).toEqual([])
  })

  it('drops every segment when the first one alone exceeds the cap', () => {
    const plan = planStateTail({ relationship: cjk(31), preference: cjk(5), flag: cjk(5) }, 30)
    expect(plan.text).toBeUndefined()
    expect(plan.kept).toEqual([])
    expect(plan.dropped).toEqual(['relationship', 'preference', 'flag'])
    expect(plan.chars).toBe(0)
    expect(plan.tokens).toBe(0)
    expect(plan.truncated).toBe(true)
  })

  it('replaces the tail when a later round says something different', () => {
    const recorder = recordingHost()
    let state: PersonaState | undefined = { preference: '简洁' }
    const composer = composerOf({ readState: () => state })
    expect(composer.register(recorder.host).tailRegistered).toBe(true)
    state = { preference: '详细' }
    expect(composer.register(recorder.host).tailRegistered).toBe(true)
    // The second registration replaced the first; only 详细 is live.
    expect(recorder.live.get(PERSONA_STATE_CONTEXT_NAME)).toBe('详细')
    expect(recorder.calls.filter(call => call.kind === 'context')).toHaveLength(2)
  })

  // INJ_TAIL_CLEARED
  it('disposes the old tail when a later round has nothing to say', () => {
    const recorder = recordingHost()
    let state: PersonaState | undefined = { preference: '简洁' }
    const composer = composerOf({ readState: () => state })
    expect(composer.register(recorder.host).tailRegistered).toBe(true)
    expect(recorder.live.has(PERSONA_STATE_CONTEXT_NAME)).toBe(true)
    state = undefined
    expect(composer.register(recorder.host).tailRegistered).toBe(false)
    expect(recorder.live.has(PERSONA_STATE_CONTEXT_NAME)).toBe(false)
    // Both calls were recorded; the first one's registration is simply not live.
    expect(recorder.calls.filter(call => call.kind === 'context')).toHaveLength(1)
  })
})

describe('injection: the recall tier', () => {
  // INJ_RECALL_OVER
  it('cuts recall at its own pool, and keeps the items that fit as a prefix', () => {
    // topK 5 x 10 = a 50-token pool. The first 30-token item fits, the second
    // would reach 60 and stops the loop.
    const items: RecallItem[] = [
      { memKey: 'assertion:Elliott:likes:a', text: cjk(30) },
      { memKey: 'assertion:Elliott:likes:b', text: cjk(30) },
    ]
    const plan = composerOf({
      personaText: cjk(100),
      topK: 5,
      recallItemBudgetTokens: 10,
      readRecall: () => items,
    }).compose()
    expect(plan.recall.kept.map(item => item.memKey)).toEqual(['assertion:Elliott:likes:a'])
    expect(plan.recall.overBudget).toBe(1)
    expect(plan.recall.overCount).toBe(0)
    expect(plan.truncatedItems).toContain('recall')
    expect(plan.truncated).toBe(true)
    // The other two tiers are untouched: recall never takes from them.
    expect([...plan.persona.text]).toHaveLength(100)
    expect(plan.persona.truncated).toBe(false)
    expect(plan.tail.tokens).toBe(0)
  })

  it('does not hand an unused tail budget to recall', () => {
    // Two items of 10 tokens into a 30-token pool with no tail at all. If the
    // tail's unused 30 were pooled in, all three would fit.
    const items: RecallItem[] = Array.from({ length: 3 }, (_, index) => ({
      memKey: `assertion:Elliott:likes:${index}`,
      text: cjk(10),
    }))
    const emptiness = composerOf({ topK: 3, recallItemBudgetTokens: 10, readRecall: () => items }).compose()
    expect(emptiness.recall.kept).toHaveLength(3)
    const withTail = composerOf({
      topK: 3,
      recallItemBudgetTokens: 10,
      readState: () => ({ relationship: cjk(5) }),
      readRecall: () => items,
    }).compose()
    // Same recall decision whether or not the tail took anything.
    expect(withTail.recall.kept.map(item => item.memKey)).toEqual(emptiness.recall.kept.map(item => item.memKey))
    expect(withTail.recall.tokens).toBe(emptiness.recall.tokens)
    expect(withTail.tail.tokens).toBe(5)
  })

  it('drops the tail of the list rather than skipping ahead to a smaller item', () => {
    // The first item alone fills the 20-token pool; the 5-token item behind it
    // must not take the place of the 25-token one that could not fit.
    const items: RecallItem[] = [
      { memKey: 'assertion:Elliott:likes:big', text: cjk(25) },
      { memKey: 'assertion:Elliott:likes:small', text: cjk(5) },
    ]
    const plan = composerOf({ topK: 2, recallItemBudgetTokens: 10, readRecall: () => items }).compose()
    expect(plan.recall.kept).toEqual([])
    expect(plan.recall.overBudget).toBe(2)
  })

  it('stops at topK even when the budget would allow more, without calling it a cut', () => {
    const items: RecallItem[] = Array.from({ length: 7 }, (_, index) => ({
      memKey: `assertion:Elliott:likes:${index}`,
      text: cjk(4),
    }))
    const plan = composerOf({ topK: 5, readRecall: () => items }).compose()
    expect(plan.recall.kept).toHaveLength(5)
    expect(plan.recall.overCount).toBe(2)
    expect(plan.recall.overBudget).toBe(0)
    // A normal five-item recall is the contract working, not a truncation.
    expect(plan.recall.truncated).toBe(false)
    expect(plan.truncatedItems).not.toContain('recall')
    expect(plan.truncated).toBe(false)
  })

  // INJ_RECALL_ABSENT
  it('reports an empty recall tier and no truncation when nothing is recalled', () => {
    const plan = composerOf().compose()
    expect(plan.recall).toEqual({
      kept: [],
      chars: 0,
      overCount: 0,
      overBudget: 0,
      tokens: 0,
      truncated: false,
    })
    expect(plan.truncatedItems).not.toContain('recall')
    expect(plan.truncated).toBe(false)
  })

  // INJ_SCENE_PRESENT (the byte-identity half lives in test/load/inject.test.ts)
  it('composes the same plan whether recall is unwired or wired but empty', () => {
    const unwired = composerOf().compose()
    const wired = composerOf({ readRecall: () => [] }).compose()
    expect(wired.persona.text).toBe(unwired.persona.text)
    expect(wired.tail).toEqual(unwired.tail)
    expect(wired.recall).toEqual(unwired.recall)
    expect(wired.budget).toBe(unwired.budget)
  })
})

describe('injection: the shared budget', () => {
  it('derives the budget from the three caps instead of inventing a fourth', () => {
    const plan = composerOf({ topK: 3, recallItemBudgetTokens: 20 }).compose()
    expect(plan.identityTokens).toBe(estimateTokens(plan.persona.text))
    expect(plan.budget).toBe(plan.identityTokens + 30 + 3 * 20)
  })

  it('defaults the derivation to the configured constants, not to repeated numbers', () => {
    const plan = composerOf().compose()
    expect(plan.budget).toBe(plan.identityTokens + 30 + DEFAULT_TOP_K * RECALL_ITEM_BUDGET_TOKENS)
  })

  it('never reports more tokens than the budget allows', () => {
    const items: RecallItem[] = Array.from({ length: 40 }, (_, index) => ({
      memKey: `assertion:Elliott:likes:${index}`,
      text: cjk(80),
    }))
    const plan = composerOf({ personaText: cjk(900), readRecall: () => items }).compose()
    // Each tier stays inside its own cap, which is why the total can never exceed
    // the sum of the caps. Asserting the total alone would be an arithmetic
    // identity: it could not fail however the tiers were computed.
    expect(plan.recall.tokens).toBeLessThanOrEqual(DEFAULT_TOP_K * RECALL_ITEM_BUDGET_TOKENS)
    expect(plan.tail.tokens).toBeLessThanOrEqual(30)
    expect(plan.tokens).toBeLessThanOrEqual(plan.budget)
    expect(plan.tokens).toBe(plan.identityTokens + plan.tail.tokens + plan.recall.tokens)
  })

  it('measures a CJK character as one token and a Latin run as one', () => {
    expect(estimateTokens(cjk(10))).toBe(10)
    expect(estimateTokens('hello world')).toBe(2)
    expect(estimateTokens('')).toBe(0)
  })
})

describe('injection: a host that refuses', () => {
  // INJ_HOST_THROWS
  it('names the refused channel instead of throwing, and still lands the tail', () => {
    const { host, calls } = recordingHost()
    const refusing: SystemPromptLike = {
      section(): never {
        throw new Error('host refused the section')
      },
      context: host.context,
    }
    const outcome = composerOf({
      readState: () => ({ preference: '简短回答' }),
    }).register(refusing)
    expect(outcome.failed).toEqual(['section'])
    expect(outcome.personaRegistered).toBe(false)
    // The tail went on a different channel and was not refused with the section.
    expect(outcome.tailRegistered).toBe(true)
    expect(calls.filter(call => call.kind === 'context')).toHaveLength(1)
    // The plan still describes what was assembled: a refused mount is degraded,
    // not empty, and the audit row has to report real numbers.
    expect(outcome.plan.persona.text.length).toBeGreaterThan(0)
  })

  it('keeps the previous section when the host refuses the replacement', () => {
    let refuse = false
    const recorder = recordingHost()
    const flaky: SystemPromptLike = {
      section(registration) {
        if (refuse) throw new Error('host refused the replacement')
        return recorder.host.section(registration)
      },
      context: recorder.host.context,
    }
    let persona = '第一版'
    const composer = composerOf({ personaText: () => persona })
    expect(composer.register(flaky).personaRegistered).toBe(true)
    refuse = true
    persona = '第二版'
    const outcome = composer.register(flaky)
    expect(outcome.failed).toEqual(['section'])
    // Losing the section because a replacement was refused would be worse than
    // keeping the older text: the model still gets an identity.
    expect(recorder.live.get(PERSONA_SECTION_NAME)).toBe('第一版')
    expect(composer.hasSection).toBe(true)
  })

  // The section is a provider, so the host renders it again on every assembly.
  // A refusal has to survive that second render: the older registration must
  // keep answering with the older text, or the refused replacement silently
  // reaches the model anyway (AD-20: the row describes the prompt that was sent).
  it('keeps rendering the older text after the host refuses a replacement', () => {
    const host = providerHost()
    let persona = '第一版'
    const composer = composerOf({ personaText: () => persona })
    expect(composer.register(host.host).personaRegistered).toBe(true)
    expect(host.render(PERSONA_SECTION_NAME)).toBe('第一版')

    host.refuse = true
    persona = '第二版'
    expect(composer.register(host.host).failed).toEqual(['section'])

    expect(host.render(PERSONA_SECTION_NAME)).toBe('第一版')
  })
})

describe('injection: the synchronous path is fast enough', () => {
  it('assembles 1000 times with a p95 under 20ms', () => {
    const items: RecallItem[] = Array.from({ length: 5 }, (_, index) => ({
      memKey: `assertion:Elliott:likes:${index}`,
      text: `埃利奥特喜欢${cjk(20)}`,
    }))
    const composer = composerOf({
      personaText: cjk(1200),
      readState: () => ({ relationship: '认识了两个月', preference: '简洁', flag: '待确认' }),
      readRecall: () => items,
    })
    const samples: number[] = []
    for (let round = 0; round < 200; round += 1) composer.compose()
    for (let round = 0; round < 1000; round += 1) {
      const started = performance.now()
      composer.compose()
      samples.push(performance.now() - started)
    }
    samples.sort((left, right) => left - right)
    const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))] ?? 0
    const median = samples[Math.floor(samples.length / 2)] ?? 0
    process.stdout.write(`perf compose: median=${median.toFixed(3)}ms p95=${p95.toFixed(3)}ms n=${samples.length}`)
    expect(p95).toBeLessThanOrEqual(20)
  })
})

describe('injection: a reader that throws', () => {
  // FR-15: the identity section is injected even when the store cannot answer.
  // A throwing reader must not cost the round its identity section, and the
  // failure has to reach the caller under the tier that actually failed.
  it('keeps the identity section when the state reader throws', () => {
    const recorder = recordingHost()
    const failures: string[] = []
    const composer = composerOf({
      readState: () => {
        throw new Error('store unrunnable')
      },
      onReaderFailure: (tier, error) => failures.push(`${tier}:${String((error as Error).message)}`),
    })
    const outcome = composer.register(recorder.host)
    expect(outcome.personaRegistered).toBe(true)
    expect(composer.hasSection).toBe(true)
    expect(recorder.calls.some(call => call.kind === 'section')).toBe(true)
    // Once: `register()` composes one plan, and the provider replays that very
    // plan rather than composing again, so a broken reader is reported once per
    // registration. The failure still never escapes and the section survives it.
    expect(failures).toEqual(['state:store unrunnable'])
    // No state source answered this round, so the tail has no text at all.
    expect(outcome.plan.tail.text).toBeUndefined()
    expect(outcome.failed).toEqual([])
  })

  it('keeps the identity section and the tail when the recall reader throws', () => {
    const recorder = recordingHost()
    const failures: string[] = []
    const composer = composerOf({
      readState: () => ({ preference: '简洁' }),
      readRecall: () => {
        throw new Error('recall unavailable')
      },
      onReaderFailure: (tier, error) => failures.push(`${tier}:${String((error as Error).message)}`),
    })
    const outcome = composer.register(recorder.host)
    expect(outcome.personaRegistered).toBe(true)
    expect(outcome.tailRegistered).toBe(true)
    expect(failures).toEqual(['recall:recall unavailable'])
    expect(outcome.plan.recall).toEqual({
      kept: [],
      chars: 0,
      overCount: 0,
      overBudget: 0,
      tokens: 0,
      truncated: false,
    })
  })
})
