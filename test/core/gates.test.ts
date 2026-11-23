/**
 * AD-13 — the startup gate is a pure function, so every branch is testable
 * without a database, a snapshot, or a clock.
 * @module
 */
import { describe, expect, it } from 'vitest'
import { decideGates, type GateInput } from '../../src/core/gates.ts'

/** All four probes passing. */
const healthy: GateInput = {
  dbOpen: { ok: true },
  snapshot: { ok: true },
  dim: { ok: true, expected: 1024, actual: 1024 },
  contract: { ok: true, supported: 1, stored: null },
}

describe('gates: the first failure in order wins', () => {
  it('passes when all four probes pass', () => {
    expect(decideGates(healthy)).toEqual({ state: 'ok' })
  })

  it('reports the database before anything else', () => {
    const decision = decideGates({
      ...healthy,
      dbOpen: { ok: false, reason: 'corrupt file' },
      snapshot: { ok: false, reason: 'never reached' },
      dim: { ok: false, expected: 1024, actual: 512 },
    })
    expect(decision).toEqual({
      state: 'no-op',
      code: 'OMW_DB_OPEN',
      detail: { probe: 'db', reason: 'corrupt file' },
    })
  })

  it('reports the snapshot with the directory it tried', () => {
    const decision = decideGates({
      ...healthy,
      snapshot: { ok: false, reason: 'crc mismatch', snapshot: '/tmp/snap' },
      dim: { ok: false, expected: 1024, actual: 512 },
    })
    expect(decision).toEqual({
      state: 'no-op',
      code: 'OMW_SNAPSHOT_VERIFY',
      detail: { probe: 'snapshot', reason: 'crc mismatch', snapshot: '/tmp/snap' },
    })
  })

  it('reports the dimension with both widths', () => {
    const decision = decideGates({ ...healthy, dim: { ok: false, expected: 1024, actual: 512 } })
    expect(decision).toEqual({
      state: 'no-op',
      code: 'OMW_DIM_MISMATCH',
      detail: { probe: 'dim', key: 'db.dim', expected: 1024, actual: 512 },
    })
  })

  it('reports a contract version this build cannot read as an open failure', () => {
    const decision = decideGates({ ...healthy, contract: { ok: false, supported: 1, stored: 99 } })
    expect(decision).toEqual({
      state: 'no-op',
      code: 'OMW_DB_OPEN',
      detail: { probe: 'contract', supported: 1, stored: 99 },
    })
  })
})
