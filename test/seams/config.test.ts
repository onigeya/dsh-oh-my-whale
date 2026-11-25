/**
 * `src/seams/config.ts`: the one place a default or a bound may live (AD-26).
 *
 * The story's own row is AC21 — `tbox.maxNewPredsPerDay` defaults to 20 and
 * refuses 0 and 1.5 by name — plus the path helpers the audit rows are written
 * through.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MAX_NEW_PREDS_PER_DAY,
  auditFileName,
  auditFilePath,
  parseConfig,
  resolvePaths,
  type Config,
} from '../../src/seams/config.ts'

function parsed(input: unknown): Config {
  const result = parseConfig(input)
  if (!result.ok) throw new Error(`config refused: ${result.issues.map((i) => i.key).join(',')}`)
  return result.config
}

describe('config: the predicate budget', () => {
  it('defaults to twenty new predicates per local day', () => {
    expect(DEFAULT_MAX_NEW_PREDS_PER_DAY).toBe(20)
    expect(parsed({}).tbox.maxNewPredsPerDay).toBe(20)
    expect(parsed({ tbox: {} }).tbox.maxNewPredsPerDay).toBe(20)
  })

  it('keeps an explicit budget', () => {
    expect(parsed({ tbox: { maxNewPredsPerDay: 3 } }).tbox.maxNewPredsPerDay).toBe(3)
  })

  it('refuses zero and names the key the user must edit', () => {
    const result = parseConfig({ tbox: { maxNewPredsPerDay: 0 } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]?.key).toBe('tbox.maxNewPredsPerDay')
    expect(result.issues[0]?.received).toBe('number')
  })

  it('refuses a fractional budget and names the key', () => {
    const result = parseConfig({ tbox: { maxNewPredsPerDay: 1.5 } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues[0]?.key).toBe('tbox.maxNewPredsPerDay')
    expect(result.issues[0]?.received).toBe('number')
  })

  it('refuses a budget that is not a number at all', () => {
    const result = parseConfig({ tbox: { maxNewPredsPerDay: '20' } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues[0]?.key).toBe('tbox.maxNewPredsPerDay')
    expect(result.issues[0]?.received).toBe('string')
  })
})

describe('config: the block a later epic configured', () => {
  it('keeps an unknown key instead of failing the profile', () => {
    const config = parsed({ dream: { budget: 7 } })
    expect(config.dream).toEqual({ budget: 7 })
  })
})

describe('config: paths', () => {
  it('puts every artifact under the harness home by default', () => {
    const paths = resolvePaths(parsed({}), (...segments) => join('C:/home', ...segments))
    expect(paths.dataDir).toBe(join('C:/home', 'oh-my-whale'))
    expect(paths.dbFile).toBe(join('C:/home', 'oh-my-whale', 'oh-my-whale.tdb'))
    expect(paths.logFile).toBe(join('C:/home', 'oh-my-whale', 'omw.log'))
    expect(paths.snapshotsDir).toBe(join('C:/home', 'oh-my-whale', 'snapshots'))
  })

  it('lets an explicit database file decide the data root', () => {
    const paths = resolvePaths(
      parsed({ db: { path: 'D:/memory/omw.tdb' } }),
      (...segments) => join('C:/home', ...segments),
    )
    // `resolve`/`dirname` normalise the separator, so compare against `join`.
    expect(paths.dataDir).toBe(join('D:/memory'))
    expect(paths.dbFile).toBe(join('D:/memory', 'omw.tdb'))
  })
})

describe('config: audit file names', () => {
  it('names a file by local calendar day, zero padded', () => {
    expect(auditFileName(new Date(2026, 10, 23, 4, 0, 0))).toBe('audit-20261123.jsonl')
    expect(auditFileName(new Date(2027, 0, 5, 23, 59, 59))).toBe('audit-20270105.jsonl')
  })

  it('places the file directly under the data directory', () => {
    const paths = resolvePaths(parsed({}), (...segments) => join('C:/home', ...segments))
    expect(auditFilePath(paths, new Date(2026, 10, 23, 4, 0, 0))).toBe(
      join('C:/home', 'oh-my-whale', 'audit-20261123.jsonl'),
    )
  })
})
