/**
 * The startup gate: four ordered probes in, one decision out (AD-13).
 *
 * Pure function; the probes themselves are supplied by `seams/runtime.ts`,
 * which owns IO. Keeping the decision pure is what makes "which check failed
 * first" a unit-testable fact instead of an emergent property of registration
 * order.
 * @module
 */
import type { DegradeDetail, OmwCode } from './degrade.ts'

/** Result of trying to open the database. */
export type DbOpenProbe = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/** Result of verifying today's snapshot. */
export type SnapshotProbe =
  | { readonly ok: true; readonly snapshot?: string }
  | { readonly ok: false; readonly reason: string; readonly snapshot?: string }

/** Result of comparing configured `db.dim` with the database's actual dimension. */
export interface DimProbe {
  readonly ok: boolean
  readonly expected: number
  readonly actual: number | null
}

/** Result of comparing the stored contract version with the supported one. */
export interface ContractProbe {
  readonly ok: boolean
  readonly supported: number
  readonly stored: number | null
}

/** Everything the gate looks at, in the order it looks at it. */
export interface GateInput {
  readonly dbOpen: DbOpenProbe
  readonly snapshot: SnapshotProbe
  readonly dim: DimProbe
  readonly contract: ContractProbe
}

/** The gate's verdict: either everything passed, or the first failure in order. */
export type GateDecision =
  | { readonly state: 'ok' }
  | { readonly state: 'no-op'; readonly code: OmwCode; readonly detail: DegradeDetail }

/**
 * Evaluate the four probes in their fixed order and report the first failure.
 *
 * Order is part of the contract: database, snapshot, dimension, contract
 * version. A later probe never masks an earlier one, so the reported code is
 * always the most root-cause-like of the failures present.
 * @param input - the four probe results.
 * @returns `{state:'ok'}`, or `{state:'no-op'}` with the first failing code.
 */
export function decideGates(input: GateInput): GateDecision {
  if (!input.dbOpen.ok) {
    return { state: 'no-op', code: 'OMW_DB_OPEN', detail: { probe: 'db', reason: input.dbOpen.reason } }
  }
  if (!input.snapshot.ok) {
    return {
      state: 'no-op',
      code: 'OMW_SNAPSHOT_VERIFY',
      detail: {
        probe: 'snapshot',
        reason: input.snapshot.reason,
        ...(input.snapshot.snapshot === undefined ? {} : { snapshot: input.snapshot.snapshot }),
      },
    }
  }
  if (!input.dim.ok) {
    return {
      state: 'no-op',
      code: 'OMW_DIM_MISMATCH',
      detail: { probe: 'dim', key: 'db.dim', expected: input.dim.expected, actual: input.dim.actual },
    }
  }
  if (!input.contract.ok) {
    // The closed eight have no dedicated contract code. A stored version this
    // build cannot read means the database is unusable by this code, so it is
    // reported as an open/acceptance failure; the detail names both sides.
    return {
      state: 'no-op',
      code: 'OMW_DB_OPEN',
      detail: { probe: 'contract', supported: input.contract.supported, stored: input.contract.stored },
    }
  }
  return { state: 'ok' }
}
