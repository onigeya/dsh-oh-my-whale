/**
 * Story 2.1 — the write side as the runtime assembles it.
 *
 * These are the rows a unit test cannot reach: whether the bootstrap really
 * installs the registry, whether a tool mounted through `apply` can write, and
 * whether a disposed runtime drains before it lets go of the handle.
 * @module
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, type ApplyContext } from '../../src/index.ts'
import type { CommandDefinitionLike } from '../../src/seams/commands.ts'
import { parseConfig, type Config } from '../../src/seams/config.ts'
import { createLogger, createMemorySink, type MemorySink } from '../../src/seams/logger.ts'
import { startRuntime, type Runtime } from '../../src/seams/runtime.ts'
import { closeDatabase, nodeCount, openDatabase } from '../../src/store/db.ts'
import { createAssertionTemplates } from '../../src/store/templates/assertions.ts'
import { createRecordingContext, readJsonLines, tempHome, type TempHome } from '../support/fake-ctx.ts'
import { TEST_DIM } from '../support/write-store.ts'
const homes: TempHome[] = []
const runtimes: Runtime[] = []

afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.dispose()
  while (homes.length > 0) homes.pop()?.remove()
})

/** A validated configuration at the test width, in a fresh temp home. */
function homeAt(dim = TEST_DIM): { home: TempHome; config: Config } {
  const home = tempHome('omw-runtime-')
  homes.push(home)
  const parsed = parseConfig({ db: { dim } })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
  return { home, config: parsed.config }
}

/** A configuration carrying a tighter new-predicate budget than the default. */
function homeWithCap(maxNewPredsPerDay: number): { home: TempHome; config: Config } {
  const home = tempHome('omw-runtime-')
  homes.push(home)
  const parsed = parseConfig({ db: { dim: TEST_DIM }, tbox: { maxNewPredsPerDay } })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
  return { home, config: parsed.config }
}

/** Boot one runtime over a temp home, keeping the log sink. */
function boot(options: { readonly dim?: number; readonly maxNewPredsPerDay?: number } = {}): {
  readonly runtime: Runtime
  readonly sink: MemorySink
  readonly home: TempHome
} {
  const { home, config } = options.maxNewPredsPerDay === undefined
    ? homeAt(options.dim ?? TEST_DIM)
    : homeWithCap(options.maxNewPredsPerDay)
  const sink = createMemorySink()
  const recorder = createRecordingContext({ home: home.dir })
  const runtime = startRuntime({
    ctx: recorder.ctx,
    config,
    logger: createLogger(sink),
    personaText: 'You are the whale.',
  })
  runtimes.push(runtime)
  return { runtime, sink, home }
}

/** The payload stored under one business key, read through a template. */
function livePayload(runtime: Runtime, memKey: string): Record<string, unknown> | undefined {
  const db = runtime.db
  if (db === undefined) throw new Error('runtime kept no handle')
  return createAssertionTemplates(db).findLiveByKey(memKey)?.payload
}

describe('runtime: installing the store', () => {
  it('creates both indexes and the ten seed predicates on the first boot', () => {
    const { runtime } = boot()
    const db = runtime.db
    if (db === undefined) throw new Error('no handle')
    expect(db.listUniqueIndexes()).toEqual([['mem_key', 'active_slot']])
    const history = db.indexInfo().filter(info => info.kind === 'composite' && info.unique === false)
    expect(history.map(info => info.fields)).toEqual([['mem_key', 'valid_from']])
    // Ten seeds plus the contract-version flag (ADR-19 stamps one flag node).
    const templates = createAssertionTemplates(db)
    for (const name of ['name', 'lives_in', 'works_at', 'birthday', 'timezone', 'prefers_tone', 'likes', 'dislikes', 'knows', 'avoids_topic']) {
      expect(templates.findPredByName(name), `missing seed ${name}`).toBeDefined()
    }
    expect(nodeCount(db)).toBe(11)
  })

  it('records the bootstrap as one write audit row', () => {
    const { runtime, home } = boot()
    const files = readdirSync(runtime.paths.dataDir).filter(name => name.startsWith('audit-'))
    expect(files).toHaveLength(1)
    const rows = readJsonLines(join(runtime.paths.dataDir, files[0] ?? ''))
    const writes = rows.filter(row => row['kind'] === 'write')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ outcome: 'bootstrap', code: 'seed_install', mem_keys: [] })
    expect(typeof writes[0]?.['elapsed_ms']).toBe('number')
    expect(home.dir).toBeTruthy()
  })

  it('exposes the write side and the four tool names', () => {
    const { runtime } = boot()
    expect(runtime.write).toBeDefined()
    expect(runtime.loaded.tools).toEqual(['remember', 'recall', 'forget', 'explain'])
  })

  it('writes through the port and reads the fact back by its business key', async () => {
    const { runtime } = boot()
    const answer = await runtime.write?.remember({
      ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'likes', obj: 'coffee' }],
    }, 'model', 'remember')
    expect(answer?.ok).toBe(true)
    expect(answer?.mem_keys).toEqual(['assertion:Elliott:likes:coffee'])
    const stored = livePayload(runtime, 'assertion:Elliott:likes:coffee')
    expect(stored).toMatchObject({
      kind: 'assertion',
      mem_key: 'assertion:Elliott:likes:coffee',
      subj: 'Elliott',
      pred: 'likes',
      obj: 'coffee',
      active_slot: 1,
      origin: 'observed',
      vec_state: 'pending',
    })
    expect(typeof stored?.['valid_from']).toBe('string')
    expect(typeof stored?.['recorded_at']).toBe('string')
  })

  it('leaves the identity section in place while the write side is down', () => {
    const { home } = homeAt()
    // Two live versions of one key already in the file: the unique index cannot be
    // created, so the store refuses the registry. Reads still work.
    const opened = openDatabase({ file: join(home.dir, 'oh-my-whale', 'oh-my-whale.tdb'), dim: TEST_DIM, memoryLimitMb: 256 })
    if (!opened.ok) throw new Error(opened.reason)
    const zero = new Array<number>(TEST_DIM).fill(0)
    opened.db.insert(zero, { kind: 'assertion', mem_key: 'dup:key', active_slot: 1 })
    opened.db.insert(zero, { kind: 'assertion', mem_key: 'dup:key', active_slot: 1 })
    closeDatabase(opened.db)

    const sink = createMemorySink()
    const recorder = createRecordingContext({ home: home.dir })
    const parsed = parseConfig({ db: { dim: TEST_DIM } })
    if (!parsed.ok) throw new Error('config')
    const runtime = startRuntime({
      ctx: recorder.ctx,
      config: parsed.config,
      logger: createLogger(sink),
      personaText: 'You are the whale.',
    })
    runtimes.push(runtime)

    expect(runtime.write).toBeUndefined()
    expect(runtime.state).toBe('ok')
    expect(runtime.loaded.sectionRegistered).toBe(true)
    // The tools are still mounted: refusing with a code beats disappearing.
    expect(runtime.loaded.tools).toEqual(['remember', 'recall', 'forget', 'explain'])
    const codes = sink.lines.map(line => JSON.parse(line) as { code: string }).map(event => event.code)
    expect(codes).toContain('OMW_SCHEMA_NOT_READY')
  })

  it('answers E_GATE_DOWN from the remember tool when the write side is down', async () => {
    const { home } = homeAt()
    const opened = openDatabase({ file: join(home.dir, 'oh-my-whale', 'oh-my-whale.tdb'), dim: TEST_DIM, memoryLimitMb: 256 })
    if (!opened.ok) throw new Error(opened.reason)
    const zero = new Array<number>(TEST_DIM).fill(0)
    opened.db.insert(zero, { kind: 'assertion', mem_key: 'dup:key', active_slot: 1 })
    opened.db.insert(zero, { kind: 'assertion', mem_key: 'dup:key', active_slot: 1 })
    closeDatabase(opened.db)

    const recorder = createRecordingContext({ home: home.dir, withTools: true })
    const parsed = parseConfig({ db: { dim: TEST_DIM } })
    if (!parsed.ok) throw new Error('config')
    const runtime = startRuntime({
      ctx: recorder.ctx,
      config: parsed.config,
      logger: createLogger(createMemorySink()),
      personaText: 'You are the whale.',
    })
    runtimes.push(runtime)

    const remember = recorder.definitions.find(definition => definition.name === 'remember')
    expect(remember).toBeDefined()
    if (remember === undefined) return
    const answer = await remember.execute({
      patch: { ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'likes', obj: 'coffee' }] },
    }, {}) as { ok: boolean; code: string; mem_keys: unknown[] }
    expect(answer.ok).toBe(false)
    expect(answer.code).toBe('E_GATE_DOWN')
    expect(answer.mem_keys).toEqual([])
  })
})

describe('runtime: promoting a predicate through the chat surface', () => {
  it('promotes a candidate to single through a real apply() mount', async () => {
    const { home } = homeAt()
    const commands: CommandDefinitionLike[] = []
    const registry = {
      register(definition: CommandDefinitionLike): () => void {
        commands.push(definition)
        return () => {
          const index = commands.indexOf(definition)
          if (index >= 0) commands.splice(index, 1)
        }
      },
    }
    const recorder = createRecordingContext({ home: home.dir })
    const context: ApplyContext = {
      ...recorder.ctx,
      get: (name: string) => (name === 'commands' ? registry : undefined),
      effect: (callback) => {
        cleanup = callback() as (() => Promise<void>) | undefined
      },
    }
    let cleanup: (() => Promise<void>) | undefined

    apply(context, { db: { dim: TEST_DIM } })

    const command = commands.find(entry => entry.name === 'omw')
    expect(command).toBeDefined()
    if (command === undefined) return

    // The model proposes the predicate first; only the user may promote it.
    const remember = recorder.definitions.find(definition => definition.name === 'remember')
    expect(remember).toBeDefined()

    const promoted = await command.handler({
      rawInput: ' pred promote mood --single --reason 探针',
    }) as { kind: string; text?: string }
    expect(promoted.kind).toBe('success')
    expect(promoted.text).toContain('已更新谓词登记表')

    // The cleanup returns the drain promise; awaiting it is what Story 2.1 requires.
    expect(cleanup).toBeDefined()
    await cleanup?.()

    const reopened = openDatabase({ file: join(home.dir, 'oh-my-whale', 'oh-my-whale.tdb'), dim: TEST_DIM, memoryLimitMb: 256 })
    if (!reopened.ok) throw new Error(reopened.reason)
    try {
      const stored = createAssertionTemplates(reopened.db).findPredByName('mood')
      expect(stored?.payload['cardinality']).toBe('single')
      expect(stored?.payload['status']).toBe('active')
      expect(stored?.payload['decided_by']).toBe('user')
    } finally {
      closeDatabase(reopened.db)
    }
  })
})

describe('runtime: letting go of the handle', () => {
  it('drains a queued write before the handle closes', async () => {
    const { runtime, home } = boot()
    const port = runtime.write
    if (port === undefined) throw new Error('no port')
    const pending = port.remember({
      ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'likes', obj: 'tea' }],
    }, 'model', 'remember')
    const closed = runtime.dispose()
    const answer = await pending
    await closed
    expect(answer.ok).toBe(true)
    expect(answer.mem_keys).toEqual(['assertion:Elliott:likes:tea'])

    const reopened = openDatabase({ file: join(home.dir, 'oh-my-whale', 'oh-my-whale.tdb'), dim: TEST_DIM, memoryLimitMb: 256 })
    if (!reopened.ok) throw new Error(reopened.reason)
    try {
      expect(createAssertionTemplates(reopened.db).findLiveByKey('assertion:Elliott:likes:tea')).toBeDefined()
    } finally {
      closeDatabase(reopened.db)
    }
  })

  it('refuses later writes instead of dropping them', async () => {
    const { runtime } = boot()
    const port = runtime.write
    if (port === undefined) throw new Error('no port')
    await runtime.dispose()
    const answer = await port.remember({
      ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'likes', obj: 'coffee' }],
    }, 'model', 'remember')
    expect(answer.ok).toBe(false)
    expect(answer.code).toBe('E_GATE_DOWN')
  })

  it('is idempotent', async () => {
    const { runtime } = boot()
    await runtime.dispose()
    await expect(runtime.dispose()).resolves.toBeUndefined()
  })
})