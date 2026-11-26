/**
 * Story 2.1 — bootstrap builds the two indexes once and seeds the vocabulary
 * in one transaction, or leaves the registry empty (AC2, AC12, AC23).
 *
 * The failure cases matter as much as the success: a half-seeded registry would
 * let the model resolve a predicate that was never installed, and a store whose
 * index creation failed must not be presented to the tools as writable.
 * @module
 */
import { describe, expect, it } from 'vitest'
import {
  ensureSchema,
  HISTORY_KEY_INDEX,
  UNIQUE_KEY_INDEX,
  type SchemaEvent,
} from '../../src/store/schema.ts'
import { createAssertionTemplates } from '../../src/store/templates/assertions.ts'
import { SEED_PREDICATES } from '../../src/store/tbox.ts'
import { nodeCount, openDatabase } from '../../src/store/db.ts'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { closeWriteStores, openWriteStore, TEST_DIM } from '../support/write-store.ts'

/** A clock pinned to one morning. */
const NOON = Date.UTC(2026, 10, 23, 4, 0, 0)

/** Every registry entry a live handle holds, by name. */
function registryNames(db: Parameters<typeof createAssertionTemplates>[0]): string[] {
  const templates = createAssertionTemplates(db)
  return SEED_PREDICATES
    .filter(seed => templates.findPredByName(seed.name) !== undefined)
    .map(seed => seed.name)
}

describe('schema: the first bootstrap', () => {
  it('creates both indexes and the ten seeds, and reports how many it wrote', () => {
    const store = openWriteStore('omw-schema-')
    const events: SchemaEvent[] = []

    const outcome = ensureSchema(store.db, { now: () => NOON, onEvent: event => events.push(event) })

    expect(outcome).toMatchObject({ ok: true, writable: true, seeded: 10 })
    expect(store.db.listUniqueIndexes()).toEqual([[...UNIQUE_KEY_INDEX]])
    expect(store.db.indexInfo().filter(info => info.kind === 'composite' && !info.unique).map(info => info.fields))
      .toEqual([[...HISTORY_KEY_INDEX]])
    expect(registryNames(store.db)).toEqual(SEED_PREDICATES.map(seed => seed.name))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ outcome: 'bootstrap', code: 'seed_install', seeded: 10 })
  })

  it('writes every seed as an active, seed-decided predicate', () => {
    const store = openWriteStore('omw-schema-')
    ensureSchema(store.db, { now: () => NOON })
    const templates = createAssertionTemplates(store.db)

    const mood = templates.findPredByName('likes')

    expect(mood?.payload).toMatchObject({
      kind: 'pred',
      mem_key: 'pred:likes',
      pred: 'likes',
      cardinality: 'multi',
      status: 'active',
      decided_by: 'seed',
      active_slot: 1,
    })
    expect(templates.findPredByName('name')?.payload['cardinality']).toBe('single')
  })

  it('is idempotent: a second boot writes nothing and emits no event', () => {
    const store = openWriteStore('omw-schema-')
    const first = ensureSchema(store.db, { now: () => NOON })
    const events: SchemaEvent[] = []
    const before = nodeCount(store.db)

    const second = ensureSchema(store.db, { now: () => NOON, onEvent: event => events.push(event) })

    expect(first).toMatchObject({ ok: true, seeded: 10 })
    expect(second).toMatchObject({ ok: true, writable: true, seeded: 0 })
    expect(nodeCount(store.db)).toBe(before)
    expect(events).toEqual([])
  })

  it('installs only the seeds a partly seeded registry is missing', () => {
    const store = openWriteStore('omw-schema-')
    ensureSchema(store.db, { now: () => NOON })
    const templates = createAssertionTemplates(store.db)
    const likes = templates.findPredByName('likes')
    if (likes === undefined) throw new Error('seed missing')
    store.db.patchPayload(likes.id, { $set: { superseded_at: NOON, active_slot: NOON } })

    const outcome = ensureSchema(store.db, { now: () => NOON })

    expect(outcome).toMatchObject({ ok: true, writable: true, seeded: 1 })
    expect(registryNames(store.db)).toEqual(SEED_PREDICATES.map(seed => seed.name))
  })
})

describe('schema: a handle that must not be written', () => {
  it('leaves a read-only handle completely alone, and says why', () => {
    const store = openWriteStore('omw-schema-')
    const events: SchemaEvent[] = []
    const before = readFileSync(store.dbFile)

    const outcome = ensureSchema(store.db, { now: () => NOON, readOnly: true, onEvent: event => events.push(event) })

    expect(outcome).toEqual({ ok: true, writable: false, reason: '只读句柄：不建索引、不写种子' })
    expect(store.db.listUniqueIndexes()).toEqual([])
    expect(nodeCount(store.db)).toBe(0)
    expect(events).toEqual([])
    expect(createHash('sha256').update(readFileSync(store.dbFile)).digest('hex'))
      .toBe(createHash('sha256').update(before).digest('hex'))
  })
})

describe('schema: a bootstrap that cannot finish', () => {
  it('reports the index failure and stays unwritable when a duplicate blocks it', () => {
    const store = openWriteStore('omw-schema-')
    // Two live versions of one key: the unique index cannot be built over this.
    for (const slot of [1, 1]) {
      store.db.insert(new Array(TEST_DIM).fill(0), { kind: 'assertion', mem_key: 'assertion:Elliott:likes:coffee', active_slot: slot })
    }
    const events: SchemaEvent[] = []

    const outcome = ensureSchema(store.db, { now: () => NOON, onEvent: event => events.push(event) })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.writable).toBe(false)
    expect(outcome.code).toBe('TDB_UNIQUE_CONSTRAINT')
    expect(outcome.reason).toMatch(/^建索引失败：/u)
    expect(store.db.listUniqueIndexes()).toEqual([])
    expect(registryNames(store.db)).toEqual([])
    expect(events).toEqual([])
  })
})

describe('schema: the seed transaction', () => {
  it('rolls the whole batch back when one seed collides, leaving the registry empty', () => {
    const store = openWriteStore('omw-schema-')
    // A retired entry that kept active_slot = 1: invisible to the live template, so
    // bootstrap counts `likes` as missing, yet the unique index still holds its
    // (mem_key, active_slot) pair and refuses the replacement.
    store.db.createUniqueCompositeIndex([...UNIQUE_KEY_INDEX])
    store.db.insert(new Array(TEST_DIM).fill(0), {
      kind: 'pred',
      mem_key: 'pred:likes',
      pred: 'likes',
      cardinality: 'multi',
      status: 'active',
      active_slot: 1,
      superseded_at: NOON - 1000,
    })

    const outcome = ensureSchema(store.db, { now: () => NOON })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.writable).toBe(false)
    expect(outcome.code).toBe('OMW_SCHEMA_UNIQUE')
    expect(outcome.reason).toBe('写种子谓词失败（unique），注册表保持为空')
    // The nine other seeds were in the same transaction, and it did not commit.
    expect(registryNames(store.db)).toEqual([])
  })

  it('treats a retired registration as missing and installs a fresh one', () => {
    const store = openWriteStore('omw-schema-')
    ensureSchema(store.db, { now: () => NOON })
    const templates = createAssertionTemplates(store.db)
    const likes = templates.findPredByName('likes')
    if (likes === undefined) throw new Error('seed missing')
    // Retire it the way a rekey would: keep the slot distinct so the index allows it.
    store.db.patchPayload(likes.id, { $set: { superseded_at: NOON, active_slot: NOON } })

    const outcome = ensureSchema(store.db, { now: () => NOON })

    expect(outcome).toMatchObject({ ok: true, writable: true, seeded: 1 })
    expect(templates.findPredByName('likes')?.payload).toMatchObject({ decided_by: 'seed', active_slot: 1 })
    expect(nodeCount(store.db)).toBe(11)
  })
})