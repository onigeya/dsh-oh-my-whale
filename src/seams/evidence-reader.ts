/**
 * The read side of a memory: which pointers stand behind one business key (AD-6).
 *
 * Writing a pointer is only half of traceability; the other half is being able
 * to ask, later and outside the model, where a fact came from. That question is
 * answered here and nowhere else: the command surface renders this answer, and
 * the shape it returns is the six fields AD-6 allows plus the key that was asked
 * about.
 *
 * The reader never writes, never touches the write queue, and never enters
 * recall or injection. It also never invents text: the quote it reports is the
 * one stored with the pointer. The host read is used for exactly one purpose —
 * deciding whether the pointer is still resolvable — and a failed host read is
 * reported as `degraded: 'evidence-unresolvable'` rather than papered over.
 * @module
 */
import type { QuoteSource } from './evidence-source.ts'
import type { StoredEvidenceNode } from '../store/templates/evidence.ts'
import type { Database } from '../store/db.ts'
import { createReadGateway } from '../store/commits/reads.ts'
import { isUnreadableQuote } from '../core/evidence.ts'
import { E_OK } from '../core/tool-errors.ts'

/**
 * One pointer, as the reader reports it.
 *
 * Field names match the stored payload on purpose: a reader that renamed them
 * would make the audit log and the store disagree about what an evidence
 * pointer is.
 */
export interface EvidencePointerView {
  readonly session_id: string
  /** Absent when the stored payload does not hold a usable sequence number. */
  readonly seq_from?: number
  /** Absent when the stored payload does not hold a usable sequence number. */
  readonly seq_to?: number
  readonly quote: string
  readonly quote_truncated: boolean
  readonly deidentified: boolean
}

/** Why a pointer cannot be resolved right now. */
export type EvidenceDegradation = 'evidence-unresolvable'

/** The answer to one `/omw evidence <mem_key>` question. */
export interface EvidenceReadAnswer {
  /** `OK`, `E_BOUNDARY` for a key this store has never seen, `E_GATE_DOWN` for a closed handle. */
  readonly ok: boolean
  readonly code: string
  /** The key that was asked about, echoed so a log line needs no join. */
  readonly mem_key: string
  /** One line of our own words; never engine text, never a node id. */
  readonly message: string
  readonly pointers: readonly EvidencePointerView[]
  /** Present only when the host could not resolve at least one pointer. */
  readonly degraded?: EvidenceDegradation
}

/** What the reader needs from the store and the host. */
export interface EvidenceReaderDeps {
  readonly db: Database
  /** The host's read-only session log, absent when the host offers none. */
  readonly readQuote?: QuoteSource
}

/** The read port the command surface and later projections use. */
export interface EvidenceReader {
  /** Every pointer supporting one business key, live version only. */
  read(memKey: string): Promise<EvidenceReadAnswer>
  /**
   * Mark the reader closed; idempotent.
   *
   * It deliberately does not close the database: the handle belongs to the
   * runtime and is shared with the write side, so a reader that closed it
   * would take the writer down with it. After this call every read answers
   * `E_GATE_DOWN` instead of touching a handle it no longer owns.
   */
  dispose(): void
}

/**
 * Read one payload field without trusting its type.
 *
 * A stored pointer with a wrong-typed field is corrupt, but throwing here would
 * turn one bad row into an unusable audit command. The coercion keeps the row
 * visible with the values that are actually there, and the missing field shows
 * up as an empty string or a zero rather than as a fabricated fact.
 * @param payload - the stored payload.
 * @param key - the field to read.
 * @returns the string, or an empty string.
 */
function textField(payload: Readonly<Record<string, unknown>>, key: string): string {
  const value = payload[key]
  return typeof value === 'string' ? value : ''
}

/**
 * Read one payload field as an integer.
 *
 * A value that is not an integer comes back as `undefined` rather than `0`: a
 * rendered `#0-0` would look exactly like a real range that starts at zero,
 * and a broken payload should look broken.
 * @param payload - the stored payload.
 * @param key - the field to read.
 * @returns the integer, or `undefined` when the field is not a safe integer.
 */
function intField(payload: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = payload[key]
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

/**
 * Read one payload field as a boolean.
 * @param payload - the stored payload.
 * @param key - the field to read.
 * @returns the boolean, or `false` when the field is not one.
 */
function boolField(payload: Readonly<Record<string, unknown>>, key: string): boolean {
  return payload[key] === true
}

/**
 * Project one stored evidence node onto the six reported fields.
 * @param node - the stored node.
 * @returns the pointer as the reader reports it.
 */
function toPointerView(node: StoredEvidenceNode): EvidencePointerView {
  return {
    session_id: textField(node.payload, 'session_id'),
    seq_from: intField(node.payload, 'seq_from'),
    seq_to: intField(node.payload, 'seq_to'),
    quote: textField(node.payload, 'quote'),
    quote_truncated: boolField(node.payload, 'quote_truncated'),
    deidentified: boolField(node.payload, 'deidentified'),
  }
}

/**
 * Build the reader over one open handle.
 *
 * The read gateway is reused rather than a second set of templates: it already
 * owns the one live-version read and the one `supports`-incoming read, and a
 * second implementation would be a second place for the edge direction to be
 * wrong. It is the read gateway and not the write one on purpose: a write
 * gateway prepares a commit engine, an engine owns the handle it was built on,
 * and a reader that held one would either leak it or close a handle the writer
 * is still using.
 * @param deps - the handle and the host's session log.
 * @returns the reader.
 */
export function createEvidenceReader(deps: EvidenceReaderDeps): EvidenceReader {
  const gateway = createReadGateway(deps.db)
  let disposed = false
  return {
    async read(memKey: string): Promise<EvidenceReadAnswer> {
      const key = memKey.trim()
      if (key === '') {
        return {
          ok: false,
          code: 'E_BOUNDARY',
          mem_key: key,
          message: '需要给出一个业务键：/omw evidence <mem_key>',
          pointers: [],
        }
      }
      if (disposed) {
        return { ok: false, code: 'E_GATE_DOWN', mem_key: key, message: '记忆库已关闭，本次没有读到任何东西。', pointers: [] }
      }
      // The live version decides whether the key exists at all. Asking for
      // evidence on an unknown key and on a key with no evidence are different
      // answers, and a caller that conflated them would read silence as proof.
      const live = gateway.findLive(key)
      if (live === undefined) {
        return {
          ok: false,
          code: 'E_BOUNDARY',
          mem_key: key,
          message: `未找到该业务键：${key}`,
          pointers: [],
        }
      }
      // A pointer is asked about by the key of the fact it supports. Naming a
      // pointer's own key would find the pointer, then look for pointers on it
      // and answer "none" — a true sentence that reads like a fact with no
      // source. Refuse it instead of answering the wrong question.
      if (live.payload['kind'] === 'evidence') {
        return {
          ok: false,
          code: 'E_BOUNDARY',
          mem_key: key,
          message: `该键是一条证据节点本身，请用它所支持的记忆的业务键查询：${key}`,
          pointers: [],
        }
      }
      // The reader answers a user who asked about one key by name, so it shows
      // what is stored, redacted quotes included: withholding one here would
      // hide the very pointer the caller is asking to see (AD-6 puts the
      // exclusion on the export path, not on a direct question).
      const nodes = gateway.listEvidenceFor(key, { includeSensitive: true })
      const pointers = nodes.map(node => toPointerView(node))
      if (pointers.length === 0) {
        return { ok: true, code: E_OK, mem_key: key, message: `该业务键没有证据指针：${key}`, pointers: [] }
      }
      // Resolvability is asked per pointer, not once for the batch: pointers on
      // one fact may name different sessions, and a host may have dropped one
      // session while keeping another. A batch answer would call all of them
      // unreadable because one was.
      const resolvable = await Promise.all(pointers.map(async pointer => {
        // A pointer written without text is already known unresolved: it was
        // stored during a write that could not read its range, and the empty
        // quote is the record of that. Asking the host again would only repeat
        // what the payload already says.
        if (isUnreadableQuote(pointer.quote)) return false
        if (deps.readQuote === undefined) return false
        // A pointer whose range did not survive storage cannot be asked about;
        // report it unresolved instead of guessing a sequence number for it.
        if (pointer.seq_from === undefined || pointer.session_id === '') return false
        const event = await deps.readQuote.readQuote({ sessionId: pointer.session_id, seq: pointer.seq_from })
        return event !== undefined
      }))
      if (resolvable.every(Boolean)) {
        return {
          ok: true,
          code: E_OK,
          mem_key: key,
          message: `该业务键有 ${pointers.length} 条证据指针：${key}`,
          pointers,
        }
      }
      // Saying which failure this is matters, and there are three of them: a
      // pointer stored without text can never be resolved again, a session
      // service that was never wired up may come back on the next start, and a
      // host that cannot answer right now is expected to heal on its own.
      const unresolved = resolvable.filter(ok => !ok).length
      const neverCaptured = pointers.filter(pointer => isUnreadableQuote(pointer.quote)).length
      const message = neverCaptured === pointers.length
        ? `该业务键有 ${pointers.length} 条证据指针，写入时都没能读到原文，引文保持为空：${key}`
        : deps.readQuote === undefined
          ? `该业务键有 ${pointers.length} 条证据指针，但本次启动没有接入会话回读，引文无法现场核对：${key}`
          : `该业务键有 ${unresolved}/${pointers.length} 条证据指针此刻不可解引用：${key}`
      return { ok: true, code: E_OK, mem_key: key, message, pointers, degraded: 'evidence-unresolvable' }
    },
    dispose(): void {
      if (disposed) return
      disposed = true
    },
  }
}