/**
 * `src/store/commits/engine.ts`: every failure the engine can hand back, and the
 * one rule that decides whether a caller may retry.
 *
 * The handle here is a stub, not a database: the point is the translation of a
 * thrown value into `WriteFailure`, which is the only thing the layers above
 * are allowed to see. `commit` is exercised against a real store in
 * `commits.test.ts`; this file pins the arms a real store cannot be made to
 * produce on demand.
 * @module
 */
import { describe, expect, it } from 'vitest'

import type { Database } from '../../src/store/db.ts'
import { createCommitEngine } from '../../src/store/commits/engine.ts'

/** A handle whose every write method throws the value it was given. */
function stubbedDatabase(thrown: unknown): Database {
  const fail = (): never => {
    throw thrown
  }
  return {
    commitTransaction: fail,
    updatePayload: fail,
    close: fail,
  } as unknown as Database
}

describe('commit engine: a batch that is empty', () => {
  it('is a caller bug, reported as an engine refusal rather than a silent success', () => {
    const engine = createCommitEngine(stubbedDatabase(new Error('not reached')), 4)
    expect(engine.commit([])).toEqual({
      ok: false,
      failure: { kind: 'engine', code: 'TDB_INVALID_INPUT', outcome: 'not_committed' },
    })
  })
})

describe('commit engine: translating a refusal', () => {
  it('keeps both node ids of a uniqueness violation as numbers', () => {
    const engine = createCommitEngine(
      stubbedDatabase({
        code: 'TDB_UNIQUE_CONSTRAINT',
        details: { fields: ['mem_key', 'active_slot'], existing_id: 1, conflicting_id: 2 },
      }),
      4,
    )
    const outcome = engine.commit([{ type: 'insert', vector: [0, 0, 0, 0], payload: {} }])
    expect(outcome).toEqual({
      ok: false,
      failure: {
        kind: 'unique',
        details: { fields: ['mem_key', 'active_slot'], existingId: 1, conflictingId: 2 },
      },
    })
  })

  it('reads a stringified id and drops fields that are not strings', () => {
    const engine = createCommitEngine(
      stubbedDatabase({
        code: 'TDB_UNIQUE_CONSTRAINT',
        details: { fields: ['mem_key', 7], existing_id: '1', conflicting_id: '2' },
      }),
      4,
    )
    const outcome = engine.commit([{ type: 'insert', vector: [0, 0, 0, 0], payload: {} }])
    expect(outcome).toEqual({
      ok: false,
      failure: {
        kind: 'unique',
        details: { fields: ['mem_key'], existingId: 1, conflictingId: 2 },
      },
    })
  })

  it('still reports the violation when it names no node ids', () => {
    // The ids are evidence, not the finding: a violation with no ids is still a
    // violation. Throwing here would escape a function that only ever answers
    // with a WriteOutcome, and the caller would lose the rejection row it owes.
    const engine = createCommitEngine(stubbedDatabase({ code: 'TDB_UNIQUE_CONSTRAINT' }), 4)
    expect(engine.commit([{ type: 'insert', vector: [0, 0, 0, 0], payload: {} }])).toEqual({
      ok: false,
      failure: { kind: 'unique', details: { fields: [] } },
    })
  })

  it('drops an id it cannot read instead of inventing one', () => {
    const engine = createCommitEngine(
      stubbedDatabase({ code: 'TDB_UNIQUE_CONSTRAINT', details: { existing_id: '0x10' } }),
      4,
    )
    expect(engine.commit([{ type: 'insert', vector: [0, 0, 0, 0], payload: {} }])).toEqual({
      ok: false,
      failure: { kind: 'unique', details: { fields: [] } },
    })
  })

  it('names a read-only handle as such, keeping the operation', () => {
    const engine = createCommitEngine(stubbedDatabase({ code: 'TDB_READ_ONLY' }), 4)
    expect(engine.commit([{ type: 'insert', vector: [0, 0, 0, 0], payload: {} }])).toEqual({
      ok: false,
      failure: { kind: 'read-only', operation: 'commitTransaction' },
    })
  })

  it('calls a closed handle closed', () => {
    const engine = createCommitEngine(stubbedDatabase({ code: 'TDB_DATABASE_CLOSED' }), 4)
    expect(engine.commit([{ type: 'insert', vector: [0, 0, 0, 0], payload: {} }])).toEqual({
      ok: false,
      failure: { kind: 'closed' },
    })
  })

  it('carries an unknown engine code and its write outcome', () => {
    const engine = createCommitEngine(
      stubbedDatabase({ code: 'TDB_QUERY_PARSE', write: { outcome: 'unknown' } }),
      4,
    )
    expect(engine.commit([{ type: 'insert', vector: [0, 0, 0, 0], payload: {} }])).toEqual({
      ok: false,
      failure: { kind: 'engine', code: 'TDB_QUERY_PARSE', outcome: 'unknown' },
    })
  })

  it('drops an outcome outside the closed set', () => {
    const engine = createCommitEngine(
      stubbedDatabase({ code: 'TDB_QUERY_PARSE', write: { outcome: 'maybe' } }),
      4,
    )
    expect(engine.commit([{ type: 'insert', vector: [0, 0, 0, 0], payload: {} }])).toEqual({
      ok: false,
      failure: { kind: 'engine', code: 'TDB_QUERY_PARSE', outcome: undefined },
    })
  })

  it('falls back to TDB_ERROR when the thrown value names no code', () => {
    const engine = createCommitEngine(stubbedDatabase(new Error('boom')), 4)
    expect(engine.commit([{ type: 'insert', vector: [0, 0, 0, 0], payload: {} }])).toEqual({
      ok: false,
      failure: { kind: 'engine', code: 'TDB_ERROR', outcome: undefined },
    })
  })

  it('falls back to TDB_ERROR when the engine throws a string', () => {
    const engine = createCommitEngine(stubbedDatabase('boom'), 4)
    expect(engine.commit([{ type: 'insert', vector: [0, 0, 0, 0], payload: {} }])).toEqual({
      ok: false,
      failure: { kind: 'engine', code: 'TDB_ERROR', outcome: undefined },
    })
  })
})

describe('commit engine: rewriting and closing', () => {
  it('reports a refusal from updatePayload with its own operation name', () => {
    const engine = createCommitEngine(stubbedDatabase({ code: 'TDB_READ_ONLY' }), 4)
    expect(engine.replacePayload(1, { active_slot: 3 })).toEqual({
      ok: false,
      failure: { kind: 'read-only', operation: 'updatePayload' },
    })
  })

  it('reports a refusal from close with its own operation name', () => {
    const engine = createCommitEngine(stubbedDatabase({ code: 'TDB_SHUTDOWN_FAILED' }), 4)
    expect(engine.close()).toEqual({ kind: 'closed' })
  })

  it('resolves undefined when the handle closes cleanly', () => {
    const database = { close: (): void => {} } as unknown as Database
    expect(createCommitEngine(database, 4).close()).toBeUndefined()
  })

  it('allocates the zero vector once, at its configured width', () => {
    const engine = createCommitEngine({} as Database, 4)
    expect(engine.zeroVector).toEqual([0, 0, 0, 0])
  })
})
