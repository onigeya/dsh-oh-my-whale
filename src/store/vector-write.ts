/**
 * The minimal "commit the node, then try to attach a vector" path (AD-19).
 *
 * Two rules shape it:
 *
 * 1. the node is committed **first**, so a broken vector path can never cost a
 *    memory;
 * 2. a node without a vector stays usable — it is `pending`, participates in the
 *    text and graph paths, and is filled in later.
 *
 * This module reports transport-level facts only. Mapping them to the closed
 * degradation vocabulary belongs to `seams/`, because `store/` may not depend on
 * `core/`.
 * @module
 */
import type { Database } from './db.ts'
import { embed, type EmbeddingFailure, type EmbeddingOptions } from './embedding.ts'

/** Where one node stands on the vector path. */
export type VecState = 'pending' | 'ready'

/** Inputs of {@link insertNodeWithVector}. */
export interface VectorWriteInput {
  readonly db: Database
  /** Payload to commit; `vec_state` is added by this module. */
  readonly payload: Readonly<Record<string, unknown>>
  /** Text to embed. */
  readonly text: string
  /** Embedding channel options (endpoint, model, ceiling, width, transport). */
  readonly options: EmbeddingOptions
}

/** Outcome of one commit-plus-embed attempt. */
export interface VectorWriteOutcome {
  /** Id of the committed node. */
  readonly nodeId: number
  /** `ready` only when a vector of the right width was attached. */
  readonly vecState: VecState
  /** Whether a vector was attached. */
  readonly embedded: boolean
  /** Transport failure, present exactly when `embedded` is false. */
  readonly failure?: EmbeddingFailure
}

/**
 * Commit a node with no vector attached.
 *
 * The placeholder vector is zero-filled and the payload carries
 * `vec_state:'pending'`, which is what makes the node text-searchable but absent
 * from the vector path.
 * @param db - open handle.
 * @param payload - caller payload.
 * @returns the new node id and the state written.
 */
export function insertNodePending(
  db: Database,
  payload: Readonly<Record<string, unknown>>,
): { readonly nodeId: number; readonly vecState: VecState } {
  const dimensions = db.dim()
  const placeholder = new Array<number>(dimensions).fill(0)
  const nodeId = db.insert(placeholder, { ...payload, vec_state: 'pending' })
  return { nodeId, vecState: 'pending' }
}

/**
 * Commit a node, then try to attach its vector.
 *
 * The commit is never rolled back: a failed embedding leaves a `pending` node,
 * not a lost one. Nothing here retries — retry policy is the caller's, and 401/402
 * must not be retried at all.
 * @param input - handle, payload, text and channel options.
 * @returns the committed node, its vector state, and the failure when one occurred.
 */
export async function insertNodeWithVector(input: VectorWriteInput): Promise<VectorWriteOutcome> {
  const { nodeId } = insertNodePending(input.db, input.payload)
  const result = await embed([input.text], input.options)
  if (!result.ok) {
    return { nodeId, vecState: 'pending', embedded: false, failure: result.failure }
  }
  const vector = result.vectors[0]
  if (vector === undefined) {
    return {
      nodeId,
      vecState: 'pending',
      embedded: false,
      failure: { kind: 'transient', message: 'embedding returned no vector for the submitted text' },
    }
  }
  try {
    input.db.updateVector(nodeId, [...vector])
    input.db.updatePayload(nodeId, { ...input.payload, vec_state: 'ready' })
  } catch (error) {
    // The node is already committed, so a failed attach must not escape the write
    // path: it falls back to `pending` and reports itself as retryable.
    return {
      nodeId,
      vecState: 'pending',
      embedded: false,
      failure: { kind: 'transient', message: error instanceof Error ? error.message : String(error) },
    }
  }
  return { nodeId, vecState: 'ready', embedded: true }
}
