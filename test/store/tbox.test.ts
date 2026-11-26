/**
 * Story 2.1 — the predicate vocabulary is data, not code (AD-27).
 *
 * `tbox.ts` owns every rule about predicate names and the ten seeds. These
 * tests pin the name grammar (the table is fed to a tool by a model, so a bad
 * name must be refused with a reason a caller can act on), the seed table the
 * story quotes verbatim, and the payload shape the templates then read back.
 * @module
 */
import { describe, expect, it } from 'vitest'
import {
  buildPredicatePayload,
  checkPredicateName,
  NORM_VERSION,
  PREDICATE_NAME_MAX_LENGTH,
  PREDICATE_NAME_PATTERN,
  RESERVED_PREDICATE_PREFIX,
  SEED_PREDICATES,
  startOfLocalDayIso,
} from '../../src/store/tbox.ts'

describe('tbox: the seed vocabulary', () => {
  it('holds the ten names the data model declares, with their cardinality', () => {
    const byName = new Map(SEED_PREDICATES.map(seed => [seed.name, seed.cardinality]))

    expect([...byName.keys()]).toEqual([
      'name',
      'lives_in',
      'works_at',
      'birthday',
      'timezone',
      'prefers_tone',
      'likes',
      'dislikes',
      'knows',
      'avoids_topic',
    ])
    expect([...byName.entries()].filter(([, cardinality]) => cardinality === 'single').map(([name]) => name))
      .toEqual(['name', 'lives_in', 'works_at', 'birthday', 'timezone', 'prefers_tone'])
    expect([...byName.entries()].filter(([, cardinality]) => cardinality === 'multi').map(([name]) => name))
      .toEqual(['likes', 'dislikes', 'knows', 'avoids_topic'])
  })

  it('never seeds a name its own grammar would refuse', () => {
    for (const seed of SEED_PREDICATES) {
      expect(checkPredicateName(seed.name).ok).toBe(true)
      expect(seed.name.startsWith(RESERVED_PREDICATE_PREFIX)).toBe(false)
    }
  })
})

describe('tbox: the predicate name grammar', () => {
  it('accepts a lower snake name and trims the surrounding space', () => {
    expect(checkPredicateName('  mood ')).toEqual({ ok: true, name: 'mood' })
    expect(checkPredicateName('avoids_topic')).toEqual({ ok: true, name: 'avoids_topic' })
  })

  it('refuses a value that is not a string', () => {
    expect(checkPredicateName(undefined)).toEqual({ ok: false, reason: 'pred 必须是字符串（收到 undefined）' })
    expect(checkPredicateName(7)).toEqual({ ok: false, reason: 'pred 必须是字符串（收到 number）' })
  })

  it('refuses the empty name, with the boundary the caller must fix named', () => {
    expect(checkPredicateName('')).toEqual({ ok: false, reason: 'pred 为空' })
    expect(checkPredicateName('   ')).toEqual({ ok: false, reason: 'pred 为空' })
  })

  it('refuses a name over forty characters', () => {
    const long = 'a'.repeat(PREDICATE_NAME_MAX_LENGTH + 1)
    expect(checkPredicateName(long)).toEqual({ ok: false, reason: `pred 超过 ${PREDICATE_NAME_MAX_LENGTH} 个字符：${long}` })
    expect(checkPredicateName('a'.repeat(PREDICATE_NAME_MAX_LENGTH)).ok).toBe(true)
  })

  it('refuses an upper-case or otherwise off-grammar name', () => {
    expect(checkPredicateName('Mood')).toEqual({ ok: false, reason: `pred 必须是小写蛇形（${PREDICATE_NAME_PATTERN.source}）：Mood` })
    expect(checkPredicateName('reply-style')).toEqual({ ok: false, reason: `pred 必须是小写蛇形（${PREDICATE_NAME_PATTERN.source}）：reply-style` })
    expect(checkPredicateName('9lives')).toEqual({ ok: false, reason: `pred 必须是小写蛇形（${PREDICATE_NAME_PATTERN.source}）：9lives` })
  })

  it('refuses the reserved prefix, because those names belong to the product', () => {
    expect(checkPredicateName('omw_x')).toEqual({ ok: false, reason: `pred 不能使用保留前缀 ${RESERVED_PREDICATE_PREFIX}：omw_x` })
  })
})

describe('tbox: the predicate payload', () => {
  it('writes the fields the templates and the data model name', () => {
    const iso = '2026-11-23T04:00:00.000Z'
    const payload = buildPredicatePayload({
      name: 'mood',
      cardinality: 'multi',
      status: 'candidate',
      aliases: ['feeling'],
      decidedBy: 'model',
      decidedAt: iso,
      normVersion: NORM_VERSION,
      activeSlot: 1,
      recordedAt: iso,
      validFrom: iso,
    })

    expect(payload).toEqual({
      kind: 'pred',
      mem_key: 'pred:mood',
      pred: 'mood',
      cardinality: 'multi',
      status: 'candidate',
      aliases: ['feeling'],
      decided_by: 'model',
      decided_at: iso,
      norm_version: NORM_VERSION,
      active_slot: 1,
      valid_from: iso,
      recorded_at: iso,
    })
  })

  it('normalises a whole day to local midnight, so a day matches the user day', () => {
    const morning = new Date(2026, 10, 23, 0, 0, 0)
    const evening = new Date(2026, 10, 23, 23, 59, 59)

    expect(startOfLocalDayIso(evening)).toBe(startOfLocalDayIso(morning))
    expect(startOfLocalDayIso(morning)).toBe(new Date(2026, 10, 23, 0, 0, 0).toISOString())
  })
})