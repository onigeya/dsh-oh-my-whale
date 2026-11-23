/**
 * The audit facade's closed vocabularies.
 *
 * An audit row is evidence that leaves the machine, so a row naming an outcome
 * or a degraded reason this build does not define is refused at append time
 * rather than written and read back by something that cannot interpret it.
 * `test/degrade/vector-off.test.ts` pins the recall side; this file pins the
 * write side, which Story 2.1 adds.
 * @module
 */
import { describe, expect, it } from 'vitest'
import {
  assertClosedOutcome,
  assertClosedReasons,
  createAudit,
  createMemoryAuditSink,
  WRITE_OUTCOMES,
  type AuditRow,
  type WriteAuditRow,
} from '../../src/ops/audit.ts'
import { tempHome } from '../support/fake-ctx.ts'

const NOW = new Date(Date.UTC(2026, 10, 23, 4, 0, 0))

function row(overrides: Partial<WriteAuditRow> = {}): WriteAuditRow {
  return {
    kind: 'write',
    ts: NOW.toISOString(),
    outcome: 'committed',
    code: 'OK',
    mem_keys: ['assertion:Elliott:likes:coffee'],
    elapsed_ms: 1,
    ...overrides,
  }
}

describe('audit: the write outcome vocabulary', () => {
  it('is the four outcomes Story 2.1 writes', () => {
    expect([...WRITE_OUTCOMES]).toEqual(['committed', 'rejected', 'downgraded', 'bootstrap'])
  })

  it('accepts every outcome in the closed set', () => {
    for (const outcome of WRITE_OUTCOMES) {
      expect(() => assertClosedOutcome(row({ outcome }))).not.toThrow()
    }
  })

  it('refuses an outcome it does not define, and names the closed set', () => {
    expect(() => assertClosedOutcome(row({ outcome: 'partial' as never })))
      .toThrow(/unknown write outcome "partial"; closed set is committed, rejected, downgraded, bootstrap/u)
  })
})

describe('audit: appending a write row', () => {
  it('refuses an unknown outcome before it reaches the sink', () => {
    const home = tempHome('omw-audit-')
    try {
      const sink = createMemoryAuditSink()
      const audit = createAudit({ dataDir: home.dir, now: () => NOW, sink })
      expect(() => audit.append(row({ outcome: 'lost' as never }))).toThrow(/closed set/u)
      // Nothing landed: a refused row is not retained and not written.
      expect(audit.rows).toEqual([])
      expect(sink.writes).toEqual([])
    } finally {
      home.remove()
    }
  })

  it('writes one JSON line per accepted row and keeps it in memory', () => {
    const home = tempHome('omw-audit-')
    try {
      const sink = createMemoryAuditSink()
      const audit = createAudit({ dataDir: home.dir, now: () => NOW, sink })
      const appended = audit.append(row())
      expect(appended.file.endsWith('audit-20261123.jsonl')).toBe(true)
      expect(audit.rows).toHaveLength(1)
      expect(sink.writes).toHaveLength(1)
      expect(JSON.parse(sink.writes[0]?.line ?? '')).toMatchObject({
        kind: 'write',
        outcome: 'committed',
        code: 'OK',
        mem_keys: ['assertion:Elliott:likes:coffee'],
      })
    } finally {
      home.remove()
    }
  })

  it('still checks the recall vocabulary on a recall row', () => {
    const home = tempHome('omw-audit-')
    try {
      const sink = createMemoryAuditSink()
      const audit = createAudit({ dataDir: home.dir, now: () => NOW, sink })
      const recall: AuditRow = {
        kind: 'recall',
        ts: NOW.toISOString(),
        query_hash: 'abc',
        topK: 5,
        hits: [],
        elapsed_ms: 2,
        degraded: true,
        degraded_reason: ['something_else' as never],
      }
      expect(() => audit.append(recall)).toThrow(/closed set/u)
      expect(() => assertClosedReasons({ ...recall, degraded_reason: ['vec_unavailable'] })).not.toThrow()
    } finally {
      home.remove()
    }
  })
})
