/**
 * G0-6 — the layer gate is a real gate, not a convention.
 *
 * The test runs the shipped checker twice: over this repository (must pass) and
 * over a throw-away fixture containing a deliberate `core -> seams` import
 * (must fail and name the rule).
 * @module
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const checker = join(repoRoot, 'scripts', 'check-layers.mjs')
const fixture = mkdtempSync(join(tmpdir(), 'omw-layers-'))

afterAll(() => {
  rmSync(fixture, { recursive: true, force: true })
})

/** Run the checker over one root. */
function check(root: string): { status: number; output: string } {
  const result = spawnSync(process.execPath, [checker, '--root', root], { encoding: 'utf8' })
  return { status: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

describe('lint: layer dependencies', () => {
  it('passes on this repository', () => {
    const result = check(repoRoot)
    expect(result.output).toContain('全部规则通过')
    expect(result.status).toBe(0)
  })

  it('fails on a deliberate core -> seams import', () => {
    mkdirSync(join(fixture, 'src', 'core'), { recursive: true })
    mkdirSync(join(fixture, 'src', 'seams'), { recursive: true })
    writeFileSync(join(fixture, 'src', 'seams', 'dep.ts'), 'export const x = 1\n')
    writeFileSync(
      join(fixture, 'src', 'core', 'violation.ts'),
      "import { x } from '../seams/dep.ts'\nexport const y = x\n",
    )
    const result = check(fixture)
    expect(result.status).toBe(1)
    expect(result.output).toContain('core-no-seams')
    expect(result.output).toContain('violation.ts')
  })

  it('passes again once the violation is removed', () => {
    writeFileSync(join(fixture, 'src', 'core', 'violation.ts'), 'export const y = 1\n')
    const result = check(fixture)
    expect(result.status).toBe(0)
  })

  it('rejects triviumdb outside the store layer', () => {
    writeFileSync(join(fixture, 'src', 'core', 'db.ts'), "import { TriviumDB } from 'triviumdb'\nexport const x = TriviumDB\n")
    const result = check(fixture)
    expect(result.status).toBe(1)
    expect(result.output).toContain('triviumdb-owner')
  })

  it('rejects prompt-seam calls outside the prompt composer', () => {
    const file = join(fixture, 'src', 'seams', 'leak.ts')
    writeFileSync(file, "export function leak(ctx: any) {\n  return ctx.systemPrompt.section({ name: 'x', order: 1, text: 'y' })\n}\n")
    try {
      const result = check(fixture)
      expect(result.status).toBe(1)
      expect(result.output).toContain('prompt-seam-owner')
      expect(result.output).toContain('leak.ts')
    } finally {
      rmSync(file, { force: true })
    }
  })

  it('rejects hard deletes outside the snapshot module', () => {
    const file = join(fixture, 'src', 'ops', 'leak.ts')
    mkdirSync(join(fixture, 'src', 'ops'), { recursive: true })
    writeFileSync(file, 'export function leak(db: any) {\n  return db.delete(1)\n}\n')
    try {
      const result = check(fixture)
      expect(result.status).toBe(1)
      expect(result.output).toContain('hard-delete-owner')
      expect(result.output).toContain('leak.ts')
    } finally {
      rmSync(file, { force: true })
    }
  })

  it('rejects a write method outside the commit engine', () => {
    const file = join(fixture, 'src', 'ops', 'writer.ts')
    writeFileSync(file, 'export function write(db: any) {\n  return db.insert([], {})\n}\n')
    try {
      const result = check(fixture)
      expect(result.status).toBe(1)
      expect(result.output).toContain('write-authority')
      expect(result.output).toContain('writer.ts')
    } finally {
      rmSync(file, { force: true })
    }
  })

  it('rejects every write token it knows, one fixture per token', () => {
    const tokens = [
      'insert',
      'insertWithId',
      'batchInsert',
      'upsertWithId',
      'patchPayload',
      'updatePayload',
      'updateVector',
      'link',
      'upsertEdge',
      'commitTransaction',
      'tqlMut',
    ]
    for (const token of tokens) {
      const file = join(fixture, 'src', 'ops', `writer-${token}.ts`)
      writeFileSync(file, `export function write(db: any) {\n  return db.${token}(1, 2)\n}\n`)
      try {
        const result = check(fixture)
        expect(result.output, `token ${token} was not caught`).toContain('write-authority')
      } finally {
        rmSync(file, { force: true })
      }
    }
  })

  it('does not read unlink( as link(', () => {
    const file = join(fixture, 'src', 'ops', 'unlinker.ts')
    writeFileSync(file, 'export function write(db: any) {\n  return db.unlink(1)\n}\n')
    try {
      const result = check(fixture)
      // unlink( is a hard delete, so the snapshot rule names it, not the write gate.
      expect(result.output).toContain('hard-delete-owner')
      expect(result.output).not.toContain('write-authority')
    } finally {
      rmSync(file, { force: true })
    }
  })

  it('rejects TQL text outside the template directory', () => {
    const file = join(fixture, 'src', 'ops', 'query.ts')
    writeFileSync(file, "export function q(db: any) {\n  return db.prepareTql('FIND *')\n}\n")
    try {
      const result = check(fixture)
      expect(result.status).toBe(1)
      expect(result.output).toContain('tql-owner')
      expect(result.output).toContain('query.ts')
    } finally {
      rmSync(file, { force: true })
    }
  })

  it('rejects an $exists filter outside the live-version shape', () => {
    mkdirSync(join(fixture, 'src', 'store', 'templates'), { recursive: true })
    const file = join(fixture, 'src', 'store', 'templates', 'loose.ts')
    writeFileSync(file, "export const Q = 'FIND {deleted_at: {$exists: false}} RETURN *'\n")
    try {
      const result = check(fixture)
      expect(result.status).toBe(1)
      expect(result.output).toContain('exists-owner')
    } finally {
      rmSync(file, { force: true })
    }
  })

  it('allows the live-version filter in the template directory', () => {
    mkdirSync(join(fixture, 'src', 'store', 'templates'), { recursive: true })
    const file = join(fixture, 'src', 'store', 'templates', 'live.ts')
    writeFileSync(file, "export const Q = 'FIND {superseded_at: {$exists: false}} RETURN *'\n")
    try {
      const result = check(fixture)
      expect(result.output).not.toContain('exists-owner')
    } finally {
      rmSync(file, { force: true })
    }
  })
})
