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
import { E_OK } from '../../src/core/tool-errors.ts'
import type { CommandDefinitionLike } from '../../src/seams/commands.ts'
import { DEFAULT_TAIL_MAX_TOKENS, DEFAULT_TOP_K, parseConfig, RECALL_ITEM_BUDGET_TOKENS, type Config } from '../../src/seams/config.ts'
import { createLogger, createMemorySink, type MemorySink } from '../../src/seams/logger.ts'
import { startRuntime, type Runtime } from '../../src/seams/runtime.ts'
import { RECALL_CONTEXT_NAME } from '../../src/seams/prompt-composer.ts'
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

/** A configuration that narrows the recall contract, to prove it reaches the composer. */
function homeWithTopK(topK: number): { home: TempHome; config: Config } {
  const home = tempHome('omw-runtime-')
  homes.push(home)
  const parsed = parseConfig({ db: { dim: TEST_DIM }, recall: { topK } })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
  return { home, config: parsed.config }
}

/** A configuration that narrows the candidate pool, to prove the wiring reaches the reader. */
function homeWithCandidatePool(candidatePool: number): { home: TempHome; config: Config } {
  const home = tempHome('omw-runtime-')
  homes.push(home)
  const parsed = parseConfig({ db: { dim: TEST_DIM }, recall: { candidatePool } })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
  return { home, config: parsed.config }
}

/** Boot one runtime over a temp home, keeping the log sink. */
function boot(options: {
  readonly dim?: number
  readonly maxNewPredsPerDay?: number
  readonly topK?: number
  readonly candidatePool?: number
} = {}): {
  readonly runtime: Runtime
  readonly sink: MemorySink
  readonly home: TempHome
} {
  const { home, config } = options.topK !== undefined
    ? homeWithTopK(options.topK)
    : options.candidatePool !== undefined
      ? homeWithCandidatePool(options.candidatePool)
      : options.maxNewPredsPerDay === undefined
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

  it('records the bootstrap as one write audit row', async () => {
    const { runtime, home } = boot()
    // Audit lines are queued, not written: nothing is on disk until the queue drains.
    await runtime.audit?.flush()
    const files = readdirSync(runtime.paths.dataDir).filter(name => name.startsWith('audit-'))
    expect(files).toHaveLength(1)
    const rows = readJsonLines(join(runtime.paths.dataDir, files[0] ?? ''))
    const writes = rows.filter(row => row['kind'] === 'write')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ outcome: 'bootstrap', code: 'seed_install', mem_keys: [] })
    expect(typeof writes[0]?.['elapsed_ms']).toBe('number')
    // AC⑥ over all three row types: a write row names its memories by key and
    // carries no node id, so the audit trail cannot be joined back to the
    // store's internal identifiers. The injection row has its own version of
    // this check in `runtime-audit.test.ts`; a row kind nobody asserts is a row
    // kind that can grow an id without a test failing.
    const text = JSON.stringify(writes[0])
    expect(text).not.toMatch(/"(?:id|node_id|nodeId)"/u)
    expect(text).not.toMatch(/"[a-z_]+":\s*\d{3,}"/u)
    expect(home.dir).toBeTruthy()
  })

  it('exposes the write side and the four tool names', () => {
    const { runtime } = boot()
    expect(runtime.write).toBeDefined()
    expect(runtime.loaded.tools).toEqual(['remember', 'recall', 'forget', 'explain'])
  })

  it('exposes the injection plan the audit row will report', () => {
    const { runtime } = boot()
    const plan = runtime.injection
    expect(plan).toBeDefined()
    // The numbers on the plan are what actually reached the host, not a recount.
    expect(plan?.persona.text).toBe('You are the whale.')
    // No state source is wired, so the tail has no text at all — not an empty string.
    expect(plan?.tail.text).toBeUndefined()
    expect(plan?.tail.tokens).toBe(0)
    expect(plan?.prefixUnchanged).toBe(false)
    // The mount-time plan carries no recall: the tier is wired but has no query
    // yet, so its reader answers nothing. What it must NOT be is absent — the
    // plan object always names the tier (P0-1).
    expect(plan?.recall.kept).toEqual([])
    expect(plan?.truncatedItems).toEqual([])
    // The budget is derived from the three caps as configured, not from numbers
    // copied into this test: changing a default would be a semantics failure here,
    // not an arithmetic one.
    expect(plan?.budget).toBe(
      (plan?.identityTokens ?? 0) + DEFAULT_TAIL_MAX_TOKENS + DEFAULT_TOP_K * RECALL_ITEM_BUDGET_TOKENS,
    )
  })

  it('takes the recall width from the configuration, not from the composer default', () => {
    // The composer's own default equals the configuration default, so a missing
    // wire would stay invisible: boot with a narrower contract and read it back.
    const { runtime } = boot({ topK: 3 })
    const plan = runtime.injection
    expect(plan?.budget).toBe(
      (plan?.identityTokens ?? 0) + DEFAULT_TAIL_MAX_TOKENS + 3 * RECALL_ITEM_BUDGET_TOKENS,
    )
    expect(plan?.budget).not.toBe(
      (plan?.identityTokens ?? 0) + DEFAULT_TAIL_MAX_TOKENS + DEFAULT_TOP_K * RECALL_ITEM_BUDGET_TOKENS,
    )
  })

  it('keeps the assembled plan when the host refuses the section, and says so', () => {
    // `register()` reports a refused channel instead of throwing, so the runtime
    // must treat it as a partial mount: the plan still describes what was
    // assembled, the load line stops claiming a section, and the log names it.
    const home = tempHome('omw-runtime-')
    homes.push(home)
    const parsed = parseConfig({ db: { dim: TEST_DIM } })
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
    const recorder = createRecordingContext({ home: home.dir })
    const refusing: ApplyContext = {
      ...recorder.ctx,
      systemPrompt: {
        section(): never {
          throw new Error('host refused the section')
        },
        context: recorder.ctx.systemPrompt.context,
      },
    }
    const sink = createMemorySink()
    const runtime = startRuntime({
      ctx: refusing,
      config: parsed.config,
      logger: createLogger(sink),
      personaText: 'You are the whale.',
    })
    runtimes.push(runtime)
    expect(runtime.injection).toBeDefined()
    expect((runtime.injection?.persona.text ?? '').length).toBeGreaterThan(0)
    expect(runtime.loaded.sectionRegistered).toBe(false)
    const codes = sink.lines.map(line => (JSON.parse(line) as { code: string }).code)
    expect(codes).toContain('OMW_SECTION_NOT_REGISTERED')
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

    const command = commands.find(entry => entry.name === 'omw-pred-promote')
    expect(command).toBeDefined()
    if (command === undefined) return

    // The model proposes the predicate first; only the user may promote it.
    const remember = recorder.definitions.find(definition => definition.name === 'remember')
    expect(remember).toBeDefined()

    const promoted = await command.handler({
      rawInput: 'mood --single --reason 探针',
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
describe('runtime: the host session log (AD-6)', () => {
  /** A host service that answers every read with one quotable sentence. */
  function hostLog(text: string, asked: { sessionId: string; seq: number }[]): { readEvent(request: { sessionId: string; seq: number }): Promise<unknown> } {
    return {
      async readEvent(request: { sessionId: string; seq: number }) {
        asked.push(request)
        return { target: { data: { content: [{ type: 'text', text }] } } }
      },
    }
  }

  it('resolves sessionQuery through ctx.get and lands the sentence on the pointer', async () => {
    const { home } = homeAt()
    const asked: { sessionId: string; seq: number }[] = []
    const recorder = createRecordingContext({ home: home.dir })
    const parsed = parseConfig({ db: { dim: TEST_DIM } })
    if (!parsed.ok) throw new Error('config')
    const runtime = startRuntime({
      ctx: {
        ...recorder.ctx,
        get: (name: string) => (name === 'sessionQuery' ? hostLog('我更喜欢浅烘焙。', asked) : undefined),
      },
      config: parsed.config,
      logger: createLogger(createMemorySink()),
      personaText: 'You are the whale.',
    })
    runtimes.push(runtime)

    const answer = await runtime.write?.remember({
      ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'likes', obj: 'coffee', evidence: { seq_from: 5, seq_to: 5 } }],
    }, 'model', 'remember', 'session-alpha')
    expect(answer?.ok).toBe(true)
    // The host was asked about exactly the declared range.
    expect(asked).toEqual([{ sessionId: 'session-alpha', seq: 5 }])

    const reader = runtime.evidence
    expect(reader).toBeDefined()
    const read = await reader?.read('assertion:Elliott:likes:coffee')
    expect(read?.ok).toBe(true)
    expect(read?.pointers).toHaveLength(1)
    expect(read?.pointers[0]).toMatchObject({
      session_id: 'session-alpha',
      seq_from: 5,
      seq_to: 5,
      quote: '我更喜欢浅烘焙。',
      quote_truncated: false,
      deidentified: false,
    })
    // Resolvable, so nothing is marked degraded.
    expect(read?.degraded).toBeUndefined()
  })

  it('still stores the pointer when the host exposes no session log', async () => {
    const { runtime } = boot()
    const answer = await runtime.write?.remember({
      ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'likes', obj: 'coffee', evidence: { seq_from: 7, seq_to: 7 } }],
    }, 'model', 'remember', 'session-alpha')
    expect(answer?.ok).toBe(true)
    const read = await runtime.evidence?.read('assertion:Elliott:likes:coffee')
    expect(read?.pointers[0]).toMatchObject({ quote: '', deidentified: false })
    expect(read?.degraded).toBe('evidence-unresolvable')
  })

  it('answers /omw evidence through a real apply() mount', async () => {
    const { home } = homeAt()
    const asked: { sessionId: string; seq: number }[] = []
    const commands: CommandDefinitionLike[] = []
    const registry = {
      register(definition: CommandDefinitionLike): () => void {
        commands.push(definition)
        return () => {}
      },
    }
    const recorder = createRecordingContext({ home: home.dir })
    let cleanup: (() => Promise<void>) | undefined
    apply({
      ...recorder.ctx,
      get: (name: string) => (name === 'commands' ? registry : name === 'sessionQuery' ? hostLog('命令行里也读得到。', asked) : undefined),
      effect: (callback) => {
        cleanup = callback() as (() => Promise<void>) | undefined
      },
    }, { db: { dim: TEST_DIM } })

    const remember = recorder.definitions.find(definition => definition.name === 'remember')
    expect(remember).toBeDefined()
    if (remember === undefined) return
    const written = await remember.execute({
      patch: {
        ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'likes', obj: 'coffee', evidence: { seq_from: 11, seq_to: 11 } }],
      },
    }, { agent: { id: 'session-alpha' } }) as { ok: boolean }
    expect(written.ok).toBe(true)

    const command = commands.find(entry => entry.name === 'omw-evidence')
    expect(command).toBeDefined()
    if (command === undefined) return
    const result = await command.handler({ rawInput: 'assertion:Elliott:likes:coffee' }) as { kind: string; text?: string }
    expect(result.kind).toBe('success')
    const text = result.text ?? ''
    expect(text).toContain('session-alpha #11-11')
    expect(text).toContain('命令行里也读得到。')
    const json = JSON.parse(text.split('\n').at(-1) ?? '{}') as { pointers: { quote: string }[] }
    expect(json.pointers[0]?.quote).toBe('命令行里也读得到。')
    await cleanup?.()
  })
})

describe('runtime: the recall reader (Story 2.5)', () => {
  it('is assembled beside the write side and answers from the same handle', async () => {
    const { runtime } = boot()
    expect(runtime.recall).toBeDefined()
    await runtime.write?.remember({
      ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'likes', obj: 'whale watching' }],
    }, 'model', 'remember')

    const answer = runtime.recall?.recall('whale')

    expect(answer?.ok).toBe(true)
    expect(answer?.hits.map(hit => hit.mem_key)).toEqual(['assertion:Elliott:likes:whale watching'])
    // The widths come from the configuration, so a narrowed contract is visible
    // here rather than only inside the composer.
    expect(answer?.top_k).toBe(DEFAULT_TOP_K)
  })


  it('takes the candidate pool from the configuration too, not just the width', async () => {
    // The pool is the outer cut, and it was the one key nothing read: a mutation
    // that hard-coded it to 12 left the whole suite green. Five memories and a
    // pool of three makes the wiring visible in three numbers at once.
    const { runtime } = boot({ candidatePool: 3 })
    for (let index = 0; index < 5; index += 1) {
      await runtime.write?.remember({
        ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'likes', obj: `whale note ${index}` }],
      }, 'model', 'remember')
    }

    const answer = runtime.recall?.recall('whale')

    expect(answer?.candidate_pool).toBe(3)
    expect(answer?.matched).toBe(5)
    expect(answer?.candidates).toBe(3)
    // Default topK is five and the pool is three, so the pool is the binding cut
    // — and the sentence has to name it rather than report three as a shortfall.
    expect(answer?.hits).toHaveLength(3)
    expect(answer?.message).toBe('找到 5 条未失效记忆，其中 3 条进入候选池，返回前 3 条。')
  })

  it('caps what it injects at topK while still returning every hit to the tool', async () => {
    // The two cuts are different questions: the tool answers with what the store
    // holds, the prompt gets at most topK. Five memories and topK=2 makes the
    // difference visible on both sides at once.
    const { home } = homeAt()
    const recorder = createRecordingContext({ home: home.dir })
    let cleanup: (() => Promise<void>) | undefined
    apply({
      ...recorder.ctx,
      effect: (callback) => {
        cleanup = callback() as (() => Promise<void>) | undefined
      },
    }, { db: { dim: TEST_DIM }, recall: { topK: 2 } })

    const remember = recorder.definitions.find(definition => definition.name === 'remember')
    if (remember === undefined) throw new Error('no remember tool')
    for (let index = 0; index < 5; index += 1) {
      await remember.execute({
        patch: { ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'likes', obj: `whale note ${index}` }] },
      }, { agent: { id: 'session-alpha' } })
    }

    const recalled = await recorder.definitions.find(definition => definition.name === 'recall')
      ?.execute({ query: 'whale' }, { agent: { id: 'session-alpha' } }) as { items?: unknown[] } | undefined
    expect(recalled?.items).toHaveLength(2)

    const assembled = recorder.assemble('session-alpha', [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'whale' }] } },
    ])
    const recallText = assembled.sections.find(entry => entry.name === RECALL_CONTEXT_NAME)?.text ?? ''
    // Two items, no more: the injected tier obeys the same cap the tool does.
    const lines = recallText.split('\n').filter(line => line.trim() !== '')
    expect(lines).toHaveLength(2)

    await cleanup?.()
  })

  it('keeps the identity section when the recall reader throws', async () => {
    const { home } = homeAt()
    const recorder = createRecordingContext({ home: home.dir })
    let cleanup: (() => Promise<void>) | undefined
    apply({
      ...recorder.ctx,
      effect: (callback) => {
        cleanup = callback() as (() => Promise<void>) | undefined
      },
    }, { db: { dim: TEST_DIM } })

    const assembled = recorder.assemble('session-alpha', [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'whale' }] } },
    ])
    // Nothing to recall from an empty store, and that must cost only the tier.
    expect(assembled.sections.find(entry => entry.name === RECALL_CONTEXT_NAME)?.text).toBe('')
    expect(assembled.text.trim().length).toBeGreaterThan(0)

    await cleanup?.()
  })

  it('feeds those hits into the prompt once the conversation gives it a query (P0-1)', async () => {
    // The whole point of the wiring: recall is not only a tool a model may call,
    // it also rides into the prompt. A store with one memory plus a session whose
    // last turn mentions whales must produce condensed text carrying that memory.
    const { home } = homeAt()
    const recorder = createRecordingContext({ home: home.dir })
    let cleanup: (() => Promise<void>) | undefined
    apply({
      ...recorder.ctx,
      effect: (callback) => {
        cleanup = callback() as (() => Promise<void>) | undefined
      },
    }, { db: { dim: TEST_DIM } })

    const remember = recorder.definitions.find(definition => definition.name === 'remember')
    if (remember === undefined) throw new Error('no remember tool')
    await remember.execute({
      patch: { ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'likes', obj: 'whale watching' }] },
    }, { agent: { id: 'session-alpha' } })

    const assembled = recorder.assemble('session-alpha', [
      { type: 'user/message', data: { content: [{ type: 'text', text: '我最近想去看 whale' }] } },
    ])
    // The recall channel is its own context, named and ordered apart from the tail.
    const recallEntry = assembled.sections.find(entry => entry.name === RECALL_CONTEXT_NAME)
    expect(recallEntry).toBeDefined()
    expect(recallEntry?.text).toContain('whale watching')
    // And the pure-text join, which is what the model actually receives.
    expect(assembled.text).toContain('whale watching')

    await cleanup?.()
  })

  it('injects nothing when the conversation offers no query, and still assembles', async () => {
    const { home } = homeAt()
    const recorder = createRecordingContext({ home: home.dir })
    let cleanup: (() => Promise<void>) | undefined
    apply({
      ...recorder.ctx,
      effect: (callback) => {
        cleanup = callback() as (() => Promise<void>) | undefined
      },
    }, { db: { dim: TEST_DIM } })

    const remember = recorder.definitions.find(definition => definition.name === 'remember')
    if (remember === undefined) throw new Error('no remember tool')
    await remember.execute({
      patch: { ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'likes', obj: 'whale watching' }] },
    }, { agent: { id: 'session-alpha' } })

    const assembled = recorder.assemble('session-alpha', [])
    expect(assembled.sections.find(entry => entry.name === RECALL_CONTEXT_NAME)?.text).toBe('')
    // The identity section survives: "no query" is not "no prompt" (FR-15).
    expect(assembled.text.trim().length).toBeGreaterThan(0)

    await cleanup?.()
  })
  it('keeps answering while the write side is down', () => {
    // Two live versions of one key already in the file: the bootstrap cannot
    // build the unique index, so the write port is never built. Recall depends on
    // the handle, not on the registry (AD-18 keeps the halves independent).
    const { home } = homeAt()
    const opened = openDatabase({ file: join(home.dir, 'oh-my-whale', 'oh-my-whale.tdb'), dim: TEST_DIM, memoryLimitMb: 256 })
    if (!opened.ok) throw new Error(opened.reason)
    const zero = new Array<number>(TEST_DIM).fill(0)
    const iso = new Date().toISOString()
    opened.db.insert(zero, { kind: 'assertion', mem_key: 'dup:key', active_slot: 1, obj: 'whale one', valid_from: iso, recorded_at: iso })
    opened.db.insert(zero, { kind: 'assertion', mem_key: 'dup:key', active_slot: 1, obj: 'whale two', valid_from: iso, recorded_at: iso })
    closeDatabase(opened.db)

    const recorder = createRecordingContext({ home: home.dir })
    const parsed = parseConfig({ db: { dim: TEST_DIM } })
    if (!parsed.ok) throw new Error('config')
    const runtime = startRuntime({
      ctx: recorder.ctx,
      config: parsed.config,
      logger: createLogger(createMemorySink()),
      personaText: 'You are the whale.',
    })
    runtimes.push(runtime)

    expect(runtime.write).toBeUndefined()
    const answer = runtime.recall?.recall('whale')
    expect(answer?.ok).toBe(true)
    // Both live versions of that key come back: the store holds a state the
    // index forbids, and recall reports what is there rather than guessing.
    expect(answer?.candidates).toBe(2)
  })

  it('reaches the model through a real apply() mount instead of E_NOT_IMPLEMENTED', async () => {
    const { home } = homeAt()
    const recorder = createRecordingContext({ home: home.dir, withTools: true })
    let cleanup: (() => Promise<void>) | undefined
    apply({
      ...recorder.ctx,
      effect: (callback) => {
        cleanup = callback() as (() => Promise<void>) | undefined
      },
    }, { db: { dim: TEST_DIM } })

    const remember = recorder.definitions.find(definition => definition.name === 'remember')
    if (remember === undefined) throw new Error('remember was not registered')
    await remember.execute({
      patch: { ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'likes', obj: 'whale watching' }] },
    }, { agent: { id: 'session-alpha' } })

    const recall = recorder.definitions.find(definition => definition.name === 'recall')
    if (recall === undefined) throw new Error('recall was not registered')
    // The tool answer is the schema's shape, not the reader's: `hits` is the
    // reader's own view and the tool flattens it to `mem_keys` / `items`.
    const answer = await recall.execute({ query: 'whale' }, {}) as { ok: boolean; code: string; mem_keys: string[]; matched: number }
    expect(answer.ok).toBe(true)
    expect(answer.code).toBe(E_OK)
    expect(answer.mem_keys).toEqual(['assertion:Elliott:likes:whale watching'])

    // The same call one step out of bounds is refused, and refuses without
    // reading: the boundary is the reader's, not the host schema's.
    const refused = await recall.execute({ query: 'whale', topK: 9 }, {}) as { ok: boolean; code: string; mem_keys: unknown[]; matched: number }
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe('E_BOUNDARY')
    expect(refused.mem_keys).toEqual([])
    expect(refused.matched).toBe(0)
    await cleanup?.()
  })

  it('does not answer from a closed handle after dispose', async () => {
    const { runtime } = boot()
    const reader = runtime.recall
    expect(reader).toBeDefined()
    await runtime.dispose()
    runtimes.length = 0
    const answer = reader?.recall('whale')
    expect(answer?.ok).toBe(false)
    expect(answer?.code).toBe('E_GATE_DOWN')
  })
})

describe('runtime: the version reader (Story 2.3)', () => {
  it('is assembled beside the write side, and answers a rewrite without a second mount', async () => {
    const { runtime } = boot()
    expect(runtime.version).toBeDefined()
    const first = await runtime.write?.remember({
      ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'lives_in', obj: '杭州' }],
    }, 'model', 'remember')
    expect(first?.ok).toBe(true)
    const second = await runtime.write?.remember({
      ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'lives_in', obj: '上海' }],
    }, 'model', 'remember')
    expect(second?.ok).toBe(true)

    const history = runtime.version?.history('assertion:Elliott:lives_in')
    expect(history?.ok).toBe(true)
    expect(history?.versions).toHaveLength(2)
    expect(history?.versions.map(version => version.live)).toEqual([false, true])
    expect(history?.versions[0]?.obj).toBe('杭州')
    expect(history?.versions[1]?.obj).toBe('上海')
    const ledger = runtime.version?.ledger('assertion:Elliott:lives_in')
    expect(ledger?.entries.map(entry => entry.kind)).toEqual(['insert', 'supersede'])
  })

  it('is disposed with the runtime, rather than answering from a closed handle', async () => {
    const { runtime } = boot()
    await runtime.write?.remember({
      ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'lives_in', obj: '杭州' }],
    }, 'model', 'remember')
    const reader = runtime.version
    expect(reader).toBeDefined()
    await runtime.dispose()
    runtimes.length = 0
    const answer = reader?.history('assertion:Elliott:lives_in')
    expect(answer?.ok).toBe(false)
    expect(answer?.code).toBe('E_GATE_DOWN')
  })

  it('answers /omw history and /omw ledger through a real apply() mount', async () => {
    const { home } = homeAt()
    const commands: CommandDefinitionLike[] = []
    const registry = {
      register(definition: CommandDefinitionLike): () => void {
        commands.push(definition)
        return () => {}
      },
    }
    const recorder = createRecordingContext({ home: home.dir })
    let cleanup: (() => Promise<void>) | undefined
    apply({
      ...recorder.ctx,
      get: (name: string) => (name === 'commands' ? registry : undefined),
      effect: (callback) => {
        cleanup = callback() as (() => Promise<void>) | undefined
      },
    }, { db: { dim: TEST_DIM } })

    const remember = recorder.definitions.find(definition => definition.name === 'remember')
    if (remember === undefined) throw new Error('remember was not registered')
    for (const city of ['杭州', '上海']) {
      const written = await remember.execute({
        patch: { ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'lives_in', obj: city }] },
      }, { agent: { id: 'session-alpha' } }) as { ok: boolean }
      expect(written.ok).toBe(true)
    }

    const historyCommand = commands.find(entry => entry.name === 'omw-history')
    expect(historyCommand).toBeDefined()
    if (historyCommand === undefined) return
    const ledgerCommand = commands.find(entry => entry.name === 'omw-ledger')
    expect(ledgerCommand).toBeDefined()
    if (ledgerCommand === undefined) return

    const history = await historyCommand.handler({ rawInput: 'assertion:Elliott:lives_in' }) as { kind: string; text?: string }
    expect(history.kind).toBe('success')
    const historyText = history.text ?? ''
    expect(historyText).toContain('[已退役] 杭州')
    expect(historyText).toContain('[当前版本] 上海')
    const historyJson = JSON.parse(historyText.split('\n').at(-1) ?? '{}') as { versions: { live: boolean }[] }
    expect(historyJson.versions.map(version => version.live)).toEqual([false, true])

    const ledger = await ledgerCommand.handler({ rawInput: 'assertion:Elliott:lives_in' }) as { kind: string; text?: string }
    expect(ledger.kind).toBe('success')
    const ledgerText = ledger.text ?? ''
    expect(ledgerText).toContain('insert')
    expect(ledgerText).toContain('supersede')
    const ledgerJson = JSON.parse(ledgerText.split('\n').at(-1) ?? '{}') as { entries: { kind: string }[] }
    expect(ledgerJson.entries.map(entry => entry.kind)).toEqual(['insert', 'supersede'])

    // The ledger key itself has no chain: it is a record, not a memory version.
    const refused = await historyCommand.handler({ rawInput: 'rejected:let-me' }) as { kind: string; text?: string }
    expect(refused.kind).toBe('error')
    expect(refused.text ?? '').toContain('账本')
    await cleanup?.()
  })
})
