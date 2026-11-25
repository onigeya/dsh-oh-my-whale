/**
 * The ledger's two shapes: what is stored and what a reader is told.
 *
 * A stored decision carries `kind: 'decision'` so a kind scan finds it and
 * `decision_kind` for the action; Story 2.3's AC asks for `kind` to name the
 * action, so `decisionView` is the single place that translation happens. These
 * tests pin the projection, not the storage.
 * @module
 */
import { describe, expect, it } from 'vitest'
import {
  buildDecisionPayload,
  decisionMemKey,
  decisionView,
  operationId,
  patchDigest,
  rejectedMemKey,
  RANDOM_LENGTH,
  randomToken,
} from '../../src/core/decisions.ts'

/** A fixed instant every payload in this file is written at. */
const NOW = Date.UTC(2026, 10, 23, 4, 0, 0)
const NOW_ISO = new Date(NOW).toISOString()

/** One decision payload, with the two fields most tests vary. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return buildDecisionPayload({
    ts: NOW_ISO,
    actor: 'user',
    decisionKind: 'insert',
    opId: operationId(NOW, 0, () => 'abcdef'),
    affected: ['assertion:Elliott:likes:coffee'],
    targetMemKey: 'assertion:Elliott:likes:coffee',
    reason: '用户说喜欢咖啡',
    contractVersion: 1,
    index: 0,
    ...overrides,
  }).payload
}

describe('decisions: the stored shape', () => {
  it('keeps the node kind a scan needs and puts the action beside it', () => {
    const stored = payload({ decisionKind: 'supersede' })
    // AF-1: a kind scan for decisions has to find every entry, so the action
    // cannot live in `kind`.
    expect(stored['kind']).toBe('decision')
    expect(stored['decision_kind']).toBe('supersede')
    expect(stored['active_slot']).toBe(1)
    expect(stored['valid_from']).toBe(NOW_ISO)
    expect(stored['recorded_at']).toBe(NOW_ISO)
  })

  it('omits from, to and precedent_id rather than writing undefined', () => {
    const stored = payload()
    // The engine refuses a payload that holds undefined, so an absent optional
    // field has to be absent, not present-and-empty.
    expect(stored).not.toHaveProperty('from')
    expect(stored).not.toHaveProperty('to')
    expect(stored).not.toHaveProperty('precedent_id')
    expect(stored).toHaveProperty('mem_key')
  })

  it('writes from, to and precedent_id when they are given', () => {
    const stored = payload({
      decisionKind: 'supersede',
      from: { kind: 'assertion', value: '杭州' },
      to: { kind: 'assertion', value: '上海' },
      precedentId: 'op:0:abcdef',
    })
    expect(stored['from']).toEqual({ kind: 'assertion', value: '杭州' })
    expect(stored['to']).toEqual({ kind: 'assertion', value: '上海' })
    expect(stored['precedent_id']).toBe('op:0:abcdef')
  })
})

describe('decisions: the projection a reader sees', () => {
  it('gives the action back its name as kind', () => {
    const view = decisionView(payload({ decisionKind: 'rewrite' as never }))
    expect(view).toBeDefined()
    // The stored value is whatever was written; the projection reports it as
    // `kind` so a caller's ten keys match AC3 exactly.
    expect(view?.kind).toBe('rewrite')
    expect(view).not.toHaveProperty('decision_kind')
  })

  it('reports the eight required keys AC3 names, and adds no optional one on its own', () => {
    const view = decisionView(payload())!
    expect(Object.keys(view).sort()).toEqual([
      'actor', 'affected', 'contract_version', 'kind', 'op_id', 'reason', 'target_mem_key', 'ts',
    ])
    // from / to / precedent_id are optional; with none given, they stay absent.
    expect(view.ts).toBe(NOW_ISO)
    expect(view.actor).toBe('user')
    expect(view.op_id).toBe(operationId(NOW, 0, () => 'abcdef'))
    expect(view.contract_version).toBe(1)
    expect(view.affected).toEqual(['assertion:Elliott:likes:coffee'])
  })

  it('carries from, to and precedent_id when the write recorded them', () => {
    const view = decisionView(payload({
      decisionKind: 'supersede',
      from: { value: '杭州' },
      to: { value: '上海' },
      precedentId: 'op:0:abcdef',
    }))!
    expect(view.from).toEqual({ value: '杭州' })
    expect(view.to).toEqual({ value: '上海' })
    expect(view.precedent_id).toBe('op:0:abcdef')
  })

  it('refuses to project a node that is not a decision', () => {
    expect(decisionView({ kind: 'assertion', mem_key: 'x' })).toBeUndefined()
    expect(decisionView({})).toBeUndefined()
  })

  it('drops one bad field instead of losing the whole entry', () => {
    // A corrupt required field is a reason to say nothing about this entry: a
    // half-read view would report a reason that was never written.
    for (const field of ['ts', 'actor', 'decision_kind', 'op_id', 'target_mem_key', 'reason']) {
      const stored = payload()
      delete stored[field]
      expect(decisionView(stored), field).toBeUndefined()
    }
    const wrongVersion = payload()
    wrongVersion['contract_version'] = '1'
    expect(decisionView(wrongVersion)).toBeUndefined()
  })

  it('salvages a malformed affected list as an empty one', () => {
    const notAnArray = payload()
    notAnArray['affected'] = 'assertion:Elliott:likes:coffee'
    expect(decisionView(notAnArray)?.affected).toEqual([])

    const mixed = payload()
    mixed['affected'] = ['a', 7, null, 'b']
    expect(decisionView(mixed)?.affected).toEqual(['a', 'b'])
  })
})

describe('decisions: the keys the ledger writes', () => {
  it('keeps two ops of one table apart', () => {
    // A table shares one millisecond, so the index is what stops the second
    // op from colliding with the first on the unique index.
    expect(decisionMemKey(NOW, 0, () => 'abcdef')).not.toBe(decisionMemKey(NOW, 1, () => 'abcdef'))
    expect(decisionMemKey(NOW, 0, () => 'abcdef')).toBe(`decision:${NOW}:0:abcdef`)
  })

  it('pads a short random token to the documented length', () => {
    expect(randomToken(() => 'ab')).toHaveLength(RANDOM_LENGTH)
    expect(randomToken(() => 'abcdefghij')).toHaveLength(RANDOM_LENGTH)
  })

  it('separates two rejections in one millisecond by their table', () => {
    const first = patchDigest({ ops: [{ op: 'assert' }] })
    const second = patchDigest({ ops: [{ op: 'assert', obj: 'coffee' }] })
    expect(first).not.toBe(second)
    expect(first).toHaveLength(16)
    expect(rejectedMemKey(NOW, first, 1)).toBe(`rejected:${NOW}:${first}:1`)
  })

  it('digests a table that cannot be serialised instead of throwing', () => {
    const cyclic: Record<string, unknown> = { op: 'assert' }
    cyclic['self'] = cyclic
    expect(() => patchDigest(cyclic)).not.toThrow()
    expect(patchDigest(cyclic)).toHaveLength(16)
  })
})