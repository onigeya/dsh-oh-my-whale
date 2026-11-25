/**
 * Story 2.6 — the audit rows as a real mount writes them.
 *
 * Every assertion here is about a file on disk after a host-shaped assembly,
 * because that is the only shape in which the injection row exists: the session
 * id arrives with the assembly context and nowhere else. The unit tests pin the
 * fields; these pin the wiring.
 * @module
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../../src/index.ts'
import { auditFileName, parseConfig } from '../../src/seams/config.ts'
import { createLogger, createMemorySink } from '../../src/seams/logger.ts'
import { queryHash } from '../../src/ops/recall-audit.ts'
import { PERSONA_SECTION_NAME, type PersonaState } from '../../src/seams/prompt-composer.ts'
import { startRuntime, type Runtime } from '../../src/seams/runtime.ts'
import { createRecordingContext, readJsonLines, tempHome, type TempHome } from '../support/fake-ctx.ts'
import { TEST_DIM } from '../support/write-store.ts'

const homes: TempHome[] = []
const runtimes: Runtime[] = []

afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.dispose()
  while (homes.length > 0) homes.pop()?.remove()
})

const NOON = new Date(Date.UTC(2026, 10, 24, 12, 0, 0))

/** A fresh temp home and its validated configuration. */
function homeAt(): { home: TempHome; config: ReturnType<typeof parseConfig> } {
  const home = tempHome('omw-audit-runtime-')
  homes.push(home)
  return { home, config: parseConfig({ db: { dim: TEST_DIM } }) }
}

/** Boot a runtime over a recording host, at one fixed instant. */
interface BootOptions {
  readonly now?: () => Date
  readonly services?: Record<string, unknown>
  /** A state source: giving one is what puts a tail into the assembly. */
  readonly readState?: () => PersonaState | undefined
}

function boot(options: BootOptions = {}) {
  const { home, config } = homeAt()
  if (!config.ok) throw new Error(JSON.stringify(config.issues))
  const sink = createMemorySink()
  const recorder = createRecordingContext({ home: home.dir, ...(options.services === undefined ? {} : { services: options.services }) })
  const runtime = startRuntime({
    ctx: recorder.ctx,
    config: config.config,
    logger: createLogger(sink),
    personaText: 'You are the whale.',
    now: options.now ?? (() => NOON),
    ...(options.readState === undefined ? {} : { readState: options.readState }),
  })
  runtimes.push(runtime)
  return { runtime, recorder, sink, home }
}

/** The audit rows on disk for one home, once the queue has drained. */
async function rowsOnDisk(runtime: Runtime, date: Date = NOON): Promise<Record<string, unknown>[]> {
  await runtime.audit?.flush()
  return readJsonLines(join(runtime.paths.dataDir, auditFileName(date)))
}

describe('audit: the injection row a real assembly writes', () => {
  it('lands one row per assembly, naming the session the host rendered for', async () => {
    const { runtime, recorder } = boot()
    recorder.assemble('session-alpha')
    const rows = (await rowsOnDisk(runtime)).filter(row => row['kind'] === 'injection')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ session_id: 'session-alpha', tier: 'identity' })
    expect(rows[0]?.['ts']).toBe(NOON.toISOString())
    // The row has no node id anywhere in it (AC⑥). Naming the keys is what
    // makes this a check: the previous pattern matched almost any JSON, so a
    // row carrying `"id": 42` would have passed it.
    const text = JSON.stringify(rows[0])
    expect(text).not.toMatch(/"(?:id|node_id|nodeId)"/u)
    expect(text).not.toMatch(/"[a-z_]+":\s*\d{3,}"/u)
  })

  it('does not write a row for an assembly the host never asked for', async () => {
    const { runtime } = boot()
    const rows = (await rowsOnDisk(runtime)).filter(row => row['kind'] === 'injection')
    expect(rows).toEqual([])
  })

  it('reports the prefix as unchanged only across two assemblies of the same session', async () => {
    const { runtime, recorder } = boot()
    recorder.assemble('session-alpha')
    recorder.assemble('session-alpha')
    const rows = (await rowsOnDisk(runtime)).filter(row => row['kind'] === 'injection')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.['prefix_unchanged']).toBe(false)
    expect(rows[1]?.['prefix_unchanged']).toBe(true)
  })

  it('keeps the cache columns null when the host exposes no token meter', async () => {
    const { runtime, recorder } = boot()
    recorder.assemble('session-alpha')
    const row = (await rowsOnDisk(runtime)).find(entry => entry['kind'] === 'injection')
    expect(row?.['host_cache_read']).toBeNull()
    expect(row?.['host_cache_write']).toBeNull()
    expect(row?.['host_cache_uncached']).toBeNull()
  })

  it('reads the host cache delta when the services are there', async () => {
    const readings = [
      { cacheReadTokens: 400, cacheWriteTokens: 100, uncachedInputTokens: 900 },
      { cacheReadTokens: 700, cacheWriteTokens: 150, uncachedInputTokens: 1200 },
    ]
    let index = 0
    const { runtime, recorder } = boot({
      services: {
        sessions: { get: (id: string) => (id === 'session-alpha' ? { id } : undefined) },
        // Shaped like the real registry, not like a stub: `snapshot` takes the
        // session object the store returned and answers for that one. A fixture
        // that ignores the argument cannot tell a reader that passed the right
        // session from one that passed a literal.
        sessionProjections: {
          snapshot: (session: { readonly id: string }) => {
            expect(session.id).toBe('session-alpha')
            return { values: { tokenUsage: readings[Math.min(index, readings.length - 1)] } }
          },
        },
      },
    })
    // Each assembly reads the projection once, so the second row sees the later
    // reading and reports the difference rather than the total.
    recorder.assemble('session-alpha')
    index += 1
    recorder.assemble('session-alpha')
    const rows = (await rowsOnDisk(runtime)).filter(row => row['kind'] === 'injection')
    expect(rows).toHaveLength(2)
    expect([rows[0]?.['host_cache_read'], rows[0]?.['host_cache_write'], rows[0]?.['host_cache_uncached']]).toEqual([400, 100, 900])
    expect([rows[1]?.['host_cache_read'], rows[1]?.['host_cache_write'], rows[1]?.['host_cache_uncached']]).toEqual([300, 50, 300])
  })
})

describe('audit: the recall row a real recall writes', () => {
  it('lands one row per completed recall with the hits but never the query', async () => {
    const { runtime } = boot()
    await runtime.write?.remember({
      ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'likes', obj: 'whale watching' }],
    }, 'model', 'remember')
    runtime.recall?.recall('whale')
    const rows = (await rowsOnDisk(runtime)).filter(row => row['kind'] === 'recall')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.['hits']).toEqual(['assertion:Elliott:likes:whale watching'])
    expect(rows[0]?.['top_k']).toBe(5)
    expect(typeof rows[0]?.['elapsed_ms']).toBe('number')
    // The row keeps a digest instead of the text. It cannot be checked by
    // searching for the query: a hit is a business key, and a key may legitimately
    // contain the object the user searched for. So the check is the positive one —
    // there is a digest of that query and no field holding the query itself.
    expect(rows[0]?.['query_hash']).toBe(queryHash('whale'))
    expect(rows[0]).not.toHaveProperty('query')
  })

  it('writes nothing for a refused call, because no query ran', async () => {
    const { runtime } = boot()
    const refused = runtime.recall?.recall('whale', 9)
    expect(refused?.ok).toBe(false)
    const rows = (await rowsOnDisk(runtime)).filter(row => row['kind'] === 'recall')
    expect(rows).toEqual([])
  })
})

describe('audit: the day boundary and the sweep', () => {
  it('writes to the file named by the boot clock', async () => {
    const later = new Date(Date.UTC(2026, 11, 1, 1, 0, 0))
    const { runtime, recorder } = boot({ now: () => later })
    recorder.assemble('session-alpha')
    await runtime.audit?.flush()
    const files = readdirSync(runtime.paths.dataDir).filter(name => name.startsWith('audit-'))
    expect(files).toEqual([auditFileName(later)])
  })

  it('splits one session across two files when the clock crosses midnight', async () => {
    // Local wall-clock on purpose: the file name is a local date, so building
    // the instants from local components is the only way this test means the
    // same thing in every time zone.
    const before = new Date(2026, 10, 24, 23, 59, 0)
    const after = new Date(2026, 10, 25, 0, 1, 0)
    let current = before
    const { runtime, recorder } = boot({ now: () => current })
    recorder.assemble('session-alpha')
    current = after
    recorder.assemble('session-alpha')
    await runtime.audit?.flush()
    const files = readdirSync(runtime.paths.dataDir).filter(name => name.startsWith('audit-')).sort()
    expect(files).toEqual([auditFileName(before), auditFileName(after)])
    // Same session, two files: `prefix_unchanged` still compares against the
    // previous assembly, because the split is a property of the file and not of
    // what the session has seen.
    const second = readJsonLines(join(runtime.paths.dataDir, auditFileName(after)))
    expect(second[0]).toMatchObject({ session_id: 'session-alpha', prefix_unchanged: true })
  })
  it('sweeps files older than the retention window at mount, and keeps the rest', () => {
    const home = tempHome('omw-audit-runtime-')
    homes.push(home)
    const dataDir = join(home.dir, 'oh-my-whale')
    // A file from well outside the window, and one from inside it.
    mkdirSync(dataDir, { recursive: true })
    // Both files carry a real audit row: rotation only deletes a file it can
    // identify as one of ours, so a fixture of `{}` would survive as foreign and
    // the case would pass without proving the sweep ran.
    const row = `${JSON.stringify({ kind: 'injection', ts: '2026-11-20T12:00:00.000Z', session_id: 's1' })}\n`
    writeFileSync(join(dataDir, 'audit-20200101.jsonl'), row, 'utf8')
    const inside = auditFileName(new Date(Date.UTC(2026, 10, 20, 12, 0, 0)))
    writeFileSync(join(dataDir, inside), row, 'utf8')
    const parsed = parseConfig({ db: { dim: TEST_DIM } })
    if (!parsed.ok) throw new Error('config')
    const runtime = startRuntime({
      ctx: createRecordingContext({ home: home.dir }).ctx,
      config: parsed.config,
      logger: createLogger(createMemorySink()),
      personaText: 'You are the whale.',
      now: () => NOON,
    })
    runtimes.push(runtime)
    expect(runtime.retention?.rotate().removed).toEqual([])
    const files = readdirSync(dataDir).filter(name => name.startsWith('audit-'))
    expect(files).not.toContain('audit-20200101.jsonl')
    expect(files).toContain(inside)
  })
})

describe('audit: the tail a state source puts into the row', () => {
  it('reports the identity+state tier and names the unit each segment came from', async () => {
    const { runtime, recorder } = boot({
      readState: () => ({ relationship: '同事', preference: '简洁' }),
    })
    recorder.assemble('session-alpha')
    const row = (await rowsOnDisk(runtime)).find(entry => entry['kind'] === 'injection')
    // The tier is derived from what was kept, not from whether a tail text
    // exists, so this is also the check that a row cannot claim the state tier
    // while listing nothing from it.
    expect(row).toMatchObject({
      tier: 'identity+state',
      items: ['identity', 'state:relationship', 'state:preference'],
    })
    expect(row?.['chars']).toBeGreaterThan(0)
  })

  it('reports the plan frozen at registration, not the state as it is now', async () => {
    let state: PersonaState | undefined = { relationship: '同事' }
    const { runtime, recorder } = boot({ readState: () => state })
    recorder.assemble('session-alpha')
    // The plan is composed once, at registration, and every later assembly
    // replays it — by design: the host must see a stable prefix, and a row that
    // re-read the state would describe a prompt nobody received. So the second
    // row says the prefix held, which is true, and its tail is still the first
    // one's text. The other direction (a tail that really did change, from a
    // re-registration) is covered on the auditor directly, in
    // `test/ops/injection-audit.test.ts`.
    state = { relationship: '朋友' }
    recorder.assemble('session-alpha')
    const rows = (await rowsOnDisk(runtime)).filter(row => row['kind'] === 'injection')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.['prefix_unchanged']).toBe(false)
    expect(rows[1]?.['prefix_unchanged']).toBe(true)
    expect(rows[1]?.['chars']).toBe(rows[0]?.['chars'])
    expect(rows[1]?.['items']).toEqual(rows[0]?.['items'])
  })

  it('reports the identity tier when the state source has nothing to say', async () => {
    const { runtime, recorder } = boot({ readState: () => undefined })
    recorder.assemble('session-alpha')
    const row = (await rowsOnDisk(runtime)).find(entry => entry['kind'] === 'injection')
    expect(row).toMatchObject({ tier: 'identity', items: ['identity'] })
  })
})

describe('audit: an assembly the host ran without a session', () => {
  it('writes no row and says so, because there is no session id to name', async () => {
    const { runtime, recorder, sink } = boot()
    // The recorder's assemble() always supplies a session — that is what a real
    // chat turn does — so the no-session branch is reached by calling the
    // registered provider the way a preview or a title pass would: with an
    // object that carries no `session`.
    const identity = recorder.sections.find(section => section.name === PERSONA_SECTION_NAME)
    expect(identity?.render).toBeTypeOf('function')
    identity?.render?.({})
    const rows = (await rowsOnDisk(runtime)).filter(row => row['kind'] === 'injection')
    expect(rows).toEqual([])
    const events = sink.lines.map(line => JSON.parse(line) as Record<string, unknown>)
    expect(events).toContainEqual(
      expect.objectContaining({
        code: 'OMW_AUDIT_ROW_SKIPPED',
        detail: { kind: 'injection', reason: 'no-session' },
      }),
    )
  })

  it('stays quiet when nothing assembled at all, so the one-line startup invariant holds', async () => {
    const { sink } = boot()
    // Registration alone renders the provider once with no context, because the
    // fixture reads the section text as it records it. That is not an assembly,
    // and a line for it would break Story 1.3's "a broken database produces
    // exactly one omw.log line".
    const skipped = sink.lines.filter(line => line.includes('OMW_AUDIT_ROW_SKIPPED'))
    expect(skipped).toEqual([])
  })
})

describe('audit: the recall row a real recall writes', () => {
  it('names the session the recall ran for', async () => {
    const { runtime } = boot()
    await runtime.write?.remember({
      ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'likes', obj: 'whale watching' }],
    }, 'model', 'remember')
    runtime.recall?.recall('whale', 5, 'session-alpha')
    const row = (await rowsOnDisk(runtime)).find(entry => entry['kind'] === 'recall')
    // Three hops have to agree for this to hold: the reader expands the id into
    // its event, the auditor copies it into the row, the sink writes the row.
    // Each hop is unit-tested; this is the only test that walks all three.
    expect(row?.['session_id']).toBe('session-alpha')
    expect(row).not.toHaveProperty('query')
    const text = JSON.stringify(row)
    expect(text).not.toMatch(/"(?:id|node_id|nodeId)"/u)
  })

  it('writes an empty session id, never a made-up one, when the caller gave none', async () => {
    const { runtime } = boot()
    runtime.recall?.recall('whale')
    const row = (await rowsOnDisk(runtime)).find(entry => entry['kind'] === 'recall')
    expect(row?.['session_id']).toBe('')
  })
})

describe('audit: a sweep that cannot run at mount', () => {
  it('leaves the runtime mounted and says the sweep was blocked', () => {
    const home = tempHome('omw-audit-runtime-')
    homes.push(home)
    // Rotation reads the directory; pointing it at a regular file makes that
    // read throw ENOTDIR, which is the only way the mount-time catch can be
    // reached without a permission trick. The plugin must survive it: audit is
    // an observer, and an observer that cannot sweep must not take the memory
    // down with it.
    // \`dataDir\` is the *directory* holding the database file, so pointing the
    // database inside a regular file makes the sweep's \`readdirSync\` throw
    // ENOTDIR while leaving the path itself well-formed.
    const notADirectory = join(home.dir, 'oh-my-whale')
    writeFileSync(notADirectory, '', 'utf8')
    const parsed = parseConfig({ db: { dim: TEST_DIM, path: join(notADirectory, 'omw.db') } })
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
    const sink = createMemorySink()
    const runtime = startRuntime({
      ctx: createRecordingContext({ home: home.dir }).ctx,
      config: parsed.config,
      logger: createLogger(sink),
      personaText: 'You are the whale.',
      now: () => NOON,
    })
    runtimes.push(runtime)
    expect(runtime.retention).toBeUndefined()
    expect(runtime.sectionChars).toBeGreaterThan(0)
    const events = sink.lines.map(line => JSON.parse(line) as Record<string, unknown>)
    // The detail carries the platform's own message (ENOTDIR on this one), so
    // the assertion is that the sweep's failure was reported at all — a run that
    // silently swallowed it would produce no such event.
    expect(events).toContainEqual(
      expect.objectContaining({
        code: 'OMW_AUDIT_WRITE_FAILED',
        detail: expect.objectContaining({ reason: expect.stringMatching(/\S/u) }),
      }),
    )
  })
})

describe('audit: the directory a real mount wrote, read back by the report', () => {
  it('reports the rows this runtime actually produced', async () => {
    const { runtime, recorder } = boot()
    recorder.assemble('session-alpha')
    recorder.assemble('session-alpha')
    runtime.recall?.recall('whale')
    await runtime.audit?.flush()
    // The report reads the same JSONL the plugin writes. Feeding it a hand-made
    // fixture proves the script's arithmetic; feeding it the real directory is
    // what proves the two agree on the file layout and the field names.
    const script = join(import.meta.dirname, '..', '..', 'scripts', 'audit-report.mjs')
    const result = spawnSync(process.execPath, [
      script,
      '--dir', runtime.paths.dataDir,
      '--since', '24h',
      '--now', NOON.toISOString(),
      '--json',
    ], { encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    interface Block {
      readonly count: number
    }
    const report = JSON.parse(result.stdout) as Record<string, Block>
    expect(report['injection']?.count).toBe(2)
    expect(report['recall']?.count).toBe(1)
    // One write row, and it is the bootstrap: mounting installs the seed, and
    // that install is a write the audit is meant to show.
    expect(report['write']?.count).toBe(1)
  })
})

describe('audit: a real apply() mount drains its rows on dispose', () => {
  it('leaves the injection rows on disk by the time cleanup returns', async () => {
    const { home, config } = homeAt()
    if (!config.ok) throw new Error('config')
    const recorder = createRecordingContext({ home: home.dir })
    let cleanup: (() => Promise<void>) | undefined
    apply({
      ...recorder.ctx,
      effect: (callback) => {
        cleanup = callback() as (() => Promise<void>) | undefined
      },
    }, { db: { dim: TEST_DIM } })
    recorder.assemble('session-alpha')
    await cleanup?.()
    const dataDir = join(home.dir, 'oh-my-whale')
    const file = join(dataDir, auditFileName(new Date()))
    const rows = readJsonLines(file).filter(row => row['kind'] === 'injection')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ session_id: 'session-alpha' })
  })
})