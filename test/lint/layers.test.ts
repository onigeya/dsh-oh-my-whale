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
    const file = join(fixture, 'src', 'core', 'db.ts')
    writeFileSync(file, "import { TriviumDB } from 'triviumdb'\nexport const x = TriviumDB\n")
    try {
      const result = check(fixture)
      expect(result.status).toBe(1)
      expect(result.output).toContain('triviumdb-owner')
    } finally {
      // Left in place it would fail every later case that expects a clean run.
      rmSync(file, { force: true })
    }
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

  it('rejects a transaction op literal naming a hard delete, in every spelling', () => {
    mkdirSync(join(fixture, 'src', 'core'), { recursive: true })
    const spellings = [
      ["bare", "export const a = { type: 'delete', id: 1 }"],
      ['as const', "export const b = { type: ('unlink' as const), id: 1 }"],
      ['concatenated', "export const c = { type: 'del' + 'ete', id: 1 }"],
      ['template', 'export const d = { type: `unlinkLabel`, id: 1 }'],
    ] as const
    for (const [name, body] of spellings) {
      const file = join(fixture, 'src', 'core', 'op.ts')
      writeFileSync(file, `${body}\n`)
      try {
        const result = check(fixture)
        expect(result.status, `${name} was not caught`).toBe(1)
        expect(result.output, `${name} was not caught`).toContain('hard-delete-literal')
        expect(result.output).toContain('op.ts:1')
      } finally {
        rmSync(file, { force: true })
      }
    }
  })

  it('leaves shapes that do not delete alone', () => {
    mkdirSync(join(fixture, 'src', 'core'), { recursive: true })
    const harmless = [
      "export const a = { type: 'link', from: 1, to: 2 }",
      "export const b = { mode: 'delete', id: 1 }",
      "// { type: 'delete' }\nexport const c = 1",
      'export const d = { type: `${name}`, id: 1 }',
    ]
    for (const body of harmless) {
      const file = join(fixture, 'src', 'core', 'op.ts')
      writeFileSync(file, `${body}\n`)
      try {
        const result = check(fixture)
        expect(result.output, body).not.toContain('hard-delete-literal')
      } finally {
        rmSync(file, { force: true })
      }
    }
  })

  it('still reads unlink( as a hard delete and not as link(', () => {
    mkdirSync(join(fixture, 'src', 'core'), { recursive: true })
    const file = join(fixture, 'src', 'core', 'op.ts')
    writeFileSync(file, 'export function x(db: any) {\n  return db.unlink(1)\n}\n')
    try {
      const result = check(fixture)
      expect(result.output).toContain('hard-delete-owner')
      expect(result.output).not.toContain('write-authority')
    } finally {
      rmSync(file, { force: true })
    }
  })

  it('requires the AD-15 header on an exempt module', () => {
    // A root of its own, so the three states can be compared on the whole exit
    // code and not just on the presence of one rule in the output.
    const root = mkdtempSync(join(tmpdir(), 'omw-exempt-'))
    mkdirSync(join(root, 'src', 'ops'), { recursive: true })
    const file = join(root, 'src', 'ops', 'retention.ts')
    try {
      writeFileSync(file, 'export const kept = 1\n')
      const missing = check(root)
      expect(missing.status).toBe(1)
      expect(missing.output).toContain('ad15-exempt-header')

      writeFileSync(file, '\n// AD-15 豁免：\nexport const kept = 1\n')
      expect(check(root).output).toContain('ad15-exempt-header')

      writeFileSync(file, '// AD-15 豁免：保留策略\nexport const kept = 1\n')
      expect(check(root).output).not.toContain('ad15-exempt-header')
      expect(check(root).status).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not complain about an exempt module that does not exist', () => {
    const result = check(fixture)
    expect(result.output).not.toContain('ad15-exempt-header')
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
