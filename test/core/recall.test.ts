/**
 * Story 2.5 — the two bounds, decided before anything is read.
 *
 * These are pure functions, and that is the point: AC② says an out-of-range
 * `topK` returns `E_BOUNDARY` and runs no query. A bound that lives in `seams/`
 * cannot be tested without a store, so the case would be asserted against a
 * fake handle rather than against the code that actually decides.
 * @module
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CANDIDATE_POOL,
  DEFAULT_TOP_K,
  MAX_CANDIDATE_POOL,
  MAX_QUERY_CHARS,
  MAX_TOP_K,
  checkRecallBounds,
  checkRecallQuery,
} from '../../src/core/recall.ts'

describe('recall bounds: the result count', () => {
  it('defaults to five when the caller names none', () => {
    expect(checkRecallBounds(undefined)).toEqual({ ok: true, value: DEFAULT_TOP_K })
    expect(DEFAULT_TOP_K).toBe(5)
  })

  it('accepts both ends of the range', () => {
    expect(checkRecallBounds(1)).toEqual({ ok: true, value: 1 })
    expect(checkRecallBounds(MAX_TOP_K)).toEqual({ ok: true, value: MAX_TOP_K })
    expect(MAX_TOP_K).toBe(8)
  })

  it('refuses one past the ceiling instead of clamping it', () => {
    const answer = checkRecallBounds(MAX_TOP_K + 1)
    expect(answer.ok).toBe(false)
    expect(answer.ok === false && answer.reason).toContain('8')
  })

  it('refuses zero and negative counts', () => {
    for (const raw of [0, -1]) {
      const answer = checkRecallBounds(raw)
      expect(answer.ok, `topK=${raw}`).toBe(false)
      expect(answer.ok === false && answer.reason).toContain('至少为 1')
    }
  })

  it('refuses a fractional count rather than rounding it', () => {
    const answer = checkRecallBounds(2.5)
    expect(answer.ok).toBe(false)
    expect(answer.ok === false && answer.reason).toContain('整数')
  })

  it('refuses a numeric string: the host does not validate against the schema', () => {
    // `'5'` reaches the reader intact, and coercing it would invent a contract
    // the advertised schema never stated.
    const answer = checkRecallBounds('5')
    expect(answer.ok).toBe(false)
    expect(answer.ok === false && answer.reason).toContain('必须是整数')
  })

  it('refuses null, booleans and arrays, each named in the reason', () => {
    expect(checkRecallBounds(null).ok).toBe(false)
    const bool = checkRecallBounds(true)
    expect(bool.ok === false && bool.reason).toContain('boolean true')
    const array = checkRecallBounds([1])
    expect(array.ok === false && array.reason).toContain('array')
  })

  it('names an over-long string without dumping it', () => {
    const answer = checkRecallBounds('x'.repeat(40))
    expect(answer.ok).toBe(false)
    expect(answer.ok === false && answer.reason).toContain('…')
  })
})

describe('recall bounds: the query text', () => {
  it('trims the query it accepts', () => {
    expect(checkRecallQuery('  whale  ')).toEqual({ ok: true, value: 'whale' })
  })

  it('refuses a blank query instead of matching everything', () => {
    for (const raw of ['', '   ', '\t\n']) {
      const answer = checkRecallQuery(raw)
      expect(answer.ok, JSON.stringify(raw)).toBe(false)
      expect(answer.ok === false && answer.reason).toBe('query 不能为空')
    }
  })

  it('refuses a non-string query', () => {
    for (const raw of [undefined, null, 7, {}, ['whale']]) {
      expect(checkRecallQuery(raw).ok, String(raw)).toBe(false)
    }
  })

  it('accepts a query of exactly the character limit', () => {
    // The bound is on the text the search walks, so the endpoint belongs in the
    // test: a reader that trimmed one character early would still pass a test
    // that only checked 201.
    const answer = checkRecallQuery('鲸'.repeat(MAX_QUERY_CHARS))
    expect(answer).toEqual({ ok: true, value: '鲸'.repeat(MAX_QUERY_CHARS) })
  })

  it('refuses one character past the limit, counting code points not UTF-16 units', () => {
    const answer = checkRecallQuery('鲸'.repeat(MAX_QUERY_CHARS + 1))
    expect(answer.ok).toBe(false)
    expect(answer.ok === false && answer.reason).toContain(String(MAX_QUERY_CHARS))
    // Deseret script letters are a single character each but two UTF-16 units,
    // so a length check on `.length` would refuse this string at half the
    // promised limit. They are also letters, unlike an emoji, so they do not
    // trip the letter-or-digit rule that a punctuation-only query trips.
    const astral = String.fromCodePoint(0x10400).repeat(MAX_QUERY_CHARS)
    expect(astral.length).toBe(MAX_QUERY_CHARS * 2)
    expect(checkRecallQuery(astral).ok).toBe(true)
    expect(checkRecallQuery(astral + String.fromCodePoint(0x10400)).ok).toBe(false)
  })

  it('refuses a query with no letter or digit, which could only match everything', () => {
    // A punctuation-only query survives the trim and the length bound, then
    // tokenises to zero search terms: the scan would match nothing and answer
    // `ok: true` with an empty result, which reads as a real answer.
    for (const raw of ['!!!', '...', '—', '￥%&*']) {
      const answer = checkRecallQuery(raw)
      expect(answer.ok, raw).toBe(false)
      expect(answer.ok === false && answer.reason).toBe('query 至少要有一个字母或数字')
    }
    // The rule is about the whole string, not about starting with a letter.
    expect(checkRecallQuery('@whale!').ok).toBe(true)
    expect(checkRecallQuery('鲸').ok).toBe(true)
  })
})

describe('recall bounds: the candidate pool default', () => {
  it('is a separate number from the result count', () => {
    // Collapsing the two is what left this configuration key unread: the pool
    // bounds what a future reranker may see, the result count what the model does.
    expect(DEFAULT_CANDIDATE_POOL).toBe(12)
    expect(DEFAULT_CANDIDATE_POOL).not.toBe(DEFAULT_TOP_K)
  })

  it('has a ceiling of its own, since it bounds a cost and not an answer', () => {
    // The result count is refused above eight because a model cannot read more.
    // The pool is refused above fifty because it bounds how much work the store
    // may do per call: an operator who sets it to a million would be buying a
    // scan, not a broader answer.
    expect(MAX_CANDIDATE_POOL).toBeGreaterThan(MAX_TOP_K)
    expect(MAX_CANDIDATE_POOL).toBe(50)
  })
})
