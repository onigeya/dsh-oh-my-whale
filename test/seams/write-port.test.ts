/**
 * The write service, tested through its public surface only.
 *
 * Every test here goes through `remember` or `promote` — the same calls the
 * remember tool and `/omw pred promote` make — so what is pinned is the answer a
 * caller receives, the state the store is left in, and the audit row that
 * records it. Nothing reaches into the planner or the gateway directly.
 * @module
 */
import { describe, expect, it } from 'vitest'
import { createAudit, createMemoryAuditSink, type AuditRow } from '../../src/ops/audit.ts'
import { ensureSchema } from '../../src/store/schema.ts'
import { createAssertionTemplates } from '../../src/store/templates/assertions.ts'
import { createWritePort, E_OK, type WritePort, type WriteAnswer } from '../../src/seams/write-port.ts'
import { installWriteIndexes, openWriteStore, type WriteStore } from '../support/write-store.ts'

const NOW = Date.UTC(2026, 10, 23, 4, 0, 0)

interface Harness {
  readonly store: WriteStore
  readonly port: WritePort
  readonly rows: () => readonly AuditRow[]
  readonly warnings: readonly string[]
}

function harness(options: { readonly maxNewPredsPerDay?: number; readonly bootstrapped?: boolean } = {}): Harness {
  const store = openWriteStore('omw-port-')
  installWriteIndexes(store)
  if (options.bootstrapped !== false) {
    const schema = ensureSchema(store.db, { now: () => NOW })
    if (!schema.ok || !schema.writable) throw new Error('bootstrap failed')
  }
  const sink = createMemoryAuditSink()
  const audit = createAudit({ dataDir: store.dataDir, now: () => new Date(NOW), sink })
  const warnings: string[] = []
  const port = createWritePort({
    db: store.db,
    audit,
    logger: { warn: (code: string) => { warnings.push(code) } },
    maxNewPredsPerDay: options.maxNewPredsPerDay ?? 20,
    contractVersion: 1,
    now: () => NOW,
  })
  return { store, port, rows: () => audit.rows, warnings }
}

function assertOp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'likes', obj: 'coffee', ...overrides }
}

function answerOf(answer: WriteAnswer): WriteAnswer {
  return answer
}

describe('writing one assertion', () => {
  it('lands the node, the ledger row and one audit row', async () => {
    const h = harness()
    const before = h.store.db.nodeCount()
    const answer = answerOf(await h.port.remember({ ops: [assertOp()] }, 'model', 'remember'))

    expect(answer.ok).toBe(true)
    expect(answer.code).toBe(E_OK)
    expect(answer.mem_keys).toEqual(['assertion:Elliott:likes:coffee'])
    expect(answer.items).toEqual([
      { index: 1, op: 'assert', outcome: 'created', mem_key: 'assertion:Elliott:likes:coffee', kind: 'assertion', value: 'coffee' },
    ])
    expect(answer.message).toBe('写入 1 条新事实。')

    // One assertion plus one decision: the ledger rides in the same transaction.
    expect(h.store.db.nodeCount()).toBe(before + 2)
    const templates = createAssertionTemplates(h.store.db)
    expect(templates.findLiveByKey('assertion:Elliott:likes:coffee')?.payload['obj']).toBe('coffee')

    const rows = h.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'write',
      outcome: 'committed',
      code: E_OK,
      mem_keys: ['assertion:Elliott:likes:coffee'],
    })
  })

  it('answers an already-known value without writing a second node', async () => {
    const h = harness()
    await h.port.remember({ ops: [assertOp()] }, 'model', 'remember')
    const afterFirst = h.store.db.nodeCount()
    const answer = await h.port.remember({ ops: [assertOp()] }, 'model', 'remember')

    expect(answer.ok).toBe(true)
    expect(answer.items.map(item => item.outcome)).toEqual(['existing'])
    expect(answer.message).toBe('写入 0 条新事实，1 条已存在。')
    expect(h.store.db.nodeCount()).toBe(afterFirst)
    expect(h.rows()).toHaveLength(2)
  })

  it('refuses a different value for a single-valued fact, and says why', async () => {
    const h = harness()
    await h.port.remember({ ops: [assertOp({ pred: 'name', obj: 'Elliott' })] }, 'user', 'remember')
    const afterFirst = h.store.db.nodeCount()
    const answer = await h.port.remember({ ops: [assertOp({ pred: 'name', obj: 'Eliot' })] }, 'user', 'remember')

    expect(answer.ok).toBe(false)
    expect(answer.code).toBe('E_CONFLICT')
    expect(answer.items).toEqual([])
    expect(answer.mem_keys).toEqual([])
    expect(answer.message).toContain('已有不同的值')
    // The rejected row is a second transaction, so exactly one node lands.
    expect(h.store.db.nodeCount()).toBe(afterFirst + 1)
    expect(h.rows().at(-1)).toMatchObject({ outcome: 'rejected', code: 'E_CONFLICT' })
  })

  it('refuses a table it cannot parse, and still records the refusal', async () => {
    const h = harness()
    const answer = await h.port.remember({ ops: [] }, 'model', 'remember')

    expect(answer.ok).toBe(false)
    expect(answer.code).toBe('E_BOUNDARY')
    expect(answer.message).toMatch(/^ops：/)
    expect(h.store.db.nodeCount()).toBe(11)
    expect(h.rows().at(-1)).toMatchObject({ outcome: 'rejected', code: 'E_BOUNDARY', mem_keys: [] })
  })

  it('keeps one decision row per op in a table with two ops', async () => {
    const h = harness()
    const before = h.store.db.nodeCount()
    const answer = await h.port.remember({
      ops: [assertOp(), assertOp({ obj: 'tea' })],
    }, 'model', 'remember')

    expect(answer.ok).toBe(true)
    expect(answer.items.map(item => item.index)).toEqual([1, 2])
    expect(h.store.db.nodeCount()).toBe(before + 4)
  })

  it('answers E_GATE_DOWN, not E_CONFLICT, once the port is closed', async () => {
    const h = harness()
    await h.port.dispose()
    const answer = await h.port.remember({ ops: [assertOp()] }, 'model', 'remember')

    expect(answer.ok).toBe(false)
    expect(answer.code).toBe('E_GATE_DOWN')
    expect(answer.message).toBe('写面已关闭，本次调用没有落库。')
    expect(answer.items).toEqual([])
  })

  it('drains a queued write before it closes the handle', async () => {
    const h = harness()
    const pending = h.port.remember({ ops: [assertOp()] }, 'model', 'remember')
    await h.port.dispose()
    const answer = await pending

    // The write ran to completion: a discarded task would have answered
    // E_GATE_DOWN and left no committed audit row behind.
    expect(answer.ok).toBe(true)
    expect(answer.mem_keys).toEqual(['assertion:Elliott:likes:coffee'])
    expect(h.rows().map(row => row.kind === 'write' ? row.outcome : row.kind)).toEqual(['committed'])
  })
})

describe('a predicate the model proposes', () => {
  it('writes the registry entry, its flag and the assertion together', async () => {
    const h = harness()
    const before = h.store.db.nodeCount()
    const answer = await h.port.remember({ ops: [assertOp({ pred: 'mood', obj: 'calm' })] }, 'model', 'remember')

    expect(answer.ok).toBe(true)
    expect(answer.items).toEqual([
      { index: 1, op: 'assert', outcome: 'created', mem_key: 'assertion:Elliott:mood:calm', kind: 'assertion', value: 'calm' },
    ])
    // pred + flag + assertion + decision
    expect(h.store.db.nodeCount()).toBe(before + 4)
    const templates = createAssertionTemplates(h.store.db)
    const pred = templates.findPredByName('mood')
    expect(pred?.payload).toMatchObject({ cardinality: 'multi', status: 'candidate', decided_by: 'model' })
  })

  it('refuses a registry change from the model', async () => {
    const h = harness()
    const before = h.store.db.nodeCount()
    const answer = await h.port.remember({
      ops: [{ op: 'pred', pred: 'mood', cardinality: 'single', reason: '模型想改' }],
    }, 'model', 'remember')

    expect(answer.ok).toBe(false)
    expect(answer.code).toBe('E_BOUNDARY')
    expect(answer.message).toContain('只接受用户调用方')
    expect(h.store.db.nodeCount()).toBe(before + 1)
  })

  it('downgrades a new predicate once the daily cap is spent', async () => {
    const h = harness({ maxNewPredsPerDay: 1 })
    const first = await h.port.remember({ ops: [assertOp({ pred: 'mood', obj: 'calm' })] }, 'model', 'remember')
    expect(first.ok).toBe(true)

    const second = await h.port.remember({ ops: [assertOp({ pred: 'hobby', obj: 'chess' })] }, 'model', 'remember')
    expect(second.ok).toBe(true)
    expect(second.code).toBe('E_DEGRADED')
    expect(second.items.map(item => item.outcome)).toEqual(['downgraded'])
    expect(second.message).toContain('降级为场景文本')
    expect(h.rows().at(-1)).toMatchObject({ outcome: 'downgraded', code: 'E_DEGRADED' })

    const templates = createAssertionTemplates(h.store.db)
    expect(templates.findPredByName('hobby')).toBeUndefined()
    expect(templates.findLiveByKey('scene:Elliott:hobby:chess')).toBeDefined()
  })
})

describe('promoting a predicate', () => {
  it('turns a candidate into a single-valued entry the user owns', async () => {
    const h = harness()
    await h.port.remember({ ops: [assertOp({ pred: 'mood', obj: 'calm' })] }, 'model', 'remember')
    const answer = await h.port.promote('mood', 'single', '用户要求单值')

    expect(answer.ok).toBe(true)
    expect(answer.items).toEqual([
      { index: 1, op: 'pred', outcome: 'promoted', mem_key: 'pred:mood', kind: 'pred' },
    ])
    const templates = createAssertionTemplates(h.store.db)
    const pred = templates.findPredByName('mood')
    expect(pred?.payload).toMatchObject({ cardinality: 'single', status: 'active', decided_by: 'user' })
  })

  it('writes a predicate the registry never had', async () => {
    const h = harness()
    const answer = await h.port.promote('hobby', 'multi', '用户要求登记')

    expect(answer.ok).toBe(true)
    expect(answer.items.map(item => item.outcome)).toEqual(['created'])
    const templates = createAssertionTemplates(h.store.db)
    expect(templates.findPredByName('hobby')?.payload).toMatchObject({
      cardinality: 'multi',
      status: 'active',
      decided_by: 'user',
    })
  })

  it('records the promotion in the ledger with both sides', async () => {
    const h = harness()
    await h.port.remember({ ops: [assertOp({ pred: 'mood', obj: 'calm' })] }, 'model', 'remember')
    const before = h.store.db.nodeCount()
    await h.port.promote('mood', 'single', '用户要求单值')

    const rows: Record<string, unknown>[] = []
    for (const id of h.store.db.allNodeIds()) {
      const payload = h.store.db.getPayload(id) as Record<string, unknown> | undefined
      if (payload?.['kind'] === 'decision') rows.push(payload)
    }
    const promotion = rows.find(row => row['decision_kind'] === 'supersede')
    expect(promotion).toBeDefined()
    expect(promotion?.['actor']).toBe('user')
    expect(promotion?.['from']).toMatchObject({ cardinality: 'multi' })
    expect(promotion?.['to']).toMatchObject({ cardinality: 'single' })
    expect(h.store.db.nodeCount()).toBeGreaterThan(before)
  })

  it('refuses a promotion the port cannot make, without throwing', async () => {
    const h = harness()
    await h.port.dispose()
    const answer = await h.port.promote('mood', 'single', '太晚了')
    expect(answer.ok).toBe(false)
    expect(answer.code).toBe('E_GATE_DOWN')
  })
})

describe('one bad op refuses the whole table', () => {
  it('stores nothing when a writable op shares a table with a conflicting one', async () => {
    const h = harness()
    // A single-valued fact already on file: the second op below contradicts it,
    // and rewriting it belongs to Story 2.3, not to this table.
    await h.port.remember({ ops: [assertOp({ pred: 'name', obj: 'Elliott' })] }, 'user', 'remember')
    const before = h.store.db.nodeCount()
    const rowsBefore = h.rows().length

    const answer = await h.port.remember({
      ops: [
        assertOp({ obj: 'tea' }),
        assertOp({ pred: 'name', obj: 'Eliot' }),
      ],
    }, 'model', 'remember')

    expect(answer.ok).toBe(false)
    expect(answer.code).toBe('E_CONFLICT')
    expect(answer.items).toEqual([])
    expect(answer.mem_keys).toEqual([])
    // The writable op did not slip through: one rejection row, nothing else.
    expect(h.store.db.nodeCount()).toBe(before + 1)
    const rows = h.rows().slice(rowsBefore)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'write', outcome: 'rejected', code: 'E_CONFLICT', mem_keys: [] })
    const templates = createAssertionTemplates(h.store.db)
    expect(templates.findLiveByKey('assertion:Elliott:likes:tea')).toBeUndefined()
  })

  it('reports the same item shape whether the table or the store refused it', async () => {
    const h = harness()
    await h.port.remember({ ops: [assertOp({ pred: 'name', obj: 'Elliott' })] }, 'user', 'remember')

    const stored = await h.port.remember({
      ops: [assertOp({ pred: 'name', obj: 'Eliot' })],
    }, 'model', 'remember')
    const inTable = await h.port.remember({
      ops: [assertOp({ pred: 'name', obj: 'Elliott' }), assertOp({ pred: 'name', obj: 'Eliot' })],
    }, 'model', 'remember')

    expect(stored.code).toBe('E_CONFLICT')
    expect(inTable.code).toBe('E_CONFLICT')
    expect(stored.items).toEqual(inTable.items)
    expect(stored.mem_keys).toEqual(inTable.mem_keys)
    expect(stored.items).toEqual([])
  })
})

describe('the audit row', () => {
  it('names the keys that became readable and measures the write', async () => {
    const h = harness()
    await h.port.remember({ ops: [assertOp(), assertOp({ pred: 'dislikes', obj: 'rain' })] }, 'model', 'remember')
    const row = h.rows()[0]
    expect(row).toBeDefined()
    if (row === undefined || row.kind !== 'write') throw new Error('no write row')
    expect(row.mem_keys).toEqual([
      'assertion:Elliott:likes:coffee',
      'assertion:Elliott:dislikes:rain',
    ])
    expect(typeof row.elapsed_ms).toBe('number')
    expect(row.elapsed_ms).toBeGreaterThanOrEqual(0)
    expect(row.ts).toBe(new Date(NOW).toISOString())
  })
})