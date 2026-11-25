/**
 * The host's per-session token accounting, as the audit row wants it (AD-20).
 *
 * Two host services are needed and neither is guaranteed: `sessions` resolves a
 * session id to the object a projection is taken from, and `sessionProjections`
 * holds the `tokenUsage` projection. Both are optional capabilities, so every
 * path here returns `undefined` rather than throwing — a harness without a token
 * meter still injects, and its rows simply say `null` instead of inventing zero.
 *
 * The projection has four buckets and only three describe input: every input
 * token is cached-read, cache-write, or uncached, never two of them, while
 * `outputTokens` is the model's answer and has no place in a cache ratio. All
 * three are cumulative for the session; the auditor turns them into a delta and
 * this module only reads them.
 * @module
 */
import type { HostUsage } from '../ops/injection-audit.ts'

/** The `tokenUsage` projection, as this plugin reads it. */
interface TokenUsageProjection {
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly uncachedInputTokens?: number
}

/** A session object, as far as a projection needs it. */
interface SessionLike {
  readonly id: string
}

/** `sessions.get(id)`. */
interface SessionStoreLike {
  get(id: string): SessionLike | undefined
}

/** `sessionProjections.snapshot(session)`. */
interface SessionProjectionLike {
  snapshot(session: SessionLike): { readonly values: Readonly<Record<string, unknown>> }
}

/** Reads one session's cumulative accounting, or says it cannot. */
export type HostUsageReader = (sessionId: string) => HostUsage | undefined

/**
 * Build the usage reader from the host services.
 *
 * Absent services produce a reader that always answers `undefined`, which is the
 * same fact as a host that has not measured the session yet — and that is why the
 * caller does not need to distinguish the two.
 * @param sessions - the host's session store, when present and well-shaped.
 * @param projections - the host's projection registry, when present and well-shaped.
 * @returns the reader.
 */
export function createHostUsageReader(sessions: unknown, projections: unknown): HostUsageReader {
  const store = asSessionStore(sessions)
  const registry = asProjections(projections)
  return sessionId => {
    if (store === undefined || registry === undefined) return undefined
    try {
      const session = store.get(sessionId)
      if (session === undefined) return undefined
      const snapshot = registry.snapshot(session)
      const values = snapshot.values
      if (typeof values !== 'object' || values === null) return undefined
      const usage = values['tokenUsage']
      if (typeof usage !== 'object' || usage === null) return undefined
      const typed = usage as TokenUsageProjection
      //
      // A missing bucket is not a zero: the projection is filled in as the host
      // measures, so one bucket can land before another. Each is judged on its
      // own — a bucket that never was written becomes `null` while the ones that
      // were still reach the row. Blanking all three because one is absent would
      // throw away a number the row can honestly report.
      //
      return {
        read: numberOrNull(typed.cacheReadTokens),
        write: numberOrNull(typed.cacheWriteTokens),
        uncached: numberOrNull(typed.uncachedInputTokens),
      }
    } catch {
      // A projection that throws (a stale session, a race with a fork) says the
      // same thing as one that is missing: the numbers are unknown.
      return undefined
    }
  }
}

/**
 * Read a finite, non-negative token count.
 * @param value - whatever the projection held.
 * @returns the number, or `null` when the host did not say.
 */
function numberOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return value
}

/**
 * Accept a session store by shape.
 * @param candidate - whatever `ctx.get('sessions')` returned.
 * @returns the store, or undefined.
 */
function asSessionStore(candidate: unknown): SessionStoreLike | undefined {
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const get = (candidate as { get?: unknown }).get
  if (typeof get !== 'function') return undefined
  return candidate as SessionStoreLike
}

/**
 * Accept a projection registry by shape.
 * @param candidate - whatever `ctx.get('sessionProjections')` returned.
 * @returns the registry, or undefined.
 */
function asProjections(candidate: unknown): SessionProjectionLike | undefined {
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const snapshot = (candidate as { snapshot?: unknown }).snapshot
  if (typeof snapshot !== 'function') return undefined
  return candidate as SessionProjectionLike
}