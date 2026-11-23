/**
 * G0-5 — a real `dsh` session in a throw-away `DSH_HOME`.
 *
 * Opt-in: runs only with `OMW_E2E=1`, because it installs the package into a
 * temporary profile and boots the host. The user's real `~/.dsh` is never
 * touched: `DSH_HOME` is set explicitly for every child process.
 *
 * The profile is created from the shipped `headless` template — the one surface
 * that answers one task and exits — and only afterwards patched to declare and
 * mount this plugin. Creating it first matters: `--from-default-profile`
 * replaces the directory, so a patch written before that would be thrown away.
 *
 * The judgement depends on three observations only — the composed config tree,
 * the `[omw] loaded` line, and the section marker — so a missing model credential
 * cannot turn a successful load into a failure.
 * @module
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { tempHome, type TempHome } from '../support/fake-ctx.ts'

const enabled = process.env['OMW_E2E'] === '1'
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const isWindows = process.platform === 'win32'
const dshBin = process.env['OMW_DSH_BIN'] ?? 'dsh'
const PROFILE = 'omwtest'

const homes: TempHome[] = []
afterAll(() => {
  while (homes.length > 0) homes.pop()?.remove()
})

/** Run a command with `DSH_HOME` pinned to the temp home. */
function run(command: string, args: readonly string[], options: { cwd: string; home: string; timeout?: number }) {
  return spawnSync(command, [...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    shell: isWindows,
    timeout: options.timeout ?? 180_000,
    env: { ...process.env, DSH_HOME: options.home },
  })
}

/** Declare the plugin in an existing profile and mount it through the patch layer. */
function declarePlugin(profileDir: string): void {
  const manifestPath = join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  manifest.dependencies = { ...manifest.dependencies, 'dsh-oh-my-whale': `file:${repoRoot.replace(/\\/gu, '/')}` }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  manifest.dsh = { profile: { bundles: [...bundles, 'dsh-oh-my-whale'] } }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  const patchPath = join(profileDir, 'cordis.patch.yml')
  const existing = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const body = existing
    .replace(/^\s*\[\]\s*$/mu, '')
    .replace(/\s+$/u, '')
  const row = [
    '- insert:',
    '    - id: oh-my-whale',
    '      name: dsh-oh-my-whale',
    '      config: {}',
  ].join('\n')
  writeFileSync(patchPath, `${body === '' ? '' : `${body}\n`}${row}\n`)
}

describe.skipIf(!enabled)('e2e: real dsh session', () => {
  it('composes the plugin row and prints the load line', (ctx) => {
    if (/\s/u.test(repoRoot) || /\s/u.test(process.env['TEMP'] ?? '')) {
      // pnpm's Windows shim cannot survive spaces in a `shell: true` argument list.
      // Report a skip, never a pass: the gate reads a zero skip count as proof that
      // the session really ran.
      ctx.skip('路径含空格：pnpm 的 Windows shim 无法传递参数')
      return
    }
    const home = tempHome('omw-e2e-')
    homes.push(home)

    const created = run(dshBin, ['--profile', PROFILE, '--from-default-profile', 'headless', '--dump-config'], {
      cwd: home.dir,
      home: home.dir,
    })
    expect(created.status, `创建 headless profile 失败：\n${created.stderr ?? ''}`).toBe(0)
    const profileDir = join(home.dir, 'profiles', PROFILE)
    expect(existsSync(join(profileDir, 'package.json'))).toBe(true)

    declarePlugin(profileDir)

    const installed = run('pnpm', ['install', '--reporter=append-only'], { cwd: profileDir, home: home.dir, timeout: 300_000 })
    expect(installed.status, `pnpm install 失败：\n${installed.stderr ?? ''}`).toBe(0)
    expect(existsSync(join(profileDir, 'node_modules', 'dsh-oh-my-whale'))).toBe(true)

    const dumped = run(dshBin, ['--profile', PROFILE, '--dump-config'], { cwd: profileDir, home: home.dir })
    const dumpedText = `${dumped.stdout ?? ''}\n${dumped.stderr ?? ''}`
    expect(dumpedText).toContain('dsh-oh-my-whale')
    expect(dumpedText).toContain('oh-my-whale')

    // One task, then exit. A model turn may fail without credentials; the load
    // line is the observation, so the exit status is deliberately not asserted.
    const session = run(dshBin, ['--profile', PROFILE, 'hi'], { cwd: profileDir, home: home.dir, timeout: 180_000 })
    const stderr = `${session.stdout ?? ''}\n${session.stderr ?? ''}`
    const loadLines = stderr.split(/\r?\n/u).filter(line => line.includes('[omw] loaded'))
    expect(loadLines, `未观察到加载行。输出：\n${stderr.slice(-2000)}`).toHaveLength(1)
    expect(loadLines[0]).toContain('section=harness:identity')
    // Publish the observation: the gate quotes this line as its evidence, and only
    // this test saw it in the session's stderr.
    process.stdout.write(`${loadLines[0]}\n`)

    // The append sink creates the file on its first entry. A clean `ok` load
    // writes none, so an absent log is the expected shape here; the assertion is
    // about content, never about existence.
    const logPath = join(home.dir, 'oh-my-whale', 'omw.log')
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    expect(log).not.toContain('[omw] loaded')
  }, 600_000)
})
