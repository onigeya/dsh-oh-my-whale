/**
 * Story 2.1 — the four literal templates, and the row shapes they refuse.
 *
 * The templates are the only place this build reads by business key, so these
 * tests pin two things at once: which rows each query selects (a live version,
 * every version, a live registry entry, a model-proposed entry since a day) and
 * that a malformed row throws instead of being believed.
 * @module
 */
import { describe, expect, it } from 'vitest'
import { buildPredicatePayload, NORM_VERSION } from '../../src/store/tbox.ts'
import {
  createAssertionTemplates,
  predicateMemKey,
  type AssertionTemplates,
} from '../../src/store/templates/assertions.ts'
import type { Database } from '../../src/store/db.ts'
import { openWriteStore } from '../support/write-store.ts'

/** The vector every test node carries; the templates never read it. */
const ZERO = [0, 0, 0, 0]

/** A clock pinned to one morning. */
const NOON = Date.UTC(2026, 10, 23, 4, 0, 0)

/**
 * Insert one node and return its id.
 * @param db - the open handle.
 * @param payload - the payload to store.
 * @returns the new node id.
 */
function insert(db: Database, payload: Record<string, unknown>): number {
  return db.insert([...ZERO], payload)
}

/** A live assertion-shaped payload for one key. */
function livePayload(memKey: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const iso = new Date(NOON).toISOString()
  return { kind: 'assertion', mem_key: memKey, active_slot: 1, valid_from: iso, recorded_at: iso, ...extra }
}

/** A retired version of the same key: the unique index reads active_slot, not time. */
function retiredPayload(memKey: string, slot: number): Record<string, unknown> {
  const iso = new Date(NOON - 86_400_000).toISOString()
  return {
    kind: 'assertion',
    mem_key: memKey,
    active_slot: slot,
    superseded_at: NOON - 3_600_000,
    valid_from: iso,
    recorded_at: iso,
  }
}

/** A registry entry payload, with the seed defaults a test may override. */
function predPayload(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const iso = new Date(NOON).toISOString()
  return {
    ...buildPredicatePayload({
      name,
      cardinality: 'multi',
      status: 'active',
      aliases: [],
      decidedBy: 'seed',
      decidedAt: iso,
      normVersion: NORM_VERSION,
      activeSlot: 1,
      recordedAt: iso,
      validFrom: iso,
    }),
    ...extra,
  }
}

/** A templates facade over a stub handle, for the row-shape cases. */
function stubTemplates(rows: readonly unknown[]): AssertionTemplates {
  const db = {
    prepareTql: () => ({}),
    executePreparedTql: () => rows,
  }
  return createAssertionTemplates(db as unknown as Database)
}

describe('templates: reading one key', () => {
  it('finds the live version and ignores the retired ones', () => {
    const store = openWriteStore('omw-tpl-')
    const templates = createAssertionTemplates(store.db)
    insert(store.db, retiredPayload('assertion:Elliott:likes:coffee', 1_700_000_000_000))
    const live = insert(store.db, livePayload('assertion:Elliott:likes:coffee'))

    const found = templates.findLiveByKey('assertion:Elliott:likes:coffee')

    expect(found?.id).toBe(live)
    expect(found?.payload['mem_key']).toBe('assertion:Elliott:likes:coffee')
  })

  it('answers undefined for a key nothing was written under', () => {
    const store = openWriteStore('omw-tpl-')
    const templates = createAssertionTemplates(store.db)

    expect(templates.findLiveByKey('assertion:Elliott:likes:coffee')).toBeUndefined()
  })

  it('returns every version of one key, live and retired', () => {
    const store = openWriteStore('omw-tpl-')
    const templates = createAssertionTemplates(store.db)
    insert(store.db, retiredPayload('assertion:Elliott:likes:coffee', 1_700_000_000_000))
    insert(store.db, retiredPayload('assertion:Elliott:likes:coffee', 1_700_000_000_001))
    insert(store.db, livePayload('assertion:Elliott:likes:coffee'))

    const versions = templates.findAllVersionsByKey('assertion:Elliott:likes:coffee')

    expect(versions).toHaveLength(3)
    expect(versions.map(node => node.payload['active_slot'])).toEqual([1_700_000_000_000, 1_700_000_000_001, 1])
  })

  it('throws rather than picking a winner when a key has two live versions', () => {
    const store = openWriteStore('omw-tpl-')
    const templates = createAssertionTemplates(store.db)
    // No unique index is created here: this is the state the index exists to prevent.
    insert(store.db, livePayload('assertion:Elliott:likes:coffee'))
    insert(store.db, livePayload('assertion:Elliott:likes:coffee'))

    expect(() => templates.findLiveByKey('assertion:Elliott:likes:coffee'))
      .toThrow(/业务键 assertion:Elliott:likes:coffee 有 2 条未失效版本，唯一索引被绕过/u)
  })
})

describe('templates: reading the predicate registry', () => {
  it('finds the live entry for a name', () => {
    const store = openWriteStore('omw-tpl-')
    const templates = createAssertionTemplates(store.db)
    const id = insert(store.db, predPayload('mood'))

    const found = templates.findPredByName('mood')

    expect(found?.id).toBe(id)
    expect(predicateMemKey('mood')).toBe('pred:mood')
    expect(found?.payload).toMatchObject({ kind: 'pred', pred: 'mood', cardinality: 'multi', status: 'active' })
  })

  it('does not answer with a retired entry', () => {
    const store = openWriteStore('omw-tpl-')
    const templates = createAssertionTemplates(store.db)
    insert(store.db, {
      ...predPayload('mood'),
      active_slot: 1_700_000_000_000,
      superseded_at: NOON - 1000,
    })

    expect(templates.findPredByName('mood')).toBeUndefined()
  })

  it('ignores a node that carries the key but is not a predicate', () => {
    const store = openWriteStore('omw-tpl-')
    const templates = createAssertionTemplates(store.db)
    insert(store.db, { kind: 'flag', mem_key: 'pred:mood', active_slot: 1 })

    expect(templates.findPredByName('mood')).toBeUndefined()
  })

  it('throws rather than picking a winner when a name has two live entries', () => {
    const store = openWriteStore('omw-tpl-')
    const templates = createAssertionTemplates(store.db)
    insert(store.db, predPayload('mood'))
    insert(store.db, predPayload('mood'))

    expect(() => templates.findPredByName('mood')).toThrow(/谓词 mood 有 2 条未失效登记，唯一索引被绕过/u)
  })
})

describe('templates: counting what the model proposed', () => {
  it('selects only model entries decided at or after the given instant', () => {
    const store = openWriteStore('omw-tpl-')
    const templates = createAssertionTemplates(store.db)
    const dayStart = new Date(2026, 10, 23, 0, 0, 0).toISOString()
    insert(store.db, predPayload('fresh', {
      decided_by: 'model',
      decided_at: new Date(NOON).toISOString(),
    }))
    insert(store.db, predPayload('yesterday', {
      decided_by: 'model',
      decided_at: new Date(2026, 10, 22, 18, 0, 0).toISOString(),
    }))
    insert(store.db, predPayload('seeded', { decided_by: 'seed' }))

    const found = templates.findModelPredsSince(dayStart)

    expect(found.map(node => node.payload['pred'])).toEqual(['fresh'])
  })
})

describe('templates: rows this build refuses to believe', () => {
  it('rejects an id that is not a decimal integer', () => {
    const templates = stubTemplates([{ _: { id: '0x10', payload: { mem_key: 'x:y:z' } } }])

    expect(() => templates.findLiveByKey('x:y:z')).toThrow(/节点 id 不是十进制整数/u)
  })

  it('rejects a row that is not an object', () => {
    const templates = stubTemplates(['not a row'])

    expect(() => templates.findAllVersionsByKey('x:y:z')).toThrow(/模板返回的行不是对象/u)
  })

  it('rejects a row without metadata', () => {
    const templates = stubTemplates([{ payload: {} }])

    expect(() => templates.findLiveByKey('x:y:z')).toThrow(/缺少 _ 元数据/u)
  })

  it('rejects a row whose payload is not an object', () => {
    const templates = stubTemplates([{ _: { id: 3, payload: 'text' } }])

    expect(() => templates.findPredByName('mood')).toThrow(/缺少 _ \.payload 对象/u)
  })
})