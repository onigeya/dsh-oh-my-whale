/**
 * Structural view of one DSH profile (FR-17).
 *
 * A profile is three files: `package.json` (which bundles are declared),
 * `cordis.patch.yml` (the layer the user edits) and `cordis.yml` (a generated
 * root entry list that is rewritten on every boot). `omw doctor` reads all three
 * so it can tell "you edited the generated file" apart from "you forgot the
 * entry" — the two mistakes look identical from the outside.
 * @module
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/** The profile layer the user is expected to edit. */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** The generated root config; boot rewrites it, so edits here are lost. */
export const PROFILE_ROOT_FILENAME = 'cordis.yml'

/** Directory under `$DSH_HOME` that holds profiles. */
export const PROFILES_DIR = 'profiles'

/** One row of an `insert` list (or a bare id-targeted patch row). */
export interface PatchRow {
  readonly id?: string
  readonly name?: string
  readonly config?: unknown
  /** The row as parsed, for diagnostics. */
  readonly raw: unknown
}

/** One top-level patch entry. */
export type PatchEntry =
  | { readonly kind: 'insert'; readonly rows: readonly PatchRow[]; readonly raw: unknown }
  | { readonly kind: 'row'; readonly row: PatchRow; readonly raw: unknown }

/** Absolute paths of the three profile files. */
export interface ProfileFiles {
  readonly dir: string
  readonly manifestPath: string
  readonly patchPath: string
  readonly rootPath: string
}

/** A successfully loaded profile. */
export interface Profile {
  readonly files: ProfileFiles
  /** `dsh.profile.bundles` as declared; empty when absent. */
  readonly bundles: readonly string[]
  readonly patchEntries: readonly PatchEntry[]
  readonly rootEntries: readonly PatchEntry[]
  readonly patchExists: boolean
  readonly rootExists: boolean
  /** Non-fatal parse problems, kept so the doctor can explain a malformed layer. */
  readonly problems: readonly string[]
}

/** Result of loading a profile. */
export type ProfileLoadResult =
  | { readonly ok: true; readonly profile: Profile }
  | { readonly ok: false; readonly code: 'PROFILE_NOT_FOUND' | 'PROFILE_UNREADABLE'; readonly reason: string }

/** The profile's absolute directory. */
export function resolveProfileDir(name: string, home: string): string {
  return join(home, PROFILES_DIR, name)
}

/** Read and parse one JSON file, returning a problem instead of throwing. */
function readJson(file: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Read and parse one YAML file into a patch entry list. */
function readPatchEntries(
  file: string,
  problems: string[],
): { exists: boolean; entries: PatchEntry[] } {
  if (!existsSync(file)) return { exists: false, entries: [] }
  let parsed: unknown
  try {
    parsed = parseYaml(readFileSync(file, 'utf8'))
  } catch (error) {
    problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
    return { exists: true, entries: [] }
  }
  if (parsed === null || parsed === undefined) return { exists: true, entries: [] }
  if (!Array.isArray(parsed)) {
    problems.push(`${file}: 顶层必须是一个 YAML 数组`)
    return { exists: true, entries: [] }
  }
  const entries: PatchEntry[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      problems.push(`${file}: 条目必须是对象`)
      continue
    }
    const record = item as Record<string, unknown>
    if (Array.isArray(record['insert'])) {
      const rows: PatchRow[] = []
      for (const row of record['insert']) {
        if (typeof row !== 'object' || row === null) continue
        rows.push(patchRow(row))
      }
      entries.push({ kind: 'insert', rows, raw: item })
      continue
    }
    entries.push({ kind: 'row', row: patchRow(record), raw: item })
  }
  return { exists: true, entries }
}

/** Project one raw row onto {@link PatchRow}. */
function patchRow(value: object): PatchRow {
  const record = value as Record<string, unknown>
  const id = record['id']
  const name = record['name']
  return {
    ...(typeof id === 'string' ? { id } : {}),
    ...(typeof name === 'string' ? { name } : {}),
    ...(record['config'] === undefined ? {} : { config: record['config'] }),
    raw: value,
  }
}

/**
 * Load a profile from disk.
 * @param options - home root and profile name.
 * @returns the profile, or a reason it cannot be inspected.
 */
export function loadProfile(options: { readonly home: string; readonly name: string }): ProfileLoadResult {
  const dir = resolveProfileDir(options.name, options.home)
  if (!existsSync(dir)) {
    return {
      ok: false,
      code: 'PROFILE_NOT_FOUND',
      reason: `未找到 profile "${options.name}"（查找路径 ${dir}）`,
    }
  }
  const files: ProfileFiles = {
    dir,
    manifestPath: join(dir, 'package.json'),
    patchPath: join(dir, PROFILE_PATCH_FILENAME),
    rootPath: join(dir, PROFILE_ROOT_FILENAME),
  }
  if (!existsSync(files.manifestPath)) {
    return { ok: false, code: 'PROFILE_UNREADABLE', reason: `profile 缺少 package.json：${files.manifestPath}` }
  }
  const problems: string[] = []
  const manifest = readJson(files.manifestPath)
  if (!manifest.ok) {
    return { ok: false, code: 'PROFILE_UNREADABLE', reason: `${files.manifestPath}: ${manifest.reason}` }
  }
  const bundles = bundlesOf(manifest.value, problems, files.manifestPath)
  const patch = readPatchEntries(files.patchPath, problems)
  const root = readPatchEntries(files.rootPath, problems)
  return {
    ok: true,
    profile: {
      files,
      bundles,
      patchEntries: patch.entries,
      rootEntries: root.entries,
      patchExists: patch.exists,
      rootExists: root.exists,
      problems,
    },
  }
}

/** Extract `dsh.profile.bundles` from a parsed manifest. */
function bundlesOf(manifest: unknown, problems: string[], file: string): string[] {
  if (typeof manifest !== 'object' || manifest === null) {
    problems.push(`${file}: 顶层必须是对象`)
    return []
  }
  const dsh = (manifest as Record<string, unknown>)['dsh']
  if (typeof dsh !== 'object' || dsh === null) return []
  const profile = (dsh as Record<string, unknown>)['profile']
  if (typeof profile !== 'object' || profile === null) return []
  const bundles = (profile as Record<string, unknown>)['bundles']
  if (bundles === undefined) return []
  if (!Array.isArray(bundles)) {
    problems.push(`${file}: dsh.profile.bundles 必须是字符串数组，收到 ${typeof bundles}`)
    return []
  }
  return bundles.filter((entry): entry is string => typeof entry === 'string')
}

/** Every row a patch entry list contains, flattening `insert` lists. */
export function allRows(entries: readonly PatchEntry[]): PatchRow[] {
  const rows: PatchRow[] = []
  for (const entry of entries) {
    if (entry.kind === 'insert') rows.push(...entry.rows)
    else rows.push(entry.row)
  }
  return rows
}

/**
 * Find the row that mounts a plugin.
 *
 * A row matches when its `name` is the package name or its `id` is the entry id:
 * the two are independent in a patch, and users write either.
 * @param entries - entries from one patch file.
 * @param packageName - npm package name, e.g. `dsh-oh-my-whale`.
 * @param entryId - the entry id, e.g. `oh-my-whale`.
 * @returns the matching row, or `undefined`.
 */
export function findPluginRow(
  entries: readonly PatchEntry[],
  packageName: string,
  entryId: string,
): PatchRow | undefined {
  return allRows(entries).find(row => row.name === packageName || row.id === entryId)
}

/** Whether a bundle list declares a package. */
export function declaresBundle(bundles: readonly string[], packageName: string): boolean {
  return bundles.some(bundle => bundle === packageName)
}
