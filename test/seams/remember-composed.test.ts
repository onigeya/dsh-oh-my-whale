/**
 * Remember, end to end through a real mount.
 *
 * Every layer of Story 2.1 has its own test file, and each of them stubs its
 * neighbours: the planner is a pure function, the port is a facade, the tool is
 * a registry entry. That leaves one question unanswered — do the four fit
 * together? These tests call the `remember` tool that `apply` mounted and then
 * read the store back, so the answer travels tool → port → planner → engine →
 * store with nothing replaced along the way.
 * @module
 */
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, type ApplyContext } from '../../src/index.ts'
import type { CommandDefinitionLike } from '../../src/seams/commands.ts'
import { parseConfig, type Config } from '../../src/seams/config.ts'
import { createRecordingContext, tempHome, type TempHome } from '../support/fake-ctx.ts'
import { closeDatabase, openDatabase } from '../../src/store/db.ts'
import { createAssertionTemplates } from '../../src/store/templates/assertions.ts'
import { TEST_DIM } from '../support/write-store.ts'

interface Mounted {
  readonly ctx: ApplyContext
  readonly recorder: ReturnType<typeof createRecordingContext>
  readonly config: Config
  readonly home: TempHome
  readonly commands: readonly CommandDefinitionLike[]
  readonly cleanup: () => Promise<void>
}

const mounted: { cleanup?: () => Promise<void>; home: TempHome }[] = []

afterEach(async () => {
  while (mounted.length > 0) {
    const entry = mounted.pop()
    if (entry === undefined) continue
    await entry.cleanup?.()
    entry.home.remove()
  }
})

/** Mount the plugin the way the host does, with the four tools attached. */
function mount(overrides: Record<string, unknown> = {}): Mounted {
  const home = tempHome('omw-composed-')
  const parsed = parseConfig({ db: { dim: TEST_DIM }, ...overrides })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
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
  const recorder = createRecordingContext({ home: home.dir, withTools: true })
  let cleanup: (() => Promise<void>) | undefined
  const context: ApplyContext = {
    ...recorder.ctx,
    get: (name: string) => (name === 'commands' ? registry : undefined),
    effect: (callback) => {
      cleanup = callback() as (() => Promise<void>) | undefined
    },
  }
  const stderr = process.stderr.write.bind(process.stderr)
  process.stderr.write = (() => true) as typeof process.stderr.write
  try {
    apply(context, parsed.config)
  } finally {
    process.stderr.write = stderr
  }
  const resolved = cleanup
  if (resolved === undefined) throw new Error('apply registered no cleanup')
  mounted.push({ cleanup: resolved, home })
  return { ctx: context, recorder, config: parsed.config, home, commands, cleanup: resolved }
}

/** The remember definition this mount registered. */
function rememberOf(m: Mounted): { execute: (args: unknown, exec: unknown) => Promise<unknown> } {
  const definition = m.recorder.definitions.find(entry => entry.name === 'remember')
  if (definition === undefined) throw new Error('remember was not registered')
  return definition as unknown as { execute: (args: unknown, exec: unknown) => Promise<unknown> }
}

interface Answer {
  readonly ok: boolean
  readonly code: string
  readonly tool: string
  readonly message: string
  readonly mem_keys: readonly string[]
  readonly items: readonly { index: number; op: string; outcome: string; mem_key: string; kind: string }[]
}

async function remember(m: Mounted, patch: unknown): Promise<Answer> {
  const definition = rememberOf(m)
  return await definition.execute({ patch }, {}) as Answer
}

/** Read one business key back after the mount released the handle. */
function storedAfter(m: Mounted, memKey: string): Record<string, unknown> | undefined {
  const opened = openDatabase({
    file: join(m.home.dir, 'oh-my-whale', 'oh-my-whale.tdb'),
    dim: TEST_DIM,
    memoryLimitMb: 256,
  })
  if (!opened.ok) throw new Error(opened.reason)
  try {
    return createAssertionTemplates(opened.db).findLiveByKey(memKey)?.payload
  } finally {
    closeDatabase(opened.db)
  }
}

describe('remember, end to end', () => {
  it('writes a fact the caller can read back after the handle closed', async () => {
    const m = mount()
    const answer = await remember(m, {
      ops: [{ op: 'assert', kind: 'pref', subj: 'Elliott', pred: 'reply_style', obj: 'concise' }],
    })

    expect(answer.ok).toBe(true)
    expect(answer.code).toBe('OK')
    expect(answer.tool).toBe('remember')
    expect(answer.mem_keys).toEqual(['pref:Elliott:reply_style:concise'])
    expect(answer.items).toEqual([
      { index: 1, op: 'assert', outcome: 'created', mem_key: 'pref:Elliott:reply_style:concise', kind: 'pref', value: 'concise' },
    ])

    await m.cleanup()
    const stored = storedAfter(m, 'pref:Elliott:reply_style:concise')
    expect(stored).toMatchObject({
      kind: 'pref',
      key: 'reply_style',
      value: 'concise',
      active_slot: 1,
      origin: 'observed',
      cause: 'tool',
    })
  })

  it('carries a planner refusal back through the tool, word for word', async () => {
    const m = mount()
    // One key, two answers, in the same table: there is no earlier version to
    // retire, so the planner refuses. What matters here is that the sentence
    // survives the tool layer intact rather than being replaced by a generic
    // 'write failed' the model could not act on.
    const answer = await remember(m, {
      ops: [
        { op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'name', obj: 'Elliott' },
        { op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'name', obj: 'Eliot' },
      ],
    })

    expect(answer.ok).toBe(false)
    expect(answer.code).toBe('E_CONFLICT')
    expect(answer.items).toEqual([])
    expect(answer.mem_keys).toEqual([])
    expect(answer.message).toContain('同一张表里 assertion:Elliott:name 有两个不同的值')
  })

  it('applies the new-predicate budget it was configured with', async () => {
    const m = mount({ tbox: { maxNewPredsPerDay: 1 } })
    const first = await remember(m, { ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'mood', obj: 'calm' }] })
    const second = await remember(m, { ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'hobby', obj: 'chess' }] })

    expect(first.code).toBe('OK')
    // The cap came from config, not from a constant inside the port.
    expect(second.ok).toBe(true)
    expect(second.code).toBe('E_DEGRADED')
    expect(second.items.map(item => item.outcome)).toEqual(['downgraded'])

    await m.cleanup()
    expect(storedAfter(m, 'pred:hobby')).toBeUndefined()
    expect(storedAfter(m, 'scene:Elliott:hobby:chess')).toBeDefined()
  })

  it('keeps a tool call and a user promotion on the same registry', async () => {
    const m = mount()
    // The model proposes `mood`; the user then promotes it to single-valued.
    await remember(m, { ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'mood', obj: 'calm' }] })
    const command = m.commands.find(entry => entry.name === 'omw')
    if (command === undefined) throw new Error('omw was not registered')
    const promoted = await command.handler({ rawInput: ' pred promote mood --single --reason 用户要求单值' })
    expect(promoted.kind).toBe('success')

    await m.cleanup()
    expect(storedAfter(m, 'pred:mood')).toMatchObject({
      cardinality: 'single',
      status: 'active',
      decided_by: 'user',
    })
  })
})
