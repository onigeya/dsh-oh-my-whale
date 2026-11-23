#!/usr/bin/env node
/**
 * Layer and write-authority gate (AD-15, G0-6).
 *
 * TypeScript cannot express "this file may not import that directory", and the
 * TypeScript ESLint parser is incompatible with the pinned toolchain, so the
 * rule is enforced here: a deterministic scan of import specifiers and of
 * forbidden call tokens.
 *
 * Rules:
 *   store-no-imports   src/store/** imports no other plugin layer
 *   core-no-seams      src/core/**  imports no seams/, ops/, dream/, persona/, gui/
 *   gui-no-store       src/gui/**   imports no store/
 *   triviumdb-owner    triviumdb is importable only from src/store/**
 *   prompt-seam-owner  systemPrompt.section(/.context( only in src/seams/prompt-composer.ts
 *   hard-delete-owner  delete(/deleteManyAtomic(/unlink(/unlinkLabel( only in src/ops/snapshots.ts
 *   write-authority    every engine write method only in src/store/commits/** (AD-4)
 *   tql-owner          prepareTql/executePreparedTql only in src/store/templates/**
 *   exists-owner       the only query prefix allowed is `superseded_at: {$exists: false}`, and only in src/store/templates/**
 *
 * Usage: node scripts/check-layers.mjs [--root <dir>] [--json]
 * Exit: 0 when every rule holds, 1 with one line per violation.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const LAYERS = ['core', 'store', 'dream', 'persona', 'seams', 'gui', 'ops']
const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.tsx', '.js', '.mjs', '.cjs'])

/** Rules expressed as data, so a test can point the checker at a fixture. */
const RULES = [
  {
    id: 'store-no-imports',
    layer: 'store',
    allowed: ['store'],
    allowedSpecifiers: ['triviumdb'],
    description: 'store/ 不能 import 其他层',
  },
  {
    id: 'core-no-seams',
    layer: 'core',
    allowed: ['core', 'store'],
    description: 'core/ 不能 import seams/（领域规则不得依赖宿主细节）',
  },
  {
    id: 'gui-no-store',
    layer: 'gui',
    allowed: LAYERS.filter(layer => layer !== 'store'),
    description: 'gui/ 不能 import store/',
  },
]

/** Files allowed to call the prompt seam. */
const PROMPT_SEAM_OWNERS = [join('seams', 'prompt-composer.ts')]

/** Files allowed to perform physical deletion. */
const HARD_DELETE_OWNERS = [join('ops', 'snapshots.ts')]

/** Tokens that must never appear outside the snapshot module (AD-5). */
const HARD_DELETE_TOKENS = ['delete(', 'deleteManyAtomic(', 'unlink(', 'unlinkLabel(']

/** Tokens that must never appear outside the prompt composer (AD-7). */
const PROMPT_SEAM_TOKENS = ['systemPrompt.section(', 'systemPrompt.context(']

/**
 * Files allowed to call an engine write method.
 *
 * AD-4 says one write entry point, one transaction; the commit engine is that
 * point. The two older modules are named exceptions because they predate it and
 * write one narrowly-scoped node each — the contract flag and the vector state —
 * through the same handle, not through the commit path.
 */
const WRITE_AUTHORITY_OWNERS = [
  join('store', 'commits'),
  join('store', 'meta.ts'),
  join('store', 'vector-write.ts'),
  join('store', 'schema.ts'),
]

/** Every method that mutates the store. A new one belongs here too. */
const WRITE_TOKENS = [
  'insert(',
  'insertWithId(',
  'batchInsert(',
  'upsertWithId(',
  'patchPayload(',
  'updatePayload(',
  'updateVector(',
  'link(',
  'upsertEdge(',
  'commitTransaction(',
  'tqlMut(',
]

/** Directory allowed to hold TQL text (AD-8: one place, literal, precompiled). */
const TQL_OWNER_DIR = join('store', 'templates')

/** TQL entry points that must stay inside {@link TQL_OWNER_DIR}. */
const TQL_TOKENS = ['prepareTql(', 'executePreparedTql(']

/**
 * The one predicate-filter prefix this codebase is allowed to contain.
 *
 * `$exists` cannot be parameterised — TQL takes its filter as a literal — so the
 * live-version filter is repeated in each template rather than shared. That is
 * why the rule pins both the directory and the exact shape.
 */
const EXISTS_OWNER_DIR = join('store', 'templates')
const EXISTS_ALLOWED = 'superseded_at: {$exists: false}'

/** Tokens whose presence means an `$exists` filter is being written. */
const EXISTS_TOKENS = ['$exists']

/** Recursively collect source files. */
function sourceFiles(root) {
  const found = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) found.push(path)
    }
  }
  walk(join(root, 'src'))
  return found.sort()
}

/** Remove line and block comments so prose cannot trip a token rule. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * Blank out string literals while keeping newlines, so a token rule cannot fire
 * on prose or on a message, and line numbers stay correct.
 */
function stripStrings(text) {
  return text.replace(/(['"`])(?:\\[\s\S]|(?!\1)[^\\])*?\1/g, match => match.replace(/[^\n]/g, ' '))
}

/** Every import-like specifier in a file, with its 1-based line. */
function importSpecifiers(text) {
  const found = []
  const patterns = [
    // `[\s\S]` so a multi-line import (braces broken across lines) still matches.
    /(?:^|\n)\s*(?:import|export)\b[\s\S]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0
      found.push({ specifier: match[1], line: text.slice(0, index).split('\n').length })
    }
  }
  return found
}

/** The layer a relative specifier lands in, or undefined for same-dir/node/bare. */
function layerOfSpecifier(file, specifier, root) {
  if (!specifier.startsWith('.')) return { kind: 'bare', specifier }
  const target = resolve(dirname(file), specifier)
  const relativePath = relative(join(root, 'src'), target)
  if (relativePath.startsWith('..') || relativePath === '') return { kind: 'outside' }
  const first = relativePath.split(sep)[0]
  return LAYERS.includes(first) ? { kind: 'layer', layer: first } : { kind: 'outside' }
}

/**
 * Index of the first `token` that is a call and not the tail of a longer name.
 *
 * A bare `indexOf` would read `unlink(` as `link(`, and the write gate would then
 * blame the snapshot module for a call it never makes. A preceding `.` is fine
 * (that is how every call is written); any other identifier character is not.
 * @param code - source text with comments stripped.
 * @param token - the call token, parentheses included.
 * @returns the index, or `-1`.
 */
function findCall(code, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, match => `\\${match}`)
  const pattern = new RegExp(`(?<![A-Za-z0-9_$])${escaped}`, 'u')
  const found = pattern.exec(code)
  return found === null ? -1 : found.index
}

/** Check one file against the rules. */
function checkFile(file, root, violations) {
  const relativePath = relative(root, file)
  const text = readFileSync(file, 'utf8')
  // Comments first (prose may quote code), then string literals (messages may
  // name a forbidden call without calling it).
  const uncommented = stripComments(text)
  const codeOnly = stripStrings(uncommented)
  const fileLayer = relative(join(root, 'src'), file).split(sep)[0]

  for (const rule of RULES) {
    if (fileLayer !== rule.layer) continue
    for (const { specifier, line } of importSpecifiers(uncommented)) {
      const target = layerOfSpecifier(file, specifier, root)
      if (target.kind === 'layer' && !rule.allowed.includes(target.layer)) {
        violations.push({
          rule: rule.id,
          file: relativePath,
          line,
          message: `${rule.description}：${specifier}`,
        })
      }
    }
  }

  // triviumdb ownership.
  if (fileLayer !== 'store') {
    for (const { specifier, line } of importSpecifiers(uncommented)) {
      if (specifier === 'triviumdb' || specifier.startsWith('triviumdb/')) {
        violations.push({
          rule: 'triviumdb-owner',
          file: relativePath,
          line,
          message: `只有 src/store/** 可以 import triviumdb：${specifier}`,
        })
      }
    }
  }

  const srcRelative = relative(join(root, 'src'), file)
  const ownsPromptSeam = PROMPT_SEAM_OWNERS.some(owner => srcRelative === owner)
  if (!ownsPromptSeam) {
    for (const token of PROMPT_SEAM_TOKENS) {
      const index = codeOnly.indexOf(token)
      if (index >= 0) {
        violations.push({
          rule: 'prompt-seam-owner',
          file: relativePath,
          line: codeOnly.slice(0, index).split('\n').length,
          message: `只有 src/seams/prompt-composer.ts 可以调用 ${token}`,
        })
      }
    }
  }

  const ownsWriteAuthority = WRITE_AUTHORITY_OWNERS.some((owner) => {
    const normalized = owner.split(sep).join(sep)
    return srcRelative === normalized || srcRelative.startsWith(`${normalized}${sep}`)
  })
  if (!ownsWriteAuthority) {
    for (const token of WRITE_TOKENS) {
      const index = findCall(codeOnly, token)
      if (index >= 0) {
        violations.push({
          rule: 'write-authority',
          file: relativePath,
          line: codeOnly.slice(0, index).split('\n').length,
          message: `写方法只允许经 src/store/commits/ 的提交引擎调用：${token}`,
        })
      }
    }
  }

  const ownsTql = srcRelative === TQL_OWNER_DIR || srcRelative.startsWith(`${TQL_OWNER_DIR}${sep}`)
  if (!ownsTql) {
    for (const token of TQL_TOKENS) {
      const index = findCall(codeOnly, token)
      if (index >= 0) {
        violations.push({
          rule: 'tql-owner',
          file: relativePath,
          line: codeOnly.slice(0, index).split('\n').length,
          message: `TQL 只允许出现在 src/store/templates/：${token}`,
        })
      }
    }
  }

  // `$exists` is scanned in `uncommented`, not in `codeOnly`: the filter lives in a
  // string literal, which is exactly what `stripStrings` erases. Comments are
  // still gone, because the module comment quotes the filter when explaining it.
  if (uncommented.includes('$exists')) {
    const ownsExists = srcRelative === EXISTS_OWNER_DIR || srcRelative.startsWith(`${EXISTS_OWNER_DIR}${sep}`)
    if (!ownsExists) {
      violations.push({
        rule: 'exists-owner',
        file: relativePath,
        line: uncommented.slice(0, uncommented.indexOf('$exists')).split('\n').length,
        message: `$exists 只允许出现在 src/store/templates/：${EXISTS_TOKENS.join(', ')}`,
      })
    } else {
      // Inside the owning directory the shape is pinned: every occurrence has to
      // belong to the live-version filter, not to some new predicate nobody
      // reviewed.
      const occurrences = uncommented.split('$exists').length - 1
      const allowed = uncommented.split(EXISTS_ALLOWED).length - 1
      if (occurrences > allowed) {
        violations.push({
          rule: 'exists-owner',
          file: relativePath,
          line: uncommented.slice(0, uncommented.indexOf('$exists')).split('\n').length,
          message: `$exists 只允许 ${EXISTS_ALLOWED} 这一种形态`,
        })
      }
    }
  }

  const ownsHardDelete = HARD_DELETE_OWNERS.some(owner => srcRelative === owner)
  if (!ownsHardDelete) {
    for (const token of HARD_DELETE_TOKENS) {
      const index = codeOnly.indexOf(token)
      if (index >= 0) {
        violations.push({
          rule: 'hard-delete-owner',
          file: relativePath,
          line: codeOnly.slice(0, index).split('\n').length,
          message: `硬删只允许出现在 src/ops/snapshots.ts：${token}`,
        })
      }
    }
  }
}

/**
 * Run every rule over a root that contains `src/`.
 * @param {string} root absolute directory holding `src/`.
 * @returns {{ok: boolean, violations: Array<object>, files: number}}
 */
export function checkLayers(root) {
  const violations = []
  const files = sourceFiles(root)
  for (const file of files) checkFile(file, root, violations)
  return { ok: violations.length === 0, violations, files: files.length }
}

// `endsWith` breaks on a path containing spaces (it is URL-encoded on one side
// only), which made the CLI exit 0 without checking anything.
const isMain = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url

if (isMain) {
  const args = process.argv.slice(2)
  let root = process.cwd()
  let json = false
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--root') root = resolve(args[index + 1] ?? root)
    else if (args[index] === '--json') json = true
  }
  const result = checkLayers(root)
  if (result.files === 0) {
    // "No files" is a broken invocation (wrong --root, missing src/), never a pass.
    const expected = join(root, 'src')
    process.stdout.write(
      `layers: 在 ${root} 下找不到任何源文件（预期 ${expected}，存在=${existsSync(expected)}）\n`,
    )
    process.exitCode = 1
  } else if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else if (result.ok) {
    process.stdout.write(`layers: ${result.files} 个源文件，全部规则通过\n`)
  } else {
    for (const violation of result.violations) {
      process.stdout.write(`layers: ${violation.file}:${violation.line} [${violation.rule}] ${violation.message}\n`)
    }
    process.stdout.write(`layers: ${result.violations.length} 处违规（${result.files} 个源文件）\n`)
  }
  // Never overwrite the "no source files" failure set above.
  if (result.files > 0) process.exitCode = result.ok ? 0 : 1
}