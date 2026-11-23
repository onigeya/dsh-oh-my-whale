/**
 * Vector policy: the only place where an embedding failure becomes degradation
 * state (AD-19, AD-23).
 *
 * The mapping itself is pure and lives in `core/degrade.ts`; this module owns the
 * *effects* — one log line per failure, and the state transition for the failures
 * that close the vector path:
 *
 * | transport kind      | code                | effect                     |
 * | ------------------- | ------------------- | -------------------------- |
 * | `auth` / missing    | `OMW_EMBED_AUTH`    | close vector path          |
 * | `quota`             | `OMW_EMBED_QUOTA`   | close vector path          |
 * | `dimension`         | `OMW_DIM_MISMATCH`  | close vector path          |
 * | `timeout`           | `OMW_EMBED_TIMEOUT` | **no** transition          |
 * | `transient`         | `OMW_EMBED_TRANSIENT` | warn only, no transition |
 *
 * The call never throws at its caller and never retries: the write already
 * succeeded, so an embedding problem is reported, not raised.
 * @module
 */
import {
  type DegradeDetail,
  type DegradeMachine,
  type OmwCode,
  closesVectorPath,
  mapEmbeddingFailureKind,
} from '../core/degrade.ts'
import type { Database } from '../store/db.ts'
import type { EmbeddingOptions } from '../store/embedding.ts'
import { insertNodePending, insertNodeWithVector, type VecState } from '../store/vector-write.ts'
import type { Logger } from './logger.ts'

/**
 * Diagnostic log code for a retryable embedding failure.
 *
 * Not one of the eight degradation codes: a flaky transport closes nothing and
 * moves no state. It is still written down, because a provider that answers 500
 * for every call would otherwise leave the plugin silently vector-less.
 */
export const TRANSIENT_LOG_CODE = 'OMW_EMBED_TRANSIENT'

/** Inputs of {@link createVectorPolicy}. */
export interface VectorPolicyDeps {
  readonly machine: DegradeMachine
  readonly logger: Logger
  readonly db: Database
  readonly options: EmbeddingOptions
}

/** What one write attempt produced. */
export interface VectorAttempt {
  readonly nodeId: number
  readonly vecState: VecState
  /** Closed code this attempt produced, if any. */
  readonly code?: OmwCode
  /** Whether this attempt is the one that closed the vector path. */
  readonly closedPath: boolean
}

/** The vector side of the plugin, as the runtime holds it. */
export interface VectorPolicy {
  /** Whether the vector path is closed (by this plugin, at any point). */
  readonly closed: boolean
  /** Commit a node and, when still open, try to attach its vector. */
  write(payload: Readonly<Record<string, unknown>>, text: string): Promise<VectorAttempt>
}

/**
 * Build the policy over a live handle and the shared state machine.
 * @param deps - machine, logger, handle and channel options.
 * @returns the policy.
 */
export function createVectorPolicy(deps: VectorPolicyDeps): VectorPolicy {
  const { machine, logger, db, options } = deps

  return {
    get closed() {
      return machine.state !== 'ok'
    },

    async write(payload, text) {
      // With the path closed, the node still commits — it simply stays pending.
      // Nothing is sent to the provider, so a closed path cannot keep failing.
      if (machine.state !== 'ok') {
        const { nodeId, vecState } = insertNodePending(db, payload)
        return { nodeId, vecState, closedPath: false }
      }

      const outcome = await insertNodeWithVector({ db, payload, text, options })
      if (outcome.failure === undefined) {
        return { nodeId: outcome.nodeId, vecState: outcome.vecState, closedPath: false }
      }

      const detail: DegradeDetail = {
        reason: outcome.failure.kind,
        ...(outcome.failure.status === undefined ? {} : { status: outcome.failure.status }),
        ...(outcome.failure.apiKeyEnv === undefined ? {} : { env: outcome.failure.apiKeyEnv }),
        ...(outcome.failure.expected === undefined ? {} : { expected: outcome.failure.expected }),
        ...(outcome.failure.actual === undefined ? {} : { actual: outcome.failure.actual }),
      }

      const code = mapEmbeddingFailureKind(outcome.failure.kind)
      if (code === undefined) {
        // Transient: retryable, closes nothing, raises nothing — but never silent.
        logger.warn(TRANSIENT_LOG_CODE, detail)
        return { nodeId: outcome.nodeId, vecState: outcome.vecState, closedPath: false }
      }

      if (!closesVectorPath(code)) {
        // A timeout is recorded and the capability is kept (matrix EMBED_TIMEOUT).
        logger.warn(code, detail)
        return { nodeId: outcome.nodeId, vecState: outcome.vecState, code, closedPath: false }
      }

      machine.enterVectorOff(code, detail)
      logger.error(code, detail)
      return { nodeId: outcome.nodeId, vecState: outcome.vecState, code, closedPath: true }
    },
  }
}
