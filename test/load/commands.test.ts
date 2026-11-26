/**
 * The `/omw-*` command family — the in-process diagnosis surface (FR-17, P0-3).
 *
 * It must work in exactly the situation the CLI cannot: while this very instance
 * holds the database. So every case here mounts the plugin for real and then
 * invokes the registered command through the same handle.
 *
 * Ten separate names, not one `/omw` with subcommands: the host's parser takes
 * the first token as the command name, so the subcommand form only ever produced
 * a single registration while the architecture described ten.
 * @module
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../../src/index.ts'
import type { CommandDefinitionLike, CommandInvocationLike, CommandResultLike } from '../../src/seams/commands.ts'
import { createRecordingContext, tempHome, type TempHome } from '../support/fake-ctx.ts'

const homes: TempHome[] = []
const originalKey = process.env['SILICONFLOW_API_KEY']

afterEach(() => {
  while (homes.length > 0) homes.pop()?.remove()
  if (originalKey === undefined) delete process.env['SILICONFLOW_API_KEY']
  else process.env['SILICONFLOW_API_KEY'] = originalKey
})

/** Every command the surface registers, in registration order. */
const COMMANDS = [
  'omw-doctor',
  'omw-pred-promote',
  'omw-evidence',
  'omw-history',
  'omw-ledger',
  'omw-stats',
  'omw-explain',
  'omw-flag-queue',
  'omw-export',
  'omw-brief',
] as const

/** A command registry that records definitions and can invoke them by name. */
function registry(): {
  readonly definitions: CommandDefinitionLike[]
  readonly register: (definition: CommandDefinitionLike) => () => void
  invoke(name: string, rawInput?: string): Promise<CommandResultLike>
} {
  const definitions: CommandDefinitionLike[] = []
  return {
    definitions,
    register(definition) {
      definitions.push(definition)
      return () => {
        const index = definitions.indexOf(definition)
        if (index >= 0) definitions.splice(index, 1)
      }
    },
    async invoke(name: string, rawInput = '') {
      const definition = definitions.find(entry => entry.name === name)
      if (definition === undefined) throw new Error(`no command registered as ${name}`)
      return definition.handler({ rawInput } satisfies CommandInvocationLike)
    },
  }
}

/** Mount the plugin against a temp home, exposing a command registry. */
function mount(options: { readonly dirtyDb?: boolean } = {}) {
  const home = tempHome('omw-cmd-')
  homes.push(home)
  const dataDir = home.path('oh-my-whale')
  mkdirSync(dataDir, { recursive: true })
  if (options.dirtyDb === true) {
    writeFileSync(home.path('oh-my-whale', 'oh-my-whale.tdb'), 'definitely not a trivium database')
  }
  const commands = registry()
  const recorder = createRecordingContext({ home: home.dir })
  const ctx = {
    ...recorder.ctx,
    get: (name: string): unknown => (name === 'commands' ? commands : undefined),
    effect: (callback: () => (() => void) | undefined) => callback(),
  }
  const stderr = process.stderr.write
  process.stderr.write = (() => true) as typeof process.stderr.write
  try {
    apply(ctx, {})
  } finally {
    process.stderr.write = stderr
  }
  return { home, commands }
}

describe('/omw-*: the command surface', () => {
  it('registers ten names and no bare /omw', () => {
    const { commands } = mount()
    expect(commands.definitions.map(definition => definition.name)).toEqual([...COMMANDS])
    expect(commands.definitions.map(definition => definition.name)).not.toContain('omw')
  })

  it('keeps every name lowercase and hyphenated, which is what the parser accepts', () => {
    const { commands } = mount()
    for (const definition of commands.definitions) {
      expect(definition.name).toMatch(/^[a-z][a-z0-9-]*$/u)
    }
  })

  it('names the owning story for the commands whose stories have not landed', async () => {
    const { commands } = mount()
    const expected: Record<string, string> = {
      'omw-explain': 'Story 3.1',
      'omw-flag-queue': 'Story 3.3',
      'omw-export': 'Story 3.5',
      'omw-brief': 'Story 3.8',
    }
    for (const [name, owner] of Object.entries(expected)) {
      const result = await commands.invoke(name)
      expect(result.kind).toBe('error')
      expect(result.kind === 'error' ? result.text : '').toContain(owner)
    }
  })

  it('answers /omw-stats from the live audit rows, not with a placeholder', async () => {
    process.env['SILICONFLOW_API_KEY'] = 'test-key'
    const { commands } = mount()
    // A mounted instance writes a bootstrap row on first boot, so the window has
    // something real in it: the report must not be an empty one.
    const result = await commands.invoke('omw-stats', '--all')
    expect(result.kind).toBe('success')
    const text = result.kind === 'success' ? (result.text ?? '') : ''
    const json = JSON.parse(text.split('\n').at(-1) ?? '{}') as {
      tool: string
      report: { rows: number; write: { outcomes: { name: string }[] } }
    }
    expect(json.tool).toBe('omw-stats')
    expect(json.report.rows).toBeGreaterThan(0)
    expect(json.report.write.outcomes.map(entry => entry.name)).toContain('bootstrap')
  })

  it('says a bad window is a bad window, rather than reporting an empty one', async () => {
    const { commands } = mount()
    const result = await commands.invoke('omw-stats', '--since yesterday')
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' ? result.text : '').toContain('无法识别的窗口')
  })
})

describe('/omw-doctor: healthy instance', () => {
  it('reports five ordered checks', async () => {
    process.env['SILICONFLOW_API_KEY'] = 'test-key'
    const { commands } = mount()

    const result = await commands.invoke('omw-doctor')
    expect(result.kind).toBe('success')
    const text = result.kind === 'success' ? (result.text ?? '') : result.text
    const lines = text.split('\n').filter(line => /^\d\/5/u.test(line))
    expect(lines).toHaveLength(5)
    expect(lines[0]).toMatch(/^1\/5 db\s+pass/u)
    expect(lines[1]).toMatch(/^2\/5 snapshot\s+pass/u)
    expect(lines[2]).toMatch(/^3\/5 dim\s+pass/u)
    expect(lines[3]).toMatch(/^4\/5 credential\s+pass/u)
    expect(lines[4]).toMatch(/^5\/5 section\s+pass 已注册 harness:identity（\d+ 字符，4 个工具）/u)
    expect(text).toContain('omw doctor: 5/5 通过')
  })
})

describe('/omw-doctor: degraded instance', () => {
  it('still registers the whole surface, and reports the state that caused the no-op', async () => {
    const { commands } = mount({ dirtyDb: true })
    expect(commands.definitions).toHaveLength(COMMANDS.length)

    const result = await commands.invoke('omw-doctor')
    expect(result.kind).toBe('error')
    const text = result.kind === 'error' ? result.text : ''
    expect(text).toMatch(/^1\/5 db\s+FAIL .*OMW_DB_OPEN/mu)
    expect(text).toMatch(/^2\/5 snapshot\s+skip/mu)
    expect(text).toMatch(/^5\/5 section\s+pass/mu)
    expect(text).toContain('首个失败 OMW_DB_OPEN')
  })
})