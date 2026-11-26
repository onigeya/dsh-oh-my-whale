/**
 * The single injection exit (AD-7, AD-11).
 *
 * Two channels, two tiers, and nobody else may call them:
 *
 * - `ctx.systemPrompt.section({name:'harness:identity'})` — the identity text, at
 *   most 1200 characters, byte-stable. It is registered under the host's own
 *   opening-section name, so it replaces "You are an AI agent powered by DeepSeek
 *   Harness." in place instead of queueing behind it (the documented same-name
 *   rule: nearest scope wins, and within one scope the latest live registration
 *   wins). It is rendered into the prompt cache prefix, so a changed byte
 *   invalidates the cache; an unchanged hash therefore re-registers nothing.
 * - `ctx.systemPrompt.context({name:'omw:persona-state'})` — the mutable state
 *   tail, at most 30 estimated tokens. The host treats it as cache-safe context.
 *
 * Identity is decoupled from the database on purpose: when the store is unusable
 * the identity section still appears, byte for byte identical to a healthy
 * profile (AD-11, AD-13).
 *
 * {@link PromptComposer.compose} is the one place the three tiers meet. It returns
 * an {@link InjectionPlan} — what goes in, how much it costs, and which tier lost
 * something — so "what did this turn inject" is an assertable value rather than a
 * log line. The audit row that records it belongs to Story 2.6.
 * @module
 */
import { createHash } from 'node:crypto'
// AD-26: the numbers live in `config.ts`. Repeating their values here would let
// the two drift, and a drift would give the budget two disagreeing inputs.
import { DEFAULT_TOP_K, RECALL_ITEM_BUDGET_TOKENS } from './config.ts'

/**
 * Name of the identity section: the host's own opening section.
 *
 * The host registers "You are an AI agent powered by DeepSeek Harness." under
 * this name at order -1000, in the context-global layer. Reusing the name is the
 * documented way to replace it — the same-name rule keeps the nearest scope's
 * latest live registration, and this plugin mounts after the host service, so
 * the identity text lands exactly where the host sentence was. Unloading the
 * plugin removes the registration and the host sentence reappears.
 */
export const PERSONA_SECTION_NAME = 'harness:identity'

/** Name of the state tail. Part of the public contract; do not rename. */
export const PERSONA_STATE_CONTEXT_NAME = 'omw:persona-state'

/**
 * Where the identity section sorts among host sections: the host's
 * `HARNESS_IDENTITY` slot, ahead of every other section.
 */
export const PERSONA_SECTION_ORDER = -1000

/** Where the state tail sorts among host runtime contexts. */
export const PERSONA_STATE_CONTEXT_ORDER = 130

/**
 * Name of the recall context (P0-1).
 *
 * Its own channel rather than a third segment of the tail: the tail is 30 tokens
 * and the recap pool is up to five items. It also cannot ride the identity
 * section, whose byte stability is what keeps the prefix cache alive (AD-7).
 */
export const RECALL_CONTEXT_NAME = 'omw:recall'

/** Where the recall context sorts: after the state tail, so the tail keeps its slot. */
export const RECALL_CONTEXT_ORDER = PERSONA_STATE_CONTEXT_ORDER + 1

/**
 * The slice of the host's `AssembleContext` this composer reads (AD-20).
 *
 * Declared structurally rather than imported: the plugin never depends on a host
 * package (AD-1), and the only fact it needs is which session is being assembled.
 * Everything else the host passes along is allowed and ignored.
 */
export interface PromptAssemblyContext {
  /** The session this assembly is for, when the host has one. */
  readonly session?: PromptSessionLike
}

/**
 * The session facts the recall tier reads (P0-1).
 *
 * Structural, like {@link PromptAssemblyContext} itself: the host passes its own
 * `Session` object, and this module must not import the host package (AD-1). Only
 * the synchronous event reader is declared — an async read would put a promise on
 * the injection path, which AD-7's 20 ms synchronous budget forbids.
 */
export interface PromptSessionLike {
  /** The host's session id; the audit row's only attribution. */
  readonly id: string
  /** The session's own events, oldest first. Absent on a host that withholds them. */
  readonly ownEvents?: () => readonly PromptEventLike[]
}

/**
 * One `user/message` event, as far as the query builder cares.
 *
 * The interface models only the event kind this module reads, so `type` is that
 * one literal rather than `string`: the repo's layer gate reads this field to
 * exclude the hard-delete op names, and a bare `string` is the unreadable case it
 * refuses. A real session hands over other kinds too; the filter in
 * {@link recallQueryFrom} is what skips them.
 */
export interface PromptEventLike {
  readonly type: 'user/message'
  readonly data?: unknown
}

/**
 * The two host calls this module is allowed to make.
 *
 * `text` may be a provider: the host calls it once per assembly and hands over
 * its own `AssembleContext`, which is the only moment a section can learn which
 * session it is being assembled for. The identity section is registered that way
 * because an audit row needs a `session_id` (Story 2.6); a plain string stays
 * accepted for the state tail, whose text the composer already owns.
 */
export interface SystemPromptLike {
  /** Register a system section; returns the disposer. */
  section(section: { name: string; order: number; text: string | ((context?: PromptAssemblyContext) => string) }): () => void
  /** Register a runtime-context contribution; returns the disposer. */
  context(context: { name: string; order: number; text: string | ((context?: PromptAssemblyContext) => string) }): () => void
}

/** The mutable tail's inputs. Every field is optional: absent means "say nothing". */
export interface PersonaState {
  /** Relationship summary, ≈12 tokens. */
  readonly relationship?: string
  /** Most recent confirmed preference, ≈10 tokens. */
  readonly preference?: string
  /** One pending flag, ≈8 tokens. */
  readonly flag?: string
}

/** A composed identity section, ready to register. */
export interface ComposedPersona {
  readonly name: typeof PERSONA_SECTION_NAME
  readonly order: number
  readonly text: string
  /** SHA-256 of `text`; equal hashes mean byte-identical text. */
  readonly hash: string
  /** Code points in `text` — what the audit row's `chars` reports. */
  readonly chars: number
  /** Whether the source exceeded the character budget and was cut. */
  readonly truncated: boolean
}

/** One recalled memory the caller wants injected. */
export interface RecallItem {
  /** Business key, kept so the audit row can name what went in. */
  readonly memKey: string
  /** The text the model would read. */
  readonly text: string
}

/** The tail's three segments, in retention-priority order. */
export type TailSegment = 'relationship' | 'preference' | 'flag'

/**
 * Why a tier lost something, as a closed vocabulary.
 *
 * A boolean could only say "something was cut"; a reader of the audit row needs
 * to know which tier, and for the tail which segment. Only a *budget* loss is
 * listed: keeping fewer recalled items than the caller offered because `topK`
 * is the contract working, not something being cut.
 */
export type TruncatedItem = 'identity' | `state:${TailSegment}` | 'recall'

/** What the state tail kept, dropped, and cost. */
export interface TailPlan {
  /** The joined tail, or `undefined` when nothing survived. */
  readonly text: string | undefined
  /**
   * Names of the segments kept, in relationship → preference → flag order.
   *
   * Names rather than text, and the same vocabulary `dropped` uses: an audit row
   * says *which* tier lost something, and a reader comparing kept with dropped
   * must not find text on one side and identifiers on the other.
   */
  readonly kept: readonly TailSegment[]
  /** Names of the segments dropped for the token budget, in the order they lost. */
  readonly dropped: readonly TailSegment[]
  /** Code points in {@link text} — what the audit row's `chars` reports. */
  readonly chars: number
  /** Estimated tokens of {@link text} (0 when absent). */
  readonly tokens: number
  /** Whether the token budget cut a segment. */
  readonly truncated: boolean
}

/** What the recall tier kept and cost. */
export interface RecallPlan {
  /** Items that fit the token pool, in the caller's order (a prefix). */
  readonly kept: readonly RecallItem[]
  /** Code points across `kept` — what the audit row's `chars` reports. */
  readonly chars: number
  /**
   * Items beyond `topK`.
   *
   * Not a truncation: "at most five" is the tier's own bound (AD-8 ③), and a
   * reader who saw this counted as a cut would learn that a normal recall was
   * over budget.
   */
  readonly overCount: number
  /** Items that did not fit the token pool. This *is* a truncation. */
  readonly overBudget: number
  /** Estimated tokens of {@link kept}. */
  readonly tokens: number
  /** Whether the token pool cut an item. */
  readonly truncated: boolean
}

/**
 * Everything one assembly decided.
 *
 * The three `*Tokens` fields are per-tier so an audit row can be written per
 * tier; `tokens` is the whole injection and never exceeds `budget`.
 */
export interface InjectionPlan {
  /** The identity section as it will be registered. */
  readonly persona: ComposedPersona
  /** The state tail, already bounded by its own cap. */
  readonly tail: TailPlan
  /** The recalled memories that fit. */
  readonly recall: RecallPlan
  /** Estimated tokens of the identity section. */
  readonly identityTokens: number
  /** The shared budget, derived from the three caps (see the module notes). */
  readonly budget: number
  /**
   * Estimated tokens of everything this plan composed.
   *
   * A tier is only in here when something could carry it into the prompt. The
   * identity section and the tail each have a host channel; recall does not until
   * Story 2.5 wires one, and `runtime.ts` therefore composes no recall at all —
   * so a real mount reports 0 here for that tier rather than counting text the
   * model never saw.
   */
  readonly tokens: number
  /** Which tiers lost something, in the order the losses happened. */
  readonly truncatedItems: readonly TruncatedItem[]
  /**
   * Whether anything was cut at all.
   *
   * Redundant with `truncatedItems.length > 0` on purpose: the audit row carries
   * a boolean `truncated` (AD-20) beside its own item list, and a reader must
   * never have to infer one shape from the other.
   */
  readonly truncated: boolean
  /**
   * Whether this text is byte-identical to what was last registered.
   *
   * `false` on the first assembly of a process (nothing is registered yet) and
   * `true` from the second identical one onwards, which is exactly the moment
   * "the prefix did not change" becomes true.
   */
  readonly prefixUnchanged: boolean
}

/** Options for {@link PromptComposer}. */
export interface PromptComposerOptions {
  /**
   * Raw identity text, as read from `assets/persona.md`.
   *
   * A function is accepted for one reason: with a fixed string the hash can never
   * differ inside one composer, so the "text changed, re-register" path would be
   * unreachable — and an unreachable branch is one no test can hold to account.
   * `runtime.ts` passes the text it loaded, which is what makes the identity
   * byte-stable across rounds (FR-15, I9).
   */
  readonly personaText: string | (() => string)
  /** Identity character budget (AD-7: 1200). */
  readonly personaMaxChars: number
  /** State-tail token budget (AD-7: 30). */
  readonly tailMaxTokens: number
  /** Recall item count used to derive the shared budget (AD-8: 5). */
  readonly topK?: number
  /** Estimated tokens one recalled item is budgeted for; derives the budget. */
  readonly recallItemBudgetTokens?: number
  /** Current tail inputs, evaluated on each assembly. Defaults to no tail. */
  readonly readState?: () => PersonaState | undefined
  /**
   * Current recall inputs, evaluated with this assembly's query (P0-1).
   *
   * The query comes from the recent conversation, so this is asked once per
   * assembly rather than once per mount. Absent means "no recall tier", which is
   * what a store that never came up looks like.
   */
  readonly readRecall?: (query: string) => readonly RecallItem[] | undefined
  /**
   * Called when a tier's reader throws, instead of letting the throw escape.
   *
   * The tier then contributes nothing. Reporting it is the caller's job because
   * only the caller knows where a log line goes; silent swallowing would hide a
   * broken store behind an empty prompt.
   */
  readonly onReaderFailure?: (tier: string, error: unknown) => void
  /**
   * Called once per assembly of the identity section, with the plan behind it.
   *
   * The host invokes the section provider on every assembly; that is the only
   * place a `session_id` exists, so it is where the audit row is produced (AD-20).
   * A throw here is caught and ignored: a bookkeeping failure must never cost the
   * prompt its identity (FR-15).
   * @param elapsedMs - wall time this assembly took, in milliseconds (P0-8's
   *   injection p50/p95 has no other source: only the provider sees both ends).
   */
  readonly onInject?: (plan: InjectionPlan, context: PromptAssemblyContext | undefined, elapsedMs: number) => void
}

/**
 * Normalize identity text for byte stability.
 *
 * Line endings are unified to `\n` and trailing whitespace on the whole block is
 * dropped, so the same file produces the same bytes on Windows and POSIX
 * checkouts. Nothing else is rewritten: the file is the source of truth.
 * @param raw - file contents.
 * @param maxChars - hard character budget.
 * @returns the normalized text and whether it was truncated.
 */
export function normalizePersona(raw: string, maxChars: number): { text: string; truncated: boolean } {
  const normalized = raw.replace(/\r\n?/gu, '\n').replace(/\s+$/u, '')
  // Count code points, not UTF-16 units, so a CJK budget is a character budget.
  const codePoints = [...normalized]
  if (codePoints.length <= maxChars) return { text: normalized, truncated: false }
  return { text: codePoints.slice(0, maxChars).join('').replace(/\s+$/u, ''), truncated: true }
}

/**
 * Estimate token count conservatively.
 *
 * A CJK character is one token, a run of Latin/digit characters is one token,
 * and any other non-space character is one token. This over-counts rather than
 * under-counts, which is the safe direction for a budget.
 * @param text - the text to measure.
 * @returns the estimated token count.
 */
export function estimateTokens(text: string): number {
  let tokens = 0
  let inWord = false
  for (const char of text) {
    if (/\s/u.test(char)) {
      inWord = false
      continue
    }
    if (/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/u.test(char)) {
      tokens += 1
      inWord = false
      continue
    }
    if (/[A-Za-z0-9_]/u.test(char)) {
      if (!inWord) tokens += 1
      inWord = true
      continue
    }
    tokens += 1
    inWord = false
  }
  return tokens
}

/** The tail segments in retention-priority order. */
const TAIL_SEGMENTS: readonly TailSegment[] = ['relationship', 'preference', 'flag']

/**
 * Plan the state tail within budget.
 *
 * Priority is relationship, then preference, then flag: the least important
 * segment is dropped first, and a segment is never cut mid-way (a half-sentence
 * about a relationship is worse than no sentence).
 * @param state - available segments.
 * @param maxTokens - token budget.
 * @returns what was kept, what was dropped, and the cost.
 */
export function planStateTail(state: PersonaState | undefined, maxTokens: number): TailPlan {
  if (state === undefined) {
    return { text: undefined, kept: [], dropped: [], chars: 0, tokens: 0, truncated: false }
  }
  // Two parallel lists: the names go out in the plan, the texts build the tail.
  // Mixing them in one array is how a caller ends up rendering "preference" as
  // if it were something the user said.
  const kept: TailSegment[] = []
  const keptTexts: string[] = []
  const dropped: TailSegment[] = []
  for (const field of TAIL_SEGMENTS) {
    const segment = state[field]?.trim()
    if (segment === undefined || segment.length === 0) continue
    const nextText = [...keptTexts, segment].join(' · ')
    // Everything after the first miss also misses: a dropped segment followed by
    // a kept one would silently promote the less important text.
    if (dropped.length > 0 || estimateTokens(nextText) > maxTokens) {
      dropped.push(field)
      continue
    }
    kept.push(field)
    keptTexts.push(segment)
  }
  const text = keptTexts.length === 0 ? undefined : keptTexts.join(' · ')
  return {
    text,
    kept,
    dropped,
    chars: text === undefined ? 0 : [...text].length,
    tokens: text === undefined ? 0 : estimateTokens(text),
    truncated: dropped.length > 0,
  }
}

/**
 * Compose the state tail within budget.
 *
 * Thin wrapper over {@link planStateTail} for callers that only want the text.
 * @param state - available segments.
 * @param maxTokens - token budget.
 * @returns the joined tail, or `undefined` when nothing fits or nothing is known.
 */
export function composeStateTail(state: PersonaState | undefined, maxTokens: number): string | undefined {
  return planStateTail(state, maxTokens).text
}

/** Which host channel a registration attempt was made on. */
export type HostChannel = 'section' | 'context' | 'recall'

/** How many characters of recent conversation become one recall query (P0-1). */
export const RECALL_QUERY_MAX_CHARS = 200

/**
 * Build a recall query from the recent conversation (P0-1).
 *
 * Newest first, joined until {@link RECALL_QUERY_MAX_CHARS}: the latest thing the
 * user said is what this turn is about, and older turns are context for it. Only
 * `user/message` counts — an assistant line is the model reading its own output
 * back, and a query built from it would recall what the plugin already said.
 *
 * Synchronous on purpose: this runs inside the identity provider, on the injection
 * path, where AD-7 allows 20 ms for `compose()` and nothing for a promise.
 * @param session - the host session, when the host supplied one.
 * @returns the query, or `undefined` when there is nothing to ask with.
 */
export function recallQueryFrom(session: PromptSessionLike | undefined): string | undefined {
  if (session?.ownEvents === undefined) return undefined
  let events: readonly PromptEventLike[]
  try {
    events = session.ownEvents()
  } catch {
    // A host that cannot enumerate its own log is a host that has nothing to
    // recall with; the tier contributes nothing and the prompt is unaffected.
    return undefined
  }
  const parts: string[] = []
  let used = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'user/message') continue
    const text = messageTextOf(event.data)
    if (text === undefined) continue
    if (used + text.length > RECALL_QUERY_MAX_CHARS && parts.length > 0) break
    parts.push(text.slice(0, RECALL_QUERY_MAX_CHARS - used))
    used += text.length
    if (used >= RECALL_QUERY_MAX_CHARS) break
  }
  if (parts.length === 0) return undefined
  return parts.reverse().join(' ')
}

/**
 * The text of one `user/message` payload.
 *
 * The host's message shape is `{ content: ContentBlock[] }`, and only `text`
 * blocks carry words a query could be built from.
 * @param data - the event's payload.
 * @returns the joined text, or `undefined` when it carries none.
 */
function messageTextOf(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const content = (data as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  const texts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string' && candidate.text.trim() !== '') {
      texts.push(candidate.text.trim())
    }
  }
  return texts.length === 0 ? undefined : texts.join(' ')
}

/** What {@link PromptComposer.register} produced. */
export interface RegisterOutcome {
  /** The full assembly decision, including the audit fields. */
  readonly plan: InjectionPlan
  /** The composed identity section (also on `plan`; kept for existing callers). */
  readonly persona: ComposedPersona
  /** Whether a new identity registration was made (false when the hash was unchanged). */
  readonly personaRegistered: boolean
  /** Whether a state tail was registered. */
  readonly tailRegistered: boolean
  /** Whether the recall context was registered this call (P0-1). */
  readonly recallRegistered: boolean
  /**
   * Host channels that threw, in the order they were tried.
   *
   * A refused registration is a degraded mount, not a failed one: the tail may
   * still land when the section did not, and the caller needs to know which
   * happened rather than receive a throw that hides the surviving half.
   */
  readonly failed: readonly HostChannel[]
  /** Release everything this call owns. */
  readonly dispose: () => void
}

/**
 * Owns the two injection channels and the three-tier budget.
 *
 * One instance per `apply` call. The hash cache is the mechanism behind
 * "unchanged text is not rewritten": registering the same bytes twice is a
 * no-op, not a re-registration.
 */
export class PromptComposer {
  readonly #options: PromptComposerOptions
  #personaRegistration: { hash: string; dispose: () => void } | undefined
  #tailRegistration: { text: string; plan: TailPlan; dispose: () => void } | undefined
  /** The recall context registration, when one landed (P0-1). */
  #recallRegistration: { dispose: () => void } | undefined
  /**
   * The recall text this assembly computed, replayed by the recall provider.
   *
   * Written by the identity provider (which runs first) and read by the recall
   * context's provider (order 131). Keeping the computation on the earlier side
   * is what lets the audit row describe the prompt the model actually receives.
   */
  #recallText: string | undefined
  readonly #onReaderFailure: ((tier: string, error: unknown) => void) | undefined
  readonly #onInject: ((plan: InjectionPlan, context: PromptAssemblyContext | undefined, elapsedMs: number) => void) | undefined
  /**
   * The plan the prompt actually carries, kept current by `register`.
   *
   * The identity section is a provider, so the host may render it at any moment,
   * including while `register()` is still running. Whatever the provider reports
   * has to be the prompt that exists, not the plan this iteration composed: a
   * refused tail registration leaves the previous tail in place, and a row that
   * described the composed tail would name text the model never saw (AD-20).
   */
  #livePlan: InjectionPlan | undefined

  //
  // The plan a registration call is currently offering the host. The provider
  // reads it while `systemPrompt.section()` runs, because a host may render the
  // section eagerly before that call returns; it is cleared once the attempt
  // settles, and only a successful one is promoted to `#livePlan`. Keeping the
  // two apart is what stops a refused replacement from changing the text the
  // host is still holding (AD-20: the row describes the prompt that was sent).
  //
  #offeredPlan: InjectionPlan | undefined

  /**
   * The tail this prompt actually carries, expressed as a tail plan.
   *
   * The tail the host renders is the *registered* string, which is not always the
   * tail this `compose()` produced: a host that refused the new context keeps
   * serving the old one. So the answer is built from the registration, and the
   * plan recorded alongside it, never from `plan.tail` alone.
   *
   * The tail plan travels with the text for one reason: `tier` says whether a tail
   * is present and `items` says which segments it carries, so a tail plan with
   * text but no segments would publish `identity+state` over an `items` list that
   * names no state. That combination cannot arise here because the plan and the
   * text are recorded together.
   *
   * @param plan - the plan this `register()` call composed.
   * @returns the tail plan that matches what is registered.
   */
  /**
   * Put the tail registration back the way it was before the current call.
   * @param systemPrompt - the host seam.
   * @param before - the registration this call replaced, if any.
   * @returns whether the prompt is back to that state.
   */
  #restoreTail(
    systemPrompt: SystemPromptLike,
    before: { text: string; plan: TailPlan; dispose: () => void } | undefined,
  ): boolean {
    this.#tailRegistration?.dispose()
    this.#tailRegistration = undefined
    if (before === undefined) return true
    try {
      const dispose = systemPrompt.context({
        name: PERSONA_STATE_CONTEXT_NAME,
        order: PERSONA_STATE_CONTEXT_ORDER,
        text: before.text,
      })
      this.#tailRegistration = { text: before.text, plan: before.plan, dispose }
      return true
    } catch {
      return false
    }
  }

  #registeredTail(plan: InjectionPlan): TailPlan {
    const registered = this.#tailRegistration
    if (registered === undefined) {
      return plan.tail.text === undefined
        ? plan.tail
        : { ...plan.tail, text: undefined, kept: [], chars: 0, tokens: 0 }
    }
    if (plan.tail.text === registered.text) return plan.tail
    return registered.plan
  }

  constructor(options: PromptComposerOptions) {
    this.#options = options
    this.#onReaderFailure = options.onReaderFailure
    this.#onInject = options.onInject
  }

  /**
   * Assemble all three tiers without touching the host.
   *
   * Retention priority is identity > state > recall, which shows up as *who loses*
   * when the shared budget binds: recall gives way first and completely, the tail
   * is bounded only by its own cap, and the identity section is bounded only by its
   * own character cap. Cutting the identity section to make room would break the
   * byte stability that the prefix cache depends on (FR-15, I9), so it never
   * yields to another tier.
   * @param query - this assembly's recall query; absent means "no recall tier",
   *   which is the mount-time plan and any assembly outside a session.
   * @returns the plan.
   */
  compose(query?: string): InjectionPlan {
    // Identity first, and it cannot fail: FR-15 says an unusable store must not
    // cost the prompt its identity, so nothing that reads the store may run
    // before this line or be allowed to throw past it.
    const persona = this.composePersona()
    const identityTokens = estimateTokens(persona.text)
    const tailCap = this.#options.tailMaxTokens
    const topK = this.#options.topK ?? DEFAULT_TOP_K
    const perItem = this.#options.recallItemBudgetTokens ?? RECALL_ITEM_BUDGET_TOKENS
    const recallCap = topK * perItem
    // The shared budget is the three caps added up, never a fourth number: AD-7
    // and NFR-9 bound each tier separately, and inventing a total would make this
    // implementation the only place that number exists.
    const budget = identityTokens + tailCap + recallCap
    const tail = planStateTail(this.#readOrNothing(this.#options.readState, 'state'), tailCap)
    const truncatedItems: TruncatedItem[] = []
    if (persona.truncated) truncatedItems.push('identity')
    for (const field of tail.dropped) truncatedItems.push(`state:${field}`)
    // Each tier guards its own cap. Recall is bounded by `recallCap` alone: an
    // unused tail does not hand its slack to recall, because that would make the
    // recall bound depend on the host's state and turn "each tier has a budget"
    // into "there is one pool split three ways". `tokens <= budget` still holds
    // without needing to be enforced: every tier is already inside its own cap.
    // The tier is always consulted; what varies with the assembly is the query it
    // is asked with. A mount-time plan passes `''`, and a reader that cannot use a
    // blank query answers "nothing" — which is exactly the old behaviour for a
    // mount, without a second code path deciding it here.
    const recalled = this.#readOrNothing(() => this.#options.readRecall?.(query ?? ''), 'recall') ?? []
    const kept: RecallItem[] = []
    let recallTokens = 0
    let recallChars = 0
    let overCount = 0
    let overBudget = 0
    // Ranked order is the caller's order, so the items that lose are always the
    // last ones: the loop stops at the first item that does not fit rather than
    // skipping it and admitting a smaller item from further down the list. The
    // two reasons stay apart — running past `topK` is the tier working, running
    // past the token pool is a cut, and only the second one is reported.
    for (const item of recalled) {
      if (kept.length >= topK) {
        overCount = recalled.length - kept.length
        break
      }
      const cost = estimateTokens(item.text)
      if (recallTokens + cost > recallCap) {
        overBudget = recalled.length - kept.length
        break
      }
      kept.push(item)
      recallTokens += cost
      recallChars += [...item.text].length
    }
    if (overBudget > 0) truncatedItems.push('recall')
    return {
      persona,
      tail,
      recall: {
        kept,
        chars: recallChars,
        overCount,
        overBudget,
        tokens: recallTokens,
        truncated: overBudget > 0,
      },
      identityTokens,
      budget,
      tokens: identityTokens + tail.tokens + recallTokens,
      truncatedItems,
      truncated: truncatedItems.length > 0,
      prefixUnchanged: this.#personaRegistration?.hash === persona.hash,
    }
  }

  /**
   * Evaluate a tier's reader, treating a failure as "nothing to say".
   *
   * A throwing reader is how an unusable store shows up here. Letting it escape
   * would abort the whole assembly — including the identity section that FR-15
   * requires to survive exactly that case — so the tier contributes nothing and
   * the rest of the plan is still composed.
   * @param reader - the tier's source, if it has one.
   * @param tier - which tier, used in the log line.
   * @returns the reader's value, or `undefined` when it threw or is absent.
   */
  #readOrNothing<T>(reader: (() => T | undefined) | undefined, tier: string): T | undefined {
    if (reader === undefined) return undefined
    try {
      return reader()
    } catch (error) {
      this.#onReaderFailure?.(tier, error)
      return undefined
    }
  }

  /** Compose the identity section without touching the host. */
  composePersona(): ComposedPersona {
    const source = this.#options.personaText
    const raw = typeof source === 'function' ? source() : source
    const { text, truncated } = normalizePersona(raw, this.#options.personaMaxChars)
    return {
      name: PERSONA_SECTION_NAME,
      order: PERSONA_SECTION_ORDER,
      text,
      hash: createHash('sha256').update(text, 'utf8').digest('hex'),
      chars: [...text].length,
      truncated,
    }
  }

  /**
   * Register the identity section and (when present) the state tail.
   * @param systemPrompt - the host seam.
   * @returns what was registered and how to undo it.
   */
  register(systemPrompt: SystemPromptLike): RegisterOutcome {
    const plan = this.compose()
    const { persona } = plan
    const failed: HostChannel[] = []
    //
    // The tail is registered before the identity section on purpose: the section
    // is a provider, and a host that renders registrations eagerly calls it
    // before this method returns. Registering the tail first means that very
    // first render already reports the prompt it is being asked to produce.
    //
    const tail = plan.tail.text
    const tailBefore = this.#tailRegistration
    let tailRegistered = false
    if (tail !== undefined && this.#tailRegistration?.text !== tail) {
      const previous = this.#tailRegistration
      try {
        const dispose = systemPrompt.context({
          name: PERSONA_STATE_CONTEXT_NAME,
          order: PERSONA_STATE_CONTEXT_ORDER,
          text: tail,
        })
        previous?.dispose()
        this.#tailRegistration = { text: tail, plan: plan.tail, dispose }
        tailRegistered = true
      } catch {
        failed.push('context')
      }
    } else if (tail === undefined && this.#tailRegistration !== undefined) {
      // "No state" means "no tail": leaving the old registration in place would
      // keep injecting a tail the current turn no longer supports.
      this.#tailRegistration.dispose()
      this.#tailRegistration = undefined
    }
    const nextPlan = { ...plan, tail: this.#registeredTail(plan) }
    const tailsDiffer = this.#tailRegistration !== tailBefore
    let personaRegistered = false
    let personaRefused = false
    if (this.#personaRegistration?.hash !== persona.hash) {
      // The old registration is only released once the new call succeeded: a host
      // that refuses the replacement must not cost the prompt the section it has.
      const previous = this.#personaRegistration
      this.#offeredPlan = nextPlan
      try {
        const dispose = systemPrompt.section({
          name: PERSONA_SECTION_NAME,
          order: PERSONA_SECTION_ORDER,
          //
          // A provider, not a string: the host calls it once per assembly and
          // hands over the only `session_id` this plugin ever sees. The plan it
          // reports is the plan whose text it returns, so an audit row can never
          // describe a prompt that was not sent (AD-20).
          //
          // It replays the registered plan instead of composing again: composing
          // here would read the state store on the injection path, which this
          // story forbids, and would report a tail the host may never receive.
          //
          text: (context?: PromptAssemblyContext) => {
            const started = performance.now()
            // Recall first, and it must be here rather than in the recall
            // context's own provider: the host renders sections in ascending
            // order, so this provider (order -1000) runs *before* the recall
            // context (order 131). Computing there would mean the audit row
            // below reports a plan with no recall while the prompt carries it —
            // the one mismatch AD-20 forbids. So the answer is computed once,
            // here, and the recall provider only replays it.
            const query = recallQueryFrom(context?.session)
            const assembled = query === undefined
              ? (this.#offeredPlan ?? this.#livePlan ?? plan)
              : this.compose(query)
            const recallText = assembled.recall.kept.length === 0
              ? undefined
              : assembled.recall.kept.map(item => item.text).join('\n')
            this.#recallText = recallText
            try {
              this.#onInject?.(assembled, context, Math.round(performance.now() - started))
            } catch {
              // Bookkeeping failure must never cost the prompt its identity.
              //
              // Deliberately silent as well as deliberately swallowing: the
              // composer is given one callback and has no logger, so the
              // mounting side is where the warning belongs. `runtime` wraps
              // this callback and logs `OMW_AUDIT_WRITE_FAILED`; this catch is
              // the guard for the case where it does not, which is why the two
              // layers are not redundant.
            }
            return assembled.persona.text
          },
        })
        previous?.dispose()
        this.#personaRegistration = { hash: persona.hash, dispose }
        personaRegistered = true
      } catch {
        personaRefused = true
        failed.push('section')
        // The rejected section and the tail accepted above would otherwise
        // disagree: the host would assemble the new tail around the old identity
        // and the row would describe a prompt nobody was sent. Undo the tail too,
        // so a refused registration leaves the prompt exactly as it was.
        if (tailsDiffer) {
          if (!this.#restoreTail(systemPrompt, tailBefore)) failed.push('context')
        }
      } finally {
        this.#offeredPlan = undefined
      }
    }
    if (!personaRefused) this.#livePlan = nextPlan
    //
    // The recall context is registered last and only once: its provider replays
    // whatever the identity provider computed for this assembly (order 131 runs
    // after order -1000), so the registration itself carries no text and never
    // needs replacing. A host that refuses it costs the plugin its recall tier
    // and nothing else (AD-18).
    //
    let recallRegistered = false
    if (this.#recallRegistration === undefined) {
      try {
        const dispose = systemPrompt.context({
          name: RECALL_CONTEXT_NAME,
          order: RECALL_CONTEXT_ORDER,
          text: (): string => this.#recallText ?? '',
        })
        this.#recallRegistration = { dispose }
        recallRegistered = true
      } catch {
        failed.push('recall')
      }
    }
    return {
      plan,
      persona,
      personaRegistered,
      tailRegistered,
      recallRegistered,
      failed,
      dispose: () => this.dispose(),
    }
  }
  /** Whether an identity registration is currently live. */
  get hasSection(): boolean {
    return this.#personaRegistration !== undefined
  }

  /** Release both registrations. Idempotent. */
  dispose(): void {
    this.#personaRegistration?.dispose()
    this.#personaRegistration = undefined
    this.#tailRegistration?.dispose()
    this.#tailRegistration = undefined
    this.#recallRegistration?.dispose()
    this.#recallRegistration = undefined
  }
}