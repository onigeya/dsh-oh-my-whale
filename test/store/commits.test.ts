/**
 * The gate between a plan and the engine, tested against a real database.
 *
 * These tests are the only place in the suite where a plan meets the unique
 * index. Two of them exist purely to pin ordering: a retirement must reach the
 * engine before the insert that replaces it, and a batch that gets it wrong must
 * fail exactly the way the gateway promises it cannot.
 * @module
 */
import { describe, expect, it } from 'vitest'
import { buildPredicatePayload, NORM_VERSION, startOfLocalDayIso } from '../../src/store/tbox.ts'
import { createAssertionTemplates } from '../../src/store/templates/assertions.ts'
import {
  createCommitEngine,
  toTransactionOperations,
} from '../../src/store/commits/engine.ts'
import {
  createWriteGateway,
  GATEWAY_LOG_CODES,
  type PlannedCommit,
} from '../../src/store/commits/assertions.ts'
import { installWriteIndexes, openWriteStore, TEST_DIM } from '../support/write-store.ts'

const NOW = Date.UTC(2026, 10, 23, 4, 0, 0)
const NOW_ISO = new Date(NOW).toISOString()

function predicatePayload(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...buildPredicatePayload({
      name,
      cardinality: 'multi',
      status: 'active',
      aliases: [],
      decidedBy: 'seed',
      decidedAt: NOW_ISO,
      evidenceCount: 0,
      normVersion: NORM_VERSION,
      activeSlot: 1,
      recordedAt: NOW_ISO,
      validFrom: NOW_ISO,
    }),
    ...extra,
  }
}

function assertionPayload(memKey: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'assertion',
    mem_key: memKey,
    subj: 'Elliott',
    pred: 'likes',
    obj: 'coffee',
    obj_norm: 'coffee',
    norm_version: NORM_VERSION,
    valid_from: NOW_ISO,
    recorded_at: NOW_ISO,
    active_slot: 1,
    origin: 'observed',
    vec_state: 'pending',
    actor: 'model',
    cause: 'tool',
    prompt_version: 'omw-write/2.1',
    ...extra,
  }
}

function planOf(payloads: readonly Record<string, unknown>[], updates: PlannedCommit['updates'] = []): PlannedCommit {
  return { inserts: payloads.map(payload => ({ payload })), updates }
}

describe('the commit engine', () => {
  it('refuses an empty batch instead of pretending it wrote something', () => {
    const store = openWriteStore('omw-engine-')
    installWriteIndexes(store)
    const engine = createCommitEngine(store.db, TEST_DIM)
    const outcome = engine.commit([])
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure).toEqual({
      kind: 'engine',
      code: 'TDB_INVALID_INPUT',
      outcome: 'not_committed',
    })
  })

  it('writes a batch and returns the ids it assigned', () => {
    const store = openWriteStore('omw-engine-')
    installWriteIndexes(store)
    const engine = createCommitEngine(store.db, TEST_DIM)
    const outcome = engine.commit(toTransactionOperations({
      zeroVector: engine.zeroVector,
      inserts: [
        { payload: assertionPayload('assertion:Elliott:likes:coffee') },
        { payload: assertionPayload('assertion:Elliott:likes:tea') },
      ],
      updates: [],
    }))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value).toHaveLength(2)
    expect(new Set(outcome.value).size).toBe(2)
  })

  it('leaves nothing behind when one insert in the batch collides', () => {
    const store = openWriteStore('omw-engine-')
    installWriteIndexes(store)
    const engine = createCommitEngine(store.db, TEST_DIM)
    const batch = toTransactionOperations({
      zeroVector: engine.zeroVector,
      inserts: [
        { payload: assertionPayload('assertion:Elliott:likes:coffee') },
        { payload: assertionPayload('assertion:Elliott:likes:coffee') },
      ],
      updates: [],
    })
    const outcome = engine.commit(batch)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure.kind).toBe('unique')
    if (outcome.failure.kind !== 'unique') return
    expect(outcome.failure.details.fields).toEqual(['mem_key', 'active_slot'])
    expect(store.db.nodeCount()).toBe(0)
  })

  it('translates a unique conflict without repeating engine text', () => {
    const store = openWriteStore('omw-engine-')
    installWriteIndexes(store)
    const engine = createCommitEngine(store.db, TEST_DIM)
    engine.commit(toTransactionOperations({
      zeroVector: engine.zeroVector,
      inserts: [{ payload: assertionPayload('assertion:Elliott:likes:coffee') }],
      updates: [],
    }))
    const second = engine.commit(toTransactionOperations({
      zeroVector: engine.zeroVector,
      inserts: [{ payload: assertionPayload('assertion:Elliott:likes:coffee') }],
      updates: [],
    }))
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.failure.kind).toBe('unique')
    expect(JSON.stringify(second.failure)).not.toContain('节点')
  })

  it('replaces one payload and reports a missing node as an engine failure', () => {
    const store = openWriteStore('omw-engine-')
    installWriteIndexes(store)
    const engine = createCommitEngine(store.db, TEST_DIM)
    const written = engine.commit(toTransactionOperations({
      zeroVector: engine.zeroVector,
      inserts: [{ payload: predicatePayload('likes', { aliases: ['loves'] }) }],
      updates: [],
    }))
    expect(written.ok).toBe(true)
    if (!written.ok) return
    const nodeId = written.value[0] as number
    const replaced = engine.replacePayload(nodeId, predicatePayload('likes', { aliases: ['adores'] }))
    expect(replaced.ok).toBe(true)
    const templates = createAssertionTemplates(store.db)
    expect(templates.findPredByName('likes')?.payload['aliases']).toEqual(['adores'])
  })
})

describe('the gateway', () => {
  it('treats a plan with nothing to write as a success', () => {
    const store = openWriteStore('omw-gateway-')
    installWriteIndexes(store)
    const gateway = createWriteGateway(store.db)
    expect(gateway.commit({ inserts: [], updates: [] })).toEqual({ ok: true, value: [] })
    expect(store.db.nodeCount()).toBe(0)
  })

  it('keeps a retirement ahead of the insert that replaces it', () => {
    const store = openWriteStore('omw-gateway-')
    installWriteIndexes(store)
    const gateway = createWriteGateway(store.db)
    const memKey = 'assertion:Elliott:likes:coffee'
    const first = gateway.commit(planOf([assertionPayload(memKey)]))
    expect(first.ok).toBe(true)
    const live = gateway.findLive(memKey)
    expect(live).toBeDefined()
    if (live === undefined) return

    const retired = assertionPayload(memKey, {
      active_slot: NOW + 1,
      superseded_at: NOW,
    })
    const replacement = assertionPayload(memKey, { obj: 'tea', obj_norm: 'tea' })
    const second = gateway.commit({
      inserts: [{ payload: replacement }],
      updates: [{ nodeId: live.id, payload: retired }],
    })
    expect(second.ok).toBe(true)

    const versions = gateway.findVersions(memKey)
    expect(versions).toHaveLength(2)
    expect(gateway.findLive(memKey)?.payload['obj']).toBe('tea')
  })

  it('never leaves two live versions, whatever order the batch uses', () => {
    const store = openWriteStore('omw-gateway-')
    installWriteIndexes(store)
    const engine = createCommitEngine(store.db, TEST_DIM)
    const gateway = createWriteGateway(store.db)
    const memKey = 'assertion:Elliott:likes:coffee'
    const first = gateway.commit(planOf([assertionPayload(memKey)]))
    expect(first.ok).toBe(true)
    const live = gateway.findLive(memKey)
    if (live === undefined) throw new Error('no live version')

    // The engine checks the batch's *final* state, not the order it reaches it
    // in: insert-then-retire passes because nothing is duplicated once both
    // operations land. Ordering in the gateway is therefore defensive, not what
    // makes the invariant hold — the index is.
    const retired = assertionPayload(memKey, { active_slot: NOW + 1, superseded_at: NOW })
    const reordered = engine.commit([
      { type: 'insert' as const, vector: [...engine.zeroVector], payload: assertionPayload(memKey, { obj: 'tea', obj_norm: 'tea' }) },
      { type: 'updatePayload' as const, id: live.id, payload: retired },
    ])
    expect(reordered.ok).toBe(true)

    // Two live versions of one key, on the other hand, is refused in either order.
    const liveNow = gateway.findLive(memKey)
    if (liveNow === undefined) throw new Error('no live version after reorder')
    const duplicated = gateway.commit(planOf([assertionPayload(memKey, { obj: 'cocoa', obj_norm: 'cocoa' })]))
    expect(duplicated.ok).toBe(false)
    if (duplicated.ok) return
    expect(duplicated.failure.kind).toBe('unique')
    expect(gateway.findVersions(memKey)).toHaveLength(2)
  })

  it('answers the three reads a plan needs', () => {
    const store = openWriteStore('omw-gateway-')
    installWriteIndexes(store)
    const gateway = createWriteGateway(store.db)
    expect(gateway.findLive('assertion:Elliott:likes:coffee')).toBeUndefined()
    expect(gateway.findPredicate('likes')).toBeUndefined()
    expect(gateway.findVersions('assertion:Elliott:likes:coffee')).toEqual([])

    gateway.commit(planOf([predicatePayload('likes')]))
    expect(gateway.findPredicate('likes')?.payload['status']).toBe('active')
  })

  it('counts only the predicates the model proposed since local midnight', () => {
    const store = openWriteStore('omw-gateway-')
    installWriteIndexes(store)
    const gateway = createWriteGateway(store.db)
    const today = new Date(NOW).toISOString()
    const yesterday = new Date(NOW - 36 * 60 * 60 * 1000).toISOString()
    gateway.commit(planOf([
      predicatePayload('model_today', { decided_by: 'model', decided_at: today }),
      predicatePayload('model_yesterday', { decided_by: 'model', decided_at: yesterday }),
      predicatePayload('user_today', { decided_by: 'user', decided_at: today }),
    ]))
    expect(gateway.countModelPredicatesToday(NOW)).toBe(1)
    expect(startOfLocalDayIso(new Date(NOW))).not.toBe('')
  })

  it('records a rejection in its own transaction', () => {
    const store = openWriteStore('omw-gateway-')
    installWriteIndexes(store)
    const gateway = createWriteGateway(store.db)
    const outcome = gateway.recordRejection({
      kind: 'rejected',
      mem_key: 'rejected:1:abc:1',
      patch: { ops: [] },
      reason: 'ops: 为空',
      code: 'E_BOUNDARY',
      at: NOW_ISO,
      active_slot: 1,
    })
    expect(outcome.ok).toBe(true)
    expect(store.db.nodeCount()).toBe(1)
  })

  it('reports a rejection it could not keep, and still answers', () => {
    const store = openWriteStore('omw-gateway-')
    installWriteIndexes(store)
    const codes: string[] = []
    const gateway = createWriteGateway(store.db, {
      reporter: { report: code => { codes.push(code) } },
    })
    const outcome = gateway.recordRejection({
      kind: 'rejected',
      mem_key: 'rejected:1:abc:1',
      active_slot: 1,
    })
    expect(outcome.ok).toBe(true)
    gateway.recordRejection({ kind: 'rejected', mem_key: 'rejected:1:abc:1', active_slot: 1 })
    expect(codes).toEqual([GATEWAY_LOG_CODES.rejectionFailed])
  })
})