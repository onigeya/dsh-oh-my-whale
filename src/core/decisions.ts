/**
 * The decision ledger: one `decision` node per state change (AD-21).
 *
 * A `decision` node answers "why does this memory say what it says", so every
 * field the governance queries need is written even when it is empty. The node
 * `kind` stays `decision` and the action name goes to `decision_kind`: the
 * engine filters on `kind`, so putting the action there would hide every entry
 * from a `kind: "decision"` scan.
 * @module
 */
import { createHash } from 'node:crypto'

/** What a decision did to the state it names (data-model §3). */
export type DecisionKind = 'insert' | 'supersede' | 'arbitrate' | 'resolve_flag' | 'migrate' | 'revert'

/** Who caused the change. */
export type DecisionActor = 'user' | 'model' | 'seed' | 'system'

/** Random suffix length, in base-36 characters (36^6 ≈ 2.2e9). */
export const RANDOM_LENGTH = 6

/**
 * Default randomness: base-36, padded to exactly {@link RANDOM_LENGTH} characters.
 * Padding keeps every key the same shape, which makes a key-scan readable.
 * @returns the token.
 */
function defaultRandom(): string {
  return Math.random().toString(36).slice(2, 2 + RANDOM_LENGTH).padEnd(RANDOM_LENGTH, '0')
}

/**
 * A stable random token, injectable so a test can pin it.
 * @param random - the source of randomness.
 * @returns exactly {@link RANDOM_LENGTH} base-36 characters.
 */
export function randomToken(random: () => string = defaultRandom): string {
  return random().slice(0, RANDOM_LENGTH).padEnd(RANDOM_LENGTH, '0')
}

/**
 * Business key of one `decision` node: append-only, one per state change.
 *
 * The table index is part of the key: two ops in one patch table share a
 * millisecond, and a key without the index would make the second insert collide
 * with the first — a legal patch table rejected by the ledger.
 * @param nowMs - the instant the table was committed.
 * @param index - the 0-based position of the op inside the table.
 * @param random - the randomness source.
 * @returns the business key.
 */
export function decisionMemKey(nowMs: number, index: number, random?: () => string): string {
  return `decision:${nowMs}:${index}:${randomToken(random)}`
}

/**
 * The ledger operation id: `<ms>:<table index>:<rand36>`.
 *
 * Every decision one op writes shares this id, which is what makes an op
 * reversible: a `revert` names the id it undoes, not a node.
 * @param nowMs - the instant the table was committed.
 * @param index - the 0-based position of the op inside the table.
 * @param random - the randomness source.
 * @returns the operation id, also written to the audit row.
 */
export function operationId(nowMs: number, index: number, random?: () => string): string {
  return `${nowMs}:${index}:${randomToken(random)}`
}

/**
 * Sixteen hex characters of a patch table's canonical JSON.
 *
 * Two rejections in the same millisecond differ by their table, so the digest
 * — not the instant — keeps `rejected:` keys distinct.
 * @param patch - the rejected table, as received.
 * @returns the first 16 hex characters of its SHA-256.
 */
export function patchDigest(patch: unknown): string {
  let text: string
  try {
    text = JSON.stringify(patch) ?? String(patch)
  } catch {
    text = String(patch)
  }
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/**
 * Business key of one `rejected` node: `<ms>:<digest>:<sequence>`.
 *
 * The sequence is a per-process counter, so a retry loop that fails twice in
 * one millisecond still writes two rows instead of colliding on the first.
 * @param nowMs - the instant the table was rejected.
 * @param digest - {@link patchDigest} of the rejected table.
 * @param sequence - monotonically increasing counter for this process.
 * @returns the business key.
 */
export function rejectedMemKey(nowMs: number, digest: string, sequence: number): string {
  return `rejected:${nowMs}:${digest}:${sequence}`
}

/** One ledger entry, before it becomes a node payload. */
export interface DecisionInput {
  /** Instant of the change, ISO-8601 UTC. */
  readonly ts: string
  readonly actor: DecisionActor
  readonly decisionKind: DecisionKind
  /** Operation id, shared by every decision one op writes. */
  readonly opId: string
  /** `mem_key`s written or changed by the op (data-model §6 closure). */
  readonly affected: readonly string[]
  readonly targetMemKey: string
  readonly from?: unknown
  readonly to?: unknown
  readonly reason: string
  readonly precedentId?: string
  readonly contractVersion: number
  /** 0-based position inside the table; also disambiguates the node key. */
  readonly index: number
}

/**
 * Build one `decision` node payload.
 *
 * `from`/`to` are omitted rather than written as `null`: a node payload may not
 * carry `undefined`, and `null` would be indistinguishable from a field the
 * engine dropped.
 * @param input - the ledger entry.
 * @param random - the randomness source for the node key.
 * @returns the payload plus the business key it was written under.
 */
export function buildDecisionPayload(
  input: DecisionInput,
  random?: () => string,
): { readonly memKey: string; readonly payload: Record<string, unknown> } {
  const memKey = decisionMemKey(Date.parse(input.ts), input.index, random)
  const payload: Record<string, unknown> = {
    kind: 'decision',
    mem_key: memKey,
    ts: input.ts,
    actor: input.actor,
    decision_kind: input.decisionKind,
    op_id: input.opId,
    affected: [...input.affected],
    target_mem_key: input.targetMemKey,
    reason: input.reason,
    contract_version: input.contractVersion,
    active_slot: 1,
    valid_from: input.ts,
    recorded_at: input.ts,
  }
  if (input.from !== undefined) payload['from'] = input.from
  if (input.to !== undefined) payload['to'] = input.to
  if (input.precedentId !== undefined) payload['precedent_id'] = input.precedentId
  return { memKey, payload }
}

/**
 * One ledger entry as a reader sees it: the shape FR-3 and AD-21 name.
 *
 * The stored node keeps `kind: 'decision'` so a `kind` scan finds every entry;
 * the action therefore travels under `decision_kind` in the payload and is
 * projected back to `kind` here. Nothing outside this function has to know the
 * storage shape, and the trade-off stays in one place instead of two.
 */
export interface DecisionView {
  /** Instant of the change, ISO-8601 UTC. */
  readonly ts: string
  /** Who caused it: `user` | `model` | `seed` | `system`. */
  readonly actor: string
  /** What it did: `insert` | `supersede` | `arbitrate` | `resolve_flag` | `migrate` | `revert`. */
  readonly kind: string
  /** Operation id, shared by every entry one op wrote. */
  readonly op_id: string
  /** `mem_key`s this op wrote or changed (data-model §6 closure). */
  readonly affected: readonly string[]
  /** The state the op was about. */
  readonly target_mem_key: string
  readonly from?: unknown
  readonly to?: unknown
  readonly reason: string
  readonly contract_version: number
  readonly precedent_id?: string
}

/**
 * Read one stored payload as a ledger entry.
 * @param payload - the stored payload, as read back from the engine.
 * @returns the entry, or `undefined` when the payload is not a decision node.
 */
export function decisionView(payload: Readonly<Record<string, unknown>>): DecisionView | undefined {
  if (payload['kind'] !== 'decision') return undefined
  const ts = textField(payload['ts'])
  const actor = textField(payload['actor'])
  const kind = textField(payload['decision_kind'])
  const opId = textField(payload['op_id'])
  const target = textField(payload['target_mem_key'])
  const reason = textField(payload['reason'])
  const contractVersion = payload['contract_version']
  if (ts === undefined || actor === undefined || kind === undefined) return undefined
  if (opId === undefined || target === undefined || reason === undefined) return undefined
  if (typeof contractVersion !== 'number') return undefined
  const affected = payload['affected']
  const view: DecisionView = {
    ts,
    actor,
    kind,
    op_id: opId,
    affected: Array.isArray(affected) ? affected.filter((key): key is string => typeof key === 'string') : [],
    target_mem_key: target,
    reason,
    contract_version: contractVersion,
    ...(payload['from'] === undefined ? {} : { from: payload['from'] }),
    ...(payload['to'] === undefined ? {} : { to: payload['to'] }),
    ...(typeof payload['precedent_id'] === 'string' ? { precedent_id: payload['precedent_id'] } : {}),
  }
  return view
}

/**
 * Read a required string field.
 * @param value - the stored value.
 * @returns the text, or `undefined` when the field is missing or empty.
 */
function textField(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
