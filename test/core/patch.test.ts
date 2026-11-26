/**
 * Story 2.1 — the planner is a pure function, so every matrix row about a
 * refused table, a registered predicate or a capped write is testable without
 * a database.
 * @module
 */
import { describe, expect, it } from 'vitest'
import {
  checkObject,
  checkSubject,
  codePointLength,
  deriveMemKey,
  normalizeObjectText,
  parsePatchTable,
  PATCH_TABLE_MAX_OPS,
  TEXT_MAX_CODE_POINTS,
  WRITE_ORIGIN,
  WRITE_PROMPT_VERSION,
} from '../../src/core/patch.ts'
import { NORM_VERSION, predicateMemKey } from '../../src/store/tbox.ts'
import {
  expectOk,
  fakeContext,
  fakeStore,
  planOf,
  PLAN_NOW,
  seedNode,
  seedPredicate,
  seedRetiredVersion,
} from '../support/fake-registry.ts'

/** One assert op, spelled the way a caller sends it. */
function assertOp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'likes', obj: 'coffee', ...overrides }
}

/** One table around a single assert op. */
function tableOf(op: Record<string, unknown>, reason?: string): Record<string, unknown> {
  return reason === undefined ? { ops: [op] } : { ops: [op], reason }
}

describe('patch: text fields', () => {
  it('trims a subject and keeps its case', () => {
    expect(checkSubject('  Elliott  ')).toEqual({ ok: true, text: 'Elliott' })
    expect(checkSubject('elliott')).toEqual({ ok: true, text: 'elliott' })
  })

  it('refuses an empty subject or one that can forge a key boundary', () => {
    expect(checkSubject('   ')).toEqual({ ok: false, reason: 'subj 为空' })
    expect(checkSubject('a:b')).toEqual({ ok: false, reason: "subj 不能包含 ':'" })
    expect(checkSubject('a\u0007b')).toEqual({ ok: false, reason: 'subj 含控制字符' })
  })

  it('counts subjects in code points, so an emoji costs one', () => {
    expect(codePointLength('👍')).toBe(1)
    expect(codePointLength('👍'.repeat(3))).toBe(3)
    const emoji = '👍'.repeat(TEXT_MAX_CODE_POINTS)
    expect(checkSubject(emoji)).toEqual({ ok: true, text: emoji })
    expect(checkSubject(`${emoji}👍`)).toEqual({ ok: false, reason: `subj 超过 ${TEXT_MAX_CODE_POINTS} 码点` })
    // An object must survive normalisation, and a symbol normalises away.
    const letters = 'é'.repeat(TEXT_MAX_CODE_POINTS)
    expect(checkObject(letters)).toEqual({ ok: true, text: letters })
    expect(checkObject(`${letters}é`)).toEqual({ ok: false, reason: `obj 超过 ${TEXT_MAX_CODE_POINTS} 码点` })
  })

  it('refuses an object that normalises to nothing', () => {
    expect(checkObject('...')).toEqual({ ok: false, reason: 'obj 规范化后为空' })
    expect(checkObject('!!!')).toEqual({ ok: false, reason: 'obj 规范化后为空' })
    expect(checkObject('   ')).toEqual({ ok: false, reason: 'obj 为空' })
  })
})

describe('patch: normalisation', () => {
  it('folds case, width and punctuation', () => {
    expect(normalizeObjectText('Coffee')).toBe('coffee')
    expect(normalizeObjectText('  ＮＥＷ   York ')).toBe('new york')
    expect(normalizeObjectText('Rock  &amp; Roll')).toBe('rock amp roll')
  })

  it('gives C++ and C# one identity, deliberately', () => {
    expect(normalizeObjectText('C++')).toBe('c')
    expect(normalizeObjectText('C#')).toBe('c')
  })
})

describe('patch: identity', () => {
  it('leaves the value out of a single-valued key', () => {
    expect(deriveMemKey('assertion', 'Elliott', 'lives_in')).toBe('assertion:Elliott:lives_in')
  })

  it('puts the normalised value into a multi-valued key', () => {
    expect(deriveMemKey('assertion', 'Elliott', 'likes', 'coffee')).toBe('assertion:Elliott:likes:coffee')
    expect(deriveMemKey('pref', 'Elliott', 'reply_style', 'concise')).toBe('pref:Elliott:reply_style:concise')
  })
})

describe('patch: parsing', () => {
  it('accepts both documented example tables', () => {
    expect(parsePatchTable({
      ops: [{ op: 'assert', kind: 'pref', subj: 'Elliott', pred: 'reply_style', obj: 'concise' }],
      reason: '用户明确要求',
    }).ok).toBe(true)
    expect(parsePatchTable({
      ops: [{ op: 'pred', pred: 'mood', cardinality: 'single', aliases: [], reason: '用户提升为单值' }],
      reason: '用户明确要求',
    }).ok).toBe(true)
  })

  it('refuses an empty table and one over the op ceiling', () => {
    const empty = parsePatchTable({ ops: [] })
    expect(empty.ok).toBe(false)
    if (empty.ok) return
    expect(empty.field).toBe('ops')

    const tooMany = parsePatchTable({
      ops: Array.from({ length: PATCH_TABLE_MAX_OPS + 1 }, () => assertOp({ obj: 'coffee' })),
    })
    expect(tooMany.ok).toBe(false)
    if (tooMany.ok) return
    expect(tooMany.field).toBe('ops')
  })

  it('names the field an unknown op breaks', () => {
    const parsed = parsePatchTable({ ops: [assertOp(), { op: 'delete', mem_key: 'x' }] })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.field).toBe('ops.1.op')
  })

  it('refuses an unknown field rather than ignoring it', () => {
    const parsed = parsePatchTable({ ops: [assertOp({ confidence: 0.9 })] })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.field).toBe('ops.0')
  })
})

describe('patch: an empty store', () => {
  it('plans one assertion, one node and one ledger entry', () => {
    const store = fakeStore()
    seedPredicate(store, 'likes', 'multi')
    const plan = expectOk(planOf(tableOf(assertOp()), fakeContext(store, { caller: 'user' })))

    expect(plan.nodes).toHaveLength(1)
    const node = plan.nodes[0]
    expect(node?.memKey).toBe('assertion:Elliott:likes:coffee')
    expect(node?.payload).toMatchObject({
      kind: 'assertion',
      mem_key: 'assertion:Elliott:likes:coffee',
      subj: 'Elliott',
      pred: 'likes',
      obj: 'coffee',
      obj_norm: 'coffee',
      norm_version: NORM_VERSION,
      active_slot: 1,
      origin: WRITE_ORIGIN,
      vec_state: 'pending',
      // A user-typed command reaches the store through the chat, not through a
      // tool call; the ledger has to be able to tell those apart afterwards.
      cause: 'conversation',
      prompt_version: WRITE_PROMPT_VERSION,
    })
    expect(typeof node?.payload['valid_from']).toBe('string')
    expect(typeof node?.payload['recorded_at']).toBe('string')
    expect(plan.decisions).toHaveLength(1)
    expect(plan.decisions[0]?.decisionKind).toBe('insert')
    expect(plan.decisions[0]?.targetMemKey).toBe('assertion:Elliott:likes:coffee')
    expect(plan.items).toEqual([
      { index: 1, op: 'assert', outcome: 'created', memKey: 'assertion:Elliott:likes:coffee', kind: 'assertion', value: 'coffee' },
    ])
    expect(plan.downgraded).toBe(false)
  })

  it('writes an unregistered preference as AC1 spells its key', () => {
    const store = fakeStore()
    const plan = expectOk(planOf(tableOf(assertOp({ kind: 'pref', pred: 'reply_style', obj: 'concise' })), fakeContext(store)))
    const node = plan.nodes.find(planned => planned.memKey === 'pref:Elliott:reply_style:concise')
    expect(node?.payload).toMatchObject({ kind: 'pref', key: 'reply_style', value: 'concise' })
  })

  it('leaves the value out of the key once the preference is single-valued', () => {
    const store = fakeStore()
    seedPredicate(store, 'reply_style', 'single')
    const plan = expectOk(planOf(tableOf(assertOp({ kind: 'pref', pred: 'reply_style', obj: 'concise' })), fakeContext(store)))
    const node = plan.nodes[0]
    expect(node?.memKey).toBe('pref:Elliott:reply_style')
    expect(node?.payload).toMatchObject({ kind: 'pref', key: 'reply_style', value: 'concise' })
  })

  it('writes a single-valued predicate as a three-segment key', () => {
    const store = fakeStore()
    seedPredicate(store, 'lives_in', 'single')
    const plan = expectOk(planOf(tableOf(assertOp({ kind: 'persona_state', pred: 'lives_in', obj: 'Berlin' })), fakeContext(store)))
    const node = plan.nodes[0]
    expect(node?.memKey).toBe('persona_state:Elliott:lives_in')
    expect(node?.payload['obj']).toBe('Berlin')
    expect(node?.payload['obj_norm']).toBeUndefined()
  })
})
describe('patch: the predicate registry', () => {
  it('lets a user register a predicate outright, with a ledger entry', () => {
    const store = fakeStore()
    const plan = expectOk(planOf({
      ops: [{ op: 'pred', pred: 'mood', cardinality: 'single', aliases: ['feeling'], reason: '用户新增' }],
      reason: '用户新增',
    }, fakeContext(store, { caller: 'user' })))

    expect(plan.nodes).toHaveLength(1)
    const node = plan.nodes[0]
    expect(node?.memKey).toBe(predicateMemKey('mood'))
    expect(node?.payload).toMatchObject({
      kind: 'pred',
      pred: 'mood',
      cardinality: 'single',
      status: 'active',
      decided_by: 'user',
      aliases: ['feeling'],
      active_slot: 1,
    })
    expect(plan.decisions).toHaveLength(1)
    expect(plan.decisions[0]?.decisionKind).toBe('insert')
    expect(plan.decisions[0]?.to).toEqual({ cardinality: 'single', aliases: ['feeling'] })
    expect(plan.items[0]?.outcome).toBe('created')
  })

  it('refuses a registry change from the model caller', () => {
    const store = fakeStore()
    const result = planOf({
      ops: [{ op: 'pred', pred: 'mood', cardinality: 'single' }],
    }, fakeContext(store, { caller: 'model' }))
    expect(result).toEqual({
      ok: false,
      code: 'E_BOUNDARY',
      field: 'ops[0].op',
      reason: 'op:pred 只接受用户调用方；模型不能改登记表',
    })
  })

  it('refuses a predicate name the registry rules reject, naming the field', () => {
    const store = fakeStore()
    for (const name of ['', 'Mood', 'omw_internal', 'a'.repeat(41)]) {
      const result = planOf({ ops: [{ op: 'pred', pred: name, cardinality: 'single' }] }, fakeContext(store, { caller: 'user' }))
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.code).toBe('E_BOUNDARY')
      expect(result.field).toBe('ops[0].pred')
    }
  })

  it('registers one predicate once when the table declares it twice', () => {
    const store = fakeStore()
    const plan = expectOk(planOf({
      ops: [
        { op: 'pred', pred: 'mood', cardinality: 'single' },
        { op: 'pred', pred: 'mood', cardinality: 'single', aliases: ['feeling'] },
      ],
    }, fakeContext(store, { caller: 'user' })))

    // The second declaration adds an alias, which has to reach the stored entry:
    // dropping it would silently lose what the caller asked for.
    expect(plan.nodes).toHaveLength(1)
    expect(plan.items.map(item => item.outcome)).toEqual(['created', 'promoted'])
    expect(plan.nodes[0]?.payload).toMatchObject({ aliases: ['feeling'] })
  })

  it('refuses two declarations of one name with different cardinalities', () => {
    const store = fakeStore()
    const result = planOf({
      ops: [
        { op: 'pred', pred: 'mood', cardinality: 'single' },
        { op: 'pred', pred: 'mood', cardinality: 'multi' },
      ],
    }, fakeContext(store, { caller: 'user' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.field).toBe('ops[1].cardinality')
    expect(result.reason).toContain('基数声明不一致')
  })

  it('treats a byte-identical declaration as a no-op', () => {
    const store = fakeStore()
    seedPredicate(store, 'mood', 'single', { aliases: ['feeling'] })
    const plan = expectOk(planOf({
      ops: [{ op: 'pred', pred: 'mood', cardinality: 'single', aliases: ['feeling'] }],
    }, fakeContext(store, { caller: 'user' })))

    expect(plan.nodes).toHaveLength(0)
    expect(plan.updates).toHaveLength(0)
    expect(plan.decisions).toHaveLength(0)
    expect(plan.items[0]?.outcome).toBe('unchanged')
  })

  it('merges vocabulary by retiring the old entry for a new version', () => {
    const store = fakeStore()
    const live = seedPredicate(store, 'mood', 'single', { aliases: ['feeling'], evidenceCount: 7 })
    const plan = expectOk(planOf({
      ops: [{ op: 'pred', pred: 'mood', cardinality: 'single', aliases: ['vibe'] }],
    }, fakeContext(store, { caller: 'user' })))

    const predKey = predicateMemKey('mood')
    // The retired version keeps the payload it was written with; only the slot
    // and the retirement stamps change.
    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0]).toMatchObject({ nodeId: live.id, memKey: predKey })
    expect(plan.updates[0]?.payload).toMatchObject({
      status: 'active',
      decided_by: 'seed',
      aliases: ['feeling'],
      active_slot: PLAN_NOW,
      superseded_at: PLAN_NOW,
    })

    // The merged vocabulary lives on the new version, which takes the free slot.
    expect(plan.nodes).toHaveLength(1)
    expect(plan.nodes[0]?.memKey).toBe(predKey)
    expect(plan.nodes[0]?.payload).toMatchObject({
      status: 'active',
      decided_by: 'user',
      aliases: ['feeling', 'vibe'],
      active_slot: 1,
    })

    expect(plan.decisions).toHaveLength(1)
    expect(plan.decisions[0]).toMatchObject({
      decisionKind: 'supersede',
      targetMemKey: predKey,
      from: { status: 'active', aliases: ['feeling'] },
      to: { status: 'active', aliases: ['feeling', 'vibe'] },
    })
    expect(plan.items[0]?.outcome).toBe('promoted')
  })

  it('activates a candidate on the same cardinality, keeping its proof', () => {
    const store = fakeStore()
    const live = seedPredicate(store, 'mood', 'multi', { status: 'candidate', evidenceCount: 3 })
    const plan = expectOk(planOf({
      ops: [{ op: 'pred', pred: 'mood', cardinality: 'multi' }],
    }, fakeContext(store, { caller: 'user' })))

    // The candidate is retired as it stood; the activation is the new version.
    // Neither carries a proof counter: the store keeps no mutable counts (P0-7),
    // so what survives the promotion is the status history, not a number.
    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0]).toMatchObject({ nodeId: live.id })
    expect(plan.updates[0]?.payload).toMatchObject({ status: 'candidate', decided_by: 'seed' })

    expect(plan.nodes).toHaveLength(1)
    expect(plan.nodes[0]?.payload).toMatchObject({ status: 'active', decided_by: 'user', active_slot: 1 })
    expect(plan.items[0]?.outcome).toBe('promoted')
  })

  it('retires the old entry and records both shapes when the cardinality changes', () => {
    const store = fakeStore()
    const live = seedPredicate(store, 'mood', 'multi', { aliases: ['feeling'], evidenceCount: 4 })
    const plan = expectOk(planOf({
      ops: [{ op: 'pred', pred: 'mood', cardinality: 'single', aliases: ['vibe'], reason: '用户提升为单值' }],
      reason: '用户提升为单值',
    }, fakeContext(store, { caller: 'user' })))

    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0]).toMatchObject({ nodeId: live.id })
    expect(plan.updates[0]?.payload).toMatchObject({ active_slot: PLAN_NOW, superseded_at: PLAN_NOW })

    const predKey = predicateMemKey('mood')
    const inserted = plan.nodes.find(node => node.memKey === predKey)
    expect(inserted?.payload).toMatchObject({
      cardinality: 'single',
      status: 'active',
      active_slot: 1,
      aliases: ['feeling', 'vibe'],
    })

    const flag = plan.nodes.find(node => node.memKey.startsWith('flag:predicate_rekey:'))
    expect(flag?.memKey).toBe(`flag:predicate_rekey:mood:${PLAN_NOW}:1`)
    expect(flag?.payload).toMatchObject({ kind: 'flag', flag_type: 'predicate_rekey', severity: 'warn', status: 'open' })

    expect(plan.decisions).toHaveLength(1)
    expect(plan.decisions[0]?.decisionKind).toBe('supersede')
    expect(plan.decisions[0]?.from).toEqual({ cardinality: 'multi', aliases: ['feeling'] })
    expect(plan.decisions[0]?.to).toEqual({ cardinality: 'single', aliases: ['feeling', 'vibe'] })
    // The closure ends with the key the entry is about, so a reader that only
    // looks at the last element still finds the changed predicate.
    expect(plan.decisions[0]?.affected).toEqual([`flag:predicate_rekey:mood:${PLAN_NOW}:1`, predKey])
    expect(plan.items[0]?.outcome).toBe('promoted')
  })

  it('takes a retirement slot no version has spent, so two promotions never collide', () => {
    const store = fakeStore()
    const predKey = predicateMemKey('mood')
    seedPredicate(store, 'mood', 'multi')
    seedRetiredVersion(store, predKey, PLAN_NOW + 5)
    const plan = expectOk(planOf({
      ops: [{ op: 'pred', pred: 'mood', cardinality: 'single' }],
    }, fakeContext(store, { caller: 'user' })))

    expect(plan.updates[0]?.payload['active_slot']).toBe(PLAN_NOW + 6)
    expect(plan.updates[0]?.payload['superseded_at']).toBe(PLAN_NOW)
  })

  it('asks the store only for slots this instant could still have spent', () => {
    const store = fakeStore()
    const predKey = predicateMemKey('mood')
    seedPredicate(store, 'mood', 'multi')
    // A long history the planner must not need to pay for: every slot below now
    // is old enough that slot + 1 cannot beat max(now, ...), so asking for them
    // would be reading the chain to compute a number the chain cannot change.
    for (let index = 0; index < 50; index += 1) seedRetiredVersion(store, predKey, PLAN_NOW - 1000 + index)
    const asked: { readonly memKey: string; readonly sinceMs: number }[] = []
    const context = fakeContext(store, { caller: 'user' })
    const plan = expectOk(planOf({
      ops: [{ op: 'pred', pred: 'mood', cardinality: 'single' }],
    }, {
      ...context,
      lookupSpentSlots: (memKey, sinceMs) => {
        asked.push({ memKey, sinceMs })
        return context.lookupSpentSlots(memKey, sinceMs)
      },
    }))

    expect(asked).toEqual([{ memKey: predKey, sinceMs: PLAN_NOW }])
    expect(plan.updates[0]?.payload['active_slot']).toBe(PLAN_NOW)
  })
})
describe('patch: an assertion against what is stored', () => {
  it('reports an existing memory instead of writing a second one', () => {
    const store = fakeStore()
    seedPredicate(store, 'likes', 'multi')
    seedNode(store, 'assertion:Elliott:likes:coffee', { kind: 'assertion', obj: 'coffee', obj_norm: 'coffee', active_slot: 1 })
    const plan = expectOk(planOf(tableOf(assertOp()), fakeContext(store)))

    expect(plan.nodes).toHaveLength(0)
    expect(plan.decisions).toHaveLength(0)
    expect(plan.items[0]).toMatchObject({ outcome: 'existing', memKey: 'assertion:Elliott:likes:coffee', value: 'coffee' })
  })

  it('rewrites a live value by retiring it for a new version', () => {
    const store = fakeStore()
    seedPredicate(store, 'lives_in', 'single')
    const live = seedNode(store, 'assertion:Elliott:lives_in', {
      kind: 'assertion', obj: 'Berlin', active_slot: 1, memo: 'kept',
    })
    const plan = expectOk(planOf(tableOf(assertOp({ pred: 'lives_in', obj: 'Lisbon' }), '用户搬去了里斯本'), fakeContext(store)))

    const memKey = 'assertion:Elliott:lives_in'
    // The old version keeps its value and its history; only the retirement
    // stamps are added, so an explicit history query can still read Berlin.
    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0]).toMatchObject({ memKey, nodeId: live.id })
    expect(plan.updates[0]?.payload).toMatchObject({
      obj: 'Berlin',
      memo: 'kept',
      active_slot: PLAN_NOW,
      superseded_at: PLAN_NOW,
    })
    expect(typeof plan.updates[0]?.payload['valid_to']).toBe('string')

    expect(plan.nodes).toHaveLength(1)
    expect(plan.nodes[0]?.memKey).toBe(memKey)
    expect(plan.nodes[0]?.payload).toMatchObject({ obj: 'Lisbon', active_slot: 1 })
    expect(plan.nodes[0]?.payload['superseded_at']).toBeUndefined()

    expect(plan.decisions).toHaveLength(1)
    expect(plan.decisions[0]).toMatchObject({
      decisionKind: 'supersede',
      targetMemKey: memKey,
      affected: [memKey],
      from: { kind: 'assertion', value: 'Berlin' },
      to: { kind: 'assertion', value: 'Lisbon' },
      reason: '用户搬去了里斯本',
    })
    expect(plan.items[0]).toMatchObject({ outcome: 'superseded', memKey, value: 'Lisbon' })
  })

  it('refuses a single-valued rewrite that carries no value', () => {
    const store = fakeStore()
    seedPredicate(store, 'lives_in', 'single')
    seedNode(store, 'assertion:Elliott:lives_in', { kind: 'assertion', obj: 'Berlin', active_slot: 1 })
    // A single-valued key takes its value from obj when one is given, but the
    // same write without one still lands on the live key -- so it has to be
    // refused here, not silently accepted as a rewrite that erases the fact.
    const result = planOf(tableOf(assertOp({ pred: 'lives_in', obj: undefined })), fakeContext(store))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.field).toBe('ops[0].obj')
    expect(result.reason).toBe('assertion:Elliott:lives_in 已有值「Berlin」，改写必须给出新的 obj，不能用空值覆盖')
  })

  it('accepts the same value twice in one table and writes one node', () => {
    const store = fakeStore()
    seedPredicate(store, 'likes', 'multi')
    const plan = expectOk(planOf({ ops: [assertOp(), assertOp()] }, fakeContext(store)))

    expect(plan.nodes).toHaveLength(1)
    expect(plan.decisions).toHaveLength(1)
    expect(plan.items.map(item => item.outcome)).toEqual(['created', 'existing'])
  })

  it('treats two values of a multi-valued predicate as two keys', () => {
    const store = fakeStore()
    seedPredicate(store, 'likes', 'multi')
    const plan = expectOk(planOf({ ops: [assertOp({ obj: 'coffee' }), assertOp({ obj: 'tea' })] }, fakeContext(store)))

    expect(plan.nodes.map(node => node.memKey)).toEqual([
      'assertion:Elliott:likes:coffee',
      'assertion:Elliott:likes:tea',
    ])
    expect(plan.items.map(item => item.outcome)).toEqual(['created', 'created'])
  })

  it('treats two spellings that normalise alike as one value', () => {
    const store = fakeStore()
    seedPredicate(store, 'likes', 'multi')
    const plan = expectOk(planOf({ ops: [assertOp({ obj: 'coffee' }), assertOp({ obj: 'Coffee!' })] }, fakeContext(store)))

    expect(plan.nodes).toHaveLength(1)
    expect(plan.items.map(item => item.outcome)).toEqual(['created', 'existing'])
  })
})

describe('patch: one bad op refuses the whole table', () => {
  it('writes nothing when a later op breaks a boundary rule', () => {
    const store = fakeStore()
    seedPredicate(store, 'likes', 'multi')
    seedPredicate(store, 'lives_in', 'single')
    const result = planOf({
      ops: [
        assertOp({ pred: 'likes', obj: 'coffee' }),
        assertOp({ pred: 'lives_in', obj: 'Berlin' }),
        assertOp({ subj: 'a:b', pred: 'likes', obj: 'tea' }),
      ],
    }, fakeContext(store))

    expect(result).toEqual({
      ok: false,
      code: 'E_BOUNDARY',
      field: 'ops[2].subj',
      reason: "subj 不能包含 ':'",
    })
  })

  it('writes nothing when a later op contradicts an earlier one', () => {
    const store = fakeStore()
    seedPredicate(store, 'likes', 'multi')
    seedPredicate(store, 'lives_in', 'single')
    seedNode(store, 'assertion:Elliott:lives_in', { kind: 'assertion', obj: 'Berlin', active_slot: 1 })
    // Two different values of one key inside one table is not two versions: the
    // table was meant to state one thing and states two, so it is refused whole.
    const result = planOf({
      ops: [
        assertOp({ pred: 'lives_in', obj: 'Lisbon' }),
        assertOp({ pred: 'lives_in', obj: 'Porto' }),
      ],
    }, fakeContext(store))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('E_CONFLICT')
    expect(result.field).toBe('ops[1].obj')
    expect(result.reason).toBe('同一张表里 assertion:Elliott:lives_in 有两个不同的值')
  })

  it('names the field when an object is refused for its own shape', () => {
    const store = fakeStore()
    seedPredicate(store, 'likes', 'multi')
    const result = planOf(tableOf(assertOp({ obj: 'a:b' })), fakeContext(store))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.field).toBe('ops[0].obj')
    expect(result.reason).toBe("obj 不能包含 ':'")
  })

  it('requires an object for a multi-valued predicate', () => {
    const store = fakeStore()
    seedPredicate(store, 'likes', 'multi')
    const result = planOf(tableOf(assertOp({ obj: undefined })), fakeContext(store))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.field).toBe('ops[0].obj')
    expect(result.reason).toBe('谓词 likes 是 multi，必须提供 obj')
  })

  it('requires an object when the predicate is unregistered and unknown', () => {
    const store = fakeStore()
    const result = planOf(tableOf(assertOp({ pred: 'mood', obj: undefined })), fakeContext(store))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.field).toBe('ops[0].obj')
    expect(result.reason).toBe('谓词 mood 未登记，且没有 obj 可以推断基数')
  })
})

describe('patch: a predicate the model proposes', () => {
  it('registers it as multi/candidate with an open flag, not by superseding', () => {
    const store = fakeStore()
    const plan = expectOk(planOf(tableOf(assertOp({ pred: 'mood', obj: 'calm' })), fakeContext(store, { caller: 'model' })))

    const predKey = predicateMemKey('mood')
    const pred = plan.nodes.find(node => node.memKey === predKey)
    expect(pred?.payload).toMatchObject({
      kind: 'pred',
      cardinality: 'multi',
      status: 'candidate',
      decided_by: 'model',
      aliases: [],
    })
    const flag = plan.nodes.find(node => node.memKey === 'flag:predicate_new:mood')
    expect(flag?.payload).toMatchObject({ flag_type: 'predicate_new', severity: 'info', status: 'open' })
    const assertion = plan.nodes.find(node => node.memKey === 'assertion:Elliott:mood:calm')
    expect(assertion).toBeDefined()
    expect(plan.updates).toHaveLength(0)
    expect(plan.decisions).toHaveLength(1)
    expect(plan.decisions[0]?.affected).toEqual([predKey, 'flag:predicate_new:mood', 'assertion:Elliott:mood:calm'])
  })

  it('registers one predicate for two asserts that need it', () => {
    const store = fakeStore()
    const plan = expectOk(planOf({
      ops: [assertOp({ pred: 'mood', obj: 'calm' }), assertOp({ pred: 'mood', obj: 'curious' })],
    }, fakeContext(store, { caller: 'model' })))

    expect(plan.nodes.filter(node => node.memKey === predicateMemKey('mood'))).toHaveLength(1)
    expect(plan.nodes.filter(node => node.memKey === 'flag:predicate_new:mood')).toHaveLength(1)
    expect(plan.items.map(item => item.outcome)).toEqual(['created', 'created'])
    expect(plan.decisions).toHaveLength(2)
  })

  it('downgrades to a scene node once the daily budget is spent', () => {
    const store = fakeStore()
    const plan = expectOk(planOf(tableOf(assertOp({ pred: 'mood', obj: 'calm' })), fakeContext(store, {
      caller: 'model',
      maxNewPredsPerDay: 20,
      newPredsToday: 20,
    })))

    expect(plan.downgraded).toBe(true)
    expect(plan.nodes).toHaveLength(1)
    const scene = plan.nodes[0]
    expect(scene?.memKey).toBe('scene:Elliott:mood:calm')
    expect(scene?.payload).toMatchObject({
      kind: 'scene',
      subj: 'Elliott',
      pred: 'mood',
      obj: 'calm',
      obj_norm: 'calm',
      active_slot: 1,
      vec_state: 'pending',
    })
    expect(plan.items[0]).toMatchObject({ outcome: 'downgraded', kind: 'scene', memKey: 'scene:Elliott:mood:calm' })
    expect(plan.decisions[0]?.to).toEqual({ kind: 'scene', obj_norm: 'calm' })
    expect(plan.decisions[0]?.reason).toContain('降级为场景文本')
  })

  it('still writes a known predicate once the budget is spent', () => {
    const store = fakeStore()
    seedPredicate(store, 'likes', 'multi')
    const plan = expectOk(planOf(tableOf(assertOp()), fakeContext(store, {
      caller: 'model',
      newPredsToday: 20,
    })))

    expect(plan.downgraded).toBe(false)
    expect(plan.items[0]?.outcome).toBe('created')
  })

  it('lets a user write past the cap, which only binds the model', () => {
    const store = fakeStore()
    const plan = expectOk(planOf(tableOf(assertOp({ pred: 'mood', obj: 'calm' })), fakeContext(store, {
      caller: 'user',
      newPredsToday: 20,
    })))

    expect(plan.downgraded).toBe(false)
    expect(plan.nodes.some(node => node.memKey === predicateMemKey('mood'))).toBe(true)
  })
})

describe('patch: a table that declares a predicate and then uses it', () => {
  it('uses the declared cardinality even when the declaration comes second', () => {
    const store = fakeStore()
    const plan = expectOk(planOf({
      ops: [
        assertOp({ pred: 'mood', obj: 'calm' }),
        { op: 'pred', pred: 'mood', cardinality: 'single' },
      ],
    }, fakeContext(store, { caller: 'user' })))

    expect(plan.nodes.map(node => node.memKey)).toEqual([
      predicateMemKey('mood'),
      'assertion:Elliott:mood',
    ])
    expect(plan.items.map(item => [item.op, item.outcome, item.memKey])).toEqual([
      ['pred', 'created', predicateMemKey('mood')],
      ['assert', 'created', 'assertion:Elliott:mood'],
    ])
  })

  it('refuses two values for one single-valued key in the same table', () => {
    const store = fakeStore()
    seedPredicate(store, 'mood', 'single')
    const result = planOf({ ops: [assertOp({ pred: 'mood', obj: 'calm' }), assertOp({ pred: 'mood', obj: 'curious' })] }, fakeContext(store))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('E_CONFLICT')
    expect(result.reason).toBe('同一张表里 assertion:Elliott:mood 有两个不同的值')
  })
})
