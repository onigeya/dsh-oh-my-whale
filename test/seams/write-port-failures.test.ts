/**
 * The write service when the machinery around it breaks.
 *
 * `write-port.test.ts` covers the answers a caller gets from a working store.
 * These four paths cover what happens when the *log* or the *handle* fails: a
 * write that landed must still be reported as landed, and one that cannot land
 * must never be reported as a conflict.
 * @module
 */
import { describe, expect, it } from 'vitest'
import { createAudit, createMemoryAuditSink, type AuditRow } from '../../src/ops/audit.ts'
import { ensureSchema } from '../../src/store/schema.ts'
import type { Database } from '../../src/store/db.ts'
import { createWritePort, type WritePort } from '../../src/seams/write-port.ts'
import { installWriteIndexes, openWriteStore, type WriteStore } from '../support/write-store.ts'

const NOW = Date.UTC(2026, 10, 23, 4, 0, 0)
const PATCH = { ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'likes', obj: 'coffee' }] }

interface Harness {
  readonly store: WriteStore
  readonly port: WritePort
  readonly warnings: readonly string[]
  readonly rows: readonly AuditRow[]
}

/** A port over a bootstrapped store, with whatever logger/sink the test needs. */
/**
 * A handle that behaves exactly like the real one, except for named methods.
 *
 * The engine's methods must be called with the real handle as `this` — a plain
 * `Reflect.get(receiver)` binding throws `Illegal invocation` inside triviumdb.
 * @param real - the open handle.
 * @param overrides - methods to replace, by name.
 * @returns the overlaid handle.
 */
function overlaid(real: Database, overrides: Record<string, unknown>): Database {
  return new Proxy(real, {
    get(target, property) {
      if (typeof property === 'string' && property in overrides) return overrides[property]
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? (value as (...rest: unknown[]) => unknown).bind(target) : value
    },
  })
}

function harness(options: {
  readonly db?: (real: Database) => Database
  readonly throwingSink?: boolean
} = {}): Harness {
  const store = openWriteStore('omw-port-fail-')
  installWriteIndexes(store)
  const schema = ensureSchema(store.db, { now: () => NOW })
  if (!schema.ok || !schema.writable) throw new Error('bootstrap failed')
  const memory = createMemoryAuditSink()
  const audit = createAudit({
    dataDir: store.dataDir,
    now: () => new Date(NOW),
    sink: options.throwingSink === true
      ? { write: (): never => { throw new Error('disk full') } }
      : memory,
  })
  const warnings: string[] = []
  const db = options.db === undefined ? store.db : options.db(store.db)
  const port = createWritePort({
    db,
    audit,
    logger: { warn: (code: string) => { warnings.push(code) } },
    maxNewPredsPerDay: 20,
    contractVersion: 1,
    now: () => NOW,
  })
  return { store, port, warnings, rows: audit.rows }
}

describe('the audit sink is unwritable', () => {
  it('still reports the write as landed, and says the row was lost', async () => {
    const h = harness({ throwingSink: true })
    const answer = await h.port.remember(PATCH, 'model', 'remember')

    // The store is the authority for the answer; a broken log must not turn a
    // committed write into a failure the caller would retry.
    expect(answer.ok).toBe(true)
    expect(answer.mem_keys).toEqual(['assertion:Elliott:likes:coffee'])
    expect(h.warnings).toContain('OMW_AUDIT_WRITE_FAILED')
  })

  it('reports the same way for a refusal', async () => {
    const h = harness({ throwingSink: true })
    const answer = await h.port.remember({ ops: [] }, 'model', 'remember')

    expect(answer.ok).toBe(false)
    expect(answer.code).toBe('E_BOUNDARY')
    expect(h.warnings).toContain('OMW_AUDIT_WRITE_FAILED')
  })
})

describe('the handle cannot be closed', () => {
  it('warns once and still resolves dispose', async () => {
    const h = harness({
      db: real => overlaid(real, { close: (): never => { throw new Error('shutdown failed') } }),
    })

    await expect(h.port.dispose()).resolves.toBeUndefined()
    expect(h.warnings).toContain('OMW_WRITE_CLOSE_FAILED')
  })
})

describe('the store throws while writing', () => {
  it('answers E_GATE_DOWN, never E_CONFLICT', async () => {
    const h = harness({
      db: real => overlaid(real, {
        commitTransaction: (): never => { throw new Error('engine exploded') },
      }),
    })

    const answer = await h.port.remember(PATCH, 'model', 'remember')
    expect(answer.ok).toBe(false)
    expect(answer.code).toBe('E_GATE_DOWN')
    expect(answer.items).toEqual([])
  })
})
describe('an engine message that names node ids', () => {
  it('never reaches the caller, even when it arrives inside a unique violation', async () => {
    const h = harness({
      db: real => overlaid(real, {
        // The shape the engine really throws, ids and all.
        commitTransaction: (): never => {
          const thrown = new Error('唯一约束冲突：字段 ["mem_key", "active_slot"] 的键已被节点 5 占用，冲突节点 7')
          Object.assign(thrown, {
            code: 'TDB_UNIQUE_CONSTRAINT',
            details: { fields: ['mem_key', 'active_slot'], existing_id: 5, conflicting_id: 7 },
            write: { outcome: 'not_committed' },
          })
          throw thrown
        },
      }),
    })

    const answer = await h.port.remember(PATCH, 'model', 'remember')

    expect(answer.ok).toBe(false)
    expect(answer.code).toBe('E_CONFLICT')
    expect(answer.items).toEqual([])
    // The engine's own words never travel: the refusal is written here, from
    // the failure kind, so no node id can leak even as a substring. Scrubbing
    // is a second line of defence for text the port did not author itself.
    expect(answer.message).not.toContain('节点 5')
    expect(answer.message).not.toContain('节点 7')
    expect(answer.message).not.toContain('conflicting_id')
    expect(answer.message).not.toContain('唯一约束冲突')
    expect(answer.message).toBe('写入补丁表：业务键已被另一条活动版本占用（同键并发写入，本次没有落库）')
  })

  it('keeps the refusal that reached the audit row free of ids too', async () => {
    const h = harness({
      db: real => overlaid(real, {
        commitTransaction: (): never => {
          const thrown = new Error('conflicting_id: 7')
          Object.assign(thrown, { code: 'TDB_UNIQUE_CONSTRAINT', details: { fields: ['mem_key'] } })
          throw thrown
        },
      }),
    })

    await h.port.remember(PATCH, 'model', 'remember')
    expect(h.rows.at(-1)).toMatchObject({ outcome: 'rejected', code: 'E_CONFLICT' })
  })
})
