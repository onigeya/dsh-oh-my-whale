/**
 * Matrix row PERF_P95 — a single-operation write stays inside the budget.
 *
 * Absolute milliseconds alone make a flaky gate on a loaded CI box, so the row is
 * judged three ways: a median ceiling, a p95 ceiling, and a ratio against the same
 * process writing the same bytes straight through the engine. A regression in the
 * planning or queue layer moves the ratio even when the machine is slow.
 * @module
 */
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDatabase, databaseDim, nodeCount, openDatabase } from '../../src/store/db.ts'
import { createCommitEngine } from '../../src/store/commits/engine.ts'
import { createWriteGateway } from '../../src/store/commits/assertions.ts'
import { ensureSchema } from '../../src/store/schema.ts'
import { tempHome, type TempHome } from '../support/fake-ctx.ts'

const DIM = 4
const WARMUP = 100
const SAMPLES = 200

const homes: TempHome[] = []
const handles: ReturnType<typeof openDatabase>[] = []

afterEach(() => {
  for (const opened of handles.splice(0)) {
    if (opened.ok) closeDatabase(opened.db)
  }
  while (homes.length > 0) homes.pop()?.remove()
})

/** Open a bootstrapped store at width four. */
function store(): ReturnType<typeof createWriteGateway> {
  const home = tempHome('omw-perf-')
  homes.push(home)
  const opened = openDatabase({ file: join(home.dir, 'mem.tdb'), dim: DIM, memoryLimitMb: 256 })
  if (!opened.ok) throw new Error(opened.reason)
  handles.push(opened)
  const boot = ensureSchema(opened.db, { now: () => Date.UTC(2026, 10, 23, 4, 0, 0) })
  if (!boot.ok || !boot.writable) throw new Error('bootstrap failed')
  return createWriteGateway(opened.db)
}

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

/** A fact payload with a distinct key and value per index. */
function fact(index: number): Record<string, unknown> {
  return {
    kind: 'assertion',
    mem_key: `assertion:Perf:likes:v${index}`,
    subj: 'Perf',
    pred: 'likes',
    obj: `v${index}`,
    obj_norm: `v${index}`,
    norm_version: 1,
    valid_from: '2026-11-23T04:00:00.000Z',
    recorded_at: '2026-11-23T04:00:00.000Z',
    active_slot: 1,
    origin: 'observed',
    vec_state: 'pending',
    actor: 'model',
    cause: 'tool',
    prompt_version: 'omw-write/2.1',
  }
}

describe('perf: one write per transaction', () => {
  it(`keeps 200 single-op writes inside the p95 budget at dim ${DIM}`, () => {
    const gateway = store()

    // Warm-up: the first writes pay for index insertion and page allocation that
    // no steady-state measurement should include.
    for (let index = 0; index < WARMUP; index += 1) {
      const committed = gateway.commit({ inserts: [{ payload: fact(index) }], updates: [] })
      if (!committed.ok) throw new Error(`warm-up write failed: ${committed.failure.kind}`)
    }

    const writes: number[] = []
    const next = timed()
    for (let index = 0; index < SAMPLES; index += 1) {
      const committed = gateway.commit({ inserts: [{ payload: fact(WARMUP + index) }], updates: [] })
      if (!committed.ok) throw new Error(`write failed: ${committed.failure.kind}`)
      writes.push(next())
    }

    const median = percentile(writes, 0.5)
    const p95 = percentile(writes, 0.95)
    // Publish the numbers: the story's evidence quotes them, and a threshold
    // failure without the measured value is unreadable.
    process.stdout.write(`perf write: median=${median.toFixed(3)}ms p95=${p95.toFixed(3)}ms n=${writes.length}\n`)

    expect(median).toBeLessThanOrEqual(2)
    expect(p95).toBeLessThanOrEqual(10)
  })

  it('stays within five times a raw engine insert of the same bytes', () => {
    const gateway = store()
    const home = tempHome('omw-perf-base-')
    homes.push(home)
    const opened = openDatabase({ file: join(home.dir, 'mem.tdb'), dim: DIM, memoryLimitMb: 256 })
    if (!opened.ok) throw new Error(opened.reason)
    handles.push(opened)
    const engine = createCommitEngine(opened.db, databaseDim(opened.db))
    const zero = new Array<number>(DIM).fill(0)

    for (let index = 0; index < WARMUP; index += 1) {
      const committed = gateway.commit({ inserts: [{ payload: fact(index) }], updates: [] })
      if (!committed.ok) throw new Error('warm-up failed')
      opened.db.insert(zero, fact(WARMUP + index))
    }

    const viaGateway: number[] = []
    const viaEngine: number[] = []
    const next = timed()
    for (let index = 0; index < SAMPLES; index += 1) {
      const committed = gateway.commit({ inserts: [{ payload: fact(WARMUP + index) }], updates: [] })
      if (!committed.ok) throw new Error('write failed')
      viaGateway.push(next())
    }
    for (let index = 0; index < SAMPLES; index += 1) {
      opened.db.insert(zero, fact(WARMUP + index))
      viaEngine.push(next())
    }

    const gatewayMedian = percentile(viaGateway, 0.5)
    const engineMedian = Math.max(0.001, percentile(viaEngine, 0.5))
    const ratio = gatewayMedian / engineMedian
    process.stdout.write(
      `perf ratio: gateway=${gatewayMedian.toFixed(3)}ms engine=${engineMedian.toFixed(3)}ms ratio=${ratio.toFixed(2)}x\n`,
    )
    // A transaction wrapper plus the ledger-free insert path must not cost five
    // times what the engine charges for the same write.
    expect(ratio).toBeLessThanOrEqual(5)
    expect(nodeCount(opened.db)).toBeGreaterThan(SAMPLES)
  })
})
