/**
 * `omw doctor` — five ordered checks and a structural precheck (FR-17, Story 1.2).
 *
 * The five checks answer "is it working?":
 *
 *   1. db          the database opens
 *   2. snapshot    today's snapshot exists and verifies
 *   3. dim         `db.dim` matches the database
 *   4. credential  the embedding key's environment variable is set
 *   5. section     the built artifact registers `omw:persona`
 *
 * The precheck answers "is it declared?" and produces the doctor-only codes
 * (`OMW_CONFIG_*`) plus `OMW_SECTION_NOT_REGISTERED`. Those are deliberately
 * separate from the eight runtime degradation codes: a structural mistake is not
 * a degradation state.
 *
 * A run makes zero network requests, writes zero business nodes, and appends
 * exactly one line to `omw.log`.
 * @module
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { calendarDay, ensureDailySnapshot, listSnapshots, verifySnapshotAt } from '../ops/snapshots.ts'
import { PERSONA_SECTION_NAME } from '../seams/prompt-composer.ts'
import { closeDatabase, databaseDim, nodeCount, openDatabase, type Database } from '../store/db.ts'
import { createAppendFileSink, createLogger, createMemorySink, type Logger } from '../seams/logger.ts'
import { parseConfig, resolvePaths, type Config, type Paths } from '../seams/config.ts'
import {
  declaresBundle,
  findPluginRow,
  loadProfile,
  type PatchRow,
  type Profile,
} from './profile.ts'
import { createRecordingContext } from './recording-ctx.ts'

/** The package name users add to their profile. */
export const PACKAGE_NAME = 'dsh-oh-my-whale'

/** The entry id users put in their patch row. */
export const ENTRY_ID = 'oh-my-whale'

/** Log code of the single line each doctor run appends. */
export const DOCTOR_LOG_CODE = 'OMW_DOCTOR'

/** Doctor-only diagnostic codes. Never used as a degradation state. */
export const DOCTOR_CODES = {
  depNotDeclared: 'OMW_CONFIG_DEP_NOT_DECLARED',
  wrongPatchFile: 'OMW_CONFIG_WRONG_PATCH_FILE',
  patchEntryMissing: 'OMW_CONFIG_PATCH_ENTRY_MISSING',
  schema: 'OMW_CONFIG_SCHEMA',
  sectionNotRegistered: 'OMW_SECTION_NOT_REGISTERED',
} as const

/** The five checks, in their fixed order. */
export const DOCTOR_CHECKS = [
  { id: 'db', label: '库能开' },
  { id: 'snapshot', label: '快照校验过' },
  { id: 'dim', label: '维度匹配' },
  { id: 'credential', label: '凭据可用' },
  { id: 'section', label: '注入段已注册' },
] as const

/** Identifier of one of the five checks. */
export type DoctorCheckId = (typeof DOCTOR_CHECKS)[number]['id']

/** Outcome of one check. */
export type CheckStatus = 'pass' | 'fail' | 'skip'

/** One reported check. */
export interface DoctorCheck {
  readonly id: DoctorCheckId | 'config'
  readonly label: string
  readonly status: CheckStatus
  /** Diagnostic code; present for every failure. */
  readonly code?: string
  /** One-line explanation, never containing a secret value. */
  readonly detail: string
}

/** The complete verdict of one run. */
export interface DoctorReport {
  readonly ok: boolean
  /** 0 all passed, 1 something failed, 2 profile not found. */
  readonly exitCode: 0 | 1 | 2
  readonly profile: string
  readonly home: string
  readonly dataDir: string
  readonly checks: readonly DoctorCheck[]
  /** Present when the declaration precheck failed; the five checks then do not run. */
  readonly structural?: DoctorCheck
  readonly summary: string
  /** Ready-to-print lines, in the order the fixed output requires. */
  readonly lines: readonly string[]
}

/** Inputs of {@link runDoctor}. */
export interface DoctorOptions {
  /** `$DSH_HOME` root (already resolved by the caller). */
  readonly home: string
  /** Profile name under `<home>/profiles`. */
  readonly profile: string
  readonly env?: Record<string, string | undefined>
  readonly now?: () => Date
  /** Built entry to exercise; defaults to `lib/index.js` beside this file. */
  readonly entryPath?: string
  /**
   * Network implementation, injectable for one reason only: a test asserts it is
   * never called. The doctor never performs an embedding request.
   */
  readonly fetchImpl?: typeof fetch
}

/** Default built entry: `lib/index.js` two levels above `lib/cli/` or `src/cli/`. */
export function defaultEntryPath(): string {
  return fileURLToPath(new URL('../../lib/index.js', import.meta.url))
}

/**
 * Is this open failure the engine's access lease — another process holding the file?
 *
 * A running DSH is the normal case, not a defect: the single-file engine grants one
 * lease at a time, so the doctor cannot open the same file while the host has it.
 * Everything else that fails to open (a corrupt file, an unreadable one) stays a
 * failure; only the lease is downgraded to a skip.
 * @param opened - the failed open attempt.
 * @returns true when the file is held by a live lease.
 */
function isAccessLeaseLock(opened: { readonly errorCode?: string; readonly reason: string }): boolean {
  if (opened.errorCode === 'TDB_DATABASE_LOCKED') return true
  const text = opened.reason.toLowerCase()
  return text.includes('database locked') || text.includes('incompatible access lease')
}

/** Pad a check id to a stable column width. */
function padId(id: string): string {
  return id.padEnd(10, ' ')
}

/** Render one check as a single line. */
function renderCheck(check: DoctorCheck, index: number): string {
  const head = `${index}/5 ${padId(check.id)} ${check.status === 'pass' ? 'pass' : check.status === 'fail' ? 'FAIL' : 'skip'}`
  const code = check.code === undefined ? '' : ` [${check.code}]`
  return `${head} ${check.detail}${code}`
}

/**
 * Inspect the declaration chain: bundle list, patch file, patch row, config.
 * @param profile - the loaded profile.
 * @returns either the config to use, or the single structural failure.
 */
function precheck(profile: Profile): { config: Config } | { failure: DoctorCheck } {
  const fail = (code: string, detail: string): { failure: DoctorCheck } => ({
    failure: { id: 'config', label: '声明', status: 'fail', code, detail },
  })
  // A file that cannot be parsed must be reported as such: "no entry found" would
  // send the user to add a row that may already be there, just malformed.
  if (profile.problems.length > 0) {
    return fail(DOCTOR_CODES.schema, `profile 文件无法解析：${profile.problems.join('；')}`)
  }
  if (!declaresBundle(profile.bundles, PACKAGE_NAME)) {
    return fail(
      DOCTOR_CODES.depNotDeclared,
      `profile 的 package.json 未在 dsh.profile.bundles 中声明 "${PACKAGE_NAME}"（当前：${profile.bundles.length === 0 ? '空' : profile.bundles.join(', ')}）`,
    )
  }
  const row: PatchRow | undefined = findPluginRow(profile.patchEntries, PACKAGE_NAME, ENTRY_ID)
  if (row === undefined) {
    const misplaced = findPluginRow(profile.rootEntries, PACKAGE_NAME, ENTRY_ID)
    if (misplaced !== undefined) {
      return fail(
        DOCTOR_CODES.wrongPatchFile,
        `条目写在了生成物 cordis.yml 里，请改 ${profile.files.patchPath}（cordis.yml 每次启动都会被重写）`,
      )
    }
    return fail(
      DOCTOR_CODES.patchEntryMissing,
      `${profile.files.patchPath} 中没有 "${PACKAGE_NAME}" 的 insert 条目；应写 - insert: [{id: ${ENTRY_ID}, name: ${PACKAGE_NAME}, config: {}}]`,
    )
  }
  const parsed = parseConfig(row.config ?? {})
  if (!parsed.ok) {
    const first = parsed.issues[0]
    const all = parsed.issues.map(issue => `${issue.key}（收到 ${issue.received}）`).join('；')
    return fail(
      DOCTOR_CODES.schema,
      first === undefined
        ? `配置不合法：${all}`
        : `配置不合法：${first.key} 收到 ${first.received}，${first.message}${parsed.issues.length > 1 ? `；另有 ${parsed.issues.length - 1} 处` : ''}`,
    )
  }
  return { config: parsed.config }
}

/**
 * Run the doctor.
 * @param options - home, profile name, and test seams.
 * @returns the report; the caller decides how to print and which exit code to use.
 */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const home = options.home
  const env = options.env ?? process.env
  const now = options.now ?? (() => new Date())
  const loaded = loadProfile({ home, name: options.profile })

  if (!loaded.ok) {
    const structural: DoctorCheck = {
      id: 'config',
      label: '声明',
      status: 'fail',
      code: loaded.code,
      detail: loaded.reason,
    }
    return buildReport({
      // Only "no such profile" is a usage error (2). A profile that exists but
      // cannot be read is a failure of the thing being diagnosed (1).
      exitCode: loaded.code === 'PROFILE_NOT_FOUND' ? 2 : 1,
      profile: options.profile,
      home,
      dataDir: join(home, ENTRY_ID),
      checks: [],
      structural,
    })
  }

  const profile = loaded.profile
  const prechecked = precheck(profile)
  if ('failure' in prechecked) {
    const dataDir = join(home, ENTRY_ID)
    appendDoctorLog(dataDir, now, { ok: false, passed: 0, failed: 0, skipped: 5, code: prechecked.failure.code })
    return buildReport({
      exitCode: 1,
      profile: options.profile,
      home,
      dataDir,
      checks: [],
      structural: prechecked.failure,
    })
  }

  const config = prechecked.config
  const paths: Paths = resolvePaths(config, (...segments: string[]) => join(home, ...segments))
  const checks: DoctorCheck[] = []
  let db: Database | undefined
  /** A dimension mismatch surfaces as an open failure, before any handle exists. */
  let dimFromOpenError: { fileDim: number | null; requestedDim: number } | undefined
  /** True when the open failed on the engine's access lease, i.e. a host is running. */
  let leaseLock = false

  // 1/5 — the database opens.
  //
  // The handle must be writable exactly when this run may have to create today's
  // snapshot: a read-only handle answers `create_snapshot` with
  // "Read-only database operation denied", which would report a missing snapshot
  // as an unverifiable one. When today's snapshot is already on disk and verifies,
  // the read-only handle is both sufficient and the stronger promise.
  const fileExists = existsSync(paths.dbFile)
  const todayReady = (() => {
    const day = calendarDay(now())
    const newest = listSnapshots(paths.snapshotsDir)
      .filter(entry => !entry.preMigration && entry.date === day)
      .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]
    return newest !== undefined && verifySnapshotAt(newest.path).ok
  })()
  const opened = openDatabase({
    file: paths.dbFile,
    dim: config.db.dim,
    memoryLimitMb: config.db.memoryLimitMb,
    readOnly: fileExists && todayReady,
  })
  if (opened.ok) {
    db = opened.db
    checks.push({
      id: 'db',
      label: '库能开',
      status: 'pass',
      detail: `${paths.dbFile}（${fileExists ? '只读打开' : '已创建'}，dim=${databaseDim(db)}，节点 ${nodeCount(db)}）`,
    })
  } else if (opened.errorCode === 'TDB_DIMENSION_MISMATCH') {
    // The database opens fine at its own width; only `db.dim` disagrees. Reporting
    // that as "库打不开" would send the user after the wrong file, so this belongs
    // to check 3 and the matrix's DIM_MISMATCH row.
    dimFromOpenError = { fileDim: opened.fileDim ?? null, requestedDim: opened.requestedDim ?? config.db.dim }
    checks.push({
      id: 'db',
      label: '库能开',
      status: 'pass',
      detail: `${paths.dbFile}（可打开；维度与 db.dim 不符，见第 3 项）`,
    })
  } else if (isAccessLeaseLock(opened)) {
    // A live host holds the one lease the engine grants. That is the normal state of
    // an installed and running plugin, not a broken database — so the deep checks are
    // skipped instead of reporting the occupancy as a failure.
    leaseLock = true
    checks.push({
      id: 'db',
      label: '库能开',
      status: 'skip',
      detail: `${paths.dbFile} 正被运行中的 DSH 占用，本项跳过深度校验（真正损坏或无法打开的库仍为 FAIL）`,
    })
  } else {
    checks.push({ id: 'db', label: '库能开', status: 'fail', code: 'OMW_DB_OPEN', detail: `库打不开：${opened.reason}` })
  }

  // 2/5 — today's snapshot exists and verifies.
  if (db === undefined) {
    checks.push({
      id: 'snapshot',
      label: '快照校验过',
      status: 'skip',
      detail: leaseLock
        ? '库正被运行中的 DSH 占用（依赖第 1 项），未执行'
        : dimFromOpenError === undefined ? '依赖第 1 项，未执行' : '库句柄不可用（维度不符），未执行',
    })
  } else {
    try {
      const ensured = ensureDailySnapshot({
        db,
        snapshotsDir: paths.snapshotsDir,
        // A diagnosis must not rotate history: with `snapshot.keep` (7 by default)
        // a single doctor run could delete generations the user still needs.
        keep: Number.MAX_SAFE_INTEGER,
        now,
      })
      checks.push(
        ensured.ok
          ? {
            id: 'snapshot',
            label: '快照校验过',
            status: 'pass',
            detail: ensured.created ? `已补做并校验：${ensured.path}` : `今日快照已校验：${ensured.path}`,
          }
          : {
            id: 'snapshot',
            label: '快照校验过',
            status: 'fail',
            code: 'OMW_SNAPSHOT_VERIFY',
            detail: `校验失败：${ensured.reason}`,
          },
      )
    } catch (error) {
      checks.push({
        id: 'snapshot',
        label: '快照校验过',
        status: 'fail',
        code: 'OMW_SNAPSHOT_VERIFY',
        detail: `校验失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  // 3/5 — configured dimension matches the database.
  if (db === undefined && dimFromOpenError !== undefined) {
    checks.push({
      id: 'dim',
      label: '维度匹配',
      status: 'fail',
      code: 'OMW_DIM_MISMATCH',
      detail: `db.dim=${config.db.dim}，库=${dimFromOpenError.fileDim === null ? '未知' : dimFromOpenError.fileDim}`,
    })
  } else if (db === undefined) {
    checks.push({
      id: 'dim',
      label: '维度匹配',
      status: 'skip',
      detail: leaseLock ? '库正被运行中的 DSH 占用（依赖第 1 项），未执行' : '依赖第 1 项，未执行',
    })
  } else {
    let actual: number | null = null
    try {
      actual = databaseDim(db)
    } catch {
      actual = null
    }
    checks.push(
      actual === config.db.dim
        ? { id: 'dim', label: '维度匹配', status: 'pass', detail: `db.dim=${config.db.dim} 与库一致` }
        : {
          id: 'dim',
          label: '维度匹配',
          status: 'fail',
          code: 'OMW_DIM_MISMATCH',
          detail: `db.dim=${config.db.dim}，库=${actual === null ? '未知' : actual}`,
        },
    )
  }

  // 4/5 — the credential's environment variable is present. No network, ever.
  const envName = config.embedding.apiKeyEnv
  const credential = env[envName]
  checks.push(
    typeof credential === 'string' && credential.trim() !== ''
      ? { id: 'credential', label: '凭据可用', status: 'pass', detail: `环境变量 ${envName} 已设置` }
      : {
        id: 'credential',
        label: '凭据可用',
        status: 'fail',
        code: 'OMW_EMBED_AUTH',
        detail: `环境变量 ${envName} 未设置（向量路径将关闭；值不会出现在任何输出中）`,
      },
  )

  // Release the handle before exercising `apply`: the single-file database takes an
  // exclusive access lease, so a second open in the same process fails and the section
  // check would report a lock instead of the registration it is meant to observe.
  if (db !== undefined) {
    closeDatabase(db)
    db = undefined
  }

  // 5/5 — the built artifact registers the identity section.
  //
  // This must work while a host is running and holds the database lease, so the
  // check mounts the plugin against a scratch data directory of its own (see
  // {@link checkSection}). The live database and snapshot tree stay untouched.
  checks.push(await checkSection({
    home,
    ...(options.entryPath === undefined ? {} : { entryPath: options.entryPath }),
    config,
    logger: createLogger(createMemorySink(), { now, keepEvents: false }),
  }))

  const passed = checks.filter(check => check.status === 'pass').length
  const failed = checks.filter(check => check.status === 'fail').length
  const skipped = checks.filter(check => check.status === 'skip').length
  const firstFailure = checks.find(check => check.status === 'fail')
  appendDoctorLog(paths.dataDir, now, {
    ok: failed === 0,
    passed,
    failed,
    skipped,
    ...(firstFailure?.code === undefined ? {} : { code: firstFailure.code }),
  })
  return buildReport({
    // Skips are not failures: a host that is running is exactly when the lease is
    // taken, and the doctor must still answer the question it can answer.
    exitCode: failed === 0 ? 0 : 1,
    profile: options.profile,
    home,
    dataDir: paths.dataDir,
    checks,
    ...(leaseLock ? { skipNote: '库被占用' } : {}),
  })
}

/**
 * Exercise the built entry against a recording context.
 *
 * The profile's own config is passed through, with one substitution: the database
 * path points into a throwaway directory. Mounting the plugin opens the database and
 * may create today's snapshot, so touching the live data root would fail whenever a
 * host holds the lease — precisely the situation this check has to survive. The
 * scratch directory is removed before returning, and logging goes to memory so this
 * run still appends exactly one `omw.log` line.
 */
async function checkSection(options: {
  home: string
  entryPath?: string
  config: Config
  logger: Logger
}): Promise<DoctorCheck> {
  const entry = options.entryPath ?? defaultEntryPath()
  if (!existsSync(entry)) {
    return {
      id: 'section',
      label: '注入段已注册',
      status: 'fail',
      code: DOCTOR_CODES.sectionNotRegistered,
      detail: `未找到构建产物 ${entry}，先跑 pnpm build`,
    }
  }
  const scratch = mkdtempSync(join(tmpdir(), 'omw-doctor-section-'))
  const isolated: Config = {
    ...options.config,
    db: { ...options.config.db, path: join(scratch, 'oh-my-whale.tdb') },
    // Unlimited retention is moot in a scratch directory, but keeps the mount from
    // spending time on rotation if the implementation ever changes.
    snapshot: { ...options.config.snapshot, keep: Number.MAX_SAFE_INTEGER },
  }
  const recorder = createRecordingContext({ home: options.home })
  try {
    const module = await import(pathToFileURL(entry).href) as { apply?: unknown }
    if (typeof module.apply !== 'function') {
      return {
        id: 'section',
        label: '注入段已注册',
        status: 'fail',
        code: DOCTOR_CODES.sectionNotRegistered,
        detail: `构建产物未导出 apply：${entry}`,
      }
    }
    ;(module.apply as (ctx: unknown, config: unknown, seams?: unknown) => void)(
      recorder.ctx,
      isolated,
      { logger: options.logger },
    )
    const section = recorder.sections.find(entrySection => entrySection.name === PERSONA_SECTION_NAME)
    if (section === undefined) {
      return {
        id: 'section',
        label: '注入段已注册',
        status: 'fail',
        code: DOCTOR_CODES.sectionNotRegistered,
        detail: `apply 未注册 ${PERSONA_SECTION_NAME}`,
      }
    }
    if (section.text.trim() === '') {
      return {
        id: 'section',
        label: '注入段已注册',
        status: 'fail',
        code: DOCTOR_CODES.sectionNotRegistered,
        detail: `${PERSONA_SECTION_NAME} 注册了空文本`,
      }
    }
    return {
      id: 'section',
      label: '注入段已注册',
      status: 'pass',
      detail: `已注册 ${PERSONA_SECTION_NAME}（${[...section.text].length} 字符，${recorder.tools.length} 个工具）`,
    }
  } catch (error) {
    return {
      id: 'section',
      label: '注入段已注册',
      status: 'fail',
      code: DOCTOR_CODES.sectionNotRegistered,
      detail: `调用 apply 失败：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    recorder.dispose()
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Append the single `omw.log` line this run is allowed. */
function appendDoctorLog(
  dataDir: string,
  now: () => Date,
  detail: Record<string, unknown>,
): void {
  try {
    createLogger(createAppendFileSink(join(dataDir, 'omw.log')), { now, keepEvents: false })
      .info(DOCTOR_LOG_CODE, detail)
  } catch {
    // A read-only data directory must not turn a diagnosis into a crash.
  }
}

/** Assemble the report, including the fixed-order rendered lines. */
function buildReport(input: {
  exitCode: 0 | 1 | 2
  profile: string
  home: string
  dataDir: string
  checks: readonly DoctorCheck[]
  structural?: DoctorCheck
  /** Short reason appended to the skip count, e.g. `库被占用`. */
  skipNote?: string
}): DoctorReport {
  const lines: string[] = []
  if (input.structural !== undefined) {
    lines.push(`0/5 ${padId('config')} FAIL ${input.structural.detail}${input.structural.code === undefined ? '' : ` [${input.structural.code}]`}`)
  }
  input.checks.forEach((check, index) => {
    lines.push(renderCheck(check, index + 1))
  })
  const passed = input.checks.filter(check => check.status === 'pass').length
  const failed = input.checks.filter(check => check.status === 'fail').length
  const skipped = input.checks.filter(check => check.status === 'skip').length
  const firstFailure = input.structural ?? input.checks.find(check => check.status === 'fail')
  const skipSuffix = skipped === 0
    ? ''
    : `、${skipped} 跳过${input.skipNote === undefined ? '' : `（${input.skipNote}）`}`
  const summary = input.exitCode === 2
    ? `omw doctor: 未找到 profile "${input.profile}"`
    : firstFailure === undefined
      ? `omw doctor: ${passed}/${input.checks.length} 通过${skipSuffix}`
      : `omw doctor: ${passed}/${input.checks.length} 通过、${failed} 失败${skipSuffix}；首个失败 ${firstFailure.code ?? firstFailure.id}`
  lines.push(summary)
  lines.push(`数据目录：${input.dataDir}`)
  return {
    ok: input.exitCode === 0,
    exitCode: input.exitCode,
    profile: input.profile,
    home: input.home,
    dataDir: input.dataDir,
    checks: input.checks,
    ...(input.structural === undefined ? {} : { structural: input.structural }),
    summary,
    lines,
  }
}
