/**
 * The database-side contract version (ADR-19) and its Epic 1 carrier.
 *
 * `triviumdb` 0.9.3 exposes no meta or contract field — `StorageInfo` carries
 * only format versions — so the contract version lives in an ordinary `flag`
 * node keyed `flag:contract_version`. Read and write happen only here.
 *
 * Reading is a bounded scan rather than an index lookup on purpose: creating a
 * property index would modify the database file, and `omw doctor` must leave
 * the store untouched. The dedicated index arrives with the first real query
 * path, in the epic that needs it.
 * @module
 */
import type { Database } from './db.ts'
import { allNodeIds, databaseDim, readPayload } from './db.ts'

/** The contract version this build understands. Higher in the file means "written by a newer plugin". */
export const SUPPORTED_CONTRACT_VERSION = 1

/** Business identity of the contract-version flag node. */
export const CONTRACT_VERSION_MEM_KEY = 'flag:contract_version'

/** Node kind of a flag. `flag` is a node, never an edge (AD-9, AD-21). */
export const FLAG_KIND = 'flag'

/** Payload stored in the contract-version flag node. */
export interface ContractVersionPayload {
  readonly kind: typeof FLAG_KIND
  readonly flag_type: 'contract_version'
  readonly mem_key: string
  readonly value: number
  /** ISO-8601 UTC instant with milliseconds. */
  readonly written_at: string
}

/** Result of reading the stored contract version. */
export type ReadContractVersion =
  | { readonly ok: true; readonly value: number | null; readonly nodeId: number | null }
  | { readonly ok: false; readonly reason: string }

/** Whether a payload is a contract-version flag. */
function isContractVersionPayload(payload: unknown): payload is ContractVersionPayload {
  if (typeof payload !== 'object' || payload === null) return false
  const candidate = payload as Record<string, unknown>
  return candidate['flag_type'] === 'contract_version' && typeof candidate['value'] === 'number'
}

/**
 * Read the contract version stored in the file.
 * @param db - an open handle.
 * @returns the stored value (`null` when the flag is absent), or a read failure.
 */
export function readContractVersion(db: Database): ReadContractVersion {
  try {
    for (const id of allNodeIds(db)) {
      const payload = readPayload(db, id)
      if (isContractVersionPayload(payload)) {
        return { ok: true, value: payload.value, nodeId: id }
      }
    }
    return { ok: true, value: null, nodeId: null }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Result of writing the contract version. */
export interface WriteContractVersion {
  readonly nodeId: number
  readonly created: boolean
}

/**
 * Write the contract version, creating the flag node on first use.
 * @param db - an open handle.
 * @param value - the version to record.
 * @param now - clock, injectable for deterministic tests.
 * @returns the node id and whether it was created.
 */
export function writeContractVersion(db: Database, value: number, now: () => Date = () => new Date()): WriteContractVersion {
  const existing = readContractVersion(db)
  if (!existing.ok) throw new Error(`cannot read contract version: ${existing.reason}`)
  const payload: ContractVersionPayload = {
    kind: FLAG_KIND,
    flag_type: 'contract_version',
    mem_key: CONTRACT_VERSION_MEM_KEY,
    value,
    written_at: now().toISOString(),
  }
  if (existing.nodeId !== null) {
    db.updatePayload(existing.nodeId, payload)
    return { nodeId: existing.nodeId, created: false }
  }
  // A flag carries no meaning in vector space; a zero vector keeps the node
  // addressable by id without claiming a semantic position.
  const zero = new Array<number>(databaseDim(db)).fill(0)
  return { nodeId: db.insert(zero, payload), created: true }
}

/**
 * Compare the stored contract version with the supported one (ADR-19).
 *
 * A newer file is a gate failure; an absent flag is a fresh database and is
 * accepted. An older file is read as-is: this epic performs no migration, so
 * `stored <= supported` is supported rather than queued for later.
 * @param stored - the value read from the file.
 * @returns whether the version is supported, plus both sides for the diagnostic.
 */
export function contractVersionSupported(stored: number | null): { ok: boolean; supported: number; stored: number | null } {
  if (stored === null) return { ok: true, supported: SUPPORTED_CONTRACT_VERSION, stored }
  return { ok: stored <= SUPPORTED_CONTRACT_VERSION, supported: SUPPORTED_CONTRACT_VERSION, stored }
}
