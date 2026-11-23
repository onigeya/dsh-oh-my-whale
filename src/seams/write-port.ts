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
  type PatchContext,
  type PlanItemResult,
} from '../core/patch.ts'
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
  type WriteGateway,
} from '../store/commits/assertions.ts'
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
  remember(raw: unknown, caller: 'user' | 'model', tool: string): Promise<WriteAnswer>
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

  /**
   * The whole write, as one queue task.
   * @param raw - the caller's patch table.
   * @param caller - who is writing.
   * @param tool - the tool name to answer with.
   * @returns the answer.
   */
  const submit = async (raw: unknown, caller: 'user' | 'model', tool: string): Promise<WriteAnswer> => {
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
    const commit: PlannedCommit = {
      inserts: [
        ...plan.nodes.map(node => ({ payload: node.payload })),
        ...ledgerRows(plan, caller, atMs).map(payload => ({ payload })),
      ],
      updates: plan.updates.map(update => ({ nodeId: update.nodeId, payload: update.payload })),
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
      message: describeSuccess(items, plan.downgraded),
      mem_keys: memKeys,
      items,
    }
  }

  /**
   * Run one submission through the queue, translating queue failures.
   * @param raw - the patch table.
   * @param caller - who is writing.
   * @param tool - the tool name.
   * @returns the answer; never throws for a write problem.
   */
  const run = async (raw: unknown, caller: 'user' | 'model', tool: string): Promise<WriteAnswer> => {
    try {
      return await queue.run({ lane: WRITE_LANE, run: () => submit(raw, caller, tool) })
    } catch (error) {
      // A queue error already speaks the closed vocabulary; anything else is a
      // handle that did not survive, which the caller sees as a closed gate.
      if (error instanceof WriteQueueError) {
        const closed = writeQueueError(error)
        return { ok: false, code: closed.code, tool, message: sanitizeEngineText(closed.message), mem_keys: [], items: [] }
      }
      return { ok: false, code: 'E_GATE_DOWN', tool, message: sanitizeEngineText(describe(error)), mem_keys: [], items: [] }
    }
  }

  return {
    remember(raw: unknown, caller: 'user' | 'model', tool: string): Promise<WriteAnswer> {
      // A raising handle means the gate is down, not that the table was wrong;
      // saying E_CONFLICT here would blame the caller for our broken store.
      if (disposed) return Promise.resolve(gateDown(tool))
      return run(raw, caller, tool)
    },
    promote(name: string, cardinality: 'single' | 'multi', reason: string): Promise<WriteAnswer> {
      if (disposed) return Promise.resolve(gateDown('omw'))
      return run({
        ops: [{ op: 'pred', pred: name, cardinality, reason }],
        reason,
      }, 'user', 'omw')
    },
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      queue.close()
      await queue.idle()
      const failure = gateway.close()
      if (failure !== undefined) {
        deps.logger.warn('OMW_WRITE_CLOSE_FAILED', { kind: failure.kind })
      }
    },
  }
}

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
function describeSuccess(items: readonly WriteItem[], downgraded: boolean): string {
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