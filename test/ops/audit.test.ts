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
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertClosedOutcome,
  assertClosedReasons,
  assertClosedTier,
  AUDIT_ROWS_RETAINED,
  createAppendAuditSink,
  createAudit,
  createMemoryAuditSink,
  INJECTION_TIERS,
  isFlushableSink,
  WRITE_OUTCOMES,
  type AuditRow,
  type InjectionAuditRow,
  type WriteAuditRow,
} from '../../src/ops/audit.ts'
import { readJsonLines, tempHome } from '../support/fake-ctx.ts'

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
        session_id: 'session-1',
        query_hash: 'abc',
        top_k: 5,
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

/** A minimal injection row. */
function injection(overrides: Partial<InjectionAuditRow> = {}): InjectionAuditRow {
  return {
    kind: 'injection',
    ts: NOW.toISOString(),
    session_id: 'session-alpha',
    tier: 'identity',
    chars: 19,
    tokens: 4,
    items: ['identity'],
    truncated: false,
    prefix_unchanged: false,
    elapsed_ms: 1,
    host_cache_read: null,
    host_cache_write: null,
    host_cache_uncached: null,
    ...overrides,
  }
}

describe('audit: the injection tier vocabulary', () => {
  it('names the four shapes an injection can take, one per combination of tail and recall', () => {
    expect([...INJECTION_TIERS]).toEqual([
      'identity',
      'identity+state',
      'identity+recall',
      'identity+state+recall',
    ])
  })

  it('accepts every tier and refuses anything else before it reaches the sink', () => {
    for (const tier of INJECTION_TIERS) {
      expect(() => assertClosedTier(injection({ tier }))).not.toThrow()
    }
    expect(() => assertClosedTier(injection({ tier: 'identity+everything' as never })))
      .toThrow(/unknown injection tier "identity\+everything"; closed set is identity, identity\+state, identity\+recall, identity\+state\+recall/u)
    const home = tempHome('omw-audit-')
    try {
      const sink = createMemoryAuditSink()
      const audit = createAudit({ dataDir: home.dir, now: () => NOW, sink })
      expect(() => audit.append(injection({ tier: 'everything' as never }))).toThrow(/closed set/u)
      expect(audit.rows).toEqual([])
      expect(sink.writes).toEqual([])
    } finally {
      home.remove()
    }
  })

  it('writes a null cache column rather than a zero, since the host may not have said', () => {
    const home = tempHome('omw-audit-')
    try {
      const sink = createMemoryAuditSink()
      const audit = createAudit({ dataDir: home.dir, now: () => NOW, sink })
      audit.append(injection())
      const written = JSON.parse(sink.writes[0]?.line ?? '') as Record<string, unknown>
      expect(written['host_cache_read']).toBeNull()
      expect(written['host_cache_uncached']).toBeNull()
    } finally {
      home.remove()
    }
  })
})

describe('audit: the file sink', () => {
  it('writes every queued row to the day file once flushed', async () => {
    const home = tempHome('omw-audit-')
    try {
      const audit = createAudit({ dataDir: home.dir, now: () => NOW, sink: createAppendAuditSink() })
      audit.append(row())
      audit.append(injection())
      await audit.flush()
      const lines = readJsonLines(audit.path(NOW))
      expect(lines).toHaveLength(2)
      expect(lines[0]?.['kind']).toBe('write')
      expect(lines[1]?.['kind']).toBe('injection')
    } finally {
      home.remove()
    }
  })

  it('creates the data directory it was pointed at', async () => {
    const home = tempHome('omw-audit-')
    try {
      const nested = join(home.dir, 'missing', 'deeper')
      const audit = createAudit({ dataDir: nested, now: () => NOW, sink: createAppendAuditSink() })
      audit.append(row())
      await audit.flush()
      expect(readJsonLines(audit.path(NOW))).toHaveLength(1)
    } finally {
      home.remove()
    }
  })

  it('holds a write failure until flush, so the injection path never waits on it', async () => {
    const home = tempHome('omw-audit-')
    try {
      // A file where the day directory should be: every append fails.
      const blocked = join(home.dir, 'blocked')
      writeFileSync(blocked, 'not a directory', 'utf8')
      const audit = createAudit({ dataDir: blocked, now: () => NOW, sink: createAppendAuditSink() })
      expect(() => audit.append(row())).not.toThrow()
      await expect(audit.flush()).rejects.toThrow()
      // The queue keeps draining, so the next append is still attempted and the
      // failure is reported once rather than poisoning the sink forever.
      audit.append(row())
      await expect(audit.flush()).rejects.toThrow()
    } finally {
      home.remove()
    }
  })
})
describe('audit: the in-memory row list stays bounded', () => {
  it('keeps the newest rows once the cap is passed, so a long-lived process cannot grow forever', () => {
    const home = tempHome('omw-audit-')
    try {
      const audit = createAudit({ dataDir: home.dir, now: () => NOW, sink: createMemoryAuditSink() })
      const over = AUDIT_ROWS_RETAINED + 5
      for (let index = 0; index < over; index += 1) {
        audit.append(row({ mem_keys: [`assertion:Elliott:likes:coffee${index}`] }))
      }
      const retained = audit.rows
      expect(retained).toHaveLength(AUDIT_ROWS_RETAINED)
      // The cap drops from the front, so what survives is the most recent
      // window: the oldest rows are the ones missing, not the newest.
      const first = retained[0]
      const last = retained[retained.length - 1]
      expect(first?.kind === 'write' ? first.mem_keys[0] : undefined)
        .toBe(`assertion:Elliott:likes:coffee${over - AUDIT_ROWS_RETAINED}`)
      expect(last?.kind === 'write' ? last.mem_keys[0] : undefined)
        .toBe(`assertion:Elliott:likes:coffee${over - 1}`)
    } finally {
      home.remove()
    }
  })

  it('hands out a snapshot, so a caller cannot rewrite the rows it reads', () => {
    const home = tempHome('omw-audit-')
    try {
      const audit = createAudit({ dataDir: home.dir, now: () => NOW, sink: createMemoryAuditSink() })
      audit.append(row())
      const leaked = audit.rows as AuditRow[]
      leaked.push(injection())
      expect(audit.rows).toHaveLength(1)
    } finally {
      home.remove()
    }
  })
})

describe('audit: a sink with nothing to drain', () => {
  it('recognises the memory sink as one that never needs a flush', () => {
    expect(isFlushableSink(createMemoryAuditSink())).toBe(false)
  })

  it('drains an empty queue without reporting a failure', async () => {
    const sink = createAppendAuditSink()
    expect(isFlushableSink(sink)).toBe(true)
    // Dispose flushes unconditionally, so a mount that wrote nothing must see
    // a resolved promise rather than a rejection it would have to special-case.
    await expect(sink.flush()).resolves.toBeUndefined()
  })
})
