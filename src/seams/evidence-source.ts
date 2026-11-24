/**
 * The adapter between the write path and the host's read-only session log (AD-6).
 *
 * A patch table names the seq range its evidence comes from; the host is the
 * only place the text of that range exists. The plugin never imports the host's
 * session-query package — it declares the two shapes it uses and reads them
 * structurally, so a host without the capability simply yields `undefined`
 * instead of a compile or load failure.
 *
 * Every failure mode of the host collapses to the same answer here — absent
 * capability, a rejected promise, a timeout, a malformed window. The caller
 * then writes a pointer with an empty quote and marks it unresolvable, which is
 * the degradation AD-6 asks for: a pointer that is honest about not resolving
 * beats a fabricated quote, and it must never stop the assertion from landing.
 * @module
 */

/**
 * One host event, as far as this adapter cares.
 *
 * `content` is a list of blocks; only blocks of type `text` carry quotable
 * text. `data` is the declaration-merged payload, whose own `content` is the
 * field `user/message` events actually use.
 */
export interface HostEventLike {
  readonly data?: unknown
}

/** The window `readEvent` resolves to; only `target` is read here. */
export interface HostEventWindowLike {
  readonly target?: HostEventLike
}

/** The one host method this adapter calls. */
export interface SessionQueryLike {
  readEvent(request: { sessionId: string; seq: number }, signal?: AbortSignal): Promise<HostEventWindowLike>
}

/** One read of the original text behind a seq range. */
export interface QuoteSource {
  /** Read the text of one event, or `undefined` when the host cannot supply it. */
  readQuote(request: { sessionId: string; seq: number }): Promise<unknown | undefined>
}

/** How long one session read may take before the pointer is written unresolved. */
export const READ_QUOTE_TIMEOUT_MS = 250

/**
 * Narrow an unknown service to the shape {@link SessionQueryLike} declares.
 * @param candidate - the value resolved from the context, possibly absent.
 * @returns the service, or `undefined` when it does not offer `readEvent`.
 */
export function asSessionQuery(candidate: unknown): SessionQueryLike | undefined {
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const readEvent = (candidate as { readEvent?: unknown }).readEvent
  if (typeof readEvent !== 'function') return undefined
  return candidate as SessionQueryLike
}

/**
 * Adapt the host's session log to the write path's one question.
 *
 * A missing service yields a source whose every read is `undefined` rather than
 * no source at all: the write path then has one code path for "cannot resolve"
 * whether the capability is absent or merely failing, and no caller has to
 * branch on it.
 * @param service - the host service, or `undefined` when the host has none.
 * @returns the reader; reads never reject.
 */
export function createQuoteSource(service: SessionQueryLike | undefined): QuoteSource {
  return {
    async readQuote(request: { sessionId: string; seq: number }): Promise<unknown | undefined> {
      if (service === undefined) return undefined
      // A read that never settles must not hold a write open: the pointer is
      // worth writing without its quote, and the queue task timeout is far too
      // coarse to borrow for this. Giving up on the promise is not enough —
      // the host would keep scanning a session we no longer want — so the
      // timeout also aborts the request, and the timer is always cleared.
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          controller.abort()
          resolve(undefined)
        }, READ_QUOTE_TIMEOUT_MS)
      })
      try {
        const window = await Promise.race([
          service.readEvent({ sessionId: request.sessionId, seq: request.seq }, controller.signal),
          timeout,
        ])
        if (window === undefined) return undefined
        return window.target
      } catch {
        // The host's failure is not this installation's failure: report it as an
        // unresolvable pointer, which the caller logs, and keep writing.
        return undefined
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    },
  }
}
