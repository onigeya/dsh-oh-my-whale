/**
 * Recall audit rows (Story 2.6, AD-20).
 *
 * The point of this file is the field that is not there: a recall row must never
 * carry the query. The row is written to a file that can leave the machine, and a
 * query is whatever the model typed. So the tests check the digest shape, that the
 * digest is not the query, and that two different queries get two different digests.
 * @module
 */
import { describe, expect, it } from 'vitest'
import { createAudit, createMemoryAuditSink } from '../../src/ops/audit.ts'
import { createRecallAuditor, queryHash } from '../../src/ops/recall-audit.ts'
import type { RecallEvent } from '../../src/seams/recall-reader.ts'
import { tempHome } from '../support/fake-ctx.ts'

const NOW = new Date(Date.UTC(2026, 10, 24, 4, 0, 0))

/** An event as the reader reports one. */
function event(overrides: Partial<RecallEvent> = {}): RecallEvent {
  return {
    query: 'whale watching',
    topK: 5,
    memKeys: ['assertion:Elliott:likes:whale watching'],
    elapsedMs: 3,
    degraded: false,
    degradedReason: [],
    ...overrides,
  }
}

/** Build an auditor over a fresh memory sink. */
function harness() {
  const home = tempHome('omw-recall-audit-')
  const sink = createMemoryAuditSink()
  const audit = createAudit({ dataDir: home.dir, now: () => NOW, sink })
  const auditor = createRecallAuditor({ audit, now: () => NOW })
  return { home, sink, audit, auditor }
}

describe('recall audit: the row it writes', () => {
  it('carries the closed vocabulary and the numbers of the call that ran', () => {
    const { home, audit, auditor } = harness()
    try {
      const row = auditor.record(event({ topK: 8, elapsedMs: 12, degraded: true, degradedReason: ['vec_unavailable'] }))
      expect(row.kind).toBe('recall')
      expect(row.ts).toBe(NOW.toISOString())
      expect(row.top_k).toBe(8)
      expect(row.elapsed_ms).toBe(12)
      expect(row.degraded).toBe(true)
      expect(row.degraded_reason).toEqual(['vec_unavailable'])
      expect(row.hits).toEqual(['assertion:Elliott:likes:whale watching'])
      expect(audit.rows).toHaveLength(1)
    } finally {
      home.remove()
    }
  })

  it('names the session the call came from, because a recall is how a session reads', () => {
    const { home, auditor } = harness()
    try {
      const row = auditor.record(event({ sessionId: 'session-alpha' }))
      expect(row.session_id).toBe('session-alpha')
    } finally {
      home.remove()
    }
  })

  it('writes an empty session rather than inventing one when the host gave none', () => {
    const { home, auditor } = harness()
    try {
      const row = auditor.record(event())
      expect(row.session_id).toBe('')
    } finally {
      home.remove()
    }
  })

  it('records an empty hit list as an empty list, not as a missing field', () => {
    const { home, auditor } = harness()
    try {
      const row = auditor.record(event({ memKeys: [] }))
      expect(row.hits).toEqual([])
    } finally {
      home.remove()
    }
  })
})

describe('recall audit: the query never lands', () => {
  it('writes a 16-character digest and no query text', () => {
    const { home, sink, auditor } = harness()
    try {
      const query = '13812345678'
      const row = auditor.record(event({ query }))
      expect(row.query_hash).toBe(queryHash(query))
      expect(row.query_hash).toHaveLength(16)
      const line = sink.writes[0]?.line ?? ''
      expect(line).not.toContain(query)
      expect(JSON.parse(line)).not.toHaveProperty('query')
    } finally {
      home.remove()
    }
  })

  it('tells two different queries apart and matches a repeat', () => {
    const { home, auditor } = harness()
    try {
      const one = auditor.record(event({ query: 'whale' }))
      const two = auditor.record(event({ query: 'dolphin' }))
      const again = auditor.record(event({ query: 'whale' }))
      expect(one.query_hash).not.toBe(two.query_hash)
      expect(one.query_hash).toBe(again.query_hash)
    } finally {
      home.remove()
    }
  })
})

describe('recall audit: the facade still guards the row', () => {
  it('refuses a degraded reason outside the closed set, and writes nothing', () => {
    const { home, audit, sink, auditor } = harness()
    try {
      expect(() => auditor.record(event({ degraded: true, degradedReason: ['invented' as never] }))).toThrow(/closed set/u)
      expect(audit.rows).toEqual([])
      expect(sink.writes).toEqual([])
    } finally {
      home.remove()
    }
  })
})