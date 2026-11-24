/**
 * The evidence half of one transaction, at the store layer.
 *
 * The promise this file pins is atomicity: a pointer, the assertion it supports
 * and the edge between them either all land or none of them do. That is why the
 * tests drive `createWriteGateway` directly — the ids are chosen here, before the
 * commit, and a batch that cannot be written whole must leave `nodeCount` exactly
 * where it was.
 * @module
 */
import { describe, expect, it } from 'vitest'
import { createWriteGateway } from '../../src/store/commits/assertions.ts'
import { createReadGateway } from '../../src/store/commits/reads.ts'
import { buildEvidencePayload, evidenceMemKey } from '../../src/core/evidence.ts'
import { buildAssertPayload } from '../../src/core/patch.ts'
import { createEvidenceTemplates } from '../../src/store/templates/evidence.ts'
import { createAssertionTemplates } from '../../src/store/templates/assertions.ts'
import { installWriteIndexes, openWriteStore } from '../support/write-store.ts'

const WARMUP = 100
const SAMPLES = 200

const NOW = Date.UTC(2026, 10, 24, 2, 0, 0)
const NOW_ISO = new Date(NOW).toISOString()

/** Open a store with the 2.1 indexes in place and a gateway over it. */
function harness() {
  const store = openWriteStore('omw-evidence-')
  installWriteIndexes(store)
  const gateway = createWriteGateway(store.db)
  return { store, gateway }
}

/** One assertion payload, as the planner would build it. */
function assertionPayload(memKey: string, obj: string): Record<string, unknown> {
  const [kind, subj, pred] = memKey.split(':')
  return buildAssertPayload({
    kind: kind as 'assertion',
    memKey,
    subj: subj as string,
    pred: pred as string,
    obj,
    nowIso: NOW_ISO,
    caller: 'model',
  })
}

/** One evidence payload for a range in one session. */
function evidencePayload(sessionId: string, seqFrom: number, seqTo: number, quote: string, deidentified = false) {
  return buildEvidencePayload({
    memKey: evidenceMemKey(sessionId, seqFrom, seqTo),
    sessionId,
    seqFrom,
    seqTo,
    quote,
    quoteTruncated: false,
    deidentified,
  })
}

describe('one batch: assertion, pointer and edge', () => {
  it('commits all three, with the edge pointing from the pointer to the assertion', () => {
    const { store, gateway } = harness()
    const before = store.db.nodeCount()
    const ids = gateway.allocateIds(2)
    expect(ids).toHaveLength(2)
    expect(store.db.contains(ids[0]!)).toBe(false)
    expect(store.db.contains(ids[1]!)).toBe(false)

    const outcome = gateway.commit({
      inserts: [
        { id: ids[0]!, payload: assertionPayload('assertion:Elliott:likes:coffee', 'coffee') },
        { id: ids[1]!, payload: evidencePayload('sess-1', 5, 6, '我喜欢咖啡') },
      ],
      updates: [],
      links: [{ src: ids[1]!, dst: ids[0]!, label: 'supports' }],
    })
    expect(outcome.ok).toBe(true)
    expect(store.db.nodeCount()).toBe(before + 2)

    const assertion = createAssertionTemplates(store.db).findLiveByKey('assertion:Elliott:likes:coffee')
    expect(assertion).toBeDefined()
    const incoming = store.db.getIncomingEdges(assertion!.id, 'supports')
    expect(incoming).toHaveLength(1)
    expect(incoming[0]!.sourceId).toBe(ids[1])

    const evidence = createEvidenceTemplates(store.db).findByKey(evidenceMemKey('sess-1', 5, 6))
    expect(evidence?.id).toBe(ids[1])
    expect(evidence?.payload['quote']).toBe('我喜欢咖啡')
  })

  it('stores exactly the eight keys AD-6 allows, and nothing else', () => {
    const { store, gateway } = harness()
    const ids = gateway.allocateIds(1)
    gateway.commit({
      inserts: [{ id: ids[0]!, payload: evidencePayload('sess-1', 1, 1, '一句话') }],
      updates: [],
    })
    const payload = store.db.getPayload(ids[0]!) as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual([
      'deidentified', 'kind', 'mem_key', 'quote', 'quote_truncated', 'seq_from', 'seq_to', 'session_id',
    ])
    // No copied message body, and no node-id bookkeeping leaking into the payload.
    expect(payload['quote']).toBe('一句话')
    expect(payload).not.toHaveProperty('active_slot')
  })

  it('writes an already-masked quote as it is handed over', () => {
    const { store, gateway } = harness()
    const ids = gateway.allocateIds(1)
    gateway.commit({
      inserts: [{ id: ids[0]!, payload: evidencePayload('sess-1', 2, 2, '电话 [手机号]', true) }],
      updates: [],
    })
    const payload = store.db.getPayload(ids[0]!) as Record<string, unknown>
    expect(payload['quote']).toBe('电话 [手机号]')
    expect(payload['deidentified']).toBe(true)
  })
})

describe('a batch that cannot be written whole', () => {
  it('leaves no pointer behind when the engine refuses the batch', () => {
    const { store, gateway } = harness()
    // Take an id that already exists: the engine refuses the whole batch.
    const existing = gateway.allocateIds(1)[0]!
    expect(gateway.commit({
      inserts: [{ id: existing, payload: evidencePayload('sess-1', 3, 3, '先写进去') }],
      updates: [],
    }).ok).toBe(true)
    const afterFirst = store.db.nodeCount()

    const outcome = gateway.commit({
      inserts: [
        { payload: assertionPayload('assertion:Elliott:likes:tea', 'tea') },
        { id: existing, payload: evidencePayload('sess-1', 4, 4, '这一批应该整体失败') },
      ],
      updates: [],
    })
    expect(outcome.ok).toBe(false)
    expect(store.db.nodeCount()).toBe(afterFirst)
    expect(createEvidenceTemplates(store.db).findByKey(evidenceMemKey('sess-1', 4, 4))).toBeUndefined()
    expect(createAssertionTemplates(store.db).findLiveByKey('assertion:Elliott:likes:tea')).toBeUndefined()
  })

  it('treats an empty plan as a no-op success', () => {
    const { store, gateway } = harness()
    const before = store.db.nodeCount()
    expect(gateway.commit({ inserts: [], updates: [] })).toEqual({ ok: true, value: [] })
    expect(store.db.nodeCount()).toBe(before)
  })
})

describe('reading the pointers of one assertion', () => {
  it('answers with the pointer that supports it, and nothing for an unknown key', () => {
    const { store, gateway } = harness()
    const ids = gateway.allocateIds(2)
    gateway.commit({
      inserts: [
        { id: ids[0]!, payload: assertionPayload('assertion:Elliott:likes:coffee', 'coffee') },
        { id: ids[1]!, payload: evidencePayload('sess-1', 7, 8, '来源在这里') },
      ],
      updates: [],
      links: [{ src: ids[1]!, dst: ids[0]!, label: 'supports' }],
    })
    const reader = createReadGateway(store.db)
    const pointers = reader.listEvidenceFor('assertion:Elliott:likes:coffee')
    expect(pointers).toHaveLength(1)
    expect(pointers[0]!.payload['session_id']).toBe('sess-1')
    expect(reader.listEvidenceFor('assertion:Elliott:likes:nothing')).toEqual([])
  })

  it('answers a retired key with nothing rather than with stale edges', () => {
    const { store, gateway } = harness()
    const ids = gateway.allocateIds(2)
    gateway.commit({
      inserts: [
        { id: ids[0]!, payload: assertionPayload('assertion:Elliott:likes:coffee', 'coffee') },
        { id: ids[1]!, payload: evidencePayload('sess-1', 9, 9, '旧来源') },
      ],
      updates: [],
      links: [{ src: ids[1]!, dst: ids[0]!, label: 'supports' }],
    })
    // Retire the assertion the way a supersede will: no deletion, slot moves on.
    const live = gateway.findLive('assertion:Elliott:likes:coffee')!
    gateway.commit({
      inserts: [],
      updates: [{ nodeId: live.id, payload: { ...live.payload, active_slot: NOW + 1, superseded_at: NOW_ISO } }],
    })
    expect(createReadGateway(store.db).listEvidenceFor('assertion:Elliott:likes:coffee')).toEqual([])
  })
})

/** One neighbour percentile value from an unsorted sample. */
function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index] ?? 0
}

/** Milliseconds from one clock reading to the next. */
function timed(): () => number {
  let previous = performance.now()
  return () => {
    const now = performance.now()
    const elapsed = now - previous
    previous = now
    return elapsed
  }
}

describe('perf: a write that declares a source', () => {
  it(`keeps 200 evidence writes inside the budget, and near the same write without one`, () => {
    const { gateway } = harness()
    const withEvidence: number[] = []
    const without: number[] = []
    const next = timed()

    // Warm-up pays for index and page work the steady state should not carry.
    for (let index = 0; index < WARMUP; index += 1) {
      const ids = gateway.allocateIds(2)
      const committed = gateway.commit({
        inserts: [
          { id: ids[0]!, payload: assertionPayload(`assertion:Perf:likes:w${index}`, `w${index}`) },
          { id: ids[1]!, payload: evidencePayload('perf', index, index, '预热') },
        ],
        updates: [],
        links: [{ src: ids[1]!, dst: ids[0]!, label: 'supports' }],
      })
      if (!committed.ok) throw new Error('warm-up write failed')
    }

    for (let index = 0; index < SAMPLES; index += 1) {
      const seq = WARMUP + index
      const ids = gateway.allocateIds(2)
      const committed = gateway.commit({
        inserts: [
          { id: ids[0]!, payload: assertionPayload(`assertion:Perf:likes:e${index}`, `e${index}`) },
          { id: ids[1]!, payload: evidencePayload('perf', seq, seq, '带来源的一次写入') },
        ],
        updates: [],
        links: [{ src: ids[1]!, dst: ids[0]!, label: 'supports' }],
      })
      if (!committed.ok) throw new Error('write failed')
      withEvidence.push(next())
    }
    for (let index = 0; index < SAMPLES; index += 1) {
      const committed = gateway.commit({
        inserts: [{ payload: assertionPayload(`assertion:Perf:likes:p${index}`, `p${index}`) }],
        updates: [],
      })
      if (!committed.ok) throw new Error('write failed')
      without.push(next())
    }

    const median = percentile(withEvidence, 0.5)
    const p95 = percentile(withEvidence, 0.95)
    const baseMedian = Math.max(0.001, percentile(without, 0.5))
    const ratio = median / baseMedian
    // Publish the numbers: the story's evidence quotes them.
    process.stdout.write(
      `perf evidence: median=${median.toFixed(3)}ms p95=${p95.toFixed(3)}ms ratio=${ratio.toFixed(2)}x\n`,
    )

    expect(median).toBeLessThanOrEqual(2)
    expect(p95).toBeLessThanOrEqual(10)
    // A pointer costs a node, an edge and two reserved ids: bounded, not free.
    expect(ratio).toBeLessThanOrEqual(5)
  })
})

describe('reserving ids', () => {
  it('reserves ids the store does not yet hold, ascending', () => {
    const { store, gateway } = harness()
    store.db.insert(new Array(4).fill(0), { kind: 'probe', mem_key: 'probe:a:1', active_slot: 1 })
    const ids = gateway.allocateIds(3)
    expect(ids).toHaveLength(3)
    expect([...ids].sort((a, b) => a - b)).toEqual([...ids])
    for (const id of ids) expect(store.db.contains(id)).toBe(false)
  })

  it('reserves nothing for a batch that needs no ids', () => {
    const { gateway } = harness()
    expect(gateway.allocateIds(0)).toEqual([])
  })
})
