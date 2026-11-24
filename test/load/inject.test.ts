/**
 * FR-15 / Story 1.1 — the identity section and the load line.
 * @module
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../../src/index.ts'
import { normalizePersona } from '../../src/seams/prompt-composer.ts'
import { registerPlaceholderTools, type ToolRegistryLike } from '../../src/seams/tools.ts'
import { createRecordingContext, tempHome, type TempHome } from '../support/fake-ctx.ts'

const personaFile = new URL('../../assets/persona.md', import.meta.url)

/** Capture everything the plugin writes to stderr during one call. */
function captureStderr<T>(run: () => T): { result: T; stderr: string } {
  const original = process.stderr.write.bind(process.stderr)
  let captured = ''
  process.stderr.write = ((chunk: unknown): boolean => {
    captured += String(chunk)
    return true
  }) as typeof process.stderr.write
  try {
    return { result: run(), stderr: captured }
  } finally {
    process.stderr.write = original
  }
}

const homes: TempHome[] = []
afterEach(() => {
  while (homes.length > 0) homes.pop()?.remove()
})

/** Run `apply` against a fresh recording context. */
function load(): { sections: ReturnType<typeof createRecordingContext>; stderr: string; home: TempHome } {
  const home = tempHome()
  homes.push(home)
  const recorder = createRecordingContext({ home: home.dir })
  const { stderr } = captureStderr(() => {
    apply(recorder.ctx, {})
  })
  return { sections: recorder, stderr, home }
}

describe('load: identity section', () => {
  it('registers harness:identity with the persona file text', () => {
    const { sections } = load()
    const persona = sections.sections.find(section => section.name === 'harness:identity')
    expect(persona).toBeDefined()
    const expected = normalizePersona(readFileSync(personaFile, 'utf8'), 1200)
    expect(persona?.text).toBe(expected.text)
    expect(persona?.text.length).toBeGreaterThan(0)
  })

  it('keeps the section within the 1200-character budget', () => {
    const { sections } = load()
    const persona = sections.sections.find(section => section.name === 'harness:identity')
    expect([...(persona?.text ?? '')].length).toBeLessThanOrEqual(1200)
  })

  it('is byte-stable across two independent loads', () => {
    const first = load()
    const second = load()
    const textOf = (recorder: ReturnType<typeof createRecordingContext>): string =>
      recorder.sections.find(section => section.name === 'harness:identity')?.text ?? ''
    expect(textOf(first.sections)).toBe(textOf(second.sections))
    const hash = createHash('sha256').update(textOf(first.sections), 'utf8').digest('hex')
    expect(hash).toBe(createHash('sha256').update(textOf(second.sections), 'utf8').digest('hex'))
  })

  it('normalizes CRLF so a Windows checkout injects the same bytes', () => {
    const raw = readFileSync(personaFile, 'utf8')
    // The asset may already be CRLF on a Windows checkout, so normalise to LF
    // first: replacing every \n blindly would turn \r\n into \r\r\n.
    const lf = raw.replace(/\r\n/gu, '\n')
    const crlf = lf.replace(/\n/gu, '\r\n')
    expect(normalizePersona(crlf, 1200).text).toBe(normalizePersona(lf, 1200).text)
  })

  it('registers no state tail in Epic 1', () => {
    const { sections } = load()
    expect(sections.contexts).toEqual([])
  })
})

describe('load: stderr confirmation', () => {
  it('prints exactly one loaded line naming the section', () => {
    const { stderr } = load()
    const lines = stderr.split(/\r?\n/u).filter(line => line.includes('[omw] loaded'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('section=harness:identity')
  })

  it('does not write the load line to omw.log', () => {
    const { home } = load()
    const log = (() => {
      try {
        return readFileSync(home.path('oh-my-whale', 'omw.log'), 'utf8')
      } catch {
        return ''
      }
    })()
    expect(log).not.toContain('[omw] loaded')
  })
})

describe('load: tool surface', () => {
  it('registers the four placeholders by name', () => {
    const { sections } = load()
    expect(sections.tools).toEqual(['remember', 'recall', 'forget', 'explain'])
  })

  it('answers every call with a structured not-implemented error', async () => {
    const { sections } = load()
    const recall = sections.definitions.find(definition => definition.name === 'recall')
    const answer = await recall?.execute({ query: 'hi' }, {}) as Record<string, unknown>
    expect(answer).toMatchObject({ ok: false, code: 'E_NOT_IMPLEMENTED', tool: 'recall' })
  })
})

describe('load: host seams', () => {
  it('throws for an invalid config, names the key, and registers nothing', () => {
    const home = tempHome()
    homes.push(home)
    const recorder = createRecordingContext({ home: home.dir })
    expect(() => apply(recorder.ctx, { db: { dim: '1024' } })).toThrow(/db\.dim/u)
    expect(() => apply(recorder.ctx, { db: { dim: '1024' } })).toThrow(/string/u)
    expect(recorder.sections).toEqual([])
    expect(recorder.tools).toEqual([])
  })

  it('resolves the tool registry through ctx.get when the property is absent', () => {
    const home = tempHome()
    homes.push(home)
    const recorder = createRecordingContext({ home: home.dir, toolsViaGet: true })
    const { stderr } = captureStderr(() => {
      apply(recorder.ctx, {})
    })
    expect(stderr).toContain('state=ok')
    expect(recorder.tools).toEqual(['remember', 'recall', 'forget', 'explain'])
    expect('tools' in recorder.ctx).toBe(false)
  })

  it('keeps the no-op state and the database unchanged across repeated mounts', async () => {
    const home = tempHome()
    homes.push(home)
    mkdirSync(home.path('oh-my-whale'), { recursive: true })
    const dbFile = home.path('oh-my-whale', 'oh-my-whale.tdb')
    writeFileSync(dbFile, 'definitely not a trivium database')
    const before = createHash('sha256').update(readFileSync(dbFile)).digest('hex')

    const states: string[] = []
    for (let turn = 0; turn < 2; turn += 1) {
      const recorder = createRecordingContext({ home: home.dir })
      const { stderr } = captureStderr(() => {
        apply(recorder.ctx, {})
      })
      states.push(stderr)
      expect(recorder.tools).toEqual([])
      expect(recorder.sections.find(section => section.name === 'harness:identity')).toBeDefined()
      await recorder.dispose()
    }

    expect(states).toHaveLength(2)
    expect(states.every(line => line.includes('state=no-op'))).toBe(true)
    expect(createHash('sha256').update(readFileSync(dbFile)).digest('hex')).toBe(before)
  })
})

describe('load: tool registration is all-or-nothing', () => {
  it('rolls back the tools already registered when one registration throws', () => {
    const registered: string[] = []
    const disposed: string[] = []
    const registry = {
      register(definition: { name: string }): () => void {
        if (registered.length === 2) throw new Error('registry refused')
        registered.push(definition.name)
        return () => {
          disposed.push(definition.name)
        }
      },
    } as unknown as ToolRegistryLike

    expect(() => registerPlaceholderTools(registry)).toThrow(/registry refused/u)
    expect(registered).toEqual(['remember', 'recall'])
    // Undone newest-first, so a partial surface never survives a failure.
    expect(disposed).toEqual(['recall', 'remember'])
  })
})

describe('load: optional host surfaces', () => {
  it('does not fail the mount when the tools property throws without inject', () => {
    const home = tempHome()
    homes.push(home)
    const recorder = createRecordingContext({ home: home.dir })
    const guarded = {
      ...recorder.ctx,
      get: (_name: string): unknown => undefined,
      get tools(): never {
        // Mirrors Cordis: reading an un-injected service throws.
        throw new Error('cannot get property "tools" without inject')
      },
    }
    const { stderr } = captureStderr(() => apply(guarded, {}))
    expect(stderr).toContain('[omw] loaded state=ok')
    // The mount survived, so the section was registered on the guarded context.
    expect(guarded.get('tools')).toBeUndefined()
  })
})
