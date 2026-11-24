/**
 * Story 1.3 — when the foundation is broken the plugin steps aside, but the
 * whale is still the whale.
 * @module
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { normalizePersona } from '../../src/seams/prompt-composer.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../../src/index.ts'
import { closeDatabase, nodeCount, openDatabase } from '../../src/store/db.ts'
import { SNAPSHOT_ATTEMPTS, calendarDay } from '../../src/ops/snapshots.ts'
import { SUPPORTED_CONTRACT_VERSION, writeContractVersion } from '../../src/store/meta.ts'
import { createRecordingContext, readJsonLines, tempHome, type TempHome } from '../support/fake-ctx.ts'

const personaFile = new URL('../../assets/persona.md', import.meta.url)
const homes: TempHome[] = []

afterEach(() => {
  while (homes.length > 0) homes.pop()?.remove()
})

/** Capture stderr while running one load. */
function load(home: TempHome): ReturnType<typeof createRecordingContext> {
  const recorder = createRecordingContext({ home: home.dir })
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = (() => true) as typeof process.stderr.write
  try {
    apply(recorder.ctx, {})
  } finally {
    process.stderr.write = original
  }
  return recorder
}

/** The identity text expected in every state. */
function expectedPersona(): string {
  return normalizePersona(readFileSync(personaFile, 'utf8'), 1200).text
}

describe('degrade: dirty database (DB_OPEN_FAIL)', () => {
  it('injects the identical identity section and registers no tools', () => {
    const home = tempHome()
    homes.push(home)
    mkdirSync(home.path('oh-my-whale'), { recursive: true })
    writeFileSync(home.path('oh-my-whale', 'oh-my-whale.tdb'), 'definitely not a trivium database')
    const recorder = load(home)
    const persona = recorder.sections.find(section => section.name === 'harness:identity')
    expect(persona?.text).toBe(expectedPersona())
    expect(recorder.tools).toEqual([])
  })

  it('writes exactly one omw.log line, level=error, code=OMW_DB_OPEN', () => {
    const home = tempHome()
    homes.push(home)
    mkdirSync(home.path('oh-my-whale'), { recursive: true })
    writeFileSync(home.path('oh-my-whale', 'oh-my-whale.tdb'), 'definitely not a trivium database')
    load(home)
    const lines = readJsonLines(home.path('oh-my-whale', 'omw.log'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ level: 'error', code: 'OMW_DB_OPEN' })
  })

  it('writes no audit row and never rewrites the corrupt file', () => {
    const home = tempHome()
    homes.push(home)
    mkdirSync(home.path('oh-my-whale'), { recursive: true })
    const dbFile = home.path('oh-my-whale', 'oh-my-whale.tdb')
    writeFileSync(dbFile, 'definitely not a trivium database')
    const before = createHash('sha256').update(readFileSync(dbFile)).digest('hex')
    load(home)
    expect(readdirSync(home.path('oh-my-whale')).filter(name => name.startsWith('audit-'))).toEqual([])
    expect(createHash('sha256').update(readFileSync(dbFile)).digest('hex')).toBe(before)
    expect(existsSync(home.path('oh-my-whale', 'snapshots'))).toBe(false)
  })
})

describe('degrade: contract version ahead (CONTRACT_AHEAD)', () => {
  it('steps aside, names both sides, and leaves the database untouched', () => {
    const home = tempHome()
    homes.push(home)
    mkdirSync(home.path('oh-my-whale'), { recursive: true })
    const dbFile = home.path('oh-my-whale', 'oh-my-whale.tdb')
    const prepared = openDatabase({ file: dbFile, dim: 1024, memoryLimitMb: 512 })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    writeContractVersion(prepared.db, 99)
    const nodesBefore = nodeCount(prepared.db)
    closeDatabase(prepared.db)

    const recorder = load(home)
    expect(recorder.sections.find(section => section.name === 'harness:identity')?.text).toBe(expectedPersona())
    expect(recorder.tools).toEqual([])

    const lines = readJsonLines(home.path('oh-my-whale', 'omw.log'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ level: 'error', code: 'OMW_DB_OPEN' })
    expect(lines[0]?.['detail']).toMatchObject({
      probe: 'contract',
      supported: SUPPORTED_CONTRACT_VERSION,
      stored: 99,
    })

    const after = openDatabase({ file: dbFile, dim: 1024, memoryLimitMb: 512, readOnly: true })
    expect(after.ok ? nodeCount(after.db) : -1).toBe(nodesBefore)
    if (after.ok) closeDatabase(after.db)
  })
})

describe('degrade: dimension mismatch (DIM_MISMATCH)', () => {
  it('steps aside and names db.dim and both values', () => {
    const home = tempHome()
    homes.push(home)
    mkdirSync(home.path('oh-my-whale'), { recursive: true })
    const dbFile = home.path('oh-my-whale', 'oh-my-whale.tdb')
    const prepared = openDatabase({ file: dbFile, dim: 512, memoryLimitMb: 512 })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    closeDatabase(prepared.db)

    const recorder = createRecordingContext({ home: home.dir })
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      apply(recorder.ctx, { db: { dim: 1024 } })
    } finally {
      process.stderr.write = original
    }
    expect(recorder.tools).toEqual([])
    const lines = readJsonLines(home.path('oh-my-whale', 'omw.log'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ level: 'error', code: 'OMW_DIM_MISMATCH' })
    expect(lines[0]?.['detail']).toMatchObject({ key: 'db.dim', expected: 1024, actual: 512 })
  })
})

describe('degrade: snapshot cannot be verified (SNAPSHOT_VERIFY)', () => {
  it('steps aside, keeps the identity, and writes exactly one error line', () => {
    const home = tempHome()
    homes.push(home)
    // Every suffix for today is taken by a directory that does not verify, so no
    // snapshot can be made and the second gate fails.
    const day = calendarDay(new Date())
    for (const attempt of SNAPSHOT_ATTEMPTS) {
      mkdirSync(home.path('oh-my-whale', 'snapshots', `${day}-${attempt}`), { recursive: true })
    }

    const recorder = createRecordingContext({ home: home.dir })
    let stderr = ''
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk)
      return true
    }) as typeof process.stderr.write
    try {
      apply(recorder.ctx, {})
    } finally {
      process.stderr.write = original
    }

    expect(stderr).toContain('state=no-op')
    expect(recorder.tools).toEqual([])
    expect(recorder.sections.find(section => section.name === 'harness:identity')?.text).toBe(expectedPersona())

    const lines = readJsonLines(home.path('oh-my-whale', 'omw.log'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ level: 'error', code: 'OMW_SNAPSHOT_VERIFY' })
  })
})
