/**
 * Evidence pointers: the six fields AD-6 allows, and the masking that earns them.
 *
 * An assertion without a pointer cannot be traced back to the sentence it came
 * from, and a pointer that copies the sentence is a privacy leak. Everything in
 * this module therefore exists to answer two questions at write time and one at
 * read time:
 *
 * - *What may be stored?* Exactly eight keys — the six AD-6 content fields plus
 *   the `kind` and `mem_key` every node in this store carries.
 * - *How much of the sentence?* At most 200 code points, masked before it is cut,
 *   so the mask never pushes the quote back over the budget.
 * - *May it be exported?* Not by default, once `deidentified` is set.
 *
 * Masking happens before truncation on purpose. A quote cut at 200 characters
 * and *then* masked could lose a digit of the phone number it was cutting
 * through and keep the other ten; masking first means a partial pattern is no
 * longer a pattern, and the mask itself only ever shortens the text.
 * @module
 */

/** Longest quote this store keeps, in code points. */
export const QUOTE_MAX_CODE_POINTS = 200

/**
 * Most events one declared range may cover.
 *
 * A range is read back event by event, so its width is a cost the caller
 * chooses. Twenty is wide enough for a paragraph a model quotes as a whole and
 * narrow enough that one declaration cannot turn into a thousand host reads.
 */
export const MAX_RANGE_EVENTS = 20

/** Operators' log codes this module names. */
export const EVIDENCE_LOG_CODES = {
  /** The host could not hand back the sentence a pointer names. */
  unreadable: 'OMW_EVIDENCE_UNREADABLE',
  /** A pointer was stored but its `supports` edge could not be resolved. */
  linkSkipped: 'OMW_EVIDENCE_LINK_SKIPPED',
  /** A table declared a source range but the write had no session to read it in. */
  noSession: 'OMW_EVIDENCE_NO_SESSION',
  /** The reserved-id guard fired: a bug, not a caller mistake. */
  idReservation: 'OMW_EVIDENCE_ID_RESERVATION',
} as const

/** The replacement text for one masked pattern. */
const MASKS = {
  phone: '[手机号]',
  idCard: '[身份证]',
  email: '[邮箱]',
  bankCard: '[银行卡]',
} as const

/**
 * Whitespace and hyphen separators people type inside a number.
 *
 * A phone number written `138 1234 5678` or `138-1234-5678` is the same number
 * as `13812345678`, and a card number grouped in fours is still a card number.
 * A rule that only matched contiguous digits therefore hid the number only when
 * the writer happened not to group it, which is not a privacy property. Only
 * space and hyphen are tolerated: a newline would let a rule span two unrelated
 * lines and hide text that is not a number at all.
 */
const NUMERIC_GAP = '[- \u00A0]?'

/**
 * The four patterns NFR-5 names, in the order they are applied.
 *
 * Order matters three times. An email is masked first so its local part cannot
 * be half-eaten by the phone rule; a phone is masked before a card because a
 * grouped phone is long enough to satisfy a loose card rule; an identity card
 * is masked before a card so the applicant's birthday is recognised as a date
 * rather than left to the 16-to-19-digit rule, which would hide the digits
 * correctly but label them `[银行卡]`.
 *
 * The identity card rule wants a plausible `YYYYMMDD` in the middle. That is not
 * a validity check — a card with an impossible date is still masked, just as a
 * card number — but it is what makes the mask name the right document. A run of
 * 18 digits whose middle is not a date is masked as a card number: the mask
 * exists to hide the number, and hiding it is the part that must never fail.
 */
const MASK_RULES: readonly { readonly pattern: RegExp; readonly mask: string }[] = [
  { pattern: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu, mask: MASKS.email },
  /**
   * A mainland mobile number, with or without the `+86` country code and with
   * optional grouping: `13812345678`, `+86 138 1234 5678`, `138-1234-5678`.
   */
  { pattern: new RegExp(`(?<!\\d)(?:\\+?86${NUMERIC_GAP})?1[3-9]\\d(?:${NUMERIC_GAP}\\d){8}(?!\\d)`, 'gu'), mask: MASKS.phone },
  /**
   * An 18-character identity card: six digits of region, an eight-digit
   * birthday, three digits, then a digit or `X`.
   */
  { pattern: /(?<!\d)\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\dXx])/gu, mask: MASKS.idCard },
  /** A card number: 16 to 19 digits, optionally grouped in fours. */
  { pattern: new RegExp(`(?<!\\d)\\d{4}(?:${NUMERIC_GAP}\\d){12,15}(?!\\d)`, 'gu'), mask: MASKS.bankCard },
]

/** A masked text and whether anything was masked. */
export interface MaskResult {
  /** The text with every match replaced by its mask. */
  readonly text: string
  /** Whether at least one pattern matched. */
  readonly deidentified: boolean
}

/**
 * Mask every phone number, identity card, email and card number in one text.
 *
 * The result is a *new* string: the caller keeps the original only long enough
 * to decide `quote_truncated`, and never writes it anywhere.
 * @param raw - the text a host event carried.
 * @returns the masked text and whether masking happened.
 */
export function maskSensitiveText(raw: string): MaskResult {
  let text = raw
  let deidentified = false
  for (const rule of MASK_RULES) {
    // A fresh regex per pass: a `g` pattern carries `lastIndex` between calls.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags)
    const replaced = text.replace(pattern, rule.mask)
    if (replaced !== text) deidentified = true
    text = replaced
  }
  return { text, deidentified }
}

/** A stored quote and whether it was cut. */
export interface QuoteResult {
  /** At most {@link QUOTE_MAX_CODE_POINTS} code points of already-masked text. */
  readonly quote: string
  /** Whether the masked text was longer than the budget. */
  readonly truncated: boolean
}

/**
 * Cut one already-masked text down to the quote budget.
 *
 * Code points, not UTF-16 units: `'👍'.length` is 2, and a budget that counted
 * units would cut an emoji in half and store a lone surrogate. The budget counts
 * what a reader sees, so it is applied to what a reader sees.
 * @param masked - text that has already been through {@link maskSensitiveText}.
 * @returns the quote and whether anything was dropped.
 */
export function quoteFromText(masked: string): QuoteResult {
  const characters = [...masked]
  if (characters.length <= QUOTE_MAX_CODE_POINTS) return { quote: masked, truncated: false }
  return { quote: characters.slice(0, QUOTE_MAX_CODE_POINTS).join(''), truncated: true }
}

/** One quote, ready to store, plus what had to happen to it. */
export interface PreparedQuote {
  /** At most {@link QUOTE_MAX_CODE_POINTS} code points, already masked. */
  readonly quote: string
  /** Whether the *masked* text was longer than the budget. */
  readonly truncated: boolean
  /** Whether masking replaced anything. */
  readonly deidentified: boolean
}

/**
 * What a pointer stores when the host hands back nothing.
 *
 * An empty quote is a fact — "this pointer names a sentence this host no longer
 * serves" — and it is written as such. Substituting any text would be the one
 * thing AD-6 forbids outright.
 */
export const UNREADABLE_QUOTE: PreparedQuote = { quote: '', truncated: false, deidentified: false }

/**
 * Whether a stored quote was never captured.
 *
 * A pointer that read back at least one text block always stores a non-empty
 * quote -- {@link prepareQuote} is only reached with joined text -- and every
 * other case stores {@link UNREADABLE_QUOTE}. The empty string is therefore a
 * complete marker, and it is named here so that a reader, an export or a dream
 * check cannot each invent a slightly different test for it.
 * @param quote - a stored payload's quote field, untyped on purpose.
 * @returns whether the pointer's text was never captured.
 */
export function isUnreadableQuote(quote: unknown): boolean {
  return quote === ''
}

/**
 * Turn one raw sentence into the three fields a pointer keeps.
 *
 * Masking runs first, then the cut. Doing it the other way round would let a
 * truncation slice a phone number in half and store the surviving digits as
 * clean text, and a half pattern is no longer a pattern to the next masker.
 * @param raw - the sentence as the host served it.
 * @returns the quote and what happened to it.
 */
export function prepareQuote(raw: string): PreparedQuote {
  const masked = maskSensitiveText(raw)
  const cut = quoteFromText(masked.text)
  return { quote: cut.quote, truncated: cut.truncated, deidentified: masked.deidentified }
}

/**
 * The business key of one evidence pointer.
 *
 * `#` separates the session from the range because a session id may itself
 * contain colons, and a key that cannot be read back is not an identity. The
 * key is a function of the pointer alone, which is what makes a second reference
 * to the same range resolve to the same node.
 * @param sessionId - the host session the range lives in.
 * @param seqFrom - first event the pointer covers.
 * @param seqTo - last event the pointer covers.
 * @returns the key.
 */
export function evidenceMemKey(sessionId: string, seqFrom: number, seqTo: number): string {
  return `evidence:${sessionId}#${seqFrom}-${seqTo}`
}

/** Everything one evidence payload is built from. */
export interface EvidenceInput {
  readonly memKey: string
  readonly sessionId: string
  readonly seqFrom: number
  readonly seqTo: number
  /** Already masked and already cut. */
  readonly quote: string
  readonly quoteTruncated: boolean
  readonly deidentified: boolean
}

/**
 * Build the payload of one evidence node.
 *
 * Eight keys, every one of them written explicitly. Optional fields are not a
 * thing here: the engine refuses `undefined` as a value, and a reader that has to
 * guess whether a missing `deidentified` means `false` or `unknown` cannot decide
 * whether the pointer is exportable.
 * @param input - the pointer, already masked and cut.
 * @returns the payload.
 */
export function buildEvidencePayload(input: EvidenceInput): Record<string, unknown> {
  return {
    kind: 'evidence',
    mem_key: input.memKey,
    session_id: input.sessionId,
    seq_from: input.seqFrom,
    seq_to: input.seqTo,
    quote: input.quote,
    quote_truncated: input.quoteTruncated,
    deidentified: input.deidentified,
  }
}

/** Whether a pointer's range can be read at all. */
export type RangeCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/**
 * Check that one declared range is a range.
 *
 * Both ends are event sequence numbers, so both are positive integers, and the
 * end cannot precede the start. Nothing else about the range is knowable here:
 * whether those events exist is the host's question, and a missing event is a
 * degraded pointer rather than a refused write (AD-18).
 * @param seqFrom - declared start.
 * @param seqTo - declared end.
 * @returns whether the range is usable, or why it is not.
 */
export function checkEvidenceRange(seqFrom: number, seqTo: number): RangeCheck {
  if (!Number.isSafeInteger(seqFrom) || seqFrom < 1) return { ok: false, reason: 'seq_from 必须是 ≥1 的整数' }
  if (!Number.isSafeInteger(seqTo) || seqTo < 1) return { ok: false, reason: 'seq_to 必须是 ≥1 的整数' }
  if (seqTo < seqFrom) return { ok: false, reason: 'seq_to 不能小于 seq_from' }
  if (seqTo - seqFrom + 1 > MAX_RANGE_EVENTS) {
    return { ok: false, reason: `一个来源区间最多覆盖 ${MAX_RANGE_EVENTS} 条事件` }
  }
  return { ok: true }
}

/**
 * Read the text blocks of one host event, structurally.
 *
 * The plugin declares the shape it needs instead of importing the host's event
 * types (AD-15): an event whose `data.content` is an array of blocks is a message
 * this build understands, and anything else contributes nothing. Only `text`
 * blocks count — `reasoning`, `tool-call` and `file` blocks are either hidden
 * thinking or payloads that were never prose, and neither belongs in a quote.
 * @param event - one `readEvent().target` value, or anything else.
 * @returns the joined text, or `''` when the event carries none.
 */
export function extractQuoteSource(event: unknown): string {
  const texts: string[] = []
  for (const block of contentBlocksOf(event)) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as { readonly type?: unknown; readonly text?: unknown }
    if (record.type !== 'text') continue
    if (typeof record.text !== 'string') continue
    const text = record.text.trim()
    if (text !== '') texts.push(text)
  }
  return texts.join('\n')
}

/**
 * The content blocks of one event, wherever this host puts them.
 * @param event - the value under inspection.
 * @returns the blocks, or an empty list.
 */
function contentBlocksOf(event: unknown): readonly unknown[] {
  if (typeof event !== 'object' || event === null) return []
  const data = (event as { readonly data?: unknown }).data
  if (typeof data !== 'object' || data === null) return []
  const direct = (data as { readonly content?: unknown }).content
  if (Array.isArray(direct)) return direct
  // A wrapped message (`data.message.content`) is accepted too: the host has
  // both shapes across its event types, and refusing one would make a pointer
  // unreadable for a reason the reader cannot see.
  const message = (data as { readonly message?: unknown }).message
  if (typeof message !== 'object' || message === null) return []
  const nested = (message as { readonly content?: unknown }).content
  return Array.isArray(nested) ? nested : []
}

// The export rule (FR-24, AD-6) is *not* here. It lives in
// `src/store/commits/reads.ts`, on the one query that can return a redacted
// quote, because the store layer may not import this module: a second copy
// here would be a second chance to disagree about which rows are safe.
