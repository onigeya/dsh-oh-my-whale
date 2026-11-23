/**
 * `/omw doctor` — the in-process diagnosis surface (FR-17).
 *
 * It must work in exactly the situation the CLI cannot: while this very instance
 * holds the database. So every case here mounts the plugin for real and then
 * invokes the registered command through the same handle.
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

/** A command registry that records definitions and can invoke them. */
function registry(): {
  readonly definitions: CommandDefinitionLike[]
  readonly register: (definition: CommandDefinitionLike) => () => void
  invoke(rawInput: string): Promise<CommandResultLike>
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
    async invoke(rawInput: string) {
      const definition = definitions[0]
      if (definition === undefined) throw new Error('no command registered')
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

describe('/omw doctor: healthy instance', () => {
  it('registers the command and reports five ordered checks', async () => {
    process.env['SILICONFLOW_API_KEY'] = 'test-key'
    const { commands } = mount()
    expect(commands.definitions.map(definition => definition.name)).toEqual(['omw'])

    const result = await commands.invoke(' doctor')
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

  it('answers help and rejects an unknown subcommand', async () => {
    const { commands } = mount()
    const help = await commands.invoke('')
    expect(help.kind).toBe('success')
    expect(help.kind === 'success' ? help.text : '').toContain('/omw doctor')

    const unknown = await commands.invoke(' nope')
    expect(unknown.kind).toBe('error')
    expect(unknown.kind === 'error' ? unknown.text : '').toContain('未知子命令')
  })
})

describe('/omw doctor: degraded instance', () => {
  it('still registers, and reports the state that caused the no-op', async () => {
    const { commands } = mount({ dirtyDb: true })
    expect(commands.definitions).toHaveLength(1)

    const result = await commands.invoke(' doctor')
    expect(result.kind).toBe('error')
    const text = result.kind === 'error' ? result.text : ''
    expect(text).toMatch(/^1\/5 db\s+FAIL .*OMW_DB_OPEN/mu)
    expect(text).toMatch(/^2\/5 snapshot\s+skip/mu)
    expect(text).toMatch(/^5\/5 section\s+pass/mu)
    expect(text).toContain('首个失败 OMW_DB_OPEN')
  })
})
