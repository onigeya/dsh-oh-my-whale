/**
 * The recall read path: validate, score, cut twice, report.
 *
 * Order matters and is the whole contract. A call that is out of bounds is
 * refused before the store is touched, so "no query ran" is a property of the
 * code rather than something a test has to hope for (AC②). The two cuts are
 * different questions: the candidate pool bounds how much a future reranker may
 * see, the result count bounds what reaches the model. Before this story the
 * second `recall.candidatePool` key existed in the configuration and nothing
 * read it.
 *
 * Read-only by construction, not by discipline: nothing here holds a write
 * capability. The handle it is given is the shared read handle, and every
 * statement it can reach is a `FIND`.
 * @module
 */
import { checkRecallBounds, checkRecallQuery } from '../core/recall.ts'
import { DEGRADED_REASONS, type DegradedReason } from '../core/degrade.ts'
import { E_OK, sanitizeEngineText } from '../core/tool-errors.ts'
import { isSearchable, isLive, memKeyOf } from '../store/filters.ts'
import { createTextSearch, type TextHit } from '../store/search.ts'
import { createRecallTemplates } from '../store/templates/recall.ts'
import type { Database } from '../store/db.ts'

/** One memory a recall returns. */
export interface RecallItem {
  /** Business identity; the only thing a caller may quote back to us (AR-4). */
  readonly mem_key: string
  /** Node kind, so a caller can tell an assertion from a preference. */
  readonly kind: string
  /** The most specific value the payload carries, for display. */
  readonly value: string
}

/** The answer a recall tool returns, refused or not. */
export interface RecallAnswer {
  readonly ok: boolean
  /** Closed tool code: `E_OK`, `E_BOUNDARY` or `E_GATE_DOWN`. */
  readonly code: string
  /** One line a model may read aloud. */
  readonly message: string
  /** The result count that was applied. */
  readonly top_k: number
  /** The candidate pool that was applied. */
  readonly candidate_pool: number
  /** How many live, nameable hits entered the candidate pool. */
  readonly candidates: number
  /** How many live, searchable, nameable memories matched before either cut. */
  readonly matched: number
  /** The memories, best first, at most `top_k`. */
  readonly hits: readonly RecallItem[]
  /** Wall-clock duration of this call, whole milliseconds. */
  readonly elapsed_ms: number
  /** Whether anything was degraded; always false until Epic 5 adds reranking. */
  readonly degraded: boolean
  /** Empty when nothing degraded; members come from the closed sixth-value list. */
  readonly degraded_reason: readonly DegradedReason[]
}

/** What a recall needs to run. */
export interface RecallReaderDeps {
  /** An open handle; read-only handles are fine and are the point. */
  readonly db: Database
  /** Configured result count (`recall.topK`); the per-call argument overrides it. */
  readonly topK: number
  /** Configured candidate pool (`recall.candidatePool`), already bounded by config. */
  readonly candidatePool: number
  /**
   * Clock in milliseconds, injected so the timing can be asserted.
   *
   * `elapsed_ms` is part of the answer contract (AC⑥), and a number a test can
   * only check for being non-negative is a number nobody checks. Defaults to
   * `performance.now`, so no caller has to supply one.
   */
  readonly now?: () => number
}

/** The recall seam. */
export interface RecallReader {
  /**
   * Answer one recall.
   * @param query - free text; blank is refused.
   * @param topK - optional per-call count; out-of-range is refused, never clamped.
   * @returns the answer; a refusal carries a code and an empty hit list.
   */
  recall(query: unknown, topK?: unknown): RecallAnswer
  /**
   * Stop answering. Safe to call twice.
   *
   * It flips a flag and nothing else: the database handle belongs to the
   * runtime, which closes it on its own schedule after disposing every reader.
   * Closing it here would take the store out from under the writers still
   * draining, so this deliberately does not.
   */
  dispose(): void
}

/**
 * Build the recall reader.
 * @param deps - handle plus the two configured widths.
 * @returns the reader; call `dispose()` when the runtime closes.
 */
export function createRecallReader(deps: RecallReaderDeps): RecallReader {
  const templates = createRecallTemplates(deps.db)
  const search = createTextSearch(templates)
  const clock = deps.now ?? (() => performance.now())
  let disposed = false

  return {
    recall(query: unknown, topK?: unknown): RecallAnswer {
      const started = clock()
      // A call that omits the count means the configured one, not five. The
      // configuration is the operator's decision and the argument is the
      // caller's override; passing undefined straight through would leave
      // recall.topK a setting nothing reads, which is the same bug this story
      // fixes one level down for candidatePool.
      const bounds = checkRecallBounds(topK === undefined ? deps.topK : topK)
      if (!bounds.ok) {
        return refuse('E_BOUNDARY', bounds.reason, deps, started, clock)
      }
      const text = checkRecallQuery(query)
      if (!text.ok) {
        return refuse('E_BOUNDARY', text.reason, deps, started, clock)
      }
      if (disposed) {
        return refuse('E_GATE_DOWN', '记忆库已关闭，本次没有召回任何东西。', deps, started, clock)
      }
      try {
        return answer(text.value, bounds.value, deps, search, started, clock)
      } catch (error) {
        // The disposed flag above only knows about this reader. The handle it
        // reads through belongs to the runtime, so a closed database arrives
        // here as a throw from the engine. That is still 'the store is down',
        // and the I/O matrix promises a refusal for it, not a stack trace in
        // the host's tool result (AD-25 E_GATE_DOWN).
        const detail = error instanceof Error ? error.message : String(error)
        return refuse(
          'E_GATE_DOWN',
          `记忆库不可读，本次没有召回任何东西：${sanitizeEngineText(detail)}`,
          deps,
          started,
          clock,
        )
      }
    },
    dispose(): void {
      disposed = true
    },
  }
}

/**
 * A refusal: no hits, nothing read, and the widths still reported.
 *
 * The widths are echoed even here because they are the context of the refusal:
 * "topK 最多为 8" reads differently when the caller can see the pool it would
 * have drawn from. They are the *configured* widths, not the rejected argument —
 * a caller that asked for 9 still sees `top_k: 5`, and the message is what says
 * 9 was refused. Nothing was clamped, so nothing here may look like a result.
 * @param code - `E_BOUNDARY` or `E_GATE_DOWN`.
 * @param message - the reason, already in the user's language.
 * @param deps - the configured widths.
 * @param started - the call's start time.
 * @param clock - the injected clock, so a refusal's timing is assertable too.
 * @returns an answer with no hits.
 */
function refuse(
  code: string,
  message: string,
  deps: RecallReaderDeps,
  started: number,
  clock: () => number,
): RecallAnswer {
  return {
    ok: false,
    code,
    message,
    top_k: deps.topK,
    candidate_pool: deps.candidatePool,
    candidates: 0,
    matched: 0,
    hits: [],
    elapsed_ms: Math.round(clock() - started),
    degraded: false,
    degraded_reason: [],
  }
}

/**
 * Run the accepted call: score, cut to the pool, cut to the count, report.
 * @param query - the validated query text.
 * @param topK - the validated result count.
 * @param deps - the configured widths.
 * @param search - the prepared searcher.
 * @param started - the call's start time.
 * @param clock - the injected clock.
 * @returns the answer.
 */
function answer(
  query: string,
  topK: number,
  deps: RecallReaderDeps,
  search: ReturnType<typeof createTextSearch>,
  started: number,
  clock: () => number,
): RecallAnswer {
  const found = search.search(query)
  const ranked = rank(found.hits)
  // No `Math.max(pool, 1)` here: the configuration is validated where it is
  // loaded (`recallSchema` bounds it at 1..MAX_CANDIDATE_POOL), so a value that
  // needed clamping could only arrive from a caller that bypassed the schema.
  // Silently repairing it would hide exactly that.
  const pool = ranked.slice(0, deps.candidatePool)
  const kept = pool.slice(0, topK)
  return {
    ok: true,
    code: E_OK,
    // `ranked.length`, not `found.hits.length`: the sentence tells the caller how
    // many memories matched, and a node with no business key or a ledger row is
    // not a memory it can ask about. Counting those produced the contradiction
    // 「找到 1 条…返回前 0 条」for a store that held nothing recallable.
    message: describe(kept.length, pool.length, ranked.length),
    top_k: topK,
    candidate_pool: deps.candidatePool,
    candidates: pool.length,
    matched: ranked.length,
    hits: kept.map(toItem),
    elapsed_ms: Math.round(clock() - started),
    degraded: false,
    degraded_reason: [],
  }
}

/**
 * Drop hits recall may not return at all.
 *
 * Three drops. A retired version is history, and a recall answers with the
 * current truth (AC①); the template already filters those, so this is defence
 * against a template that stops doing it. A searchable-only filter keeps ledger
 * rows and pointers out even if the searcher is ever asked for them directly.
 * A node without a business key is dropped because a caller cannot ask about it
 * again — `mem_key` is the only identity the tool surface exposes.
 *
 * `matched` counts what survives all three, so the sentence a model reads never
 * claims more memories than it was given.
 * @param hits - scored hits, best first.
 * @returns the hits that survive.
 */
function rank(hits: readonly TextHit[]): TextHit[] {
  return hits.filter(hit => isLive(hit.payload) && isSearchable(hit.payload) && memKeyOf(hit.payload) !== undefined)
}

/**
 * One hit as the tool surface reports it.
 *
 * `value` is a display string, not a re-serialisation of the payload: an
 * assertion keeps its object in `obj`, a preference its target in `value`, a
 * scene its text in `text`. A payload with none of those still deserves a line,
 * so it falls back to the business key's last segment rather than to JSON.
 * @param hit - one surviving hit.
 * @returns the item.
 */
function toItem(hit: TextHit): RecallItem {
  const payload = hit.payload
  const kind = typeof payload['kind'] === 'string' ? payload['kind'] : 'unknown'
  return {
    mem_key: memKeyOf(payload) ?? '',
    kind,
    value: displayValue(payload),
  }
}

/**
 * The payload fields that carry what a memory actually says, best first.
 *
 * One list rather than a per-kind switch, because every memory kind puts its
 * content in whichever field its own shape calls for (data-model §3): an
 * assertion in `obj`, a preference in `value`, an entity or scene in `name`, an
 * episode in `summary`. A reader that only knew `obj` would answer an episode
 * with the last segment of its key — a hit whose value is the word `whale` says
 * nothing about what was remembered.
 *
 * `title` before `summary` and `name` before `description`: when a node carries
 * both, the shorter one is the label and the longer one is the body, and the
 * tool answer is a list item, not a page.
 */
const DISPLAY_FIELDS = ['obj', 'value', 'name', 'title', 'summary', 'description', 'text', 'detail', 'reason']

/**
 * The most specific displayable value in a payload.
 * @param payload - a hit's payload.
 * @returns a short string, never empty.
 */
function displayValue(payload: Readonly<Record<string, unknown>>): string {
  for (const field of DISPLAY_FIELDS) {
    const raw = payload[field]
    if (typeof raw === 'string' && raw.trim().length > 0) return raw
  }
  const key = memKeyOf(payload)
  if (key === undefined) return ''
  const segments = key.split(':')
  return segments[segments.length - 1] ?? key
}

/**
 * One sentence describing what came back.
 *
 * It names both cuts when the pool ran out, because "5 results" alone cannot
 * tell a caller whether the store held five or five hundred.
 * @param kept - how many hits are returned.
 * @param pooled - how many entered the pool.
 * @param matched - how many live nodes matched at all.
 * @returns the sentence.
 */
function describe(kept: number, pooled: number, matched: number): string {
  if (matched === 0) return '没有找到匹配的未失效记忆。'
  if (kept === matched) return `找到 ${matched} 条未失效记忆，全部返回。`
  const poolNote = pooled < matched ? `，其中 ${pooled} 条进入候选池` : ''
  return `找到 ${matched} 条未失效记忆${poolNote}，返回前 ${kept} 条。`
}

/**
 * The closed vocabulary as a runtime list, for callers that must validate one.
 * Re-exported rather than duplicated so the six values have one source (AD-20).
 */
export const RECALL_DEGRADED_REASONS: readonly DegradedReason[] = DEGRADED_REASONS
