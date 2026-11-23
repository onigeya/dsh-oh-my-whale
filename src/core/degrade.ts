/**
 * The closed degradation vocabulary and its single state machine (AD-13, AD-18,
 * AD-19).
 *
 * Exactly three states exist — `ok`, `no-op`, `vector-off` — and exactly eight
 * runtime error codes. Both sets are frozen: adding, removing or renaming an
 * entry is a compatibility break. `no-op` is terminal, and no transition ever
 * returns to `ok`: recovery is a plugin reload, never an in-process self-heal.
 *
 * This module is pure. It performs no IO and imports nothing outside `core/`.
 * @module
 */

/** The only states the plugin may ever be in. Order is part of the contract. */
export const DEGRADE_STATES = ['ok', 'no-op', 'vector-off'] as const

/** One of the three closed degradation states. */
export type DegradeState = (typeof DEGRADE_STATES)[number]

/** The eight closed runtime degradation codes. */
export const OMW_CODES = [
  'OMW_DB_OPEN',
  'OMW_SNAPSHOT_VERIFY',
  'OMW_DIM_MISMATCH',
  'OMW_EMBED_AUTH',
  'OMW_EMBED_QUOTA',
  'OMW_EMBED_TIMEOUT',
  'OMW_EXTRACT_FAIL',
  'OMW_DREAM_BUDGET',
] as const

/** One of the eight closed runtime degradation codes. */
export type OmwCode = (typeof OMW_CODES)[number]

/** The closed `degraded_reason` vocabulary written to audit rows (AD-20). */
export const DEGRADED_REASONS = [
  'recall_timeout',
  'rerank_unavailable',
  'rerank_circuit_open',
  'vec_unavailable',
  'embed_circuit_open',
  'budget_truncated',
] as const

/** One member of the closed `degraded_reason` vocabulary. */
export type DegradedReason = (typeof DEGRADED_REASONS)[number]

/** Structured context attached to a degradation reason. */
export type DegradeDetail = Readonly<Record<string, unknown>>

/** An immutable view of the machine at one instant. */
export interface DegradeSnapshot {
  readonly state: DegradeState
  /** First failure that drove the machine away from `ok`; never overwritten. */
  readonly code?: OmwCode
  /** Values that explain the failure (both sides of a mismatch, env var name, …). */
  readonly detail?: DegradeDetail
}

/** Raised when a caller asks for a transition the contract forbids. */
export class IllegalDegradeTransition extends Error {
  constructor(from: DegradeState, to: DegradeState, reason: string) {
    super(`illegal degradation transition ${from} -> ${to}: ${reason}`)
    this.name = 'IllegalDegradeTransition'
  }
}

/** Whether `code` is one of the eight closed runtime codes. */
export function isOmwCode(value: unknown): value is OmwCode {
  return typeof value === 'string' && (OMW_CODES as readonly string[]).includes(value)
}

/** Whether `reason` is one of the closed audit reasons. */
export function isDegradedReason(value: unknown): value is DegradedReason {
  return typeof value === 'string' && (DEGRADED_REASONS as readonly string[]).includes(value)
}

/** Whether `state` is one of the three closed states. */
export function isDegradeState(value: unknown): value is DegradeState {
  return typeof value === 'string' && (DEGRADE_STATES as readonly string[]).includes(value)
}

/**
 * The single owner of the degradation state.
 *
 * Transitions are one-way: `ok -> no-op`, `ok -> vector-off`, and
 * `vector-off -> no-op`. Repeating the current state is allowed and keeps the
 * first failure (checks run in a fixed order and a later check must not mask an
 * earlier one). Everything else throws, so a fourth state or a silent recovery
 * cannot be introduced by accident.
 */
export class DegradeMachine {
  #snapshot: DegradeSnapshot = { state: 'ok' }

  /** The current state and the first failure behind it. */
  get snapshot(): DegradeSnapshot {
    return this.#snapshot
  }

  /** The current state alone. */
  get state(): DegradeState {
    return this.#snapshot.state
  }

  /** Whether nothing is degraded. */
  get isOk(): boolean {
    return this.#snapshot.state === 'ok'
  }

  /** Whether the whole plugin has stepped aside. */
  get isNoOp(): boolean {
    return this.#snapshot.state === 'no-op'
  }

  /** Whether only the vector path is closed. */
  get isVectorOff(): boolean {
    return this.#snapshot.state === 'vector-off'
  }

  /**
   * Enter the overall no-op state. Terminal and idempotent: the first code and
   * detail are retained, because the gate that failed first is the one worth
   * reporting.
   * @param code - one of the eight closed runtime codes.
   * @param detail - values that explain the failure.
   * @returns the resulting snapshot.
   */
  enterNoOp(code: OmwCode, detail?: DegradeDetail): DegradeSnapshot {
    if (this.#snapshot.state === 'no-op') return this.#snapshot
    return this.#commit('no-op', code, detail)
  }

  /**
   * Close only the vector path. Legal from `ok` only; from `no-op` or from an
   * already closed vector path it is a programming error, because a closed
   * vector path can never be reopened.
   * @param code - one of the eight closed runtime codes.
   * @param detail - values that explain the failure.
   * @returns the resulting snapshot.
   */
  enterVectorOff(code: OmwCode, detail?: DegradeDetail): DegradeSnapshot {
    if (this.#snapshot.state === 'vector-off') return this.#snapshot
    if (this.#snapshot.state !== 'ok') {
      throw new IllegalDegradeTransition(this.#snapshot.state, 'vector-off', 'the vector path cannot reopen')
    }
    if (!closesVectorPath(code)) {
      // A timeout or a transient failure must not close the path; the code table
      // is the single place that decides which failures are terminal.
      throw new IllegalDegradeTransition(this.#snapshot.state, 'vector-off', `${code} does not close the vector path`)
    }
    return this.#commit('vector-off', code, detail)
  }

  #commit(state: DegradeState, code: OmwCode, detail?: DegradeDetail): DegradeSnapshot {
    if (!isOmwCode(code)) throw new Error(`unknown degradation code ${JSON.stringify(code)}`)
    const next: DegradeSnapshot = detail === undefined
      ? { state, code }
      : { state, code, detail }
    this.#snapshot = Object.freeze(next)
    return this.#snapshot
  }
}

/**
 * Transport-level embedding failure kinds, restated here.
 *
 * `store/embedding.ts` owns the transport and this module owns the vocabulary, so
 * the union is duplicated rather than imported: `core/` must not depend on the
 * storage layer's types. The two unions are structurally identical, so a
 * transport kind assigns without a cast.
 */
export const EMBEDDING_FAILURE_KINDS = [
  'missing-credential',
  'auth',
  'quota',
  'timeout',
  'dimension',
  'transient',
] as const

/** One transport-level embedding failure kind. */
export type EmbeddingFailureKindLike = (typeof EMBEDDING_FAILURE_KINDS)[number]

/** Codes that close the vector path permanently (AD-19). */
export const VECTOR_CLOSING_CODES = ['OMW_EMBED_AUTH', 'OMW_EMBED_QUOTA', 'OMW_DIM_MISMATCH'] as const

/**
 * Map one transport failure onto the closed runtime vocabulary.
 *
 * `undefined` means "this failure closes nothing": `transient` is retryable and
 * `OMW_EMBED_TIMEOUT` is recorded without a state transition (AD-19).
 * @param kind - transport failure kind, as reported by the embedding channel.
 * @returns the degradation code, or `undefined` when no code applies.
 */
export function mapEmbeddingFailureKind(kind: string): OmwCode | undefined {
  switch (kind) {
    case 'missing-credential':
    case 'auth':
      return 'OMW_EMBED_AUTH'
    case 'quota':
      return 'OMW_EMBED_QUOTA'
    case 'timeout':
      return 'OMW_EMBED_TIMEOUT'
    case 'dimension':
      return 'OMW_DIM_MISMATCH'
    default:
      return undefined
  }
}

/**
 * Whether a code closes the vector path.
 * @param code - one of the eight closed runtime codes.
 * @returns `true` for credential, balance and width failures.
 */
export function closesVectorPath(code: OmwCode): boolean {
  return (VECTOR_CLOSING_CODES as readonly string[]).includes(code)
}
