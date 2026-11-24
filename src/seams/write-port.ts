/**
 * The one write service the tool and command surfaces talk to (AD-4, AD-21).
 *
 * Everything a write needs is assembled here and nowhere else: the queue, the
 * gateway, the planner, the ledger and the audit row. The surfaces above pass a
 * raw patch table in and get one structured answer out; they never see a store
 * handle, a node id or a transaction.
 *
 * Two rules shape the code below.
 *
 * - *Planning and committing are one queue task.* A table is parsed, planned and
 *   committed without yielding to another writer, so the predicate cap, the
 *   registry snapshot and the unique index all describe the same instant. A
 *   refusal is recorded inside that same task, which is why a rejected table and
 *   a committed table never interleave.
 * - *A refusal still answers the caller.* Nothing here throws for a bad table:
 *   the answer carries the closed code, an empty `items` list and a message
 *   built from our own words, never from engine text that might name a node.
 * @module
 */
import type { JsonSchemaNode } from './json-schema.ts'
import {
  buildDecisionPayload,
  operationId,
  patchDigest,
  rejectedMemKey,
} from '../core/decisions.ts'
import {
  planPatchTable,
  parsePatchTable,
  type DecisionDraft,
  type EvidenceDraft,
  type PatchContext,
  type PlanItemResult,
} from '../core/patch.ts'
import {
  buildEvidencePayload,
  checkEvidenceRange,
  EVIDENCE_LOG_CODES,
  evidenceMemKey,
  extractQuoteSource,
  prepareQuote,
  UNREADABLE_QUOTE,
  type PreparedQuote,
} from '../core/evidence.ts'
import type { QuoteSource } from './evidence-source.ts'
import { SUPPORTS_LABEL } from '../store/templates/evidence.ts'
import {
  sanitizeEngineText,
  writeFailureError,
  writeQueueError,
} from '../core/tool-errors.ts'
import { createAudit, type Audit, type WriteOutcomeKind } from '../ops/audit.ts'
import type { Database } from '../store/db.ts'
import {
  createWriteGateway,
  type PlannedCommit,
  type PlannedInsert,
  type WriteGateway,
} from '../store/commits/assertions.ts'
import type { PlannedLink } from '../store/commits/engine.ts'
import { createWriteQueue, WriteQueueError, type WriteQueue } from '../store/commits/queue.ts'
import type { WriteFailure, WriteOutcome } from '../store/commits/engine.ts'

/** The lane a conversation write takes; the highest priority in the queue. */
const WRITE_LANE = 'conversation' as const

/** The success code a tool answer carries when the table landed. */
export const E_OK = 'OK'

/** One row of a planned table, as the caller sees it. */
export interface WriteItem {
  /** 1-based position of the op inside the table. */
  readonly index: number
  /** Which op produced it. */
  readonly op: 'assert' | 'pred'
  /** What happened to it. */
  readonly outcome: 'created' | 'existing' | 'promoted' | 'unchanged' | 'downgraded'
  /** The business key it addresses. */
  readonly mem_key: string
  /** The node kind it addresses. */
  readonly kind: string
  /** The value it carries, when the op named one. */
  readonly value?: string
}

/**
 * What one write did about the sources it declared.
 *
 * The model is told this for the same reason it is told how many facts landed:
 * "the fact is stored" and "its source is stored, with an empty quote because
 * this host could not read it back" are different sentences, and only this
 * answer can say which one happened.
 */
export interface WriteEvidenceSummary {
  /** How many distinct ranges the table declared. */
  readonly declared: number
  /** Pointers this write created. */
  readonly created: number
  /** Pointers that already existed and only gained a supporting edge. */
  readonly reused: number
  /** Pointers whose quote was redacted before storage. */
  readonly redacted: number
  /** Pointers stored with an empty quote because the host could not read them. */
  readonly unreadable: number
  /** Declared ranges this write could not store at all, because it had no session to key them by. */
  readonly dropped: number
}

/** The answer one write returns, shaped like the tool output schema. */
export interface WriteAnswer {
  /** Whether anything the caller asked for failed. */
  readonly ok: boolean
  /** A closed code: `OK`, a tool error code, or `E_OK` for a downgraded write. */
  readonly code: string
  /** The tool that produced the answer. */
  readonly tool: string
  /** One sentence for the model, free of node ids. */
  readonly message: string
  /** Business keys this write made readable; empty when nothing landed. */
  readonly mem_keys: readonly string[]
  /** Per-op results; empty for a refusal. */
  readonly items: readonly WriteItem[]
  /** What happened to the declared sources; absent when the table declared none. */
  readonly evidence?: WriteEvidenceSummary
}

/** The write surface the seams above use. */
export interface WritePort {
  /**
   * Write one patch table.
   * @param raw - the caller's patch table, unparsed.
   * @param caller - who is writing; only a user may touch the registry.
   * @param tool - the tool name to answer with.
   * @returns the structured answer.
   */
  remember(raw: unknown, caller: 'user' | 'model', tool: string, sessionId?: string): Promise<WriteAnswer>
  /**
   * Promote or demote one predicate's cardinality.
   *
   * This is the only path that writes with a `user` actor, which is what makes
   * the registry authoritative rather than advisory.
   * @param name - the predicate name.
   * @param cardinality - the new cardinality.
   * @param reason - why the user asked for it.
   * @returns the structured answer.
   */
  promote(name: string, cardinality: 'single' | 'multi', reason: string): Promise<WriteAnswer>
  /** Stop accepting writes, drain what is queued, then close the handle. */
  dispose(): Promise<void>
}

/** What the write port needs from its host. */
export interface WritePortDeps {
  /** An open, writable handle that already carries the schema. */
  readonly db: Database
  /** Where audit rows land. */
  readonly audit: Audit
  /** Where operational failures land. */
  readonly logger: { warn(code: string, detail?: unknown): void }
  /** The instant-dependent limits. */
  readonly maxNewPredsPerDay: number
  /** The contract version written into every ledger row. */
  readonly contractVersion: number
  /**
   * Where an evidence pointer reads the sentence it points at.
   *
   * Absent when the host exposes no read-back service. That is a degraded
   * pointer, not a refused write (AD-6, AD-18): the pointer is stored with an
   * empty quote and the caller still gets the assertion it came from.
   */
  readonly readQuote?: QuoteSource
  /** Clock override, for tests. */
  readonly now?: () => number
}

/**
 * The tool output schema every write answers with.
 *
 * `items` and `mem_keys` are optional: a refusal has neither, and a host that
 * validates strictly must still accept the refusal.
 */
export const WRITE_OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    code: { type: 'string' },
    tool: { type: 'string' },
    message: { type: 'string' },
    mem_keys: { type: 'array', items: { type: 'string' } },
    items: { type: 'array', items: { type: 'object' } },
    evidence: {
      type: 'object',
      description: '写入怎么处理了补丁表声明的来源；表里没有声明来源时不出现。',
      properties: {
        declared: { type: 'number' },
        created: { type: 'number' },
        reused: { type: 'number' },
        redacted: { type: 'number' },
        unreadable: { type: 'number' },
        dropped: { type: 'number' },
      },
      required: ['declared', 'created', 'reused', 'redacted', 'unreadable', 'dropped'],
      additionalProperties: false,
    },
  },
  required: ['ok', 'code', 'tool', 'message'],
  additionalProperties: false,
} as JsonSchemaNode

/** One refusal, ready to answer with. */
interface Refusal {
  readonly code: string
  readonly message: string
}

/**
 * Turn a plan's items into the caller-facing shape.
 * @param items - the planner's per-op results.
 * @returns the same list, with `mem_key` spelled out.
 */
function toWriteItems(items: readonly PlanItemResult[]): WriteItem[] {
  return items.map(item => ({
    index: item.index,
    op: item.op,
    outcome: item.outcome,
    mem_key: item.memKey,
    kind: item.kind,
    ...(item.value === undefined ? {} : { value: item.value }),
  }))
}

/**
 * Assemble the write service around one open handle.
 *
 * The queue and the gateway are built once per handle: both prepare something
 * (a scheduler, four compiled queries) that does not belong on a write path.
 * @param deps - the handle, the audit sink and the limits.
 * @returns the write port.
 */
export function createWritePort(deps: WritePortDeps): WritePort {
  const now = deps.now ?? ((): number => Date.now())
  const reporter = { report: (code: string, detail: string): void => deps.logger.warn(code, detail) }
  const queue: WriteQueue = createWriteQueue({ reporter })
  const gateway: WriteGateway = createWriteGateway(deps.db, { reporter })
  let disposed = false
  // Writes that were admitted before `dispose` closed the door. Each one is still
  // reading or still queued; closing the queue under them would turn an accepted
  // write into a refusal the caller never asked for.
  const admitted: Promise<WriteAnswer>[] = []
  /**
   * How many refusals this port has recorded.
   *
   * The rejected key carries this number because a caller can retry a malformed
   * table in the same millisecond; with a constant both attempts would render
   * the same key and the second row would collide on the unique index and be
   * lost, which is exactly the evidence a retry loop needs.
   */
  let rejections = 0

  /**
   * Keep one audit row, whatever happens to the file.
   *
   * A write that landed must not be un-landed by an unwritable log: the answer
   * the caller receives is about the store, so a failing sink is reported and
   * swallowed here.
   * @param row - the parts of the row this module decides.
   */
  const audit = (row: {
    readonly outcome: WriteOutcomeKind;
    readonly code: string;
    readonly memKeys: readonly string[];
    readonly elapsedMs: number;
    readonly atMs: number;
  }): void => {
    try {
      deps.audit.append({
        kind: 'write',
        ts: new Date(row.atMs).toISOString(),
        outcome: row.outcome,
        code: row.code,
        mem_keys: row.memKeys,
        elapsed_ms: row.elapsedMs,
      })
    } catch (error) {
      deps.logger.warn('OMW_AUDIT_WRITE_FAILED', { reason: describe(error) })
    }
  }

  /**
   * Record one refusal, in its own transaction, inside the task that refused.
   * @param raw - the caller's original patch table.
   * @param code - why it was refused.
   * @param reason - one sentence, already free of node ids.
   * @param atMs - the instant of the refusal.
   */
  const reject = (raw: unknown, code: string, reason: string, atMs: number): void => {
    const payload: Record<string, unknown> = {
      kind: 'rejected',
      mem_key: rejectedMemKey(atMs, patchDigest(raw), rejections += 1),
      patch: raw,
      reason,
      code,
      at: new Date(atMs).toISOString(),
      active_slot: 1,
      valid_from: new Date(atMs).toISOString(),
      recorded_at: new Date(atMs).toISOString(),
    }
    gateway.recordRejection(payload)
  }

  /**
   * Turn one engine failure into the answer the caller sees.
   * @param failure - the translated engine failure.
   * @param operation - what was being written, for the message.
   * @returns the refusal.
   */
  const refusalFor = (failure: WriteFailure, operation: string): Refusal => {
    const error = writeFailureError(failure, operation)
    return { code: error.code, message: sanitizeEngineText(error.message) }
  }

  /**
   * Build the ledger rows a plan asked for.
   *
   * Ledger rows ride in the same transaction as the facts they describe: a
   * decision that survived without its write, or a write without its decision,
   * would make the ledger useless as evidence.
   * @param plan - the planned table.
   * @param caller - the actor of this submission.
   * @param atMs - the instant the plan was made.
   * @returns one payload per decision.
   */
  const ledgerRows = (
    plan: { readonly decisions: readonly DecisionDraft[] },
    caller: 'user' | 'model',
    atMs: number,
  ): Record<string, unknown>[] => {
    return plan.decisions.map(draft => buildDecisionPayload({
      ts: new Date(atMs).toISOString(),
      actor: caller,
      decisionKind: draft.decisionKind,
      opId: operationId(atMs, draft.index),
      affected: draft.affected,
      targetMemKey: draft.targetMemKey,
      ...(draft.from === undefined ? {} : { from: draft.from }),
      ...(draft.to === undefined ? {} : { to: draft.to }),
      reason: draft.reason,
      contractVersion: deps.contractVersion,
      index: draft.index,
    }).payload)
  }

/** One pointer a table needs, with the quote and the assertions it supports. */
interface ResolvedEvidence {
  /** The pointer's business key. */
  readonly key: string
  /** First event the pointer covers. */
  readonly seqFrom: number
  /** Last event the pointer covers. */
  readonly seqTo: number
  /** The exact quote, already masked and cut. */
  readonly quote: PreparedQuote
  /** The assertions of this table the pointer supports. */
  readonly assertions: readonly { readonly memKey: string; readonly index: number }[]
}

  /**
   * Read every range a table declares, before the write ever queues.
   *
   * The read is host IO and belongs outside the queue task: a queue task that
   * awaits a session service would hold the write lane open for a reader that
   * may be slow or absent, and the write itself does not depend on it. What
   * comes back is text or nothing; a range that reads back nothing is not a
   * refusal (AD-18), it is a pointer that says so.
   * @param raw - the caller's patch table, unparsed.
   * @param sessionId - the host session the ranges live in, when known.
   * @returns one entry per declared range, keyed by `<from>-<to>`.
   */
  const readDeclaredRanges = async (
    raw: unknown,
    sessionId: string | undefined,
  ): Promise<ReadonlyMap<string, PreparedQuote>> => {
    const quotes = new Map<string, PreparedQuote>()
    const parsed = parsePatchTable(raw)
    if (!parsed.ok) return quotes
    const ranges = new Map<string, { readonly from: number; readonly to: number }>()
    for (const op of parsed.table.ops) {
      if (op.op !== 'assert' || op.evidence === undefined) continue
      // A range the planner will refuse is never worth a host read, and the
      // refusal itself belongs to the planner, not to this pre-pass.
      if (!checkEvidenceRange(op.evidence.seq_from, op.evidence.seq_to).ok) continue
      const key = `${op.evidence.seq_from}-${op.evidence.seq_to}`
      ranges.set(key, { from: op.evidence.seq_from, to: op.evidence.seq_to })
    }
    if (ranges.size === 0) return quotes
    if (sessionId === undefined) {
      // The table says where the fact came from, but the write has no session
      // to look in. The pointer is still written — dropping it would lose the
      // declaration — and saying out loud that it could not be read is the
      // whole difference between a degraded pointer and a silent one.
      for (const key of ranges.keys()) {
        deps.logger.warn(EVIDENCE_LOG_CODES.noSession, { range: key })
        quotes.set(key, UNREADABLE_QUOTE)
      }
      return quotes
    }
    const source = deps.readQuote
    await Promise.all([...ranges].map(async ([key, range]) => {
      const texts: string[] = []
      for (let seq = range.from; seq <= range.to; seq += 1) {
        const event = source === undefined
          ? undefined
          : await source.readQuote({ sessionId, seq })
        // Undefined means the host could not hand this event back at all — a
        // missing seq, a read error, or no session service. An event that is
        // there but carries no text (a tool call, a step boundary) is normal
        // inside a range and simply contributes nothing.
        if (event === undefined) {
          deps.logger.warn(EVIDENCE_LOG_CODES.unreadable, { range: key, seq })
          quotes.set(key, UNREADABLE_QUOTE)
          return
        }
        const text = extractQuoteSource(event)
        if (text !== '') texts.push(text)
      }
      const joined = texts.join('\n')
      if (joined === '') {
        deps.logger.warn(EVIDENCE_LOG_CODES.unreadable, { range: key })
        quotes.set(key, UNREADABLE_QUOTE)
        return
      }
      quotes.set(key, prepareQuote(joined))
    }))
    return quotes
  }

  /**
   * Resolve the pointers one planned table needs, reusing what is already stored.
   *
   * Two ops may name the same range, and so may two tables. One range is one
   * node: the second reference contributes an edge and nothing else, which is
   * what keeps a pointer from multiplying every time a fact is restated.
   * @param drafts - what the planner asked for.
   * @param sessionId - the session those ranges live in.
   * @param quotes - the ranges as already read.
   * @returns one entry per distinct range.
   */
  const resolveEvidence = (
    drafts: readonly EvidenceDraft[],
    sessionId: string,
    quotes: ReadonlyMap<string, PreparedQuote>,
  ): ResolvedEvidence[] => {
    const gathered = new Map<string, ResolvedEvidence & { assertions: { memKey: string; index: number }[] }>()
    const ordered: (ResolvedEvidence & { assertions: { memKey: string; index: number }[] })[] = []
    for (const draft of drafts) {
      const key = evidenceMemKey(sessionId, draft.seqFrom, draft.seqTo)
      const known = gathered.get(key)
      if (known !== undefined) {
        known.assertions.push({ memKey: draft.assertionMemKey, index: draft.index })
        continue
      }
      const entry = {
        key,
        seqFrom: draft.seqFrom,
        seqTo: draft.seqTo,
        quote: quotes.get(`${draft.seqFrom}-${draft.seqTo}`) ?? UNREADABLE_QUOTE,
        assertions: [{ memKey: draft.assertionMemKey, index: draft.index }],
      }
      gathered.set(key, entry)
      ordered.push(entry)
    }
    return ordered
  }

  /**
   * The whole write, as one queue task.
   * @param raw - the caller's patch table.
   * @param caller - who is writing.
   * @param tool - the tool name to answer with.
   * @returns the answer.
   */
  const submit = async (raw: unknown, caller: 'user' | 'model', tool: string, sessionId: string | undefined, quotes: ReadonlyMap<string, PreparedQuote>): Promise<WriteAnswer> => {
    const startedAt = now()
    const parsed = parsePatchTable(raw)
    if (!parsed.ok) {
      const atMs = now()
      reject(raw, 'E_BOUNDARY', parsed.reason, atMs)
      audit({ outcome: 'rejected', code: 'E_BOUNDARY', memKeys: [], elapsedMs: now() - startedAt, atMs })
      return { ok: false, code: 'E_BOUNDARY', tool, message: `${parsed.field}：${parsed.reason}`, mem_keys: [], items: [] }
    }
    const atMs = now()
    const context: PatchContext = {
      caller,
      nowMs: atMs,
      maxNewPredsPerDay: deps.maxNewPredsPerDay,
      contractVersion: deps.contractVersion,
      newPredsToday: gateway.countModelPredicatesToday(atMs),
      lookupLive: memKey => gateway.findLive(memKey),
      lookupVersions: memKey => gateway.findVersions(memKey),
    }
    const plan = planPatchTable(parsed.table, context)
    if (!plan.ok) {
      reject(raw, plan.code, `${plan.field}：${plan.reason}`, atMs)
      audit({ outcome: 'rejected', code: plan.code, memKeys: [], elapsedMs: now() - startedAt, atMs })
      return { ok: false, code: plan.code, tool, message: `${plan.field}：${plan.reason}`, mem_keys: [], items: [] }
    }
    const ledger = ledgerRows(plan, caller, atMs)
    const pointers = sessionId === undefined
      ? []
      : resolveEvidence(plan.evidence, sessionId, quotes)
    // A stored pointer is reused, never rewritten: evidence is immutable, so the
    // second reference to one range only adds the edge that says which assertion
    // this pointer now supports as well.
    const resolved = pointers.map(entry => ({ entry, id: gateway.findEvidenceId(entry.key) }))
    const fresh = resolved.filter(item => item.id === undefined)
    // Ranges are counted before they are resolved: a table may declare one range
    // twice, and a range that is dropped still has to appear in the answer, or a
    // caller who declared a source would read a silent write as a stored source.
    const declaredRanges = new Set(plan.evidence.map(draft => `${draft.seqFrom}-${draft.seqTo}`)).size
    const evidenceSummary: WriteEvidenceSummary | undefined = declaredRanges === 0
      ? undefined
      : {
          declared: declaredRanges,
          created: fresh.length,
          reused: resolved.length - fresh.length,
          redacted: pointers.filter(entry => entry.quote.deidentified).length,
          unreadable: pointers.filter(entry => entry.quote.quote === '').length,
          dropped: declaredRanges - pointers.length,
        }
    // An evidence batch needs ids before it is built: the edge names both ends,
    // and the engine allocates ids only at commit time, when it is too late to
    // point an edge at them. A batch without evidence keeps automatic ids.
    const explicitIds = pointers.length > 0
    const allocated = explicitIds
      ? gateway.allocateIds(plan.nodes.length + fresh.length + ledger.length)
      : []
    let cursor = 0
    /**
     * Take the next reserved id.
     *
     * The reservation is sized from the same counts this loop walks, so the
     * guard never fires; it exists because an id that silently became
     * `undefined` would write a node under an engine-chosen id and break the
     * edge that was supposed to point at it.
     * @returns the next id.
     */
    const takeId = (): number => {
      const id = allocated[cursor]
      cursor += 1
      if (id === undefined) throw new IdReservationError('omw: 预留的节点 id 不够本次提交使用')
      return id
    }
    const assertionIds = new Map<string, number>()
    const inserts: PlannedInsert[] = []
    for (const node of plan.nodes) {
      if (!explicitIds) {
        inserts.push({ payload: node.payload })
        continue
      }
      const id = takeId()
      assertionIds.set(node.memKey, id)
      inserts.push({ id, payload: node.payload })
    }
    const evidenceIds = new Map<string, number>()
    for (const item of fresh) {
      const id = takeId()
      evidenceIds.set(item.entry.key, id)
      inserts.push({
        id,
        payload: buildEvidencePayload({
          memKey: item.entry.key,
          sessionId: sessionId ?? '',
          seqFrom: item.entry.seqFrom,
          seqTo: item.entry.seqTo,
          quote: item.entry.quote.quote,
          quoteTruncated: item.entry.quote.truncated,
          deidentified: item.entry.quote.deidentified,
        }),
      })
    }
    for (const payload of ledger) {
      inserts.push(explicitIds ? { id: takeId(), payload } : { payload })
    }
    // A fact that already existed contributed no node, so its id has to come
    // from the store instead: the pointer is new even when the fact is not, and
    // a pointer nobody can trace back to its assertion is only half a pointer.
    for (const item of resolved) {
      if (item.id !== undefined) continue
      for (const assertion of item.entry.assertions) {
        if (assertionIds.has(assertion.memKey)) continue
        const stored = gateway.findLive(assertion.memKey)
        if (stored !== undefined) assertionIds.set(assertion.memKey, stored.id)
      }
    }
    const links: PlannedLink[] = []
    for (const item of resolved) {
      const src = item.id ?? evidenceIds.get(item.entry.key)
      if (src === undefined) {
        // A stored pointer whose id could not be named: the pointer exists, so
        // this is not a refusal — but an edge that quietly vanishes would make
        // 'trace it back' fail for a reason nobody can see later.
        deps.logger.warn(EVIDENCE_LOG_CODES.linkSkipped, { pointer: item.entry.key })
        continue
      }
      for (const assertion of item.entry.assertions) {
        const dst = assertionIds.get(assertion.memKey)
        if (dst === undefined) {
          deps.logger.warn(EVIDENCE_LOG_CODES.linkSkipped, { pointer: item.entry.key, assertion: assertion.memKey })
          continue
        }
        links.push({ src, dst, label: SUPPORTS_LABEL })
      }
    }
    const commit: PlannedCommit = {
      inserts,
      updates: plan.updates.map(update => ({ nodeId: update.nodeId, payload: update.payload })),
      ...(links.length === 0 ? {} : { links }),
    }
    const outcome: WriteOutcome<readonly number[]> = gateway.commit(commit)
    if (!outcome.ok) {
      const refusal = refusalFor(outcome.failure, '写入补丁表')
      reject(raw, refusal.code, refusal.message, atMs)
      audit({ outcome: 'rejected', code: refusal.code, memKeys: [], elapsedMs: now() - startedAt, atMs })
      return { ok: false, code: refusal.code, tool, message: refusal.message, mem_keys: [], items: [] }
    }
    const items = toWriteItems(plan.items)
    const memKeys = items.map(item => item.mem_key)
    const outcomeKind: WriteOutcomeKind = plan.downgraded ? 'downgraded' : 'committed'
    audit({
      outcome: outcomeKind,
      code: plan.downgraded ? 'E_DEGRADED' : E_OK,
      memKeys,
      elapsedMs: now() - startedAt,
      atMs,
    })
    return {
      ok: true,
      code: plan.downgraded ? 'E_DEGRADED' : E_OK,
      tool,
      message: describeSuccess(items, plan.downgraded, evidenceSummary),
      mem_keys: memKeys,
      items,
      ...(evidenceSummary === undefined ? {} : { evidence: evidenceSummary }),
    }
  }

  /**
   * Run one submission through the queue, translating queue failures.
   *
   * The declared ranges are read here, outside the task: reading a session is
   * host IO with its own timeout, and a queue task that awaited it would spend
   * the write lane's time budget on a reader. The text in hand is what the task
   * stores, so the pointer and the fact still commit together.
   * @param raw - the patch table.
   * @param caller - who is writing.
   * @param tool - the tool name.
   * @param sessionId - the host session the declared ranges live in.
   * @returns the answer; never throws for a write problem.
   */
  const run = async (raw: unknown, caller: 'user' | 'model', tool: string, sessionId?: string): Promise<WriteAnswer> => {
    try {
      const quotes = await readDeclaredRanges(raw, sessionId)
      return await queue.run({ lane: WRITE_LANE, run: () => submit(raw, caller, tool, sessionId, quotes) })
    } catch (error) {
      // A queue error already speaks the closed vocabulary; anything else is a
      // handle that did not survive, which the caller sees as a closed gate.
      if (error instanceof IdReservationError) {
        // A guard, not a caller mistake and not a closed gate: the reservation
        // is sized from the same counts the loop walks, so this only fires if
        // that accounting is wrong. Nothing was written; say so precisely.
        deps.logger.warn(EVIDENCE_LOG_CODES.idReservation, {})
        return {
          ok: false,
          code: 'E_GATE_DOWN',
          tool,
          message: '本次写入没有落库：内部节点 id 预留不足（这是实现缺陷，已写入日志）。',
          mem_keys: [],
          items: [],
        }
      }
      if (error instanceof WriteQueueError) {
        const closed = writeQueueError(error)
        return { ok: false, code: closed.code, tool, message: sanitizeEngineText(closed.message), mem_keys: [], items: [] }
      }
      return { ok: false, code: 'E_GATE_DOWN', tool, message: sanitizeEngineText(describe(error)), mem_keys: [], items: [] }
    }
  }

  /** Track one admitted write until it settles, so shutdown can wait for it. */
  const admit = (work: Promise<WriteAnswer>): Promise<WriteAnswer> => {
    const tracked = work.finally(() => {
      const at = admitted.indexOf(tracked)
      if (at >= 0) admitted.splice(at, 1)
    })
    admitted.push(tracked)
    return tracked
  }

  return {
    remember(raw: unknown, caller: 'user' | 'model', tool: string, sessionId?: string): Promise<WriteAnswer> {
      // A raising handle means the gate is down, not that the table was wrong;
      // saying E_CONFLICT here would blame the caller for our broken store.
      if (disposed) return Promise.resolve(gateDown(tool))
      return admit(run(raw, caller, tool, sessionId))
    },
    promote(name: string, cardinality: 'single' | 'multi', reason: string): Promise<WriteAnswer> {
      if (disposed) return Promise.resolve(gateDown('omw'))
      return admit(run({
        ops: [{ op: 'pred', pred: name, cardinality, reason }],
        reason,
      }, 'user', 'omw'))
    },
    async dispose(): Promise<void> {
      if (disposed) return
      // Stop accepting new work, then let every accepted write finish: the read
      // of a declared range happens before the queue task, so closing the queue
      // first would discard a write the caller already handed over.
      disposed = true
      await Promise.allSettled([...admitted])
      queue.close()
      await queue.idle()
      const failure = gateway.close()
      if (failure !== undefined) {
        deps.logger.warn('OMW_WRITE_CLOSE_FAILED', { kind: failure.kind })
      }
    },
  }
}

/**
 * The reserved-id guard fired.
 *
 * Kept apart from an ordinary throw because `run()` translates anything else
 * into a closed gate: an accounting bug inside the write path is not the same
 * event as a handle that did not survive, and the caller should not be told
 * the store is shut when it is open and simply did not get written to.
 */
class IdReservationError extends Error {}

/** The answer a call gets once the port is closed. */
function gateDown(tool: string): WriteAnswer {
  return {
    ok: false,
    code: 'E_GATE_DOWN',
    tool,
    message: '写面已关闭，本次调用没有落库。',
    mem_keys: [],
    items: [],
  }
}

/**
 * Describe a write in one sentence, from the items rather than from the engine.
 * @param items - what each op did.
 * @param downgraded - whether a fact was kept in a weaker shape.
 * @returns the sentence.
 */
function describeSuccess(
  items: readonly WriteItem[],
  downgraded: boolean,
  evidence: WriteEvidenceSummary | undefined,
): string {
  const created = items.filter(item => item.outcome === 'created').length
  const existing = items.filter(item => item.outcome === 'existing').length
  const promoted = items.filter(item => item.outcome === 'promoted').length
  const unchanged = items.filter(item => item.outcome === 'unchanged').length
  const parts = [`写入 ${created} 条新事实`]
  if (existing > 0) parts.push(`${existing} 条已存在`)
  // A promotion writes no new fact but does change the registry: saying only
  // '写入 0 条新事实' would read as a no-op to the user who just promoted.
  if (promoted > 0) parts.push(`${promoted} 条谓词登记已更新`)
  if (unchanged > 0) parts.push(`${unchanged} 条无需改动`)
  if (downgraded) parts.push('有新谓词被降级为场景文本')
  // A source the caller declared and did not get is the one thing that must
  // never be silent: the message is the model's only view of the write, and a
  // pointer that was dropped would otherwise look like a write that had none.
  if (evidence !== undefined) {
    const stored = evidence.created + evidence.reused
    parts.push(`来源指针落库 ${stored} 条`)
    if (evidence.redacted > 0) parts.push(`${evidence.redacted} 条引文已脱敏`)
    if (evidence.unreadable > 0) parts.push(`${evidence.unreadable} 条引文未能回读（保持为空）`)
    if (evidence.dropped > 0) parts.push(`${evidence.dropped} 条来源没有落库（本次写入拿不到会话 id）`)
  }
  return `${parts.join('，')}。`
}

/**
 * Render one thrown value as a short line.
 * @param error - anything thrown.
 * @returns the line.
 */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}

/**
 * Build the audit facade a runtime hands to the write port.
 * @param dataDir - the directory holding `audit-YYYYMMDD.jsonl`.
 * @param now - clock override.
 * @returns the audit facade.
 */
export function createWriteAudit(dataDir: string, now?: () => Date): Audit {
  return createAudit(now === undefined ? { dataDir } : { dataDir, now })
}