/**
 * Story 1.4 — a broken vector path closes the vector path only, and the state
 * vocabulary stays closed.
 * @module
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEGRADE_STATES,
  DEGRADED_REASONS,
  DegradeMachine,
  IllegalDegradeTransition,
  OMW_CODES,
} from '../../src/core/degrade.ts'
import { assertClosedReasons, createAudit, createMemoryAuditSink } from '../../src/ops/audit.ts'
import { closeDatabase, openDatabase, type Database } from '../../src/store/db.ts'
import { embed } from '../../src/store/embedding.ts'
import { searchText } from '../../src/store/search.ts'
import { tempHome, type TempHome } from '../support/fake-ctx.ts'

const homes: TempHome[] = []
const handles: Database[] = []

afterEach(() => {
  while (handles.length > 0) {
    const db = handles.pop()
    if (db !== undefined) closeDatabase(db)
  }
  while (homes.length > 0) homes.pop()?.remove()
})

/** Base embedding options for one test. */
function options(overrides: Partial<Parameters<typeof embed>[1]> = {}): Parameters<typeof embed>[1] {
  return {
    endpoint: 'https://embedding.invalid/v1/embeddings',
    model: 'BAAI/bge-m3',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    env: { SILICONFLOW_API_KEY: 'secret-value-that-never-leaves' },
    timeoutMs: 200,
    dim: 4,
    ...overrides,
  }
}

/** A fetch that answers with one status and body. */
function respond(status: number, body: unknown): typeof fetch {
  return (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as typeof fetch
}

describe('vector-off: embedding failure mapping', () => {
  it('maps 401 to auth and does not retry', async () => {
    const fetchImpl = vi.fn(respond(401, { error: 'bad key' }))
    const result = await embed(['hello'], options({ fetchImpl }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.failure.kind).toBe('auth')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('maps 402 to quota', async () => {
    const result = await embed(['hello'], options({ fetchImpl: respond(402, { error: 'insufficient balance' }) }))
    expect(result.ok === false && result.failure.kind).toBe('quota')
  })

  it('maps an exceeded deadline to timeout', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'))
      })
    })) as unknown as typeof fetch
    const result = await embed(['hello'], options({ fetchImpl, timeoutMs: 10 }))
    expect(result.ok === false && result.failure.kind).toBe('timeout')
  })

  it('reports a missing credential without any call', async () => {
    const fetchImpl = vi.fn(respond(200, { data: [] }))
    const result = await embed(['hello'], options({ fetchImpl, env: {} }))
    expect(result.ok === false && result.failure.kind).toBe('missing-credential')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports a width that differs from db.dim', async () => {
    const result = await embed(['hello'], options({ fetchImpl: respond(200, { data: [{ embedding: [1, 2] }] }) }))
    expect(result.ok === false && result.failure.kind).toBe('dimension')
  })

  it('never leaks the key into the failure message', async () => {
    const key = 'secret-value-that-never-leaves'
    const settings = options({ fetchImpl: respond(401, { error: 'nope' }), env: { SILICONFLOW_API_KEY: key } })
    // Both directions: the key really is in play, and it is absent from the result.
    expect(JSON.stringify(settings)).toContain(key)
    const result = await embed(['hello'], settings)
    expect(result.ok === false && result.failure.kind).toBe('auth')
    expect(JSON.stringify(result)).not.toContain(key)
  })
})

describe('vector-off: closed state vocabulary', () => {
  it('has exactly three states and eight codes', () => {
    expect(DEGRADE_STATES).toEqual(['ok', 'no-op', 'vector-off'])
    expect(OMW_CODES).toHaveLength(8)
  })

  it('allows ok -> vector-off and refuses anything else afterwards', () => {
    const machine = new DegradeMachine()
    machine.enterVectorOff('OMW_EMBED_AUTH', { reason: 'missing' })
    expect(machine.state).toBe('vector-off')
    machine.enterNoOp('OMW_DB_OPEN', { reason: 'later failure' })
    expect(machine.state).toBe('no-op')
    expect(machine.snapshot.code).toBe('OMW_DB_OPEN')
  })

  it('refuses to reopen the vector path', () => {
    const machine = new DegradeMachine()
    machine.enterVectorOff('OMW_EMBED_QUOTA')
    expect(() => machine.enterVectorOff('OMW_EMBED_TIMEOUT')).not.toThrow()
    machine.enterNoOp('OMW_SNAPSHOT_VERIFY')
    expect(() => machine.enterVectorOff('OMW_EMBED_AUTH')).toThrow(IllegalDegradeTransition)
  })

  it('keeps the first failure when the same state is re-entered', () => {
    const machine = new DegradeMachine()
    machine.enterNoOp('OMW_DB_OPEN', { first: true })
    machine.enterNoOp('OMW_DIM_MISMATCH', { second: true })
    expect(machine.snapshot.code).toBe('OMW_DB_OPEN')
    expect(machine.snapshot.detail).toEqual({ first: true })
  })
})

describe('vector-off: recall still returns text hits', () => {
  /** A database with three nodes, one of them matching "whale". */
  function seeded(): Database {
    const home = tempHome('omw-vec-')
    homes.push(home)
    const opened = openDatabase({ file: home.path('oh-my-whale.tdb'), dim: 4, memoryLimitMb: 256 })
    expect(opened.ok).toBe(true)
    if (!opened.ok) throw new Error(opened.reason)
    handles.push(opened.db)
    opened.db.insert([0, 0, 0, 0], { kind: 'assertion', text: 'the whale remembers the sea' })
    opened.db.insert([0, 0, 0, 0], { kind: 'assertion', text: 'unrelated note' })
    return opened.db
  }

  it('returns a non-empty result with the vector path closed', () => {
    const db = seeded()
    const result = searchText(db, 'whale')
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits[0]?.payload).toMatchObject({ text: 'the whale remembers the sea' })
  })

  it('finds a memory written after the old twelve-node scan cap', () => {
    const home = tempHome('omw-vec-')
    homes.push(home)
    const opened = openDatabase({ file: home.path('oh-my-whale.tdb'), dim: 4, memoryLimitMb: 256 })
    expect(opened.ok).toBe(true)
    if (!opened.ok) throw new Error(opened.reason)
    handles.push(opened.db)
    for (let index = 0; index < 20; index += 1) {
      opened.db.insert([0, 0, 0, 0], { kind: 'assertion', text: `filler ${index}` })
    }
    opened.db.insert([0, 0, 0, 0], { kind: 'assertion', text: 'the last whale' })

    const result = searchText(opened.db, 'whale')

    expect(result.hits.map(hit => hit.payload?.['text'])).toContain('the last whale')
  })

  it('accepts only the closed degraded_reason vocabulary in audit rows', () => {
    const home = tempHome('omw-vec-')
    homes.push(home)
    const audit = createAudit({ dataDir: home.dir, sink: createMemoryAuditSink() })
    const row = {
      ts: new Date().toISOString(),
      kind: 'recall' as const,
      query_hash: 'abc',
      topK: 5,
      hits: ['flag:contract_version'],
      elapsed_ms: 3,
      degraded: true,
      degraded_reason: ['vec_unavailable' as const],
    }
    expect(() => audit.append(row)).not.toThrow()
    expect(() => assertClosedReasons(row)).not.toThrow()
    expect(DEGRADED_REASONS).toContain('vec_unavailable')
    expect(() => assertClosedReasons({ ...row, degraded_reason: ['something_else' as never] })).toThrow(/closed set/u)
  })
})
