/**
 * FR-15 / Story 1.1 — the identity section and the load line.
 * @module
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../../src/index.ts'
import { parseConfig, resolvePaths, type Config } from '../../src/seams/config.ts'
import { normalizePersona, RECALL_CONTEXT_NAME } from '../../src/seams/prompt-composer.ts'
import { closeDatabase, openDatabase } from '../../src/store/db.ts'
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
function load(config: unknown = {}): {
  sections: ReturnType<typeof createRecordingContext>
  stderr: string
  home: TempHome
} {
  const home = tempHome()
  homes.push(home)
  const recorder = createRecordingContext({ home: home.dir })
  const { stderr } = captureStderr(() => {
    apply(recorder.ctx, config)
  })
  return { sections: recorder, stderr, home }
}

/**
 * Mount against a temp home whose database has been seeded first.
 *
 * Story 2.4 AC5: assembling the prompt must not read the store, so a scene
 * node left behind by a dream cycle may not change one byte of the injection.
 * The configuration is the same one the plain `load()` uses, and both mounts
 * must come up healthy — otherwise "same bytes" could just mean "both failed".
 * @param config - the configuration both mounts share.
 * @param seed - called with the data directory before the plugin mounts.
 * @returns the recorder, the captured stderr and the home.
 */
function loadWithSeed(config: Config, seed: (dataDir: string) => void): {
  sections: ReturnType<typeof createRecordingContext>
  stderr: string
  home: TempHome
} {
  const home = tempHome()
  homes.push(home)
  const paths = resolvePaths(config, (...segments) => join(home.dir, ...segments))
  mkdirSync(paths.dataDir, { recursive: true })
  seed(paths.dataDir)
  const recorder = createRecordingContext({ home: home.dir })
  const { stderr } = captureStderr(() => {
    apply(recorder.ctx, config)
  })
  return { sections: recorder, stderr, home }
}

/**
 * Write one scene node into the store, the way a dream cycle would.
 *
 * The write is checked here rather than in the caller: if the node never landed,
 * the test that compares two mounts would compare an empty store with an empty
 * store and still pass, which is the one way this check can lie.
 */
function writeScene(dataDir: string): void {
  const opened = openDatabase({
    file: join(dataDir, 'oh-my-whale.tdb'),
    dim: 4,
    memoryLimitMb: 512,
  })
  if (!opened.ok) throw new Error('could not open the seeded store: ' + opened.reason)
  const id = opened.db.insert([0, 0, 0, 0], {
    kind: 'scene',
    mem_key: 'scene:weeknight-cooking',
    name: 'weeknight-cooking',
    description: '一起做晚饭的那些晚上',
    episode_refs: [],
    confidence: 0.6,
    active_slot: 1,
    valid_from: '2026-11-20T10:00:00.000Z',
    recorded_at: '2026-11-20T10:00:00.000Z',
    vec_state: 'pending',
  })
  const stored = opened.db.getPayload(id)
  closeDatabase(opened.db)
  if (stored === undefined || stored['kind'] !== 'scene') {
    throw new Error('the scene node did not land in the seeded store')
  }
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

  it('registers no state tail while the tail has no source', () => {
    const { sections } = load()
    // The recall context is registered unconditionally (its provider answers with
    // whatever the assembly computed), so "no tail" is asserted by name rather
    // than by an empty context list.
    expect(sections.contexts.map(context => context.name)).toEqual([RECALL_CONTEXT_NAME])
    expect(sections.contexts.map(context => context.text)).toEqual([''])
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
  it('registers the four tools by name', () => {
    const { sections } = load()
    expect(sections.tools).toEqual(['remember', 'recall', 'forget', 'explain'])
  })

  it('answers a recall call from the mounted store, not with a placeholder', async () => {
    const { sections } = load()
    const recall = sections.definitions.find(definition => definition.name === 'recall')
    const answer = await recall?.execute({ query: 'hi' }, {}) as Record<string, unknown>
    expect(answer).toMatchObject({ ok: true, tool: 'recall' })
    // The reader sorts by `hits`; the tool surface flattens it into mem_keys and
    // items, because the output schema declares its fields and `hits` is not one.
    expect(Array.isArray(answer['items'])).toBe(true)
    expect(Array.isArray(answer['mem_keys'])).toBe(true)
    expect(answer['hits']).toBeUndefined()
    expect(answer['top_k']).toBe(5)
  })

  it('keeps forget and explain as structured not-implemented answers', async () => {
    const { sections } = load()
    for (const name of ['forget', 'explain']) {
      const tool = sections.definitions.find(definition => definition.name === name)
      const answer = await tool?.execute({ query: 'hi' }, {}) as Record<string, unknown>
      expect(answer).toMatchObject({ ok: false, code: 'E_NOT_IMPLEMENTED', tool: name })
    }
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

describe('load: what the injection may read (Story 2.4)', () => {
  it('injects the same bytes whether or not a scene is in the store', () => {
    // One configuration for both mounts, with a small dimension so the seeded
    // store can be written cheaply: a dimension mismatch would make the two
    // mounts disagree for a reason that has nothing to do with the scene.
    const parsed = parseConfig({ db: { dim: 4 } })
    if (!parsed.ok) throw new Error('the shared config did not parse: ' + JSON.stringify(parsed.issues))
    const config = parsed.config
    const empty = load(config)
    const seeded = loadWithSeed(config, writeScene)
    const textOf = (recorder: ReturnType<typeof createRecordingContext>): string =>
      recorder.sections.find(section => section.name === 'harness:identity')?.text ?? ''
    // Both mounts came up healthy: "same bytes" must not be "both degraded".
    expect(empty.stderr).toContain('state=ok')
    expect(seeded.stderr).toContain('state=ok')
    expect(textOf(seeded.sections)).toBe(textOf(empty.sections))
    expect(textOf(seeded.sections).length).toBeGreaterThan(0)
    // Both mounts must record the same registrations, not just the same text.
    // The providers are functions, so the comparison is over names, orders and
    // the text they render for a session — two functions are never `===`.
    const shapeOf = (recorded: ReturnType<typeof load>['sections']): unknown =>
      recorded.contexts.map(context => ({
        name: context.name,
        order: context.order,
        text: context.render === undefined ? context.text : context.render({ session: { id: 'shape-check' } }),
      }))
    expect(shapeOf(seeded.sections)).toEqual(shapeOf(empty.sections))
  })
})

