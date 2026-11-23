/**
 * Matrix rows EMBED_401_402 and EMBED_TIMEOUT, exercised end to end.
 *
 * The rows are promises about the *runtime*: a rejected credential or an
 * exhausted balance closes the vector path, a missed deadline does not, and in
 * both cases the memory itself survives. These tests drive `startRuntime` with a
 * fake transport so no network call is possible.
 * @module
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closesVectorPath,
  DEGRADED_REASONS,
  mapEmbeddingFailureKind,
  OMW_CODES,
  type OmwCode,
} from '../../src/core/degrade.ts'
import { createLogger, createMemorySink, type MemorySink } from '../../src/seams/logger.ts'
import { TRANSIENT_LOG_CODE } from '../../src/seams/vector.ts'
import { parseConfig, type Config } from '../../src/seams/config.ts'
import { startRuntime, type Runtime } from '../../src/seams/runtime.ts'
import { allNodeIds, nodeCount, readPayload } from '../../src/store/db.ts'
import { DEFAULT_DIM } from '../../src/seams/config.ts'
import { createRecordingContext, tempHome, type TempHome } from '../support/fake-ctx.ts'

const homes: TempHome[] = []
const runtimes: Runtime[] = []

afterEach(async () => {
  // `dispose()` is async since Story 2.1: it drains the write queue before
  // closing the handle, so the home cannot be removed under a live write.
  while (runtimes.length > 0) await runtimes.pop()?.dispose()
  while (homes.length > 0) homes.pop()?.remove()
})

/** A validated configuration with only the embedding ceiling overridden. */
function config(overrides: { readonly timeoutMs?: number } = {}): Config {
  const parsed = parseConfig(
    overrides.timeoutMs === undefined ? {} : { embedding: { timeoutMs: overrides.timeoutMs } },
  )
  if (!parsed.ok) throw new Error(`unexpected config issues: ${JSON.stringify(parsed.issues)}`)
  return parsed.config
}

/** Boot one fully assembled runtime over a temporary home. */
function boot(fetchImpl: typeof fetch, overrides: { readonly timeoutMs?: number } = {}): {
  readonly runtime: Runtime
  readonly sink: MemorySink
} {
  const home = tempHome()
  homes.push(home)
  const sink = createMemorySink()
  const recorder = createRecordingContext({ home: home.dir })
  const runtime = startRuntime({
    ctx: recorder.ctx,
    config: config(overrides),
    env: { SILICONFLOW_API_KEY: 'test-key' },
    logger: createLogger(sink),
    fetchImpl,
    personaText: 'You are the whale.',
  })
  runtimes.push(runtime)
  return { runtime, sink }
}

/** A transport that answers with one status. */
function respond(status: number): typeof fetch {
  return (() => Promise.resolve(new Response(JSON.stringify({ error: 'nope' }), { status }))) as typeof fetch
}

/** A transport that succeeds with a vector of the requested width. */
function respondWithVector(dim: number): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify({ data: [{ index: 0, embedding: new Array<number>(dim).fill(0.25) }] }), {
        status: 200,
      }),
    )) as typeof fetch
}

/** A transport that never answers, so the per-call ceiling has to fire. */
function hang(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'))
      })
    })) as unknown as typeof fetch
}

/** Parsed log lines for one code. */
function linesFor(sink: MemorySink, code: string): Record<string, unknown>[] {
  return sink.lines
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(event => event['code'] === code)
}

/** Payload of the single node written after boot. */
function payloadOf(runtime: Runtime): Record<string, unknown> {
  const db = runtime.db
  if (db === undefined) throw new Error('runtime kept no database handle')
  const ids = allNodeIds(db)
  const last = ids[ids.length - 1]
  if (last === undefined) throw new Error('no node was written')
  return readPayload(db, last) as Record<string, unknown>
}

describe('vector-write: pure failure mapping', () => {
  it('maps every transport kind onto the closed vocabulary', () => {
    expect(mapEmbeddingFailureKind('auth')).toBe('OMW_EMBED_AUTH')
    expect(mapEmbeddingFailureKind('missing-credential')).toBe('OMW_EMBED_AUTH')
    expect(mapEmbeddingFailureKind('quota')).toBe('OMW_EMBED_QUOTA')
    expect(mapEmbeddingFailureKind('timeout')).toBe('OMW_EMBED_TIMEOUT')
    expect(mapEmbeddingFailureKind('dimension')).toBe('OMW_DIM_MISMATCH')
    expect(mapEmbeddingFailureKind('transient')).toBeUndefined()
    expect(mapEmbeddingFailureKind('something-new')).toBeUndefined()
  })

  it('never maps outside the eight codes', () => {
    for (const code of [
      mapEmbeddingFailureKind('auth'),
      mapEmbeddingFailureKind('quota'),
      mapEmbeddingFailureKind('timeout'),
      mapEmbeddingFailureKind('dimension'),
    ]) {
      if (code !== undefined) expect(OMW_CODES).toContain(code as OmwCode)
    }
  })

  it('closes the vector path for credentials, balance and width only', () => {
    expect(closesVectorPath('OMW_EMBED_AUTH')).toBe(true)
    expect(closesVectorPath('OMW_EMBED_QUOTA')).toBe(true)
    expect(closesVectorPath('OMW_DIM_MISMATCH')).toBe(true)
    expect(closesVectorPath('OMW_EMBED_TIMEOUT')).toBe(false)
    for (const code of ['OMW_DB_OPEN', 'OMW_SNAPSHOT_VERIFY', 'OMW_EXTRACT_FAIL', 'OMW_DREAM_BUDGET'] as const) {
      expect(closesVectorPath(code)).toBe(false)
    }
  })

  it('keeps both closed vocabularies at their documented size', () => {
    // Six recall reasons (data-model) and eight runtime codes (AD-19).
    expect(DEGRADED_REASONS).toHaveLength(6)
    expect(OMW_CODES).toHaveLength(8)
  })
})

describe('vector-write: matrix row EMBED_401_402', () => {
  it('closes the vector path on 401, logs OMW_EMBED_AUTH once, and calls the provider once', async () => {
    const fetchImpl = vi.fn(respond(401))
    const { runtime, sink } = boot(fetchImpl)
    expect(runtime.state).toBe('ok')
    const before = nodeCount(runtime.db!)
    const vector = runtime.vector!
    expect(vector.closed).toBe(false)

    const attempt = await vector.write({ mem_key: 'mem:one', text: 'hello' }, 'hello')

    expect(attempt.code).toBe('OMW_EMBED_AUTH')
    expect(attempt.closedPath).toBe(true)
    expect(attempt.vecState).toBe('pending')
    expect(runtime.state).toBe('vector-off')
    expect(runtime.code).toBe('OMW_EMBED_AUTH')
    expect(vector.closed).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // The memory survived the failure: one node, marked pending.
    expect(nodeCount(runtime.db!)).toBe(before + 1)
    expect(payloadOf(runtime)).toMatchObject({ mem_key: 'mem:one', vec_state: 'pending' })

    const logs = linesFor(sink, 'OMW_EMBED_AUTH')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ level: 'error', code: 'OMW_EMBED_AUTH' })
    expect(sink.lines.join('\n')).not.toContain('test-key-value')
  })

  it('closes the vector path on 402 with OMW_EMBED_QUOTA', async () => {
    const fetchImpl = vi.fn(respond(402))
    const { runtime, sink } = boot(fetchImpl)
    const before = nodeCount(runtime.db!)

    const attempt = await runtime.vector!.write({ mem_key: 'mem:two', text: 'hello' }, 'hello')

    expect(attempt.code).toBe('OMW_EMBED_QUOTA')
    expect(runtime.state).toBe('vector-off')
    expect(runtime.code).toBe('OMW_EMBED_QUOTA')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(nodeCount(runtime.db!)).toBe(before + 1)
    expect(payloadOf(runtime)).toMatchObject({ vec_state: 'pending' })
    expect(linesFor(sink, 'OMW_EMBED_QUOTA')).toHaveLength(1)
  })

  it('stops calling the provider once the path is closed, and still keeps writing', async () => {
    const fetchImpl = vi.fn(respond(401))
    const { runtime } = boot(fetchImpl)
    const vector = runtime.vector!
    await vector.write({ mem_key: 'mem:one', text: 'hello' }, 'hello')
    const before = nodeCount(runtime.db!)

    const second = await vector.write({ mem_key: 'mem:two', text: 'again' }, 'again')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(second.vecState).toBe('pending')
    expect(second.code).toBeUndefined()
    expect(second.closedPath).toBe(false)
    expect(nodeCount(runtime.db!)).toBe(before + 1)
    expect(runtime.state).toBe('vector-off')
  })

  it('treats a missing credential as OMW_EMBED_AUTH without any call', async () => {
    const fetchImpl = vi.fn(respond(200))
    const home = tempHome()
    homes.push(home)
    const recorder = createRecordingContext({ home: home.dir })
    const runtime = startRuntime({
      ctx: recorder.ctx,
      config: config(),
      env: {},
      logger: createLogger(createMemorySink()),
      fetchImpl,
      personaText: 'You are the whale.',
    })
    runtimes.push(runtime)

    const attempt = await runtime.vector!.write({ mem_key: 'mem:three', text: 'hello' }, 'hello')

    expect(attempt.code).toBe('OMW_EMBED_AUTH')
    expect(runtime.state).toBe('vector-off')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('closes the vector path on a width mismatch with OMW_DIM_MISMATCH', async () => {
    const fetchImpl = vi.fn(respondWithVector(DEFAULT_DIM + 1))
    const { runtime, sink } = boot(fetchImpl)

    const attempt = await runtime.vector!.write({ mem_key: 'mem:four', text: 'hello' }, 'hello')

    expect(attempt.code).toBe('OMW_DIM_MISMATCH')
    expect(runtime.state).toBe('vector-off')
    expect(runtime.code).toBe('OMW_DIM_MISMATCH')
    expect(payloadOf(runtime)).toMatchObject({ vec_state: 'pending' })
    expect(linesFor(sink, 'OMW_DIM_MISMATCH')).toHaveLength(1)
  })
})

describe('vector-write: matrix row EMBED_TIMEOUT', () => {
  it('records OMW_EMBED_TIMEOUT, keeps state ok, and still commits the node as pending', async () => {
    const fetchImpl = vi.fn(hang())
    const { runtime, sink } = boot(fetchImpl, { timeoutMs: 10 })
    expect(runtime.state).toBe('ok')
    const before = nodeCount(runtime.db!)

    const attempt = await runtime.vector!.write({ mem_key: 'mem:slow', text: 'slow' }, 'slow')

    expect(attempt.code).toBe('OMW_EMBED_TIMEOUT')
    expect(attempt.closedPath).toBe(false)
    expect(attempt.vecState).toBe('pending')
    expect(runtime.state).toBe('ok')
    expect(runtime.code).toBeUndefined()
    expect(runtime.vector!.closed).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(nodeCount(runtime.db!)).toBe(before + 1)
    expect(payloadOf(runtime)).toMatchObject({ mem_key: 'mem:slow', vec_state: 'pending' })

    const logs = linesFor(sink, 'OMW_EMBED_TIMEOUT')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ level: 'warn', code: 'OMW_EMBED_TIMEOUT' })
  })

  it('still embeds the next write after a timeout, because the path stayed open', async () => {
    let calls = 0
    const fetchImpl = ((() => {
      calls += 1
      if (calls === 1) {
        return new Promise((_resolve, reject) => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      }
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ index: 0, embedding: new Array<number>(DEFAULT_DIM).fill(0.5) }] }), {
          status: 200,
        }),
      )
    }) as unknown) as typeof fetch
    const { runtime } = boot(fetchImpl)

    const first = await runtime.vector!.write({ mem_key: 'mem:a', text: 'a' }, 'a')
    const second = await runtime.vector!.write({ mem_key: 'mem:b', text: 'b' }, 'b')

    expect(first.vecState).toBe('pending')
    expect(second.vecState).toBe('ready')
    expect(runtime.state).toBe('ok')
    expect(calls).toBe(2)
  })

  it('attaches a vector and marks the node ready when the provider answers', async () => {
    const fetchImpl = vi.fn(respondWithVector(DEFAULT_DIM))
    const { runtime, sink } = boot(fetchImpl)

    const attempt = await runtime.vector!.write({ mem_key: 'mem:ok', text: 'hello' }, 'hello')

    expect(attempt.vecState).toBe('ready')
    expect(attempt.code).toBeUndefined()
    expect(runtime.state).toBe('ok')
    expect(payloadOf(runtime)).toMatchObject({ mem_key: 'mem:ok', vec_state: 'ready' })
    expect(sink.lines.filter(line => line.includes('OMW_EMBED'))).toHaveLength(0)
  })
})

describe('vector-write: retryable failures', () => {
  it('logs one warn line, keeps the path open, and tries again on the next write', async () => {
    const fetchImpl = vi.fn(respond(500))
    const { runtime, sink } = boot(fetchImpl)
    const before = nodeCount(runtime.db!)

    const attempt = await runtime.vector!.write({ mem_key: 'mem:flaky', text: 'hello' }, 'hello')

    expect(attempt.code).toBeUndefined()
    expect(attempt.closedPath).toBe(false)
    expect(attempt.vecState).toBe('pending')
    expect(runtime.state).toBe('ok')
    expect(nodeCount(runtime.db!)).toBe(before + 1)

    const logs = linesFor(sink, TRANSIENT_LOG_CODE)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ level: 'warn', code: TRANSIENT_LOG_CODE })

    // Retryable means the next write really does try again.
    await runtime.vector!.write({ mem_key: 'mem:again', text: 'again' }, 'again')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})