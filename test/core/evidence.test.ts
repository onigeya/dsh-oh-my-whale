/**
 * Evidence pointers at the unit level: masking, cutting, keys and payloads.
 *
 * Everything here is a pure function, which is the point: the privacy rules of
 * NFR-5 and the budget of AD-6 are decided in one place, without a store, a host
 * or a clock. The order of the two text transforms is the sharpest of them —
 * mask first, cut second — and several cases below exist only to keep that order
 * from being quietly reversed by a later refactor.
 * @module
 */
import { describe, expect, it } from 'vitest'
import {
  buildEvidencePayload,
  checkEvidenceRange,
  EVIDENCE_LOG_CODES,
  evidenceMemKey,
  extractQuoteSource,
  maskSensitiveText,
  prepareQuote,
  QUOTE_MAX_CODE_POINTS,
  quoteFromText,
  UNREADABLE_QUOTE,
} from '../../src/core/evidence.ts'

const PHONE = '13812345678'
const ID_CARD = '11010119900307123X'
const EMAIL = 'ellio.tester@example.com'
const BANK_CARD = '6222020200112233445'

describe('masking the four patterns NFR-5 names', () => {
  it('masks a phone number and reports it did', () => {
    const result = maskSensitiveText(`我的手机是 ${PHONE}，随时联系。`)
    expect(result.text).toBe('我的手机是 [手机号]，随时联系。')
    expect(result.deidentified).toBe(true)
    expect(result.text).not.toContain(PHONE)
  })

  it('masks an identity card, including the trailing X', () => {
    const result = maskSensitiveText(`身份证号 ${ID_CARD} 已核对。`)
    expect(result.text).toBe('身份证号 [身份证] 已核对。')
    expect(result.deidentified).toBe(true)
  })

  it('masks an email address without letting the phone rule eat it first', () => {
    const result = maskSensitiveText(`发到 ${EMAIL} 即可。`)
    expect(result.text).toBe('发到 [邮箱] 即可。')
    expect(result.deidentified).toBe(true)
    expect(result.text).not.toContain('example.com')
  })

  it('masks a sixteen to nineteen digit card number', () => {
    const result = maskSensitiveText(`尾号账户 ${BANK_CARD} 已入账。`)
    expect(result.text).toBe('尾号账户 [银行卡] 已入账。')
    expect(result.deidentified).toBe(true)
  })

  it('leaves clean prose exactly as it was', () => {
    const clean = 'Elliott 喜欢 concise 的语气，周末常去杭州。'
    expect(maskSensitiveText(clean)).toEqual({ text: clean, deidentified: false })
  })

  it('does not mask a short digit run that merely looks numeric', () => {
    const result = maskSensitiveText('版本号 20261123，第 7 步。')
    expect(result.deidentified).toBe(false)
  })

  it('masks every occurrence in one pass, not just the first', () => {
    const result = maskSensitiveText(`${PHONE} 和 ${EMAIL} 都在这一句里。`)
    expect(result.text).toBe('[手机号] 和 [邮箱] 都在这一句里。')
    expect(result.deidentified).toBe(true)
  })
})

describe('cutting a quote to the budget', () => {
  it('keeps a quote of exactly the budget untouched', () => {
    const text = 'a'.repeat(QUOTE_MAX_CODE_POINTS)
    expect(quoteFromText(text)).toEqual({ quote: text, truncated: false })
  })

  it('cuts one code point past the budget and says so', () => {
    const text = 'b'.repeat(QUOTE_MAX_CODE_POINTS + 1)
    const result = quoteFromText(text)
    expect([...result.quote]).toHaveLength(QUOTE_MAX_CODE_POINTS)
    expect(result.truncated).toBe(true)
    expect(result.quote).toBe('b'.repeat(QUOTE_MAX_CODE_POINTS))
  })

  it('counts code points, so an emoji at the boundary is never split', () => {
    const text = `${'c'.repeat(QUOTE_MAX_CODE_POINTS - 1)}👍尾`
    const result = quoteFromText(text)
    expect([...result.quote]).toHaveLength(QUOTE_MAX_CODE_POINTS)
    expect(result.quote.endsWith('👍')).toBe(true)
    expect(result.truncated).toBe(true)
    // A lone surrogate would survive a UTF-16 cut and break the stored string.
    expect(result.quote).not.toMatch(/[\uD800-\uDBFF]$/u)
  })
})

describe('preparing one quote: mask, then cut', () => {
  it('masks before cutting, so the stored quote never carries the number', () => {
    const head = 'd'.repeat(QUOTE_MAX_CODE_POINTS - 20)
    const result = prepareQuote(`${head} 电话 ${PHONE} 结尾还有更多文字以超过预算上限。`)
    expect([...result.quote].length).toBeLessThanOrEqual(QUOTE_MAX_CODE_POINTS)
    expect(result.quote).not.toContain(PHONE)
    expect(result.deidentified).toBe(true)
    expect(result.truncated).toBe(true)
  })

  it('reports no truncation when masking shrank the text under the budget', () => {
    // 210 code points out, 198 in: the cut never happens, so the flag is false.
    const head = 'e'.repeat(180)
    const raw = `${head} 手机 ${PHONE} 与邮箱 ${EMAIL}`
    expect([...raw].length).toBeGreaterThan(QUOTE_MAX_CODE_POINTS)
    const result = prepareQuote(raw)
    expect([...result.quote].length).toBeLessThanOrEqual(QUOTE_MAX_CODE_POINTS)
    expect(result.truncated).toBe(false)
    expect(result.deidentified).toBe(true)
  })

  it('states an unreadable pointer as an empty quote rather than inventing one', () => {
    expect(UNREADABLE_QUOTE).toEqual({ quote: '', truncated: false, deidentified: false })
  })
})

describe('the evidence business key', () => {
  it('separates the session from the range with a hash', () => {
    expect(evidenceMemKey('sess-1', 5, 3)).toBe('evidence:sess-1#5-3')
  })

  it('survives a session id that itself contains colons', () => {
    const key = evidenceMemKey('sess:with:colons', 5, 9)
    expect(key).toBe('evidence:sess:with:colons#5-9')
    expect(key.split('#')).toHaveLength(2)
  })
})

describe('the evidence payload', () => {
  it('carries exactly the six AD-6 fields plus kind and mem_key', () => {
    const payload = buildEvidencePayload({
      memKey: 'evidence:s1#1-2',
      sessionId: 's1',
      seqFrom: 1,
      seqTo: 2,
      quote: '一句话',
      quoteTruncated: false,
      deidentified: false,
    })
    expect(Object.keys(payload).sort()).toEqual([
      'deidentified', 'kind', 'mem_key', 'quote', 'quote_truncated', 'seq_from', 'seq_to', 'session_id',
    ])
    expect(payload['kind']).toBe('evidence')
  })

  it('never writes an undefined value, which the engine refuses outright', () => {
    const payload = buildEvidencePayload({
      memKey: 'evidence:s1#1-1',
      sessionId: 's1',
      seqFrom: 1,
      seqTo: 1,
      quote: '',
      quoteTruncated: false,
      deidentified: true,
    })
    for (const value of Object.values(payload)) expect(value).not.toBeUndefined()
  })
})

describe('checking a declared range', () => {
  it('accepts a one-event range', () => {
    expect(checkEvidenceRange(7, 7)).toEqual({ ok: true })
  })

  it('refuses an end before the start', () => {
    const check = checkEvidenceRange(5, 3)
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toContain('seq_to 不能小于 seq_from')
  })

  it('refuses a zero or negative start', () => {
    expect(checkEvidenceRange(0, 1).ok).toBe(false)
    expect(checkEvidenceRange(-1, 1).ok).toBe(false)
  })

  it('refuses a fractional or unsafe sequence number', () => {
    expect(checkEvidenceRange(1.5, 2).ok).toBe(false)
    expect(checkEvidenceRange(1, Number.MAX_SAFE_INTEGER + 2).ok).toBe(false)
  })
})

describe('reading the text a host event carries', () => {
  it('joins the text blocks of one message', () => {
    const event = { data: { content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] } }
    expect(extractQuoteSource(event)).toBe('第一段\n第二段')
  })

  it('ignores reasoning and tool-call blocks', () => {
    const event = {
      data: {
        content: [
          { type: 'reasoning', text: '内心独白不应入库' },
          { type: 'tool-call', text: 'tool payload' },
          { type: 'text', text: '只保留这句' },
        ],
      },
    }
    expect(extractQuoteSource(event)).toBe('只保留这句')
  })

  it('returns nothing for an event with no text block at all', () => {
    expect(extractQuoteSource({ data: { content: [{ type: 'tool-call', text: 'x' }] } })).toBe('')
  })

  it('accepts a nested message payload', () => {
    const event = { data: { message: { content: [{ type: 'text', text: '嵌套形状' }] } } }
    expect(extractQuoteSource(event)).toBe('嵌套形状')
  })

  it('returns nothing for a value that is not an event', () => {
    expect(extractQuoteSource(undefined)).toBe('')
    expect(extractQuoteSource('plain string')).toBe('')
    expect(extractQuoteSource({ data: {} })).toBe('')
  })

  it('drops a text block that is only whitespace', () => {
    expect(extractQuoteSource({ data: { content: [{ type: 'text', text: '   ' }] } })).toBe('')
  })
})


describe('the operator log codes', () => {
  it('are the two closed codes the write path reports', () => {
    expect(EVIDENCE_LOG_CODES.unreadable).toBe('OMW_EVIDENCE_UNREADABLE')
    expect(EVIDENCE_LOG_CODES.linkSkipped).toBe('OMW_EVIDENCE_LINK_SKIPPED')
  })
})
