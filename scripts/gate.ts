#!/usr/bin/env node
/**
 * Gate evidence runner (G0-5, G0-6).
 *
 * A gate is only worth something if the failure mode is reproducible, so each
 * run records both the passing observation and the deliberate counter-example:
 *
 *   g0-6  the layer checker passes on the tree, fails on a fixture that imports
 *         `core -> seams`, and passes again once that import is removed.
 *   g0-5  a real `dsh` session in a throw-away `DSH_HOME` loads the plugin,
 *         composes the row into `--dump-config`, and prints `[omw] loaded`.
 *
 * Evidence is written to `docs/implementation-artifacts/gates/<gate>.json`.
 *
 * Usage: node scripts/gate.ts --gate g0-6|g0-5|all [--dry-run]
 * Exit: 0 pass, 1 fail.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const evidenceDir = join(repoRoot, 'docs', 'implementation-artifacts', 'gates')
const isWindows = process.platform === 'win32'

/** Result of one child process run. */
interface RunResult {
  readonly ok: boolean
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Run a command and capture its output.
 *
 * `shell` is opt-in and only for shell shims (`pnpm`, `dsh` on Windows): with
 * `shell: true` the arguments are concatenated instead of escaped, which breaks
 * as soon as an executable path contains a space (e.g. `C:\Program Files\nodejs`).
 */
function run(
  command: string,
  args: readonly string[],
  env?: Record<string, string>,
  options: { readonly shell?: boolean } = {},
): RunResult {
  const result = spawnSync(command, [...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    shell: options.shell === true,
    timeout: 300_000,
  })
  return {
    ok: result.status === 0,
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/** One piece of evidence inside a gate record. */
interface GateCheck {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

/** The record written to disk. */
interface GateRecord {
  readonly gate: string
  readonly status: 'pass' | 'fail' | 'skipped'
  readonly timestamp: string
  readonly baselineRevision: string | null
  readonly node: string
  readonly platform: string
  readonly checks: readonly GateCheck[]
  readonly note?: string
}

/** Current git revision, or `null` outside a repository. */
function baselineRevision(): string | null {
  const result = run('git', ['rev-parse', 'HEAD'])
  return result.ok ? result.stdout.trim() : null
}

/**
 * Print the checks and, unless this is a dry run, write the evidence record.
 *
 * `--dry-run` exists so a reviewer can see what a gate would assert without
 * touching the evidence directory or starting a host process.
 */
function record(
  gate: string,
  checks: readonly GateCheck[],
  options: { readonly note?: string; readonly dryRun?: boolean } = {},
): number {
  const failed = checks.filter(check => !check.ok)
  const status: GateRecord['status'] = failed.length === 0 ? 'pass' : 'fail'
  for (const check of checks) {
    process.stdout.write(`${check.ok ? 'ok  ' : 'FAIL'} ${gate} ${check.name}: ${check.detail}\n`)
  }
  if (options.dryRun === true) {
    process.stdout.write(`${gate} dry-run ${status}（未写证据，未启动 dsh）\n`)
    return status === 'pass' ? 0 : 1
  }
  const payload: GateRecord = {
    gate,
    status,
    timestamp: new Date().toISOString(),
    baselineRevision: baselineRevision(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    checks,
    ...(options.note === undefined ? {} : { note: options.note }),
  }
  mkdirSync(evidenceDir, { recursive: true })
  const file = join(evidenceDir, `${gate.toLowerCase()}.json`)
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`)
  process.stdout.write(`${gate} ${status} -> ${file}\n`)
  return status === 'pass' ? 0 : 1
}

/** G0-6: the static layer gate bites on a deliberate cross-layer import. */
function gateG06(dryRun: boolean): number {
  const checker = join(here, 'check-layers.mjs')
  const clean = run(process.execPath, [checker])
  const checks: GateCheck[] = [
    {
      name: 'tree-clean',
      ok: clean.ok,
      detail: clean.ok ? clean.stdout.trim() : clean.stdout.trim() || clean.stderr.trim(),
    },
  ]

  const fixture = mkdtempSync(join(tmpdir(), 'omw-layers-'))
  try {
    mkdirSync(join(fixture, 'src', 'core'), { recursive: true })
    mkdirSync(join(fixture, 'src', 'seams'), { recursive: true })
    writeFileSync(join(fixture, 'src', 'seams', 'dep.ts'), "export const x = 1\n")
    const violationFile = join(fixture, 'src', 'core', 'violation.ts')
    writeFileSync(violationFile, "import { x } from '../seams/dep.ts'\nexport const y = x\n")

    const dirty = run(process.execPath, [checker, '--root', fixture])
    const named = dirty.stdout.includes('core-no-seams') && dirty.stdout.includes('violation.ts')
    checks.push({
      name: 'deliberate-violation-fails',
      ok: !dirty.ok && named,
      detail: dirty.stdout.trim() || dirty.stderr.trim(),
    })

    rmSync(violationFile)
    const removed = run(process.execPath, [checker, '--root', fixture])
    checks.push({
      name: 'removal-restores-pass',
      ok: removed.ok,
      detail: removed.stdout.trim(),
    })
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
  return record('G0-6', checks, { dryRun })
}

/** Whether a `dsh` executable is reachable. */
function dshExecutable(): string | undefined {
  const override = process.env['OMW_DSH_BIN']?.trim()
  if (override !== undefined && override !== '' && existsSync(override)) return override
  const probe = run(isWindows ? 'where' : 'which', ['dsh'], undefined, { shell: isWindows })
  if (!probe.ok) return undefined
  const first = probe.stdout.split(/\r?\n/u).map(line => line.trim()).find(line => line !== '')
  return first
}

/** G0-5: a real session in a throw-away DSH_HOME loads the plugin and injects. */
function gateG05(dryRun: boolean): number {
  const dsh = dshExecutable()
  if (dsh === undefined) {
    return record('G0-5', [{ name: 'dsh-available', ok: false, detail: '未找到 dsh（可用 OMW_DSH_BIN 指定）' }], { dryRun })
  }
  if (dryRun) {
    return record(
      'G0-5',
      [
        { name: 'dsh-available', ok: true, detail: dsh },
        { name: 'e2e-loads-plugin', ok: false, detail: 'dry-run：未启动 dsh，e2e 未执行（不构成通过）' },
      ],
      { dryRun, note: 'dry-run 只做静态检查' },
    )
  }
  const result = run('pnpm', ['exec', 'vitest', 'run', 'test/e2e'], { OMW_E2E: '1', OMW_DSH_BIN: dsh }, { shell: isWindows })
  const output = `${result.stdout}\n${result.stderr}`
  const observed = loadedLine(output)
  const skippedMatch = /(\d+)\s+skipped/u.exec(output)
  const skipped = skippedMatch === null ? 0 : Number(skippedMatch[1])
  const problems = [
    observed === undefined ? '未观察到 [omw] loaded（e2e 未运行或被跳过）' : '',
    skipped > 0 ? `skipped=${skipped}（跳过的用例不算通过）` : '',
    result.ok ? '' : `exit=${result.status} ${lastLine(result.stderr)}`,
  ].filter(part => part !== '')
  const checks: GateCheck[] = [
    { name: 'dsh-available', ok: true, detail: dsh },
    {
      name: 'e2e-loads-plugin',
      // Evidence is the observed line, not the runner's exit code: a skipped run
      // exits 0 and must never be recorded as a pass.
      ok: result.ok && observed !== undefined && skipped === 0,
      detail: problems.length === 0 ? (observed as string) : `${problems.join('；')}；${observed ?? ''}`,
    },
  ]
  return record('G0-5', checks)
}

/** The plugin-load line the host actually printed, if any. */
function loadedLine(text: string): string | undefined {
  return text
    .split(/\r?\n/u)
    .map(line => line.trim())
    .find(line => line.includes('[omw] loaded'))
}

/** Last non-empty line of a captured stream. */
function lastLine(text: string): string {
  const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '')
  return lines.length === 0 ? '' : lines[lines.length - 1] as string
}

/** Entry point. */
function main(argv: readonly string[]): number {
  let gate = 'all'
  let dryRun = false
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--gate') gate = argv[index + 1] ?? gate
    else if (argv[index] === '--dry-run') dryRun = true
  }
  const wanted = gate.toLowerCase()
  if (wanted === 'g0-6') return gateG06(dryRun)
  if (wanted === 'g0-5') return gateG05(dryRun)
  if (wanted === 'all') return Math.max(gateG06(dryRun), gateG05(dryRun))
  process.stderr.write(`gate: 未知闸门 "${gate}"（可用 g0-5 / g0-6 / all）\n`)
  return 2
}

process.exitCode = main(process.argv.slice(2))
