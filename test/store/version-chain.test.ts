/**
 * The version chain, end to end, through the write port and the read gateway.
 *
 * Story 2.3 promises three things a reader can check: a rewrite retires the old
 * version instead of overwriting it, the history still returns both versions,
 * and every accepted change leaves exactly one ledger entry. The tests drive
 * `remember` — the same call the tool makes — so what is pinned is the state a
 * caller can observe, not the planner's internal shape.
 * @module
 */
import { describe, expect, it } from 'vitest'
import { decisionView } from '../../src/core/decisions.ts'
import { ensureSchema } from '../../src/store/schema.ts'
import { createReadGateway } from '../../src/store/commits/reads.ts'
import { createWritePort, E_OK, type WritePort } from '../../src/seams/write-port.ts'
import { createAudit, createMemoryAuditSink } from '../../src/ops/audit.ts'
import { installWriteIndexes, openWriteStore, type WriteStore } from '../support/write-store.ts'

const NOW = Date.UTC(2026, 10, 23, 4, 0, 0)
const LATER = NOW + 60_000
const KEY = 'assertion:Elliott:lives_in'

interface Harness {
  readonly store: WriteStore
  readonly port: WritePort
  /** The read surface a command uses, for assertions about what is stored. */
  readonly gateway: ReturnType<typeof createReadGateway>
  readonly at: (ms: number) => void
}

/** A writable store with the schema bootstrapped and a port whose clock we drive. */
function harness(): Harness {
  const store = openWriteStore('omw-versions-')
  installWriteIndexes(store)
  const schema = ensureSchema(store.db, { now: () => NOW })
  if (!schema.ok || !schema.writable) throw new Error('bootstrap failed')
  const clock = { now: NOW }
  const port = createWritePort({
    db: store.db,
    audit: createAudit({ dataDir: store.dataDir, now: () => new Date(clock.now), sink: createMemoryAuditSink() }),
    logger: { warn: () => {} },
    maxNewPredsPerDay: 20,
    contractVersion: 1,
    now: () => clock.now,
  })
  return { store, port, gateway: createReadGateway(store.db), at: (ms: number) => { clock.now = ms } }
}

/** One single-valued assertion; `lives_in` is seeded single, so it has one key. */
function cityOp(obj: string): Record<string, unknown> {
  return { op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'lives_in', obj }
}

describe('rewriting a live value', () => {
  it('retires the old version instead of overwriting it', async () => {
    const h = harness()
    const first = await h.port.remember({ ops: [cityOp('杭州')] }, 'model', 'remember')
    expect(first.ok).toBe(true)
    expect(first.items[0]?.outcome).toBe('created')

    h.at(LATER)
    const second = await h.port.remember({ ops: [cityOp('上海')] }, 'model', 'remember')
    expect(second.ok).toBe(true)
    // The caller is told this was a rewrite, not a fresh fact.
    expect(second.items[0]?.outcome).toBe('superseded')
    expect(second.mem_keys).toEqual([KEY])

    const reads = createReadGateway(h.store.db)
    const live = reads.findLive(KEY)
    expect(live?.payload['obj']).toBe('上海')
    expect(live?.payload).not.toHaveProperty('superseded_at')

    // The old value is still there, retired rather than deleted (AD-5).
    const versions = reads.findVersions(KEY)
    expect(versions).toHaveLength(2)
    const retired = versions.find(node => node.payload['obj'] === '杭州')
    expect(retired?.payload['superseded_at']).toBe(LATER)
    expect(retired?.payload['valid_to']).toBe(new Date(LATER).toISOString())
    expect(retired?.payload['active_slot']).not.toBe(1)
  })

  it('keeps a default read to the live version only', async () => {
    const h = harness()
    await h.port.remember({ ops: [cityOp('杭州')] }, 'model', 'remember')
    h.at(LATER)
    await h.port.remember({ ops: [cityOp('上海')] }, 'model', 'remember')
    const live = createReadGateway(h.store.db).findLive(KEY)
    // A read that cannot tell versions apart would report a fact the user
    // already corrected, so the default read resolves the chain.
    expect(live?.payload['obj']).toBe('上海')
  })

  it('grows the chain once per rewrite, keeping every old value', async () => {
    const h = harness()
    for (const [index, city] of ['杭州', '上海', '深圳'].entries()) {
      h.at(NOW + index * 60_000)
      const answer = await h.port.remember({ ops: [cityOp(city)] }, 'model', 'remember')
      expect(answer.ok, city).toBe(true)
    }
    const versions = createReadGateway(h.store.db).findVersions(KEY)
    expect(versions).toHaveLength(3)
    expect(versions.map(node => node.payload['obj']).sort()).toEqual(['上海', '深圳', '杭州'].sort())
    expect(versions.filter(node => node.payload['superseded_at'] === undefined)).toHaveLength(1)
  })

  it('leaves one key untouched when the value is the same', async () => {
    const h = harness()
    await h.port.remember({ ops: [cityOp('杭州')] }, 'model', 'remember')
    h.at(LATER)
    const again = await h.port.remember({ ops: [cityOp('杭州')] }, 'model', 'remember')
    expect(again.ok).toBe(true)
    expect(again.items[0]?.outcome).toBe('existing')
    // Declaring the same value again is not a change, so it writes no version.
    expect(createReadGateway(h.store.db).findVersions(KEY)).toHaveLength(1)
  })
})

describe('the ledger beside the chain', () => {
  it('writes one entry per accepted change and none for a repeat', async () => {
    const h = harness()
    const reads = createReadGateway(h.store.db)
    expect(reads.listDecisionsFor(KEY)).toHaveLength(0)

    await h.port.remember({ ops: [cityOp('杭州')] }, 'model', 'remember')
    expect(reads.listDecisionsFor(KEY)).toHaveLength(1)

    h.at(LATER)
    await h.port.remember({ ops: [cityOp('杭州')] }, 'model', 'remember')
    expect(reads.listDecisionsFor(KEY)).toHaveLength(1)

    h.at(LATER + 60_000)
    await h.port.remember({ ops: [cityOp('上海')] }, 'model', 'remember')
    expect(reads.listDecisionsFor(KEY)).toHaveLength(2)
  })

  it('records what changed, who changed it and why', async () => {
    const h = harness()
    await h.port.remember({ ops: [cityOp('杭州')] }, 'model', 'remember')
    h.at(LATER)
    // The reason is a property of the table, not of one op: a table shares one
    // intent, and the ledger records that intent once per change it caused.
    await h.port.remember({
      ops: [cityOp('上海')],
      reason: '用户说搬去上海了',
    }, 'user', 'remember')

    const entries = createReadGateway(h.store.db).listDecisionsFor(KEY)
    const rewrite = entries.map(node => decisionView(node.payload)).find(view => view?.kind === 'supersede')
    expect(rewrite).toBeDefined()
    expect(rewrite?.actor).toBe('user')
    expect(rewrite?.target_mem_key).toBe(KEY)
    expect(rewrite?.from).toMatchObject({ value: '杭州' })
    expect(rewrite?.to).toMatchObject({ value: '上海' })
    expect(rewrite?.reason).toContain('上海')
    expect(rewrite?.affected).toContain(KEY)
    expect(rewrite?.op_id).toMatch(/^\d+:/u)
    expect(rewrite?.contract_version).toBe(1)
  })

  it('opens the chain with an insert entry', async () => {
    const h = harness()
    await h.port.remember({ ops: [cityOp('杭州')] }, 'model', 'remember')
    const entries = createReadGateway(h.store.db).listDecisionsFor(KEY)
    const insert = entries.map(node => decisionView(node.payload))[0]
    expect(insert?.kind).toBe('insert')
    expect(insert?.from).toBeUndefined()
    expect(insert?.to).toMatchObject({ value: '杭州' })
  })
})

describe('the chain under a batch', () => {
  it('lands a rewrite and a new fact in one transaction', async () => {
    const h = harness()
    await h.port.remember({ ops: [cityOp('杭州')] }, 'model', 'remember')
    h.at(LATER)
    const before = h.store.db.nodeCount()
    const answer = await h.port.remember({
      ops: [cityOp('上海'), { op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'likes', obj: 'tea' }],
    }, 'model', 'remember')
    expect(answer.ok).toBe(true)
    expect(answer.items.map(item => item.outcome)).toEqual(['superseded', 'created'])
    // One retirement update, the new version, the new fact and two decisions.
    expect(h.store.db.nodeCount()).toBe(before + 4)
    const reads = createReadGateway(h.store.db)
    expect(reads.findLive(KEY)?.payload['obj']).toBe('上海')
    expect(reads.findVersions(KEY)).toHaveLength(2)
  })

  it('writes nothing when a later op of the batch is refused', async () => {
    const h = harness()
    await h.port.remember({ ops: [cityOp('杭州')] }, 'model', 'remember')
    h.at(LATER)
    const before = h.store.db.nodeCount()
    const answer = await h.port.remember({
      ops: [cityOp('上海'), { op: 'assert', kind: 'assertion', subj: '', pred: 'likes', obj: 'tea' }],
    }, 'model', 'remember')
    expect(answer.ok).toBe(false)
    // A refused table must not leave half a rewrite behind. The one node that
    // does appear is the rejection record: a refusal is itself worth keeping.
    expect(h.store.db.nodeCount()).toBe(before + 1)
    const reads = createReadGateway(h.store.db)
    expect(reads.findLive(KEY)?.payload['obj']).toBe('杭州')
    expect(reads.findVersions(KEY)).toHaveLength(1)
  })

  it('answers the same table twice without growing the chain', async () => {
    const h = harness()
    const table = { ops: [cityOp('杭州')] }
    const first = await h.port.remember(table, 'model', 'remember')
    expect(first.items[0]?.outcome).toBe('created')
    h.at(LATER)
    const second = await h.port.remember(table, 'model', 'remember')
    expect(second.ok).toBe(true)
    expect(second.items[0]?.outcome).toBe('existing')
    expect(createReadGateway(h.store.db).findVersions(KEY)).toHaveLength(1)
  })
})
/** One neighbour percentile value from an unsorted sample. */
function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index] ?? 0
}

describe('perf: rewriting the same key', () => {
  it('costs no more than rewriting a shallow key in the same store', async () => {
    // What this pins, and what it deliberately does not.
    //
    // A rewrite is one retirement plus one insert plus one ledger row, so it is
    // bounded. But an absolute millisecond budget is not something this story can
    // promise: every engine query here walks the whole node set, so any fixed
    // budget measures the store's size and would fail a healthy store for
    // filling up. Measured here: `findLive` alone moves from 0.03ms at 250 nodes
    // to 2.5ms at 1650, whatever it returns.
    //
    // So the measurement is comparative, at one moment in one store: a key with
    // hundreds of versions is rewritten alternately with a key that has a few.
    // If the length of a key's history is what a write pays for, the deep key is
    // visibly dearer. That is the cost the bounded retirement-slot read removed:
    // before it, the planner materialised every version of the key on each
    // rewrite, so one key's history made each later write slower without bound.
    const EARLY = 30
    const CHAIN = 300
    const LATE = 30
    const SHALLOW = 'assertion:Elliott:works_at'
    const h = harness()
    let clock = NOW
    let version = 0

    /** One rewrite of `key`, returning how long the call took. */
    const rewriteOnce = async (key: string, op: (obj: string) => Record<string, unknown>): Promise<number> => {
      version += 1
      clock += 1
      h.at(clock)
      const started = performance.now()
      const written = await h.port.remember({ ops: [op(`城市${version}`)] }, 'model', 'remember')
      const elapsed = performance.now() - started
      if (!written.ok || written.items[0]?.outcome !== 'superseded') {
        throw new Error(`rewrite of ${key} answered ${written.items[0]?.outcome ?? written.code}`)
      }
      return elapsed
    }
    const cityOp = (obj: string): Record<string, unknown> => ({
      op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'lives_in', obj,
    })
    const jobOp = (obj: string): Record<string, unknown> => ({
      op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'works_at', obj,
    })

    // Both keys have to exist before a rewrite of them can be measured.
    expect((await h.port.remember({ ops: [cityOp('起点')] }, 'model', 'remember')).ok).toBe(true)
    expect((await h.port.remember({ ops: [jobOp('起点')] }, 'model', 'remember')).ok).toBe(true)

    const early: number[] = []
    for (let index = 0; index < EARLY; index += 1) early.push(await rewriteOnce(KEY, cityOp))
    while (h.gateway.findVersions(KEY).length < CHAIN) await rewriteOnce(KEY, cityOp)

    // Interleaved, so both keys are measured against the very same store.
    const deep: number[] = []
    const shallow: number[] = []
    for (let index = 0; index < LATE; index += 1) {
      deep.push(await rewriteOnce(KEY, cityOp))
      shallow.push(await rewriteOnce(SHALLOW, jobOp))
    }

    const chain = h.gateway.findVersions(KEY).length
    const shallowChain = h.gateway.findVersions(SHALLOW).length
    const earlyMedian = percentile(early, 0.5)
    const deepMedian = percentile(deep, 0.5)
    const deepP95 = percentile(deep, 0.95)
    const shallowMedian = percentile(shallow, 0.5)
    const cost = deepMedian / Math.max(0.001, shallowMedian)
    // Publish the numbers: the story's evidence quotes them.
    process.stdout.write(
      `perf rewrite: chain=${chain} vs ${shallowChain}` +
        ` early=${earlyMedian.toFixed(3)}ms deep=${deepMedian.toFixed(3)}ms` +
        ` shallow=${shallowMedian.toFixed(3)}ms p95=${deepP95.toFixed(3)}ms cost=${cost.toFixed(2)}x\n`,
    )

    // The chains are real, not a claim: hundreds of versions against a few.
    expect(chain).toBeGreaterThanOrEqual(CHAIN)
    expect(shallowChain).toBeLessThanOrEqual(LATE + 2)
    // Ten times the history, at most twice the price. The unbounded read this
    // story removed multiplied the cost by the length of the chain instead.
    expect(cost).toBeLessThanOrEqual(2)
    // And the whole path stays interactive on a store of this size.
    expect(deepP95).toBeLessThanOrEqual(20)
  })
})
