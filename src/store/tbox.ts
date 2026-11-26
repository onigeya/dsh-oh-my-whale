/**
 * The predicate registry: names, seeds and the daily cap (AD-27).
 *
 * Predicates are data, not code. Ten of them ship with the installation; a
 * model may propose a new one (always `multi`, always `candidate`); only a user
 * command can promote a predicate to `single`. Nothing here reads the store —
 * the registry *contents* arrive through `store/commits/assertions.ts`.
 * @module
 */
import { predicateMemKey } from './templates/assertions.ts'

/**
 * Version of the normalisation algorithm that produced `obj_norm`.
 *
 * Stored on every node whose key carries a normalised value. Changing the
 * algorithm without bumping this would silently change the identity of keys
 * already written, so a re-key is an explicit operation, never a side effect.
 * The store owns the number because it is part of the payload shape.
 */
export const NORM_VERSION = 1

/** Longest accepted predicate name, in characters. */
export const PREDICATE_NAME_MAX_LENGTH = 40

/** Lower-case snake case: a name that survives a `mem_key` unchanged. */
export const PREDICATE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/

/** Prefix reserved for the plugin's own keys; a user predicate may not claim it. */
export const RESERVED_PREDICATE_PREFIX = 'omw_'

/** How many objects one predicate may carry. */
export type PredicateCardinality = 'single' | 'multi'

/** One shipped predicate and its cardinality (data-model §5). */
export interface SeedPredicate {
  readonly name: string
  readonly cardinality: PredicateCardinality
}

/**
 * The ten predicates every installation starts with.
 *
 * Order is the insertion order of the bootstrap transaction, and therefore the
 * order `pending` shows in a snapshot taken right after installation.
 */
export const SEED_PREDICATES: readonly SeedPredicate[] = [
  { name: 'name', cardinality: 'single' },
  { name: 'lives_in', cardinality: 'single' },
  { name: 'works_at', cardinality: 'single' },
  { name: 'birthday', cardinality: 'single' },
  { name: 'timezone', cardinality: 'single' },
  { name: 'prefers_tone', cardinality: 'single' },
  { name: 'likes', cardinality: 'multi' },
  { name: 'dislikes', cardinality: 'multi' },
  { name: 'knows', cardinality: 'multi' },
  { name: 'avoids_topic', cardinality: 'multi' },
]

/** Outcome of checking a predicate name. */
export type PredicateNameCheck =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly reason: string }

/**
 * Validate a predicate name.
 *
 * A name is part of a business key, so it is checked before anything is
 * planned: an empty name, a 41-character name, a capitalised name or one
 * claiming the `omw_` prefix rejects the whole patch table.
 * @param raw - the name as the caller supplied it.
 * @returns the accepted name, or why it cannot be one.
 */
export function checkPredicateName(raw: unknown): PredicateNameCheck {
  if (typeof raw !== 'string') return { ok: false, reason: `pred 必须是字符串（收到 ${typeof raw}）` }
  const name = raw.trim()
  if (name === '') return { ok: false, reason: 'pred 为空' }
  if ([...name].length > PREDICATE_NAME_MAX_LENGTH) {
    return { ok: false, reason: `pred 超过 ${PREDICATE_NAME_MAX_LENGTH} 个字符：${name}` }
  }
  if (!PREDICATE_NAME_PATTERN.test(name)) {
    return { ok: false, reason: `pred 必须是小写蛇形（^[a-z][a-z0-9_]*$）：${name}` }
  }
  if (name.startsWith(RESERVED_PREDICATE_PREFIX)) {
    return { ok: false, reason: `pred 不能使用保留前缀 ${RESERVED_PREDICATE_PREFIX}：${name}` }
  }
  return { ok: true, name }
}

/**
 * The instant the local calendar day containing `now` started.
 *
 * The daily new-predicate cap is a human-facing budget, so it resets at the
 * user's midnight rather than at UTC midnight.
 * @param now - the instant to place.
 * @returns the local midnight as an ISO-8601 UTC instant.
 */
export function startOfLocalDayIso(now: Date): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
}

/** Payload of one registry entry, as data-model §3 fixes it. */
export interface PredicatePayloadInput {
  readonly name: string
  readonly cardinality: PredicateCardinality
  readonly status: 'active' | 'candidate' | 'deprecated'
  readonly aliases: readonly string[]
  readonly decidedBy: 'user' | 'seed' | 'model'
  readonly decidedAt: string
  readonly normVersion: number
  readonly activeSlot: number
  readonly recordedAt: string
  readonly validFrom: string
}

/**
 * Build one `pred` node payload.
 *
 * Every field is written, including the empty alias list: a reader that sees
 * `aliases: []` knows the predicate has none, while a missing field would be
 * indistinguishable from an older node written before aliases existed.
 * @param input - the registry entry to serialise.
 * @returns the payload; `undefined` never appears in it.
 */
export function buildPredicatePayload(input: PredicatePayloadInput): Record<string, unknown> {
  return {
    kind: 'pred',
    mem_key: predicateMemKey(input.name),
    pred: input.name,
    cardinality: input.cardinality,
    status: input.status,
    aliases: [...input.aliases],
    decided_by: input.decidedBy,
    decided_at: input.decidedAt,
    norm_version: input.normVersion,
    active_slot: input.activeSlot,
    valid_from: input.validFrom,
    recorded_at: input.recordedAt,
  }
}

/** Business key of the registry entry for one predicate name. */
export { predicateMemKey } from './templates/assertions.ts'
