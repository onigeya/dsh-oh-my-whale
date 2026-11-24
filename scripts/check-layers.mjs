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
 *   hard-delete-owner  delete(/deleteManyAtomic(/unlink(/unlinkLabel( only in the AD-15 exempt modules
 *   hard-delete-literal  a transaction op literal `type: 'delete'|'unlink'|'unlinkLabel'`, in any spelling
 *   ad15-exempt-header   an exempt module's first non-empty line names its purpose
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

/**
 * Files allowed to perform physical deletion (AD-5, AD-15).
 *
 * Each one carries a first-line header naming why it is exempt; the header is
 * checked, not trusted, so a module cannot quietly join this list.
 */
const HARD_DELETE_OWNERS = [
  join('ops', 'snapshots.ts'),
  join('ops', 'retention.ts'),
  join('ops', 'dispose.ts'),
]

/** The exact first non-empty line every exempt module must start with. */
const EXEMPT_HEADER_PREFIX = '// AD-15 豁免：'

/** Calls that must never appear outside the exempt modules (AD-5). */
const HARD_DELETE_CALLS = ['delete', 'deleteManyAtomic', 'unlink', 'unlinkLabel']

/** The object key that discriminates a transaction op. */
const OP_TYPE_KEY = 'type'

/** The op discriminators that mean a node or an edge disappears. */
const HARD_DELETE_LITERALS = ['delete', 'unlink', 'unlinkLabel']

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

/** Directories walked for source files, in the order the rules read them. */
const SCANNED_DIRS = ['src', 'test', 'scripts']

/** Recursively collect source files under one directory. */
function filesUnder(dir) {
  const found = []
  const walk = (current) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name.startsWith('.')) continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) found.push(path)
    }
  }
  walk(dir)
  return found
}

/**
 * Every file the hard-delete rules read.
 *
 * Wider than {@link sourceFiles} on purpose: AD-5 forbids physical deletion
 * everywhere in the repository, and a rule that stopped at `src/` would let a
 * script reach around it with one `db.delete` call. The layering rules stay
 * inside `src/` because that is the only place layers exist.
 * @param root - repository root.
 * @returns absolute paths, sorted.
 */
function allSourceFiles(root) {
  const found = []
  for (const name of SCANNED_DIRS) found.push(...filesUnder(join(root, name)))
  // Root-level scripts next to package.json are part of the build, so they are
  // scanned too; nested directories were walked above.
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (!SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) continue
    found.push(join(root, entry.name))
  }
  return found.sort()
}

/** Collect the layered source files, which is what the import rules read. */
function sourceFiles(root) {
  return filesUnder(join(root, 'src')).sort()
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

/**
 * Split source into the tokens a literal check needs.
 *
 * Written by hand because the two shapes this gate must catch — `as const` and
 * `+` concatenation — are exactly the ones a regex over source text gets wrong,
 * and because the pinned toolchain exposes no parser (see the spec's Design
 * Notes 1). Comments are dropped, string and template bodies are decoded, and
 * `/` is read as a regex or a division from context so a quoted pattern cannot
 * start a phantom string.
 *
 * Nothing here can fail: an unfamiliar construct yields an `unknown` token, and
 * the caller then makes no claim about it rather than skipping the file.
 * @param {string} text source with comments already stripped.
 * @returns {Array<{kind: string, value: string, line: number, interpolated?: boolean}>}
 */
function tokenize(text) {
  const tokens = []
  let index = 0
  let line = 1
  /** The last significant token, used only to tell a regex from a division. */
  let previous
  const push = (kind, value, extra) => {
    const token = { kind, value, line, ...extra }
    tokens.push(token)
    previous = token
    return token
  }
  const regexAllowed = () => {
    if (previous === undefined) return true
    if (previous.kind === 'ident') return REGEX_PRECEDING_KEYWORDS.has(previous.value)
    if (previous.kind === 'punct') return previous.value !== ')' && previous.value !== ']' && previous.value !== '}'
    return false
  }
  while (index < text.length) {
    const char = text[index]
    if (char === '\n') { line += 1; index += 1; continue }
    if (char === ' ' || char === '\t' || char === '\r') { index += 1; continue }
    if (char === "'" || char === '"') {
      const quote = char
      let value = ''
      let cursor = index + 1
      while (cursor < text.length && text[cursor] !== quote) {
        if (text[cursor] === '\\') { value += decodeEscape(text[cursor + 1]); cursor += 2; continue }
        if (text[cursor] === '\n') line += 1
        value += text[cursor]
        cursor += 1
      }
      index = cursor + 1
      push('string', value)
      continue
    }
    if (char === '`') {
      let value = ''
      let interpolated = false
      let cursor = index + 1
      let depth = 0
      while (cursor < text.length) {
        const inner = text[cursor]
        if (inner === '\\') { value += decodeEscape(text[cursor + 1]); cursor += 2; continue }
        if (inner === '\n') line += 1
        if (inner === '$' && text[cursor + 1] === '{' && depth === 0) { interpolated = true; depth = 1; cursor += 2; continue }
        if (depth > 0) { if (inner === '}') depth = 0; cursor += 1; continue }
        if (inner === '`') break
        value += inner
        cursor += 1
      }
      index = cursor + 1
      push('template', interpolated ? '' : value, { interpolated })
      continue
    }
    if (char === '/' && regexAllowed()) {
      let cursor = index + 1
      let inClass = false
      while (cursor < text.length) {
        const inner = text[cursor]
        if (inner === '\\') { cursor += 2; continue }
        if (inner === '\n') break
        if (inner === '[') inClass = true
        else if (inner === ']') inClass = false
        else if (inner === '/' && !inClass) break
        cursor += 1
      }
      let end = cursor + 1
      while (end < text.length && /[a-z]/u.test(text[end])) end += 1
      index = end
      push('regex', '')
      continue
    }
    if (/[A-Za-z_$]/u.test(char)) {
      let cursor = index
      while (cursor < text.length && /[A-Za-z0-9_$]/u.test(text[cursor])) cursor += 1
      push('ident', text.slice(index, cursor))
      index = cursor
      continue
    }
    if (/[0-9]/u.test(char)) {
      let cursor = index
      while (cursor < text.length && /[0-9A-Za-z._]/u.test(text[cursor])) cursor += 1
      push('number', text.slice(index, cursor))
      index = cursor
      continue
    }
    const operator = MULTI_CHAR_PUNCT.find(candidate => text.startsWith(candidate, index))
    if (operator !== undefined) {
      push('punct', operator)
      index += operator.length
      continue
    }
    push('punct', char)
    index += 1
  }
  return tokens
}

/**
 * Punctuation that must stay one token.
 *
 * Without this, `obj?.type === 'session'` reads as `type` `=` `=` `=`, and the
 * delete-literal rule sees an assignment of an unreadable value where the source
 * has a comparison. Longest first so `===` wins over `==`.
 */
const MULTI_CHAR_PUNCT = ['===', '!==', '**=', '...', '==', '!=', '<=', '>=', '=>', '&&', '||', '??', '?.', '+=', '-=', '*=', '/=', '**']

/** Keywords after which a `/` opens a regex rather than dividing. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'case', 'delete', 'void', 'new', 'do', 'else', 'yield', 'await',
])

/** Decode the one-character escapes a string token needs to compare equal. */
function decodeEscape(char) {
  if (char === 'n') return '\n'
  if (char === 't') return '\t'
  if (char === 'r') return '\r'
  return char ?? ''
}

/**
 * Read the string value of the expression starting at `start`.
 *
 * Handles the four spellings AC4 names — bare literal, `as const`, `+`
 * concatenation, interpolation-free template — plus redundant parentheses.
 * @param {Array<object>} tokens token list.
 * @param {number} start index of the first token of the expression.
 * @returns {{value: string|null, next: number}} `null` when the shape is not a literal.
 */
function readStringExpression(tokens, start) {
  let value = ''
  let index = start
  let sawPart = false
  for (;;) {
    while (tokens[index]?.kind === 'punct' && tokens[index].value === '(') index += 1
    const token = tokens[index]
    if (token === undefined) return { value: null, next: start }
    if (token.kind === 'string') { value += token.value; index += 1 }
    else if (token.kind === 'template' && token.interpolated === false) { value += token.value; index += 1 }
    else return { value: null, next: start }
    sawPart = true
    if (tokens[index]?.kind === 'ident' && tokens[index].value === 'as') {
      index += 1
      if (tokens[index]?.kind === 'ident') index += 1
    }
    while (tokens[index]?.kind === 'punct' && tokens[index].value === ')') index += 1
    if (tokens[index]?.kind === 'punct' && tokens[index].value === '+') { index += 1; continue }
    break
  }
  return sawPart ? { value, next: index } : { value: null, next: start }
}

/**
 * Name-bearing calls in a file.
 *
 * Read through the tokenizer, not through a stripped copy of the source: this
 * rule scans the whole repository, including this gate, and this gate spells
 * the forbidden names inside its own tables. A string that has been stripped
 * correctly and a call cannot be distinguished by a text search once a file
 * both quotes and calls a name, but a token stream separates them by kind.
 * @param {string} code source with comments stripped.
 * @param {readonly string[]} names call names to report.
 * @returns {Array<{name: string, line: number}>} one entry per call site.
 */
function callNames(code, names) {
  const wanted = new Set(names)
  const tokens = tokenize(code)
  const found = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.kind !== 'ident' || !wanted.has(token.value)) continue
    const next = tokens[index + 1]
    if (next === undefined || next.kind !== 'punct' || next.value !== '(') continue
    found.push({ name: token.value, line: token.line })
  }
  return found
}

/**
 * Line numbers where a transaction op literal names a hard delete.
 *
 * Only an object key (or assignment target) named `type` counts, so a
 * `{ mode: 'delete' }` or a route named `type` in some unrelated record does
 * not fire.
 *
 * A `type` whose value the reader cannot resolve — an interpolation, a
 * variable, a function call, a cast — is reported too, separately. Silence
 * would read as "checked and clean" when nothing was checked, and a caller who
 * wanted to delete through `type: kind` would otherwise pass. The fix a caller
 * is asked for is cheap: spell the literal.
 * @param {string} code source with comments stripped.
 * @returns {{lines: number[], unreadable: number[]}} 1-based line numbers.
 */
function deleteLiteralLines(code) {
  const tokens = tokenize(code)
  const lines = []
  const unreadable = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const isTypeKey = (token.kind === 'ident' || token.kind === 'string') && token.value === OP_TYPE_KEY
    if (!isTypeKey) continue
    const separator = tokens[index + 1]
    if (separator === undefined || separator.kind !== 'punct') continue
    if (separator.value !== ':' && separator.value !== '=') continue
    // `type X = ...` is a type alias, not an op. An assignment form counts only
    // when it writes through a member (`op.type = ...`); anything else with `=`
    // is a declaration.
    if (separator.value === '=' && tokens[index - 1]?.value !== '.') continue
    const read = readStringExpression(tokens, index + 2)
    if (read.value === null) {
      unreadable.push(token.line)
      continue
    }
    if (!HARD_DELETE_LITERALS.includes(read.value)) continue
    lines.push(token.line)
  }
  return { lines, unreadable }
}

/**
 * Check one file against the no-deletion rules (AD-5, AD-15).
 *
 * Read over the whole repository rather than over `src/`: a physical delete is
 * not a layering mistake, it is forbidden everywhere, and a gate that stopped at
 * the source tree would let a script or a test reach around it.
 * @param file - absolute path.
 * @param root - repository root.
 * @param violations - collected findings.
 */
function checkDeletion(file, root, violations) {
  const relativePath = relative(root, file)
  const text = readFileSync(file, 'utf8')
  const uncommented = stripComments(text)
  const srcRelative = relative(join(root, 'src'), file)
  const insideSource = !srcRelative.startsWith('..')
  const ownsHardDelete = insideSource && HARD_DELETE_OWNERS.some(owner => srcRelative === owner)

  if (!ownsHardDelete) {
    // Read through the tokenizer rather than a stripped copy of the text: this
    // rule runs over the whole repository, including this gate, and this gate
    // spells the four names in its own tables. A textual scan of a file that
    // both quotes and calls a name cannot tell the two apart; a token stream can.
    for (const call of callNames(uncommented, HARD_DELETE_CALLS)) {
      violations.push({
        rule: 'hard-delete-owner',
        file: relativePath,
        line: call.line,
        message: `硬删只允许出现在 AD-15 豁免模块：${call.name}(`,
      })
    }
    // The second gate: a transaction op literal deletes without ever naming a
    // delete function, which is why the token list above cannot see it. It is
    // checked here rather than everywhere because an exempt module is the one
    // place allowed to spell `type: 'unlink'` — forbidding that would leave the
    // exemption unusable and push the caller back to a call the token list
    // would then blame.
    const deletionLiterals = deleteLiteralLines(uncommented)
    for (const line of deletionLiterals.lines) {
      violations.push({
        rule: 'hard-delete-literal',
        file: relativePath,
        line,
        message: `事务 op 的 type 字面量不得是 ${HARD_DELETE_LITERALS.join('/')}（AD-5 无物理删除）`,
      })
    }
    for (const line of deletionLiterals.unreadable) {
      violations.push({
        rule: 'hard-delete-unreadable',
        file: relativePath,
        line,
        message: `type 的取值读不出来，无法排除 ${HARD_DELETE_LITERALS.join('/')}：请写成字面量`,
      })
    }
    return
  }

  // An exempt module proves its own exemption. The header is checked rather than
  // trusted, so joining the list is not enough to escape the gate.
  const header = text.split('\n').find(candidate => candidate.trim() !== '') ?? ''
  const purpose = header.startsWith(EXEMPT_HEADER_PREFIX)
    ? header.slice(EXEMPT_HEADER_PREFIX.length).trim()
    : ''
  if (!header.startsWith(EXEMPT_HEADER_PREFIX) || purpose === '') {
    violations.push({
      rule: 'ad15-exempt-header',
      file: relativePath,
      line: 1,
      message: `AD-15 豁免文件的第一行必须是 ${EXEMPT_HEADER_PREFIX}<非空用途>`,
    })
  }
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
  const scanned = allSourceFiles(root)
  for (const file of scanned) checkDeletion(file, root, violations)
  return { ok: violations.length === 0, violations, files: scanned.length }
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