/**
 * Story 1.2 — five ordered checks plus the five misconfiguration rows of the
 * I/O matrix.
 * @module
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOCTOR_CODES, runDoctor } from '../../src/cli/doctor.ts'
import { closeDatabase, nodeCount, openDatabase } from '../../src/store/db.ts'
import { readJsonLines, tempHome, type TempHome } from '../support/fake-ctx.ts'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const entryPath = join(repoRoot, 'lib', 'index.js')

const homes: TempHome[] = []
let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchSpy = vi.fn(() => Promise.reject(new Error('doctor must never perform a network request')))
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
  while (homes.length > 0) homes.pop()?.remove()
})

/** Profile files to write for one case. */
interface ProfileSpec {
  readonly bundles?: readonly string[]
  /** Contents of `cordis.patch.yml`; `null` writes a bare `[]`. */
  readonly patch?: string | null
  /** Contents of `cordis.yml`; `null` writes `[]`. */
  readonly root?: string | null
  /** The plugin entry's `config:` block. */
  readonly config?: unknown
}

const DEFAULT_PATCH = `- insert:
    - id: oh-my-whale
      name: dsh-oh-my-whale
      config: {}
`

/** Create a temp home with one profile. */
function makeProfile(spec: ProfileSpec = {}): TempHome {
  const home = tempHome('omw-doctor-')
  homes.push(home)
  const dir = home.path('profiles', 'web')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: spec.bundles ?? ['dsh-oh-my-whale'] } },
  }, null, 2))
  const config = spec.config === undefined ? {} : spec.config
  const patch = spec.patch === undefined ? DEFAULT_PATCH.replace('config: {}', `config: ${JSON.stringify(config)}`) : spec.patch
  writeFileSync(join(dir, 'cordis.patch.yml'), patch ?? '[]\n')
  writeFileSync(join(dir, 'cordis.yml'), spec.root ?? '[]\n')
  return home
}

/** Run the doctor against a temp home. */
async function doctor(home: TempHome, options: { env?: Record<string, string | undefined>; entryPath?: string } = {}) {
  return runDoctor({
    home: home.dir,
    profile: 'web',
    env: options.env ?? { SILICONFLOW_API_KEY: 'test-key-value' },
    entryPath: options.entryPath ?? entryPath,
  })
}

describe('doctor: healthy profile', () => {
  it('prints five checks in order and exits 0', async () => {
    const home = makeProfile()
    const report = await doctor(home)
    expect(report.checks.map(check => check.id)).toEqual(['db', 'snapshot', 'dim', 'credential', 'section'])
    expect(report.checks.every(check => check.status === 'pass')).toBe(true)
    expect(report.exitCode).toBe(0)
    expect(report.summary).toContain('5/5')
  })

  it('appends exactly one omw.log line and creates no audit file', async () => {
    const home = makeProfile()
    await doctor(home)
    const dataDir = home.path('oh-my-whale')
    const logLines = readJsonLines(join(dataDir, 'omw.log'))
    expect(logLines).toHaveLength(1)
    expect(logLines[0]).toMatchObject({ code: 'OMW_DOCTOR', level: 'info' })
    expect(readdirSync(dataDir).filter(name => name.startsWith('audit-'))).toEqual([])
  })

  it('leaves the node count unchanged across two runs', async () => {
    const home = makeProfile()
    await doctor(home)
    const opened = openDatabase({ file: home.path('oh-my-whale', 'oh-my-whale.tdb'), dim: 1024, memoryLimitMb: 512, readOnly: true })
    expect(opened.ok).toBe(true)
    const before = opened.ok ? nodeCount(opened.db) : -1
    if (opened.ok) closeDatabase(opened.db)
    await doctor(home)
    const again = openDatabase({ file: home.path('oh-my-whale', 'oh-my-whale.tdb'), dim: 1024, memoryLimitMb: 512, readOnly: true })
    expect(again.ok ? nodeCount(again.db) : -2).toBe(before)
    if (again.ok) closeDatabase(again.db)
  })

  it('never performs a network request', async () => {
    const home = makeProfile()
    await doctor(home)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('doctor: CRED_MISSING', () => {
  it('fails the credential check without touching the network', async () => {
    const home = makeProfile()
    const report = await doctor(home, { env: {} })
    const credential = report.checks.find(check => check.id === 'credential')
    expect(credential?.status).toBe('fail')
    expect(credential?.code).toBe('OMW_EMBED_AUTH')
    expect(report.exitCode).toBe(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('names the environment variable and never a value', async () => {
    const home = makeProfile()
    const report = await doctor(home, { env: {} })
    const text = report.lines.join('\n')
    expect(text).toContain('SILICONFLOW_API_KEY')
    expect(text).not.toMatch(/sk-[A-Za-z0-9]/u)
  })
})

describe('doctor: structural misconfigurations', () => {
  it('DEP_NOT_DECLARED names the package and the field', async () => {
    const home = makeProfile({ bundles: [] })
    const report = await doctor(home)
    expect(report.exitCode).toBe(1)
    expect(report.structural?.code).toBe(DOCTOR_CODES.depNotDeclared)
    expect(report.structural?.detail).toContain('dsh-oh-my-whale')
    expect(report.structural?.detail).toContain('dsh.profile.bundles')
  })

  it('PATCH_WRONG_PLACE points at cordis.patch.yml', async () => {
    const home = makeProfile({ patch: '[]\n', root: DEFAULT_PATCH })
    const report = await doctor(home)
    expect(report.exitCode).toBe(1)
    expect(report.structural?.code).toBe(DOCTOR_CODES.wrongPatchFile)
    expect(report.structural?.detail).toContain('cordis.patch.yml')
  })

  it('PATCH_ENTRY_MISSING reports the missing insert', async () => {
    const home = makeProfile({ patch: '[]\n' })
    const report = await doctor(home)
    expect(report.exitCode).toBe(1)
    expect(report.structural?.code).toBe(DOCTOR_CODES.patchEntryMissing)
  })

  it('SCHEMA_INVALID names db.dim and the received type', async () => {
    const home = makeProfile({ config: { db: { dim: '1024' } } })
    const report = await doctor(home)
    expect(report.exitCode).toBe(1)
    expect(report.structural?.code).toBe(DOCTOR_CODES.schema)
    expect(report.structural?.detail).toContain('db.dim')
    expect(report.structural?.detail).toContain('string')
  })

  it('rejects a negative dimension', async () => {
    const home = makeProfile({ config: { db: { dim: -1 } } })
    const report = await doctor(home)
    expect(report.structural?.code).toBe(DOCTOR_CODES.schema)
    expect(report.structural?.detail).toContain('db.dim')
  })

  it('SECTION_MISSING is caught on an artifact that registers another section', async () => {
    const home = makeProfile()
    const fixture = home.path('fixture-plugin.mjs')
    writeFileSync(fixture, [
      'export function apply(ctx) {',
      "  ctx.systemPrompt.section({ name: 'other:section', order: 1, text: 'x' })",
      '}',
      '',
    ].join('\n'))
    const report = await doctor(home, { entryPath: fixture })
    const section = report.checks.find(check => check.id === 'section')
    expect(section?.status).toBe('fail')
    expect(section?.code).toBe(DOCTOR_CODES.sectionNotRegistered)
    expect(report.exitCode).toBe(1)
  })

  it('reports DATABASE_OPEN_FAIL through the first check', async () => {
    const home = makeProfile()
    mkdirSync(home.path('oh-my-whale'), { recursive: true })
    writeFileSync(home.path('oh-my-whale', 'oh-my-whale.tdb'), 'not a database')
    const report = await doctor(home)
    const db = report.checks.find(check => check.id === 'db')
    expect(db?.status).toBe('fail')
    expect(db?.code).toBe('OMW_DB_OPEN')
    expect(report.checks.find(check => check.id === 'snapshot')?.status).toBe('skip')
  })
})

describe('doctor: DIM_MISMATCH', () => {
  it('fails the dimension check and names db.dim and both values', async () => {
    const home = makeProfile({ config: { db: { dim: 1024 } } })
    const dataDir = home.path('oh-my-whale')
    mkdirSync(dataDir, { recursive: true })
    const seeded = openDatabase({ file: join(dataDir, 'oh-my-whale.tdb'), dim: 512, memoryLimitMb: 256 })
    expect(seeded.ok).toBe(true)
    if (seeded.ok) closeDatabase(seeded.db)

    const report = await doctor(home)
    expect(report.checks.find(check => check.id === 'db')?.status).toBe('pass')
    const dim = report.checks.find(check => check.id === 'dim')
    expect(dim?.status).toBe('fail')
    expect(dim?.code).toBe('OMW_DIM_MISMATCH')
    expect(dim?.detail).toContain('db.dim=1024')
    expect(dim?.detail).toContain('512')
    expect(report.exitCode).toBe(1)
  })
})

describe('doctor: snapshot backfill', () => {
  it('creates today\'s snapshot on a writable handle when none exists', async () => {
    const home = makeProfile()
    const dataDir = home.path('oh-my-whale')
    mkdirSync(dataDir, { recursive: true })
    const seeded = openDatabase({ file: join(dataDir, 'oh-my-whale.tdb'), dim: 1024, memoryLimitMb: 256 })
    expect(seeded.ok).toBe(true)
    if (seeded.ok) closeDatabase(seeded.db)
    expect(existsSync(join(dataDir, 'snapshots'))).toBe(false)

    const report = await doctor(home)

    const snapshot = report.checks.find(check => check.id === 'snapshot')
    expect(snapshot?.status).toBe('pass')
    expect(snapshot?.detail).toContain('已补做')
    expect(readdirSync(join(dataDir, 'snapshots')).length).toBeGreaterThan(0)
    expect(report.exitCode).toBe(0)
  })
})

describe('doctor: process exit codes', () => {
  const cli = join(repoRoot, 'lib', 'cli.js')

  /** Run the built CLI the way a user would. */
  function runCli(home: TempHome): { status: number; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [cli, 'doctor', '--home', home.dir, '--profile', 'web'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, SILICONFLOW_API_KEY: 'test-key-not-real' },
      timeout: 120_000,
    })
    return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }

  it('exits 0 and prints the five checks in their fixed order', () => {
    const home = makeProfile()
    const result = runCli(home)
    expect(result.status, result.stderr).toBe(0)
    const order = [...result.stdout.matchAll(/\d\/5\s+(\w+)/gu)].map(match => match[1])
    expect(order).toEqual(['db', 'snapshot', 'dim', 'credential', 'section'])
  })

  it('exits 1 when a check fails', () => {
    const home = makeProfile()
    mkdirSync(home.path('oh-my-whale'), { recursive: true })
    writeFileSync(home.path('oh-my-whale', 'oh-my-whale.tdb'), 'not a database')
    const result = runCli(home)
    expect(result.status, result.stderr).toBe(1)
    expect(result.stdout).toContain('OMW_DB_OPEN')
  })

  it('exits 2 when the profile does not exist', () => {
    const home = tempHome('omw-doctor-')
    homes.push(home)
    const result = runCli(home)
    expect(result.status, result.stderr).toBe(2)
  })
})

describe('doctor: unreadable profile', () => {
  it('fails with exit 1 when the profile has no package.json', async () => {
    const home = tempHome('omw-doctor-')
    homes.push(home)
    mkdirSync(home.path('profiles', 'web'), { recursive: true })
    writeFileSync(home.path('profiles', 'web', 'cordis.patch.yml'), DEFAULT_PATCH)
    const report = await runDoctor({ home: home.dir, profile: 'web', env: {} })
    expect(report.exitCode).toBe(1)
    expect(report.structural?.code).toBe('PROFILE_UNREADABLE')
  })

  it('reports a string bundle list as a schema problem, not an empty list', async () => {
    const home = tempHome('omw-doctor-')
    homes.push(home)
    const dir = home.path('profiles', 'web')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: 'dsh-oh-my-whale' } } }))
    writeFileSync(join(dir, 'cordis.patch.yml'), DEFAULT_PATCH)
    writeFileSync(join(dir, 'cordis.yml'), '[]\n')
    const report = await runDoctor({ home: home.dir, profile: 'web', env: {} })
    expect(report.exitCode).toBe(1)
    expect(report.structural?.code).toBe(DOCTOR_CODES.schema)
    expect(report.structural?.detail).toContain('dsh.profile.bundles')
    expect(report.structural?.detail).toContain('string')
  })
})

describe('doctor: exit code 2', () => {
  it('reports a missing profile without inventing checks', async () => {
    const home = tempHome('omw-doctor-')
    homes.push(home)
    const report = await runDoctor({ home: home.dir, profile: 'nope', env: {} })
    expect(report.exitCode).toBe(2)
    expect(report.checks).toEqual([])
    expect(existsSync(join(home.dir, 'oh-my-whale'))).toBe(false)
  })
})
