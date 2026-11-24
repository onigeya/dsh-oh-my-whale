/**
 * The store gateway the write path talks to (AD-4, AD-15).
 *
 * Planning happens in `src/core/patch.ts`; committing happens in
 * `engine.ts`. This module is the seam between them, and it exists because the
 * store layer may not import the domain layer above it: a plan therefore arrives
 * as plain payloads — already built, already carrying their `mem_key` — and the
 * only decisions left here are ordering and counting.
 *
 * Two rules live here rather than in the planner, because both follow from the
 * engine’s own semantics:
 *
 * - *Retirement before insertion.* A superseded version is updated to its
 *   retired `active_slot` before the replacement is inserted, so the unique
 *   index over `(mem_key, active_slot)` never sees two live versions of one key,
 *   not even inside one batch.
 * - *A rejection is a second transaction.* The transaction that refused a patch
 *   table has already aborted; the `rejected` node recording why can only land
 *   afterwards, which is why the matrix asks for "no nodes, one rejection"
 *   rather than "one node".
 * @module
 */
import { databaseDim, hasNode, type Database } from '../db.ts'
import { startOfLocalDayIso } from '../tbox.ts'
import { createAssertionTemplates, type StoredNode } from '../templates/assertions.ts'
import { createEvidenceTemplates } from '../templates/evidence.ts'
import {
  createCommitEngine,
  toTransactionOperations,
  type CommitEngine,
  type PlannedLink,
  type WriteFailure,
  type WriteOutcome,
} from './engine.ts'

/** One node a plan wants inserted, with its complete payload. */
export interface PlannedInsert {
  /**
   * The id this node must take, when the same batch has to name it.
   *
   * An edge needs both ends to have ids, and the engine hands out ids only as it
   * inserts. A plan that draws an edge therefore assigns ids itself, through
   * {@link WriteGateway.allocateIds}, and every other insert keeps the engine's
   * own numbering.
   */
  readonly id?: number
  readonly payload: Record<string, unknown>
}

/** One existing node a plan wants rewritten, with its complete new payload. */
export interface PlannedRewrite {
  readonly nodeId: number
  readonly payload: Record<string, unknown>
}

/** Everything one patch table decided to write, in plan order. */
export interface PlannedCommit {
  /** Nodes to insert, in the order the plan produced them. */
  readonly inserts: readonly PlannedInsert[]
  /** Live nodes to rewrite; a retirement lands here, before any insert. */
  readonly updates: readonly PlannedRewrite[]
  /** Edges between nodes this same batch writes. */
  readonly links?: readonly PlannedLink[]
}

/** A failure the gateway noticed about itself rather than about a write. */
export interface GatewayReporter {
  /**
   * Record one operational failure the caller cannot act on.
   * @param code - a closed log code.
   * @param detail - a short, id-free description.
   */
  report(code: string, detail: string): void
}

/** Logger codes the gateway emits. */
export const GATEWAY_LOG_CODES = {
  /** The rejection node could not be written: the reason is lost, the failure is not. */
  rejectionFailed: 'OMW_REJECTED_WRITE_FAILED',
} as const

/** The store surface the write path uses; nothing above `store/` sees templates. */
export interface WriteGateway {
  /** The live version of one business key, or `undefined` when the key is unused. */
  findLive(memKey: string): StoredNode | undefined
  /** The live registry entry for one predicate name. */
  findPredicate(name: string): StoredNode | undefined
  /**
   * Every version of one business key, live or retired.
   * @param memKey - the business key.
   * @returns the versions, in engine order.
   */
  findVersions(memKey: string): readonly StoredNode[]
  /**
   * The versions of one key whose slot is at or above an instant.
   *
   * The planner needs the highest slot already taken before it retires a version,
   * so two retirements in the same millisecond cannot collide on the unique index.
   * Slots below the instant cannot raise the answer — the slot it will use is
   * already at least that instant — so asking for these few keeps the write path
   * flat however long the chain grows.
   * @param memKey - the business key.
   * @param sinceMs - the instant the write happens at.
   * @returns the versions at or above that slot.
   */
  findVersionsSinceSlot(memKey: string, sinceMs: number): readonly StoredNode[]
  /**
   * How many predicates the model has proposed since local midnight.
   *
   * Read through the same gateway as the writes so the cap is counted against
   * committed state, at the moment the plan runs, inside the queue.
   * @param nowMs - the instant the plan runs.
   * @returns the count.
   */
  countModelPredicatesToday(nowMs: number): number
  /**
   * The node id of one evidence pointer, or `undefined` when the range is new.
   *
   * Evidence is immutable and carries no `active_slot`, so the unique key index
   * does not police it: a second pointer to one range would be a second node
   * under one key, and only this lookup prevents that.
   * @param memKey - the evidence business key.
   * @returns its node id, or `undefined`.
   */
  findEvidenceId(memKey: string): number | undefined
  /**
   * Commit one plan, whole or not at all.
   * @param plan - the nodes and rewrites the planner produced.
   * @returns the node ids the engine assigned, or why nothing was written.
   */
  commit(plan: PlannedCommit): WriteOutcome<readonly number[]>
  /**
   * Reserve ids the caller can name in the same batch it commits.
   *
   * The engine has no id reservation: ids are handed out as nodes are inserted,
   * and an edge can only name ids that exist by the end of its batch. A plan that
   * needs both therefore has to choose ids before it commits — inside the write
   * queue, where one write runs at a time, so two plans can never choose the
   * same one.
   * @param count - how many ids the plan needs.
   * @returns the first `count` unused ids, ascending.
   */
  allocateIds(count: number): readonly number[]
  /**
   * Record one refusal in its own transaction.
   *
   * A failure here is reported and swallowed: the caller is about to return a
   * refusal anyway, and losing the audit trail must not turn a refusal into a
   * crash. It is reported rather than silent, because a store that cannot keep
   * refusals is a store whose gate is failing.
   * @param payload - the complete `rejected` payload, built by the caller.
   * @returns the outcome, for a caller that wants to say whether it was kept.
   */
  recordRejection(payload: Record<string, unknown>): WriteOutcome<readonly number[]>
  /** Close the handle, reporting why when the engine refuses. */
  close(): WriteFailure | undefined
}

/**
 * The largest node id currently in the store.
 * @param ids - every id the store holds.
 * @returns the highest id, or 0 for an empty store.
 */
function highestNodeIdOf(ids: readonly number[]): number {
  let highest = 0
  for (const id of ids) {
    if (id > highest) highest = id
  }
  return highest
}

/**
 * Wire the gateway around one open, writable handle.
 *
 * The templates and the engine are prepared once per handle: both compile or
 * allocate something, and neither belongs on a per-write path.
 * @param db - an open, writable handle.
 * @param options - a reporter for the failures the gateway keeps to itself.
 * @returns the gateway.
 */
export function createWriteGateway(
  db: Database,
  options: { readonly reporter?: GatewayReporter } = {},
): WriteGateway {
  const templates = createAssertionTemplates(db)
  const evidence = createEvidenceTemplates(db)
  const engine: CommitEngine = createCommitEngine(db, databaseDim(db))
  const reporter = options.reporter
  /** Highest id already in use, read once per reservation. */
  const highestNodeId = (): number => highestNodeIdOf(db.allNodeIds())

  /**
   * Turn one plan into engine operations.
   *
   * Retirement first: the planner lists a rewritten node before the insert that
   * replaces it, and `toTransactionOperations` preserves that split.
   * @param plan - the plan.
   * @returns the batch, in write order.
   */
  const batch = (plan: PlannedCommit): ReturnType<typeof toTransactionOperations> =>
    toTransactionOperations({
      zeroVector: engine.zeroVector,
      inserts: plan.inserts,
      updates: plan.updates,
      ...(plan.links === undefined ? {} : { links: plan.links }),
    })

  return {
    findLive(memKey: string): StoredNode | undefined {
      return templates.findLiveByKey(memKey)
    },
    findPredicate(name: string): StoredNode | undefined {
      return templates.findPredByName(name)
    },
    findVersions(memKey: string): readonly StoredNode[] {
      return templates.findAllVersionsByKey(memKey)
    },
    findVersionsSinceSlot(memKey: string, sinceMs: number): readonly StoredNode[] {
      return templates.findVersionsSinceSlot(memKey, sinceMs)
    },
    countModelPredicatesToday(nowMs: number): number {
      return templates.findModelPredsSince(startOfLocalDayIso(new Date(nowMs))).length
    },
    findEvidenceId(memKey: string): number | undefined {
      return evidence.findByKey(memKey)?.id
    },

    allocateIds(count: number): readonly number[] {
      if (count <= 0) return []
      // The engine's next automatic id is "highest in use, plus one", so a block
      // starting there and stepping over ids already present can collide with
      // neither an explicit nor a following automatic insert.
      let candidate = highestNodeId() + 1
      const reserved: number[] = []
      while (reserved.length < count) {
        if (!hasNode(db, candidate)) reserved.push(candidate)
        candidate += 1
      }
      return reserved
    },
    commit(plan: PlannedCommit): WriteOutcome<readonly number[]> {
      // A plan with nothing to write is a success, not an empty transaction: a
      // table that resolved to "everything already exists" did what it promised.
      if (plan.inserts.length === 0 && plan.updates.length === 0 && (plan.links ?? []).length === 0) {
        return { ok: true, value: [] }
      }
      return engine.commit(batch(plan))
    },
    recordRejection(payload: Record<string, unknown>): WriteOutcome<readonly number[]> {
      const outcome = engine.commit(toTransactionOperations({
        zeroVector: engine.zeroVector,
        inserts: [{ payload }],
        updates: [],
      }))
      if (!outcome.ok) {
        reporter?.report(
          GATEWAY_LOG_CODES.rejectionFailed,
          `拒收记录未能落库（${outcome.failure.kind}）`,
        )
      }
      return outcome
    },
    close(): WriteFailure | undefined {
      return engine.close()
    },
  }
}
