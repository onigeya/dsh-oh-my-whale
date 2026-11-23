/**
 * Test support: an in-memory stand-in for the live store the planner reads.
 *
 * `planPatchTable` takes its reads as functions, so a planning test never needs a
 * database. This module keeps those functions honest: the same maps back the
 * live lookup and the version lookup, which is what the retirement slot needs.
 * @module
 */
import type { PatchContext, PlanOk, PlanResult } from '../../src/core/patch.ts'
import { parsePatchTable, planPatchTable } from '../../src/core/patch.ts'
import { buildPredicatePayload, NORM_VERSION, predicateMemKey } from '../../src/store/tbox.ts'
import type { StoredNode } from '../../src/store/templates/assertions.ts'

/** The two lookups a plan needs, plus the payloads they answer with. */
export interface FakeStore {
  readonly live: Map<string, StoredNode>
  readonly versions: Map<string, StoredNode[]>
  readonly payloads: Map<number, Record<string, unknown>>
  nextId(): number
}

/**
 * Create an empty store whose ids start at 1.
 * @returns the store.
 */
export function fakeStore(): FakeStore {
  let id = 0
  const payloads = new Map<number, Record<string, unknown>>()
  return {
    live: new Map<string, StoredNode>(),
    versions: new Map<string, StoredNode[]>(),
    payloads,
    nextId: (): number => {
      id += 1
      return id
    },
  }
}

/**
 * Register one live predicate entry, as a bootstrap would have written it.
 * @param store - the store to write into.
 * @param name - the predicate name.
 * @param cardinality - its cardinality.
 * @param extras - payload fields to override, such as a candidate status.
 * @returns the node that was written.
 */
export function seedPredicate(
  store: FakeStore,
  name: string,
  cardinality: 'single' | 'multi',
  extras: { readonly status?: 'active' | 'candidate'; readonly aliases?: readonly string[]; readonly evidenceCount?: number } = {},
): StoredNode {
  const nowIso = new Date(Date.UTC(2026, 10, 23, 4, 0, 0)).toISOString()
  const payload = buildPredicatePayload({
    name,
    cardinality,
    status: extras.status ?? 'active',
    aliases: extras.aliases ?? [],
    decidedBy: 'seed',
    decidedAt: nowIso,
    evidenceCount: extras.evidenceCount ?? 0,
    normVersion: NORM_VERSION,
    activeSlot: 1,
    recordedAt: nowIso,
    validFrom: nowIso,
  })
  const node: StoredNode = { id: store.nextId(), payload }
  store.live.set(predicateMemKey(name), node)
  store.versions.set(predicateMemKey(name), [node])
  store.payloads.set(node.id, payload)
  return node
}

/**
 * Register one live assertion, as an earlier write would have left it.
 * @param store - the store to write into.
 * @param memKey - the business key.
 * @param payload - the payload it carries.
 * @returns the node that was written.
 */
export function seedNode(
  store: FakeStore,
  memKey: string,
  payload: Record<string, unknown>,
): StoredNode {
  const node: StoredNode = { id: store.nextId(), payload: { mem_key: memKey, ...payload } }
  store.live.set(memKey, node)
  store.versions.set(memKey, [...(store.versions.get(memKey) ?? []), node])
  store.payloads.set(node.id, node.payload)
  return node
}

/**
 * Record a retired version of one key, so the retirement slot sees it.
 * @param store - the store to write into.
 * @param memKey - the business key.
 * @param slot - the `active_slot` that version spent.
 * @returns the node that was recorded.
 */
export function seedRetiredVersion(store: FakeStore, memKey: string, slot: number): StoredNode {
  const node: StoredNode = { id: store.nextId(), payload: { mem_key: memKey, active_slot: slot } }
  store.versions.set(memKey, [...(store.versions.get(memKey) ?? []), node])
  return node
}

/** The instant every planning test plans against. */
export const PLAN_NOW = Date.UTC(2026, 10, 23, 4, 0, 0)

/**
 * Build a planning context over a fake store.
 * @param store - the store the lookups read.
 * @param overrides - caller, clock and limits to change.
 * @returns the context.
 */
export function fakeContext(
  store: FakeStore,
  overrides: Partial<Omit<PatchContext, 'lookupLive' | 'lookupVersions'>> = {},
): PatchContext {
  return {
    caller: 'model',
    nowMs: PLAN_NOW,
    maxNewPredsPerDay: 20,
    contractVersion: 1,
    newPredsToday: 0,
    ...overrides,
    lookupLive: memKey => store.live.get(memKey),
    lookupVersions: memKey => store.versions.get(memKey) ?? [],
  }
}

/**
 * Parse and plan one table against one context.
 * @param raw - the patch table as a caller would send it.
 * @param context - what the plan reads.
 * @returns the plan.
 */
export function planOf(raw: unknown, context: PatchContext): PlanResult {
  const parsed = parsePatchTable(raw)
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.field}: ${parsed.reason}`)
  return planPatchTable(parsed.table, context)
}

/**
 * Assert a plan succeeded and return it.
 * @param result - the plan.
 * @returns the successful plan.
 */
export function expectOk(result: PlanResult): PlanOk {
  if (!result.ok) throw new Error(`expected an ok plan, got ${result.code}: ${result.field}: ${result.reason}`)
  return result
}