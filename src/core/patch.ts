/**
 * The patch table: the only shape a write may take (AD-3, AD-4, AD-8).
 *
 * A patch table is *planned*, never partially applied. Planning reads the live
 * store through injected lookups and returns the complete list of writes, or the
 * single reason to refuse the table; the caller commits all of it in one
 * transaction, so an illegal op anywhere leaves every earlier op unapplied.
 *
 * Identity lives in `mem_key` alone: `<kind>:<subj>:<pred>` for a single-valued
 * predicate and `<kind>:<subj>:<pred>:<obj_norm>` for a multi-valued one. The
 * value therefore re-keys a multi-valued memory and versions a single-valued one,
 * which is what keeps 2.3's version chain reachable.
 * @module
 */
import { z } from 'zod'
import {
  NORM_VERSION,
  buildPredicatePayload,
  checkPredicateName,
  predicateMemKey,
  type PredicateCardinality,
} from '../store/tbox.ts'
import type { StoredNode } from '../store/templates/assertions.ts'
import type { DecisionKind } from './decisions.ts'

/** Every kind a patch op may assert. */
export const ASSERTABLE_KINDS = ['assertion', 'pref', 'persona_state'] as const

/** One assertable kind. */
export type AssertableKind = (typeof ASSERTABLE_KINDS)[number]

/** Longest accepted subject or object, in code points (an emoji counts once). */
export const TEXT_MAX_CODE_POINTS = 200

/** Most ops one patch table may carry. */
export const PATCH_TABLE_MAX_OPS = 50

/** Version of the normalisation algorithm written into every payload. */
export { NORM_VERSION }

/** Version of the prompt that produced a tool write. */
export const WRITE_PROMPT_VERSION = 'omw-write/2.1'

/** 2.1 records observations only; inference arrives with Epic 4. */
export const WRITE_ORIGIN = 'observed'

/** Control characters a business key may never carry. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/u

/**
 * Normalise an object for identity (norm_version 1).
 *
 * NFKC, then lower case, then every punctuation and symbol becomes a space, then
 * runs of whitespace collapse, then trim. `C++` and `C#` therefore share an
 * identity: the difference is a symbol, and a symbol is not a meaning here. That
 * is deliberate — changing the algorithm must bump {@link NORM_VERSION} and go
 * through `ops/rekey`.
 * @param text - the object as the caller supplied it.
 * @returns the normalised object, possibly empty.
 */
export function normalizeObjectText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Length of a string in code points.
 *
 * `'👍'.length` is 2 while `'👍'` is one character to a reader; the 200 limit is
 * a human-facing budget, so it counts what a reader sees.
 * @param text - any string.
 * @returns the number of code points.
 */
export function codePointLength(text: string): number {
  return [...text].length
}

/** Outcome of checking one text field of an op. */
export type TextCheck =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string }

/**
 * Validate an assertion subject.
 *
 * The subject is spliced into a business key, so it must not be able to forge a
 * segment boundary: `:` is rejected, as are control characters, an empty value
 * and anything longer than {@link TEXT_MAX_CODE_POINTS}. Case is significant —
 * `Elliott` and `elliott` are two people.
 * @param raw - the subject as the caller supplied it.
 * @returns the trimmed subject, or why it cannot be one.
 */
export function checkSubject(raw: string): TextCheck {
  const text = raw.trim()
  if (text === '') return { ok: false, reason: 'subj 为空' }
  if (text.includes(':')) return { ok: false, reason: "subj 不能包含 ':'" }
  if (CONTROL_CHARS.test(text)) return { ok: false, reason: 'subj 含控制字符' }
  if (codePointLength(text) > TEXT_MAX_CODE_POINTS) {
    return { ok: false, reason: `subj 超过 ${TEXT_MAX_CODE_POINTS} 码点` }
  }
  return { ok: true, text }
}

/**
 * Validate an assertion object.
 *
 * Same rules as {@link checkSubject} minus the colon rule — an object is the last
 * segment of a multi-valued key, so a colon inside it would still forge a
 * boundary. A value that normalises to nothing cannot be recalled, so it is
 * refused rather than stored.
 * @param raw - the object as the caller supplied it.
 * @returns the trimmed object, or why it cannot be one.
 */
export function checkObject(raw: string): TextCheck {
  const text = raw.trim()
  if (text === '') return { ok: false, reason: 'obj 为空' }
  if (text.includes(':')) return { ok: false, reason: "obj 不能包含 ':'" }
  if (CONTROL_CHARS.test(text)) return { ok: false, reason: 'obj 含控制字符' }
  if (codePointLength(text) > TEXT_MAX_CODE_POINTS) {
    return { ok: false, reason: `obj 超过 ${TEXT_MAX_CODE_POINTS} 码点` }
  }
  if (normalizeObjectText(text) === '') return { ok: false, reason: 'obj 规范化后为空' }
  return { ok: true, text }
}

/**
 * Derive the business key of one assertion.
 *
 * A multi-valued predicate carries its value; a single-valued one does not, so a
 * new value versions the memory instead of creating a second live identity.
 * @param kind - the assertable kind.
 * @param subj - the validated subject.
 * @param pred - the validated predicate name.
 * @param objNorm - the normalised object, required for multi-valued predicates.
 * @returns the business key.
 */
export function deriveMemKey(
  kind: AssertableKind,
  subj: string,
  pred: string,
  objNorm?: string,
): string {
  return objNorm === undefined ? `${kind}:${subj}:${pred}` : `${kind}:${subj}:${pred}:${objNorm}`
}

/** One `op:'assert'` entry. */
export const assertOpSchema = z
  .object({
    op: z.literal('assert'),
    kind: z.enum(ASSERTABLE_KINDS),
    subj: z.string(),
    pred: z.string(),
    obj: z.string().optional(),
  })
  .strict()

/** One `op:'pred'` entry: a registry change, which only a user may request. */
export const predOpSchema = z
  .object({
    op: z.literal('pred'),
    pred: z.string(),
    cardinality: z.enum(['single', 'multi']),
    aliases: z.array(z.string()).optional(),
    reason: z.string().optional(),
  })
  .strict()

/** A whole patch table: 1..50 ops and an optional reason. */
export const patchTableSchema = z
  .object({
    ops: z.array(z.discriminatedUnion('op', [assertOpSchema, predOpSchema])).min(1).max(PATCH_TABLE_MAX_OPS),
    reason: z.string().optional(),
  })
  .strict()

/** One assert op. */
export type AssertOp = z.infer<typeof assertOpSchema>

/** One registry op. */
export type PredOp = z.infer<typeof predOpSchema>

/** Any op. */
export type PatchOp = AssertOp | PredOp

/** A parsed patch table. */
export type PatchTable = z.infer<typeof patchTableSchema>

/** A table that parsed, or the field that did not. */
export type PatchParse =
  | { readonly ok: true; readonly table: PatchTable }
  | { readonly ok: false; readonly field: string; readonly reason: string }

/**
 * Parse a patch table, without planning it.
 *
 * Shape is checked here and semantics in {@link planPatchTable}, so a caller can
 * tell a malformed table from a refused one: both reject the table whole, but
 * only the plan knows which field a predicate name or a value broke.
 * @param raw - the value a tool or command received.
 * @returns the parsed table, or the first field that is wrong.
 */
export function parsePatchTable(raw: unknown): PatchParse {
  const parsed = patchTableSchema.safeParse(raw)
  if (parsed.success) return { ok: true, table: parsed.data }
  const issue = parsed.error.issues[0]
  const field = issue === undefined || issue.path.length === 0
    ? 'patch'
    : issue.path.map(segment => String(segment)).join('.')
  return { ok: false, field, reason: issue?.message ?? '补丁表不合法' }
}

/** Payload of one node, before it is written. */
export interface PlannedNode {
  readonly memKey: string
  readonly payload: Record<string, unknown>
}

/** A payload replacement on a node that already exists. */
export interface PlannedUpdate {
  readonly memKey: string
  readonly nodeId: number
  readonly payload: Record<string, unknown>
}

/** One ledger entry, before it becomes a node. */
export interface DecisionDraft {
  /** 1-based position of the op that caused it; it seeds `op_id`. */
  readonly index: number
  readonly decisionKind: DecisionKind
  readonly targetMemKey: string
  readonly affected: readonly string[]
  readonly from?: unknown
  readonly to?: unknown
  readonly reason: string
}

/** What one op did, as the tool reports it back. */
export interface PlanItemResult {
  /** 1-based position in the table. */
  readonly index: number
  readonly op: 'assert' | 'pred'
  readonly outcome: 'created' | 'existing' | 'promoted' | 'unchanged' | 'downgraded'
  readonly memKey: string
  readonly kind: string
  readonly value?: string
}

/** A table that may be committed. */
export interface PlanOk {
  readonly ok: true
  readonly nodes: readonly PlannedNode[]
  readonly updates: readonly PlannedUpdate[]
  readonly decisions: readonly DecisionDraft[]
  readonly items: readonly PlanItemResult[]
  /** Whether any op was downgraded to a `scene` node by the daily cap. */
  readonly downgraded: boolean
}

/** A table that is refused whole. */
export interface PlanRejected {
  readonly ok: false
  readonly code: 'E_BOUNDARY' | 'E_CONFLICT'
  /** Dotted path of the field that broke, e.g. `ops[2].pred`. */
  readonly field: string
  readonly reason: string
}

/** The result of planning one table. */
export type PlanResult = PlanOk | PlanRejected

/** The registry state a table planned for itself. */
interface PlannedPredicate {
  readonly name: string
  readonly cardinality: PredicateCardinality
  readonly aliases: readonly string[]
  readonly evidenceCount: number
  /** Registry status: a user declaration activates, a model proposal only candidates. */
  readonly status: PredicateStatus
}

/** Registry status of one predicate, as stored on its live node. */
type PredicateStatus = 'active' | 'candidate' | 'deprecated'

/**
 * Read the live registry entry for one predicate name.
 * @param context - the lookups the table was planned against.
 * @param name - a validated predicate name.
 * @returns the table-local state, or `undefined` when the name is unregistered.
 */
function readPredicate(context: PatchContext, name: string): PlannedPredicate | undefined {
  const live = context.lookupLive(predicateMemKey(name))
  if (live === undefined) return undefined
  const payload = live.payload
  const rawAliases = payload['aliases']
  const aliases = Array.isArray(rawAliases)
    ? rawAliases.filter((alias): alias is string => typeof alias === 'string')
    : []
  const evidenceCount = typeof payload['evidence_count'] === 'number' ? payload['evidence_count'] : 0
  return {
    name,
    cardinality: payload['cardinality'] === 'single' ? 'single' : 'multi',
    aliases,
    evidenceCount,
    status: payload['status'] === 'candidate'
      ? 'candidate'
      : (payload['status'] === 'deprecated' ? 'deprecated' : 'active'),
  }
}

/**
 * Merge two alias lists, first occurrence first.
 * @param existing - aliases already registered.
 * @param incoming - aliases this table adds.
 * @returns the union, without duplicates.
 */
function normaliseAliases(raw: readonly string[] | undefined): readonly string[] {
  return (raw ?? []).map(alias => alias.trim()).filter(alias => alias !== '')
}

/**
 * Merge two alias lists, first occurrence first.
 * @param existing - aliases already registered.
 * @param incoming - aliases this table adds.
 * @returns the union, without duplicates.
 */
function mergeAliases(existing: readonly string[], incoming: readonly string[]): readonly string[] {
  return [...new Set([...existing, ...incoming])]
}

/**
 * Build the payload of one `flag` node.
 * @param input - flag type, key and detail.
 * @returns the payload.
 */
function flagPayload(input: {
  readonly memKey: string;
  readonly flagType: 'predicate_new' | 'predicate_rekey';
  readonly severity: 'info' | 'warn';
  readonly detail: string;
  readonly nowIso: string;
}): Record<string, unknown> {
  return {
    kind: 'flag',
    mem_key: input.memKey,
    flag_type: input.flagType,
    severity: input.severity,
    status: 'open',
    detail: input.detail,
    valid_from: input.nowIso,
    recorded_at: input.nowIso,
    active_slot: 1,
  }
}

/**
 * Which channel a write arrived on.
 *
 * The data model's closed set is conversation | tool | dream | migration. A
 * user typing `/omw pred promote` reaches the store through the chat, not
 * through a tool call, and an answer that said `tool` for both would make the
 * ledger unable to tell the two apart afterwards.
 * @param caller - who submitted the patch table.
 * @returns the `cause` value.
 */
function writeCause(caller: 'user' | 'model'): 'conversation' | 'tool' {
  return caller === 'user' ? 'conversation' : 'tool'
}

/**
 * Build the payload of one assertion node.
 *
 * Every field is written explicitly, including `origin: 'observed'` and
 * `vec_state: 'pending'`: a reader that sees `pending` knows the vector is a
 * placeholder, while a missing field would be ambiguous. Optional fields are
 * omitted rather than set to `undefined`, which the engine refuses.
 * @param input - the assertion to serialise.
 * @returns the payload.
 */
export function buildAssertPayload(input: {
  readonly kind: AssertableKind;
  readonly memKey: string;
  readonly subj: string;
  readonly pred: string;
  readonly obj?: string;
  readonly objNorm?: string;
  readonly nowIso: string;
  readonly caller: 'user' | 'model';
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    kind: input.kind,
    mem_key: input.memKey,
    subj: input.subj,
    pred: input.pred,
    valid_from: input.nowIso,
    recorded_at: input.nowIso,
    active_slot: 1,
    origin: WRITE_ORIGIN,
    vec_state: 'pending',
    actor: input.caller,
    cause: writeCause(input.caller),
    prompt_version: WRITE_PROMPT_VERSION,
  }
  if (input.obj !== undefined) payload['obj'] = input.obj
  if (input.objNorm !== undefined) {
    payload['obj_norm'] = input.objNorm
    payload['norm_version'] = NORM_VERSION
  }
  if (input.kind === 'pref' && input.obj !== undefined) {
    // `key` is the stable preference name; the value never names the identity.
    payload['key'] = input.pred
    payload['value'] = input.obj
  }
  return payload
}

/**
 * Build the payload of the `scene` node a capped write degrades to.
 *
 * When the daily new-predicate budget is spent, the information is kept as an
 * episode-shaped text node instead of being dropped: it is not recallable by
 * predicate, but it is not lost either.
 * @param input - the assertion that could not become one.
 * @returns the business key plus the payload.
 */
export function buildDowngradedScenePayload(input: {
  readonly subj: string;
  readonly pred: string;
  readonly obj: string;
  readonly nowIso: string;
  readonly caller: 'user' | 'model';
  readonly maxNewPredsPerDay: number;
}): { readonly memKey: string; readonly payload: Record<string, unknown> } {
  const objNorm = normalizeObjectText(input.obj)
  const memKey = `scene:${input.subj}:${input.pred}:${objNorm}`
  return {
    memKey,
    payload: {
      kind: 'scene',
      mem_key: memKey,
      name: input.pred,
      description: `${input.subj} ${input.pred} ${input.obj}`,
      episode_refs: [],
      confidence: 0.5,
      subj: input.subj,
      pred: input.pred,
      obj: input.obj,
      obj_norm: objNorm,
      norm_version: NORM_VERSION,
      valid_from: input.nowIso,
      recorded_at: input.nowIso,
      active_slot: 1,
      origin: WRITE_ORIGIN,
      vec_state: 'pending',
      actor: input.caller,
      cause: writeCause(input.caller),
      prompt_version: WRITE_PROMPT_VERSION,
      detail: `今日新谓词已达上限 ${input.maxNewPredsPerDay}，降级为场景文本。`,
    },
  }
}

/** Reads and limits one table is planned against. */
export interface PatchContext {
  /** Who submitted the table. Only a user may change the registry. */
  readonly caller: 'user' | 'model'
  /** Instant of the write, in epoch milliseconds. */
  readonly nowMs: number
  /** Most predicates a model may introduce per local day. */
  readonly maxNewPredsPerDay: number
  /** Contract version written into every ledger entry. */
  readonly contractVersion: number
  /** Predicates the model already introduced today. */
  readonly newPredsToday: number
  /** The single live version of a business key, or `undefined`. */
  readonly lookupLive: (memKey: string) => StoredNode | undefined
  /** Every version of a business key, live or retired. */
  readonly lookupVersions: (memKey: string) => readonly StoredNode[]
}

/**
 * Refuse a table, naming the field that broke.
 * @param field - dotted path of the offending field.
 * @param reason - why it cannot be written.
 * @returns the rejection.
 */
function refuse(field: string, reason: string): PlanRejected {
  return { ok: false, code: 'E_BOUNDARY', field, reason }
}

/**
 * Plan one whole patch table.
 *
 * Two passes, not one: every `op:'pred'` is registered before any `op:'assert'`
 * resolves, so an assertion sees the predicate shape *this table* declared even
 * when the declaration appears later in the list. Every failure is total — a
 * table that cannot be committed produces exactly one reason and no nodes.
 * @param table - a parsed table.
 * @param context - reads and limits the table is planned against.
 * @returns the complete list of writes, or the single reason to refuse it.
 */
export function planPatchTable(table: PatchTable, context: PatchContext): PlanResult {
  const nowIso = new Date(context.nowMs).toISOString()
  const planned = new Map<string, PlannedPredicate>()
  const nodes: PlannedNode[] = []
  const updates: PlannedUpdate[] = []
  const decisions: DecisionDraft[] = []
  const items: PlanItemResult[] = []
  /**
   * Live key -> the value this table already pinned it to.
   *
   * A multi-valued key carries its normalised value, a single-valued one the
   * object as written: two spellings of one value are one value, and two
   * different values for one single-valued key are a conflict, not a no-op.
   */
  const seen = new Map<string, string | undefined>()
  let newPredsHere = 0
  let downgraded = false
  const tableReason = table.reason ?? '用户提交的补丁表'

  // ---- pass 1: registry declarations ------------------------------------
  for (const [index, op] of table.ops.entries()) {
    if (op.op !== 'pred') continue
    if (context.caller !== 'user') {
      return refuse(`ops[${index}].op`, 'op:pred 只接受用户调用方；模型不能改登记表')
    }
    const checked = checkPredicateName(op.pred)
    if (!checked.ok) return refuse(`ops[${index}].pred`, checked.reason)
    const name = checked.name
    const already = planned.get(name)
    if (already !== undefined) {
      if (already.cardinality !== op.cardinality) {
        return refuse(`ops[${index}].cardinality`, `同一张表内谓词 ${name} 的基数声明不一致`)
      }
      // A second declaration of one name is not a second insert -- two live
      // entries under one key would roll the whole table back on the unique
      // index. Its vocabulary still counts, so fold it into the entry the first
      // op already planned and note that the entry ended up different.
      const merged = mergeAliases(already.aliases, normaliseAliases(op.aliases))
      if (merged.length === already.aliases.length) {
        items.push({ index: index + 1, op: 'pred', outcome: 'unchanged', memKey: predicateMemKey(name), kind: 'pred' })
        continue
      }
      planned.set(name, { ...already, aliases: merged })
      const predKey = predicateMemKey(name)
      const pending = nodes.findIndex(node => node.memKey === predKey)
      if (pending >= 0) {
        nodes[pending] = { memKey: predKey, payload: { ...nodes[pending]!.payload, aliases: merged } }
      } else {
        // The first declaration rewrote an existing entry instead of inserting
        // one, so the merged vocabulary belongs on that rewrite.
        const rewrite = updates.findIndex(update => update.memKey === predKey)
        if (rewrite >= 0) {
          updates[rewrite] = {
            memKey: predKey,
            nodeId: updates[rewrite]!.nodeId,
            payload: { ...updates[rewrite]!.payload, aliases: merged },
          }
        }
      }
      items.push({ index: index + 1, op: 'pred', outcome: 'promoted', memKey: predKey, kind: 'pred' })
      continue
    }
    const live = readPredicate(context, name)
    const aliases = mergeAliases(live?.aliases ?? [], normaliseAliases(op.aliases))
    const state: PlannedPredicate = {
      name,
      cardinality: op.cardinality,
      aliases,
      evidenceCount: live?.evidenceCount ?? 0,
      // A user declaration is authoritative: it activates a candidate outright.
      status: 'active',
    }
    planned.set(name, state)
    const predKey = predicateMemKey(name)
    const reason = op.reason ?? tableReason

    if (live === undefined) {
      // A user may register a predicate outright; the ledger records it.
      nodes.push({
        memKey: predKey,
        payload: buildPredicatePayload({
          name,
          cardinality: state.cardinality,
          status: 'active',
          aliases: state.aliases,
          decidedBy: 'user',
          decidedAt: nowIso,
          evidenceCount: state.evidenceCount,
          normVersion: NORM_VERSION,
          activeSlot: 1,
          recordedAt: nowIso,
          validFrom: nowIso,
        }),
      })
      decisions.push({
        index: index + 1,
        decisionKind: 'insert',
        targetMemKey: predKey,
        affected: [predKey],
        to: { cardinality: state.cardinality, aliases: state.aliases, evidence_count: state.evidenceCount },
        reason,
      })
      items.push({ index: index + 1, op: 'pred', outcome: 'created', memKey: predKey, kind: 'pred' })
      continue
    }

    const liveNode = context.lookupLive(predKey)
    if (liveNode === undefined) return refuse(`ops[${index}].pred`, `谓词 ${name} 的活动登记在规划期间消失`)

    if (live.cardinality === op.cardinality) {
      // Same cardinality: merge the vocabulary, write no ledger entry.
      // Same cardinality is still a real edit when it activates a candidate or
      // merges vocabulary; only a byte-identical active entry is a no-op.
      const changed = live.status !== 'active'
        || state.aliases.length !== live.aliases.length
        || state.aliases.some((alias, position) => live.aliases[position] !== alias)
      if (!changed) {
        items.push({ index: index + 1, op: 'pred', outcome: 'unchanged', memKey: predKey, kind: 'pred' })
        continue
      }
      updates.push({
        memKey: predKey,
        nodeId: liveNode.id,
        payload: buildPredicatePayload({
          name,
          cardinality: state.cardinality,
          status: 'active',
          aliases: state.aliases,
          decidedBy: 'user',
          decidedAt: nowIso,
          evidenceCount: state.evidenceCount,
          normVersion: NORM_VERSION,
          activeSlot: 1,
          recordedAt: nowIso,
          validFrom: nowIso,
        }),
      })
      items.push({ index: index + 1, op: 'pred', outcome: 'promoted', memKey: predKey, kind: 'pred' })
      continue
    }

    // Cardinality change: retire the old entry, insert the new one, record both.
    const slot = retirementSlot(predKey, context)
    updates.push({
      memKey: predKey,
      nodeId: liveNode.id,
      payload: { ...liveNode.payload, active_slot: slot, superseded_at: context.nowMs },
    })
    // The op position is part of the key: two promotions inside one
    // millisecond would otherwise render the same key and collide.
    const flagKey = `flag:predicate_rekey:${name}:${context.nowMs}:${index + 1}`
    nodes.push({
      memKey: predKey,
      payload: buildPredicatePayload({
        name,
        cardinality: state.cardinality,
        status: 'active',
        aliases: state.aliases,
        decidedBy: 'user',
        decidedAt: nowIso,
        evidenceCount: state.evidenceCount,
        normVersion: NORM_VERSION,
        activeSlot: 1,
        recordedAt: nowIso,
        validFrom: nowIso,
      }),
    })
    nodes.push({
      memKey: flagKey,
      payload: flagPayload({
        memKey: flagKey,
        flagType: 'predicate_rekey',
        severity: 'warn',
        detail: `谓词 ${name} 的基数由 ${live.cardinality} 改为 ${op.cardinality}；既有键未改写，留给 2.3 的改写决策。`,
        nowIso,
      }),
    })
    decisions.push({
      index: index + 1,
      decisionKind: 'supersede',
      targetMemKey: predKey,
      affected: [predKey, flagKey],
      from: { cardinality: live.cardinality, aliases: live.aliases, evidence_count: live.evidenceCount },
      to: { cardinality: state.cardinality, aliases: state.aliases, evidence_count: state.evidenceCount },
      reason,
    })
    items.push({ index: index + 1, op: 'pred', outcome: 'promoted', memKey: predKey, kind: 'pred' })
  }

  // ---- pass 2: assertions -----------------------------------------------
  for (const [index, op] of table.ops.entries()) {
    if (op.op !== 'assert') continue
    const subject = checkSubject(op.subj)
    if (!subject.ok) return refuse(`ops[${index}].subj`, subject.reason)
    const pred = checkPredicateName(op.pred)
    if (!pred.ok) return refuse(`ops[${index}].pred`, pred.reason)

    let obj: string | undefined
    if (op.obj !== undefined) {
      const checked = checkObject(op.obj)
      if (!checked.ok) return refuse(`ops[${index}].obj`, checked.reason)
      obj = checked.text
    }

    let state = planned.get(pred.name)
    /** Nodes this op wrote, so its single ledger entry names all of them. */
    const affected: string[] = []

    if (state === undefined) {
      const live = readPredicate(context, pred.name)
      if (live !== undefined) {
        state = live
        planned.set(pred.name, state)
      } else if (obj === undefined) {
        return refuse(`ops[${index}].obj`, `谓词 ${pred.name} 未登记，且没有 obj 可以推断基数`)
      } else if (
        context.caller === 'model'
        && context.newPredsToday + newPredsHere >= context.maxNewPredsPerDay
      ) {
        const scene = buildDowngradedScenePayload({
          subj: subject.text,
          pred: pred.name,
          obj,
          nowIso,
          caller: context.caller,
          maxNewPredsPerDay: context.maxNewPredsPerDay,
        })
        // A scene key is an identity like any other: repeating it inside one
        // table would put two live nodes under one key and lose the batch.
        if (seen.has(scene.memKey)) {
          if (seen.get(scene.memKey) !== obj) {
            return { ok: false, code: 'E_CONFLICT', field: `ops[${index}].obj`, reason: `同一张表里 ${scene.memKey} 有两个不同的值` }
          }
          items.push({ index: index + 1, op: 'assert', outcome: 'existing', memKey: scene.memKey, kind: 'scene', value: obj })
          continue
        }
        seen.set(scene.memKey, obj)
        nodes.push({ memKey: scene.memKey, payload: scene.payload })
        decisions.push({
          index: index + 1,
          decisionKind: 'insert',
          targetMemKey: scene.memKey,
          affected: [scene.memKey],
          to: { kind: 'scene', obj_norm: normalizeObjectText(obj) },
          reason: `今日新谓词已达上限 ${context.maxNewPredsPerDay}，降级为场景文本`,
        })
        downgraded = true
        items.push({
          index: index + 1,
          op: 'assert',
          outcome: 'downgraded',
          memKey: scene.memKey,
          kind: 'scene',
          value: obj,
        })
        continue
      } else {
        // A predicate this installation has never seen: always multi/candidate.
        state = { name: pred.name, cardinality: 'multi', aliases: [], evidenceCount: 0, status: 'candidate' }
        planned.set(pred.name, state)
        newPredsHere += 1
        const predKey = predicateMemKey(pred.name)
        nodes.push({
          memKey: predKey,
          payload: buildPredicatePayload({
            name: pred.name,
            cardinality: state.cardinality,
            status: 'candidate',
            aliases: state.aliases,
            decidedBy: 'model',
            decidedAt: nowIso,
            evidenceCount: state.evidenceCount,
            normVersion: NORM_VERSION,
            activeSlot: 1,
            recordedAt: nowIso,
            validFrom: nowIso,
          }),
        })
        const flagKey = `flag:predicate_new:${pred.name}`
        nodes.push({
          memKey: flagKey,
          payload: flagPayload({
            memKey: flagKey,
            flagType: 'predicate_new',
            severity: 'info',
            detail: `模型提出新谓词 ${pred.name}（multi/candidate），待用户确认。`,
            nowIso,
          }),
        })
        affected.push(predKey, flagKey)
      }
    }

    const cardinality = state.cardinality
    if (cardinality === 'multi' && obj === undefined) {
      return refuse(`ops[${index}].obj`, `谓词 ${pred.name} 是 multi，必须提供 obj`)
    }
    const objNorm = cardinality === 'multi' && obj !== undefined ? normalizeObjectText(obj) : undefined
    const memKey = deriveMemKey(op.kind, subject.text, pred.name, objNorm)

    const identity = objNorm ?? obj
    if (seen.has(memKey)) {
      if (seen.get(memKey) === identity) {
        items.push({
          index: index + 1,
          op: 'assert',
          outcome: 'existing',
          memKey,
          kind: op.kind,
          ...(obj === undefined ? {} : { value: obj }),
        })
        continue
      }
      return {
        ok: false,
        code: 'E_CONFLICT',
        field: `ops[${index}].obj`,
        reason: `同一张表里 ${memKey} 有两个不同的值`,
      }
    }

    const resolution = resolveAssert({
      kind: op.kind,
      memKey,
      subj: subject.text,
      pred: pred.name,
      nowIso,
      caller: context.caller,
      context,
      ...(obj === undefined ? {} : { obj }),
      ...(objNorm === undefined ? {} : { objNorm }),
    })
    if (resolution.kind === 'conflict') {
      return {
        ok: false,
        code: 'E_CONFLICT',
        field: `ops[${index}].obj`,
        reason: `${memKey} 已有不同的值（改写属 2.3）`,
      }
    }
    seen.set(memKey, identity)
    if (resolution.kind === 'existing') {
      items.push({
        index: index + 1,
        op: 'assert',
        outcome: 'existing',
        memKey,
        kind: op.kind,
        ...(obj === undefined ? {} : { value: obj }),
      })
      continue
    }
    nodes.push(resolution.node)
    decisions.push({
      index: index + 1,
      decisionKind: 'insert',
      targetMemKey: memKey,
      affected: [...affected, memKey],
      to: { kind: op.kind, ...(objNorm === undefined ? {} : { obj_norm: objNorm }) },
      reason: tableReason,
    })
    items.push({
      index: index + 1,
      op: 'assert',
      outcome: 'created',
      memKey,
      kind: op.kind,
      ...(obj === undefined ? {} : { value: obj }),
    })
  }

  return { ok: true, nodes, updates, decisions, items, downgraded }
}

/** The reserved value negotiation outcome of one assert op. */
type AssertResolution =
  | { readonly kind: 'insert'; readonly node: PlannedNode }
  | { readonly kind: 'existing' }
  | { readonly kind: 'conflict' }

/**
 * Decide what one assertion does against the live store.
 *
 * A key that is already live either holds this value (nothing to write) or
 * another one (a conflict, because rewriting a memory belongs to 2.3).
 * @param input - the derived identity plus the table context.
 * @returns insert, existing or conflict.
 */
function resolveAssert(input: {
  readonly kind: AssertableKind
  readonly memKey: string
  readonly subj: string
  readonly pred: string
  readonly obj?: string
  readonly objNorm?: string
  readonly nowIso: string
  readonly caller: 'user' | 'model'
  readonly context: PatchContext
}): AssertResolution {
  const live = input.context.lookupLive(input.memKey)
  if (live !== undefined) {
    const stored = live.payload
    const sameValue = input.objNorm === undefined
      ? payloadValue(stored) === input.obj
      : payloadObjNorm(stored) === input.objNorm
    return sameValue ? { kind: 'existing' } : { kind: 'conflict' }
  }
  return {
    kind: 'insert',
    node: {
      memKey: input.memKey,
      payload: buildAssertPayload({
        kind: input.kind,
        memKey: input.memKey,
        subj: input.subj,
        pred: input.pred,
        nowIso: input.nowIso,
        caller: input.caller,
        ...(input.obj === undefined ? {} : { obj: input.obj }),
        ...(input.objNorm === undefined ? {} : { objNorm: input.objNorm }),
      }),
    },
  }
}

/**
 * The value a payload carries, whichever spelling its kind uses.
 * @param payload - a stored assertion payload.
 * @returns the raw value, or `undefined` for a two-valued predicate.
 */
function payloadValue(payload: Readonly<Record<string, unknown>>): string | undefined {
  const value = payload['value'] ?? payload['obj']
  return typeof value === 'string' ? value : undefined
}

/**
 * The normalised value a payload carries, if any.
 * @param payload - a stored assertion payload.
 * @returns the normalised value.
 */
function payloadObjNorm(payload: Readonly<Record<string, unknown>>): string | undefined {
  const value = payload['obj_norm']
  return typeof value === 'string' ? value : undefined
}

/**
 * The slot a retired version takes, never reusing one already spent.
 *
 * Two promotions inside one millisecond would otherwise write the same
 * `active_slot` twice and collide with the unique index; taking one more than the
 * highest spent slot keeps the sequence monotonic without a clock.
 * @param memKey - the key being retired.
 * @param context - reads the versions already written for that key.
 * @returns `max(nowMs, every spent slot + 1)`.
 */
function retirementSlot(memKey: string, context: PatchContext): number {
  const highest = context.lookupVersions(memKey).reduce((highest, node) => {
    const slot = node.payload['active_slot']
    return typeof slot === 'number' && slot > highest ? slot : highest
  }, 0)
  return Math.max(context.nowMs, highest + 1)
}
