#!/usr/bin/env node
/**
 * `omw` — the command surface (Story 1.2).
 *
 * Exit codes follow the project-wide convention: 0 success, 2 not found, any
 * other non-zero value is an error. Today the only command is `doctor`, and it
 * returns 1 when a check fails.
 * @module
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runDoctor, type DoctorReport } from './cli/doctor.ts'

/** Usage text, printed on a bad invocation and by `omw help`. */
export const USAGE = `omw — 哦鲸鲸记忆插件命令行

用法：
  omw doctor [--home <DSH_HOME>] [--profile <名字>] [--json]
  omw help

doctor 按固定顺序检查五项：库能开、快照校验过、维度匹配、凭据可用、注入段已注册。
退出码：0 全部通过；1 有检查失败；2 未找到 profile。
`

/** Result of one command-line invocation. */
export interface CliResult {
  readonly exitCode: 0 | 1 | 2
  readonly stdout: string
  readonly stderr: string
}

/** Resolve the `$DSH_HOME` root the same way the host does. */
export function resolveHome(env: Record<string, string | undefined> = process.env): string {
  const override = env['DSH_HOME']?.trim()
  return override !== undefined && override !== '' ? override : join(homedir(), '.dsh')
}

/** Parsed arguments of the `doctor` command. */
interface DoctorArgs {
  readonly home: string
  readonly profile: string
  readonly json: boolean
}

/** Parse `doctor`'s arguments. */
function parseDoctorArgs(argv: readonly string[], env: Record<string, string | undefined>): { ok: true; args: DoctorArgs } | { ok: false; error: string } {
  let home = resolveHome(env)
  let profile = 'web'
  let json = false
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--json') {
      json = true
      continue
    }
    if (token === '--home' || token === '--profile') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) return { ok: false, error: `${token} 需要一个取值` }
      if (token === '--home') home = value
      else profile = value
      index += 1
      continue
    }
    return { ok: false, error: `未知参数：${String(token)}` }
  }
  return { ok: true, args: { home, profile, json } }
}

/** Render a report as JSON (stable key order, no secrets). */
export function reportToJson(report: DoctorReport): string {
  return `${JSON.stringify({
    ok: report.ok,
    exitCode: report.exitCode,
    profile: report.profile,
    home: report.home,
    dataDir: report.dataDir,
    structural: report.structural,
    checks: report.checks,
    summary: report.summary,
  }, null, 2)}\n`
}

/**
 * Run one invocation.
 * @param argv - arguments after the executable name.
 * @param env - environment for home resolution.
 * @returns exit code and the text to print on each stream.
 */
export async function main(argv: readonly string[], env: Record<string, string | undefined> = process.env): Promise<CliResult> {
  const command = argv[0]
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    return { exitCode: command === undefined ? 2 : 0, stdout: USAGE, stderr: '' }
  }
  if (command !== 'doctor') {
    return { exitCode: 2, stdout: '', stderr: `omw: 未知命令 "${command}"\n\n${USAGE}` }
  }
  const parsed = parseDoctorArgs(argv.slice(1), env)
  if (!parsed.ok) {
    return { exitCode: 2, stdout: '', stderr: `omw: ${parsed.error}\n\n${USAGE}` }
  }
  const report = await runDoctor({ home: parsed.args.home, profile: parsed.args.profile, env })
  const body = parsed.args.json ? reportToJson(report) : `${report.lines.join('\n')}\n`
  return { exitCode: report.exitCode, stdout: body, stderr: '' }
}

/** Whether this module is the process entry point. */
function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return pathToFileURL(entry).href === import.meta.url
  } catch {
    return fileURLToPath(import.meta.url) === entry
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2))
    .then((result) => {
      if (result.stdout !== '') process.stdout.write(result.stdout)
      if (result.stderr !== '') process.stderr.write(result.stderr)
      process.exitCode = result.exitCode
    })
    .catch((error: unknown) => {
      process.stderr.write(`omw: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
