/**
 * Which stored nodes a read path may return.
 *
 * AD-8 asks that the unpublished-only filter be constructed in exactly one place
 * and names `store/filters.ts`; the gate that shipped with Story 2.3 says the TQL
 * spelling `superseded_at: {$exists: false}` may only appear under
 * `store/templates/`. Both hold here: this module owns the *meaning* of live and
 * searchable as plain predicates over a payload, and the template owns the one
 * string the engine parses. `test/store/filters.test.ts` pins them together — the
 * same payloads must get the same verdict from `isLive` and from the query.
 *
 * The rule that a second copy drifts is not theoretical: before this module the
 * scan in `store/search.ts` applied neither predicate, so a superseded value and
 * its replacement both came back.
 * @module
 */

/**
 * Node kinds a recall never returns.
 *
 * The list is the complement of the six kinds that carry a memory a user can ask
 * about (assertion, entity, episode, scene, pref, persona_state). Each exclusion
 * has its own reason, so the set is written out rather than derived by negation —
 * a new kind has to be classified on purpose, and the default for an unknown kind
 * stays "searchable" so a new memory kind is not silently unreachable.
 *
 * - `evidence`: a pointer is reached through the assertion it supports (AD-6 keeps
 *   the edge as the only way in), and its text is a quotation of a host event, not
 *   one of our memories. Returning it would put the same sentence in the answer
 *   twice and move a quoted message onto a read path without the export rule
 *   (FR-24).
 * - `pred`: the registry of predicates is vocabulary, not memory. data-model §5
 *   says it enters neither injection nor recall, and is exported as a lexicon
 *   section instead (AD-27).
 * - `decision`, `dream_log`, `rejected`, `dream_cycle`: append-only ledgers. They
 *   describe *that* something changed, never the thing itself, and they are the
 *   only nodes that are never revoked (AD-21). A reason string in a decision is
 *   prose about an edit, and matching a query against it reports a debuggable
 *   record as if it were a memory.
 * - `flag`: a governance queue (`status=open` asks a human to look), not an
 *   answer. Flags reach the user through the queue and the injection tail
 *   (AD-7), not through recall.
 * - `whatif`: v1 creates the kind and generates none; a counterfactual that does
 *   exist was never asserted, so it cannot be recalled as one.
 */
const UNSEARCHABLE_KINDS: ReadonlySet<string> = new Set([
  'evidence',
  'pred',
  'decision',
  'dream_log',
  'rejected',
  'dream_cycle',
  'flag',
  'whatif',
])

/**
 * Whether a version is the current one.
 *
 * Retirement writes a millisecond timestamp into `superseded_at`; the field is
 * absent, never null, on a live version (data-model §1). Absence is therefore the
 * test, and a payload that carries the key at all is retired no matter what the
 * value is — that includes `superseded_at: 0`, which a truthiness check would
 * have read as live.
 * @param payload - the stored node payload.
 * @returns true when this version is still the current one.
 */
export function isLive(payload: Readonly<Record<string, unknown>>): boolean {
  return !Object.hasOwn(payload, 'superseded_at')
}

/**
 * Whether a payload may appear as a recall hit.
 *
 * Two conditions, and they are separate questions: an expired version is history
 * that a history read may still show, while a ledger row or a pointer is not a
 * memory at all. Folding them into one boolean would make `/omw history` unable to
 * reuse the kind rule.
 * @param payload - the stored node payload.
 * @returns true when recall may return this node.
 */
export function isSearchable(payload: Readonly<Record<string, unknown>>): boolean {
  const kind = payload['kind']
  if (typeof kind === 'string' && UNSEARCHABLE_KINDS.has(kind)) return false
  return true
}

/**
 * The business key a hit is reported under.
 *
 * Recall answers in business keys, never node ids (AR-4). A node without one is
 * not reported at all: a hit the caller cannot name is a hit it cannot ask about
 * afterwards, and `mem_key` is the only identity the tool surface exposes.
 * @param payload - the stored node payload.
 * @returns the key, or `undefined` when the node has none.
 */
export function memKeyOf(payload: Readonly<Record<string, unknown>>): string | undefined {
  const key = payload['mem_key']
  // A key of nothing but whitespace is not an identity: it would be reported as
  // a hit the caller cannot name, and two such nodes would look like one memory.
  return typeof key === 'string' && key.trim().length > 0 ? key : undefined
}
