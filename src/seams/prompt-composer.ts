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
 * @module
 */
import { createHash } from 'node:crypto'

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

/** The two host calls this module is allowed to make. */
export interface SystemPromptLike {
  /** Register a system section; returns the disposer. */
  section(section: { name: string; order: number; text: string | (() => string) }): () => void
  /** Register a runtime-context contribution; returns the disposer. */
  context(context: { name: string; order: number; text: string | (() => string) }): () => void
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
  /** Whether the source exceeded the character budget and was cut. */
  readonly truncated: boolean
}

/** Options for {@link PromptComposer}. */
export interface PromptComposerOptions {
  /** Raw identity text, as read from `assets/persona.md`. */
  readonly personaText: string
  /** Identity character budget (AD-7: 1200). */
  readonly personaMaxChars: number
  /** State-tail token budget (AD-7: 30). */
  readonly tailMaxTokens: number
  /** Current tail inputs, evaluated on each registration. Defaults to no tail. */
  readonly readState?: () => PersonaState | undefined
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

/**
 * Compose the state tail within budget.
 *
 * Priority is relationship, then preference, then flag: the least important
 * segment is dropped first, and a segment is never cut mid-way (a half-sentence
 * about a relationship is worse than no sentence).
 * @param state - available segments.
 * @param maxTokens - token budget.
 * @returns the joined tail, or `undefined` when nothing fits or nothing is known.
 */
export function composeStateTail(state: PersonaState | undefined, maxTokens: number): string | undefined {
  if (state === undefined) return undefined
  const segments = [state.relationship, state.preference, state.flag]
    .map(segment => segment?.trim())
    .filter((segment): segment is string => segment !== undefined && segment.length > 0)
  const kept: string[] = []
  for (const segment of segments) {
    if (estimateTokens([...kept, segment].join(' · ')) > maxTokens) break
    kept.push(segment)
  }
  return kept.length === 0 ? undefined : kept.join(' · ')
}

/** What {@link PromptComposer.register} produced. */
export interface RegisterOutcome {
  /** The composed identity section. */
  readonly persona: ComposedPersona
  /** Whether the host was actually asked to register (false when the hash was unchanged). */
  readonly personaRegistered: boolean
  /** Whether a state tail was registered. */
  readonly tailRegistered: boolean
  /** Release everything this call owns. */
  readonly dispose: () => void
}

/**
 * Owns the two injection channels.
 *
 * One instance per `apply` call. The hash cache is the mechanism behind
 * "unchanged text is not rewritten": registering the same bytes twice is a
 * no-op, not a re-registration.
 */
export class PromptComposer {
  readonly #options: PromptComposerOptions
  #personaRegistration: { hash: string; dispose: () => void } | undefined
  #tailRegistration: { text: string; dispose: () => void } | undefined

  constructor(options: PromptComposerOptions) {
    this.#options = options
  }

  /** Compose the identity section without touching the host. */
  composePersona(): ComposedPersona {
    const { text, truncated } = normalizePersona(this.#options.personaText, this.#options.personaMaxChars)
    return {
      name: PERSONA_SECTION_NAME,
      order: PERSONA_SECTION_ORDER,
      text,
      hash: createHash('sha256').update(text, 'utf8').digest('hex'),
      truncated,
    }
  }

  /**
   * Register the identity section and (when present) the state tail.
   * @param systemPrompt - the host seam.
   * @returns what was registered and how to undo it.
   */
  register(systemPrompt: SystemPromptLike): RegisterOutcome {
    const persona = this.composePersona()
    let personaRegistered = false
    if (this.#personaRegistration?.hash !== persona.hash) {
      this.#personaRegistration?.dispose()
      this.#personaRegistration = {
        hash: persona.hash,
        dispose: systemPrompt.section({
          name: PERSONA_SECTION_NAME,
          order: PERSONA_SECTION_ORDER,
          text: persona.text,
        }),
      }
      personaRegistered = true
    }
    const tail = composeStateTail(this.#options.readState?.(), this.#options.tailMaxTokens)
    let tailRegistered = false
    if (tail !== undefined && this.#tailRegistration?.text !== tail) {
      this.#tailRegistration?.dispose()
      this.#tailRegistration = {
        text: tail,
        dispose: systemPrompt.context({
          name: PERSONA_STATE_CONTEXT_NAME,
          order: PERSONA_STATE_CONTEXT_ORDER,
          text: tail,
        }),
      }
      tailRegistered = true
    } else if (tail === undefined && this.#tailRegistration !== undefined) {
      // "No state" means "no tail": leaving the old registration in place would
      // keep injecting a tail the current turn no longer supports.
      this.#tailRegistration.dispose()
      this.#tailRegistration = undefined
    }
    return {
      persona,
      personaRegistered,
      tailRegistered,
      dispose: () => this.dispose(),
    }
  }

  /** Release both registrations. Idempotent. */
  dispose(): void {
    this.#personaRegistration?.dispose()
    this.#personaRegistration = undefined
    this.#tailRegistration?.dispose()
    this.#tailRegistration = undefined
  }
}
