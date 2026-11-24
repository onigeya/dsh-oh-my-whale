/**
 * The history side of a memory: how one business key changed, and why (AD-5, AD-21).
 *
 * Two questions live here because they are the same question asked twice. `/omw
 * history` shows the versions of one key — a retired version is still there, with
 * the `valid_to` that says when it stopped being the answer. `/omw ledger` shows the
 * decisions that changed it, which is where the reason is written down. Neither
 * writes, neither queues, and neither is reachable from recall or injection: the
 * reader exists for a person asking why, not for the model guessing.
 *
 * The projection is the one place the storage shape is translated: a decision
 * node carries `kind: 'decision'` so a kind scan finds it, and the action travels
 * in `decision_kind`; {@link decisionView} gives the action back its name.
 * @module
 */
import type { Database } from '../store/db.ts'
import { createReadGateway } from '../store/commits/reads.ts'
import { decisionView, type DecisionView } from '../core/decisions.ts'
import { E_OK } from '../core/tool-errors.ts'

/** One version of a business key, as a reader sees it. */
export interface VersionView {
  /** The version's own `mem_key` (every version of one key shares it). */
  readonly mem_key: string
  /** Whether this is the version a default read returns. */
  readonly live: boolean
  /** The node kind, so a caller can tell an assertion version from a predicate one. */
  readonly kind: string
  /** Half-open interval start, ISO-8601 UTC. */
  readonly valid_from?: string
  /** Half-open interval end, ISO-8601 UTC; present only once the version was retired. */
  readonly valid_to?: string
  /** Milliseconds at which the version stopped being the answer. */
  readonly superseded_at?: number
  /** The slot that made room for a newer version; `1` while live. */
  readonly active_slot?: number
  /** When the fact was recorded, ISO-8601 UTC. */
  readonly recorded_at?: string
  /** Who wrote it: `user` | `model` | `seed` | `system`. */
  readonly actor?: string
  /** The value the version carried, when its kind stores one under `obj`. */
  readonly obj?: string
  /** The value the version carried, when its kind stores one under `value`. */
  readonly value?: string
  /** The registry status, for a predicate version. */
  readonly status?: string
}

/** The answer to one `/omw history <mem_key>` question. */
export interface VersionHistoryAnswer {
  /** `OK`, `E_BOUNDARY` for a key this store has never seen, `E_GATE_DOWN` for a closed reader. */
  readonly ok: boolean
  readonly code: string
  /** The key that was asked about, echoed so a log line needs no join. */
  readonly mem_key: string
  /** One line of our own words; never engine text, never a node id. */
  readonly message: string
  /** Oldest version first; `live` marks the one a default read returns. */
  readonly versions: readonly VersionView[]
}

/** The answer to one `/omw ledger <mem_key>` question. */
export interface LedgerAnswer {
  readonly ok: boolean
  readonly code: string
  readonly mem_key: string
  readonly message: string
  /** Oldest entry first. */
  readonly entries: readonly DecisionView[]
}

/** The read port the command surface uses for history and the ledger. */
export interface VersionReader {
  /** Every version of one business key. */
  history(memKey: string): VersionHistoryAnswer
  /** Every ledger entry whose target is one business key. */
  ledger(memKey: string): LedgerAnswer
  /**
   * Mark the reader closed; idempotent.
   *
   * The handle belongs to the runtime and is shared with the write side, so a
   * reader never closes it: after this call every read answers `E_GATE_DOWN`
   * instead of touching a handle it no longer owns.
   */
  dispose(): void
}

/**
 * Key prefixes that name a ledger record rather than a memory.
 *
 * A `decision:` node and a `rejected:` node are append-only audit entries: they
 * are written once, never rewritten, and have no history to walk.
 */
const LEDGER_KEY_PREFIXES: readonly string[] = ['decision:', 'rejected:']

/** What the reader needs. */
export interface VersionReaderDeps {
  readonly db: Database
}

/**
 * Read one payload field without trusting its type.
 *
 * A stored version with a wrong-typed field is corrupt, but throwing here would
 * turn one bad row into an unusable command: the field is dropped from the view
 * instead, so the rest of the version stays visible.
 * @param payload - the stored payload.
 * @param key - the field to read.
 * @returns the text, or `undefined` when the field is absent or not a string.
 */
function textField(payload: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Read one payload field as a finite number.
 * @param payload - the stored payload.
 * @param key - the field to read.
 * @returns the number, or `undefined` when the field is absent or not a number.
 */
function numberField(payload: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = payload[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Project one stored version onto the reported fields.
 * @param payload - the stored payload.
 * @returns the version as the reader reports it.
 */
function toVersionView(payload: Readonly<Record<string, unknown>>): VersionView {
  const memKey = textField(payload, 'mem_key') ?? ''
  const supersededAt = numberField(payload, 'superseded_at')
  const optional = {
    ...(textField(payload, 'valid_from') === undefined ? {} : { valid_from: textField(payload, 'valid_from') }),
    ...(textField(payload, 'valid_to') === undefined ? {} : { valid_to: textField(payload, 'valid_to') }),
    ...(supersededAt === undefined ? {} : { superseded_at: supersededAt }),
    ...(numberField(payload, 'active_slot') === undefined ? {} : { active_slot: numberField(payload, 'active_slot') }),
    ...(textField(payload, 'recorded_at') === undefined ? {} : { recorded_at: textField(payload, 'recorded_at') }),
    ...(textField(payload, 'actor') === undefined ? {} : { actor: textField(payload, 'actor') }),
    ...(textField(payload, 'obj') === undefined ? {} : { obj: textField(payload, 'obj') }),
    ...(textField(payload, 'value') === undefined ? {} : { value: textField(payload, 'value') }),
    ...(textField(payload, 'status') === undefined ? {} : { status: textField(payload, 'status') }),
  }
  return {
    mem_key: memKey,
    live: supersededAt === undefined,
    kind: textField(payload, 'kind') ?? '',
    ...optional,
  }
}

/**
 * Sort versions oldest first, keeping the live one last.
 *
 * `valid_from` is the interval start and the history index, so it orders the
 * chain; a version without one sorts before the ones that have it rather than
 * disappearing.
 * @param versions - the versions in engine order.
 * @returns the versions in chain order.
 */
function inChainOrder(versions: readonly VersionView[]): readonly VersionView[] {
  return [...versions].sort((left, right) => {
    const a = left.valid_from ?? ''
    const b = right.valid_from ?? ''
    if (a !== b) return a < b ? -1 : 1
    // Two versions written in the same millisecond share `valid_from`, so the
    // slot decides — except that a retired version spent a slot of its own and
    // the live one is still `1`; sorting by slot alone would put the live
    // version first, which reads as a chain that starts at the wrong end.
    if (left.live !== right.live) return left.live ? 1 : -1
    return (left.active_slot ?? 0) - (right.active_slot ?? 0)
  })
}

/**
 * Sort ledger entries oldest first.
 *
 * The engine returns them in node order, which is insertion order only by
 * accident; the answer promises chain order, so it is imposed here.
 * @param entries - the entries in engine order.
 * @returns the entries in time order.
 */
function inLedgerOrder(entries: readonly DecisionView[]): readonly DecisionView[] {
  return [...entries].sort((left, right) => {
    if (left.ts !== right.ts) return left.ts < right.ts ? -1 : 1
    if (left.op_id === right.op_id) return 0
    return left.op_id < right.op_id ? -1 : 1
  })
}

/**
 * Build the reader over one open handle.
 *
 * The read gateway is reused rather than a second set of templates: it already
 * owns the version read and the ledger read, and a second implementation would
 * be a second place for the query shape to drift.
 * @param deps - the handle.
 * @returns the reader.
 */
export function createVersionReader(deps: VersionReaderDeps): VersionReader {
  const gateway = createReadGateway(deps.db)
  let disposed = false
  const guard = (key: string, command: string): VersionHistoryAnswer | undefined => {
    // A closed handle answers the same question for every key, valid or not:
    // judging the key first would report a boundary error about the argument
    // when the real problem is that there is nothing left to ask.
    if (disposed) {
      return { ok: false, code: 'E_GATE_DOWN', mem_key: key, message: '记忆库已关闭，本次没有读到任何东西。', versions: [] }
    }
    if (key === '') {
      return {
        ok: false,
        code: 'E_BOUNDARY',
        mem_key: key,
        message: `需要给出一个业务键：/omw ${command} <mem_key>`,
        versions: [],
      }
    }
    // The ledger is a record of changes, not a memory that changes. Asking for
    // the versions of a decision or a rejected table would invite someone to
    // treat an audit trail as mutable state, which AD-5 forbids outright.
    if (LEDGER_KEY_PREFIXES.some(prefix => key.startsWith(prefix))) {
      return {
        ok: false,
        code: 'E_BOUNDARY',
        mem_key: key,
        message: `账本是记录，不是记忆版本，既没有版本链也没有改动账本：${key}`,
        versions: [],
      }
    }
    return undefined
  }
  return {
    history(memKey: string): VersionHistoryAnswer {
      const key = memKey.trim()
      const refused = guard(key, 'history')
      if (refused !== undefined) return refused
      const versions = inChainOrder(gateway.findVersions(key).map(node => toVersionView(node.payload)))
      if (versions.length === 0) {
        // A key that exists but has no version chain is not a missing key. An
        // evidence pointer, a flag or a ledger row is written once and never
        // rewritten, so 'never written' would be a wrong sentence about a node
        // that is right there; the answer says what it is instead.
        const live = gateway.findLive(key)
        if (live !== undefined) {
          const kind = textField(live.payload, 'kind') ?? ''
          const what = kind === 'evidence'
            ? '一条证据指针'
            : kind === ''
              ? '一条没有类型的记录'
              : `一条 ${kind} 记录`
          return {
            ok: true,
            code: E_OK,
            mem_key: key,
            message: `该业务键是${what}，没有版本链（这类记录写一次就不再改写）：${key}`,
            versions: [],
          }
        }
        // Not a boundary: the question was well-formed and the answer is that
        // this store has never seen the key. A refusal would make a script
        // treat 'never written' as a broken request.
        return { ok: true, code: E_OK, mem_key: key, message: `没有找到这个业务键的任何版本：${key}`, versions: [] }
      }
      const retired = versions.filter(version => !version.live).length
      const message = retired === 0
        ? `该业务键只有 1 个版本，从未被改写：${key}`
        : `该业务键共 ${versions.length} 个版本，其中 ${retired} 个已退役：${key}`
      return { ok: true, code: E_OK, mem_key: key, message, versions }
    },
    ledger(memKey: string): LedgerAnswer {
      const key = memKey.trim()
      const refused = guard(key, 'ledger')
      if (refused !== undefined) {
        return { ok: refused.ok, code: refused.code, mem_key: refused.mem_key, message: refused.message, entries: [] }
      }
      const nodes = gateway.listDecisionsFor(key)
      const entries = inLedgerOrder(
        nodes
          .map(node => decisionView(node.payload))
          .filter((entry): entry is DecisionView => entry !== undefined),
      )
      // A decision node whose payload does not project is corrupt, and dropping
      // it silently would print 'no decisions' while the nodes are right there.
      // The count is carried in the message so the discrepancy is visible.
      const dropped = nodes.length - entries.length
      if (entries.length === 0) {
        if (dropped > 0) {
          return {
            ok: false,
            code: 'E_DEGRADED',
            mem_key: key,
            message: `该业务键有 ${dropped} 条决策记录，但每一条都读不出必需字段，本版本无法展示：${key}`,
            entries: [],
          }
        }
        if (gateway.findLive(key) === undefined) {
          return { ok: true, code: E_OK, mem_key: key, message: `没有找到这个业务键的任何决策记录：${key}`, entries: [] }
        }
        return { ok: true, code: E_OK, mem_key: key, message: `该业务键没有决策记录：${key}`, entries: [] }
      }
      const head = `该业务键有 ${entries.length} 条决策记录：${key}`
      return {
        ok: true,
        code: E_OK,
        mem_key: key,
        message: dropped === 0 ? head : `${head}（另有 ${dropped} 条读不出必需字段，未列出）`,
        entries,
      }
    },
    dispose(): void {
      if (disposed) return
      disposed = true
    },
  }
}
