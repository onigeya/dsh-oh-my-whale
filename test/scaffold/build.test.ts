/**
 * Story 1.1 — the package builds into something importable.
 * @module
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const libIndex = join(repoRoot, 'lib', 'index.js')

describe('scaffold: build output', () => {
  it('emits lib/index.js and no CLI entry', () => {
    expect(existsSync(libIndex), `缺少 ${libIndex}，先跑 pnpm build`).toBe(true)
    expect(existsSync(join(repoRoot, 'lib', 'cli.js'))).toBe(false)
  })

  it('lib/index.js exports apply and inject', async () => {
    const module = await import(pathToFileURL(libIndex).href) as Record<string, unknown>
    expect(typeof module['apply']).toBe('function')
    expect(module['inject']).toEqual(['systemPrompt'])
  })

  it('declares the pinned toolchain from the architecture stack', async () => {
    const manifest = await import('../../package.json', { with: { type: 'json' } }) as { default: Record<string, unknown> }
    const pkg = manifest.default
    expect(pkg['type']).toBe('module')
    expect(pkg['main']).toBe('lib/index.js')
    const dsh = pkg['dsh'] as { manifestVersion?: unknown; bundle?: { patch?: unknown } }
    expect(dsh.manifestVersion).toBe(1)
    expect(dsh.bundle?.patch).toBe('./cordis.patch.yml')
    expect(pkg['dependencies']).toMatchObject({ triviumdb: '0.9.3', zod: '4.6.7' })
    expect(pkg['bin']).toBeUndefined()
    expect(pkg['devDependencies']).toMatchObject({ typescript: '7.0.2', vitest: '5.1.1', eslint: '10.15.0' })
  })
})