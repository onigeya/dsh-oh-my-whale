/**
 * Evidence as the two surfaces above the store see it: `remember` and `/omw evidence`.
 *
 * The write cases drive the same `createWritePort` the remember tool drives, with
 * a stand-in for the host's session log, so what is pinned is what a caller gets
 * and what the store ends up holding. The read cases drive the reader and the
 * command exactly as the chat does.
 * @module
 */
import { describe, expect, it } from 'vitest'
import { createAudit, createMemoryAuditSink, type AuditRow } from '../../src/ops/audit.ts'
import { ensureSchema } from '../../src/store/schema.ts'
import { createAssertionTemplates } from '../../src/store/templates/assertions.ts'
import { createEvidenceTemplates } from '../../src/store/templates/evidence.ts'
import { evidenceMemKey, QUOTE_MAX_CODE_POINTS } from '../../src/core/evidence.ts'
import { createWritePort, type WritePort } from '../../src/seams/write-port.ts'
import { createReadGateway } from '../../src/store/commits/reads.ts'
import { createEvidenceReader } from '../../src/seams/evidence-reader.ts'
import { createQuoteSource, type QuoteSource } from '../../src/seams/evidence-source.ts'
import {
  parseEvidenceKey,
  registerOmwCommands,
  type CommandDefinitionLike,
  type CommandRegistryLike,
} from '../../src/seams/commands.ts'
import { openWriteStore, type WriteStore } from '../support/write-store.ts'

const NOW = Date.UTC(2026, 10, 24, 3, 0, 0)
const SESSION = 'session-alpha'
const PHONE = '13812345678'

/** Text a fake host serves for one seq, plus a record of what was asked for. */
function sourceOf(events: Record<number, unknown>): { readonly source: QuoteSource; readonly reads: { sessionId: string; seq: number }[] } {
  const reads: { sessionId: string; seq: number }[] = []
  return {
    reads,
    source: {
      async readQuote(request) {
        reads.push({ sessionId: request.sessionId, seq: request.seq })
        return events[request.seq]
      },
    },
  }
}

/** The shape the host serves for a user message. */
function messageEvent(...blocks: readonly unknown[]): unknown {
  return { data: { content: blocks } }
}

interface Harness {
  readonly store: WriteStore
  readonly port: WritePort
  readonly rows: () => readonly AuditRow[]
  readonly warnings: readonly string[]
}

function harness(readQuote?: QuoteSource, options: { maxNewPredsPerDay?: number } = {}): Harness {
  const store = openWriteStore('omw-evp-')
  const schema = ensureSchema(store.db, { now: () => NOW })
  if (!schema.ok || !schema.writable) throw new Error('bootstrap failed')
  const sink = createMemoryAuditSink()
  const audit = createAudit({ dataDir: store.dataDir, now: () => new Date(NOW), sink })
  const warnings: string[] = []
  const port = createWritePort({
    db: store.db,
    audit,
    logger: { warn: (code: string) => { warnings.push(code) } },
    maxNewPredsPerDay: options.maxNewPredsPerDay ?? 20,
    contractVersion: 1,
    now: () => NOW,
    ...(readQuote === undefined ? {} : { readQuote }),
  })
  return { store, port, rows: () => audit.rows, warnings }
}

function assertOp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'likes', obj: 'coffee', ...overrides }
}

describe('writing one fact with a declared source', () => {
  it('stores the pointer, the edge and the quote in one commit', async () => {
    const { source } = sourceOf({ 5: messageEvent({ type: 'text', text: '我喜欢喝咖啡，尤其是浅烘。' }) })
    const h = harness(source)
    const before = h.store.db.nodeCount()
    const answer = await h.port.remember({ ops: [assertOp({ evidence: { seq_from: 5, seq_to: 5 } })] }, 'model', 'remember', SESSION)

    expect(answer.ok).toBe(true)
    expect(answer.mem_keys).toEqual(['assertion:Elliott:likes:coffee'])
    // assertion, decision, pointer
    expect(h.store.db.nodeCount()).toBe(before + 3)

    const pointer = createEvidenceTemplates(h.store.db).findByKey(evidenceMemKey(SESSION, 5, 5))
    expect(pointer?.payload).toEqual({
      kind: 'evidence',
      mem_key: evidenceMemKey(SESSION, 5, 5),
      session_id: SESSION,
      seq_from: 5,
      seq_to: 5,
      quote: '我喜欢喝咖啡，尤其是浅烘。',
      quote_truncated: false,
      deidentified: false,
    })
    const assertion = createAssertionTemplates(h.store.db).findLiveByKey('assertion:Elliott:likes:coffee')!
    expect(h.store.db.getIncomingEdges(assertion.id, 'supports')).toHaveLength(1)
  })

  it('masks a phone number before it stores the quote', async () => {
    const { source } = sourceOf({ 6: messageEvent({ type: 'text', text: `我的手机号是 ${PHONE}，短信联系。` }) })
    const h = harness(source)
    await h.port.remember({ ops: [assertOp({ evidence: { seq_from: 6, seq_to: 6 } })] }, 'model', 'remember', SESSION)
    const pointer = createEvidenceTemplates(h.store.db).findByKey(evidenceMemKey(SESSION, 6, 6))
    expect(pointer?.payload['quote']).toBe('我的手机号是 [手机号]，短信联系。')
    expect(pointer?.payload['deidentified']).toBe(true)
    expect(JSON.stringify(pointer?.payload)).not.toContain(PHONE)
  })

  it('cuts a long message to the budget and marks it truncated', async () => {
    const long = 'x'.repeat(QUOTE_MAX_CODE_POINTS + 50)
    const { source } = sourceOf({ 7: messageEvent({ type: 'text', text: long }) })
    const h = harness(source)
    await h.port.remember({ ops: [assertOp({ evidence: { seq_from: 7, seq_to: 7 } })] }, 'model', 'remember', SESSION)
    const pointer = createEvidenceTemplates(h.store.db).findByKey(evidenceMemKey(SESSION, 7, 7))
    expect([...(pointer?.payload['quote'] as string)]).toHaveLength(QUOTE_MAX_CODE_POINTS)
    expect(pointer?.payload['quote_truncated']).toBe(true)
  })

  it('ignores a reasoning block and stores an empty quote instead of it', async () => {
    const { source } = sourceOf({ 8: messageEvent({ type: 'reasoning', text: '思考过程绝不入库' }) })
    const h = harness(source)
    const answer = await h.port.remember({ ops: [assertOp({ evidence: { seq_from: 8, seq_to: 8 } })] }, 'model', 'remember', SESSION)
    expect(answer.ok).toBe(true)
    const pointer = createEvidenceTemplates(h.store.db).findByKey(evidenceMemKey(SESSION, 8, 8))
    expect(pointer?.payload['quote']).toBe('')
    expect(pointer?.payload['deidentified']).toBe(false)
    expect(h.warnings).toContain('OMW_EVIDENCE_UNREADABLE')
  })
})

describe('writing when the host cannot serve the source', () => {
  it('still writes the fact, with an empty quote and no invented text', async () => {
    const h = harness(undefined)
    const answer = await h.port.remember({ ops: [assertOp({ evidence: { seq_from: 9, seq_to: 9 } })] }, 'model', 'remember', SESSION)
    expect(answer.ok).toBe(true)
    expect(answer.code).toBe('OK')
    const pointer = createEvidenceTemplates(h.store.db).findByKey(evidenceMemKey(SESSION, 9, 9))
    expect(pointer?.payload['quote']).toBe('')
    expect(pointer?.payload['quote_truncated']).toBe(false)
    expect(pointer?.payload['deidentified']).toBe(false)
    expect(h.warnings).toContain('OMW_EVIDENCE_UNREADABLE')
  })

  it('treats a failing host read the same way, and keeps the write', async () => {
    const adapted = createQuoteSource({
      readEvent: async () => {
        throw new Error('host went away')
      },
    })
    const h = harness(adapted)
    const answer = await h.port.remember({ ops: [assertOp({ evidence: { seq_from: 10, seq_to: 10 } })] }, 'model', 'remember', SESSION)
    expect(answer.ok).toBe(true)
    const pointer = createEvidenceTemplates(h.store.db).findByKey(evidenceMemKey(SESSION, 10, 10))
    expect(pointer?.payload['quote']).toBe('')
    expect(h.warnings).toContain('OMW_EVIDENCE_UNREADABLE')
  })

  it('writes no pointer at all when this start knows no session', async () => {
    const h = harness(undefined)
    const answer = await h.port.remember({ ops: [assertOp({ evidence: { seq_from: 11, seq_to: 11 } })] }, 'model', 'remember')
    expect(answer.ok).toBe(true)
    expect(createEvidenceTemplates(h.store.db).findByKey(evidenceMemKey(SESSION, 11, 11))).toBeUndefined()
  })
})

describe('reusing one pointer', () => {
  it('adds the second edge without writing a second node for the same range', async () => {
    const { source } = sourceOf({ 20: messageEvent({ type: 'text', text: '两句话出自同一段。' }) })
    const h = harness(source)
    await h.port.remember({ ops: [assertOp({ evidence: { seq_from: 20, seq_to: 20 } })] }, 'model', 'remember', SESSION)
    const afterFirst = h.store.db.nodeCount()
    await h.port.remember({
      ops: [assertOp({ subj: 'Elliott', pred: 'dislikes', obj: 'coffee', evidence: { seq_from: 20, seq_to: 20 } })],
    }, 'model', 'remember', SESSION)

    // One new assertion plus its decision; the pointer is reused.
    expect(h.store.db.nodeCount()).toBe(afterFirst + 2)
    const pointer = createEvidenceTemplates(h.store.db).findByKey(evidenceMemKey(SESSION, 20, 20))
    expect(pointer).toBeDefined()
    const second = createAssertionTemplates(h.store.db).findLiveByKey('assertion:Elliott:dislikes:coffee')!
    expect(h.store.db.getIncomingEdges(second.id, 'supports')).toHaveLength(1)
  })

  it('links two assertions of one table to a single pointer node', async () => {
    const { source } = sourceOf({ 21: messageEvent({ type: 'text', text: '一句话里两个事实。' }) })
    const h = harness(source)
    await h.port.remember({
      ops: [
        assertOp({ pred: 'likes', obj: 'coffee', evidence: { seq_from: 21, seq_to: 21 } }),
        assertOp({ pred: 'likes', obj: 'tea', evidence: { seq_from: 21, seq_to: 21 } }),
      ],
    }, 'model', 'remember', SESSION)

    const pointer = createEvidenceTemplates(h.store.db).findByKey(evidenceMemKey(SESSION, 21, 21))!
    expect(h.store.db.getEdges(pointer.id).filter(edge => edge.label === 'supports')).toHaveLength(2)
  })
})

describe('which ledger entry a new pointer belongs to', () => {
  it('names the pointer in the entry of the op that declared it, not the first one', async () => {
    const { source } = sourceOf({ 50: messageEvent({ type: 'text', text: '两个事实，只有一个带来源。' }) })
    const h = harness(source)
    await h.port.remember({
      ops: [
        assertOp({ pred: 'likes', obj: 'coffee' }),
        assertOp({ pred: 'likes', obj: 'tea', evidence: { seq_from: 50, seq_to: 50 } }),
      ],
    }, 'model', 'remember', SESSION)

    const pointerKey = evidenceMemKey(SESSION, 50, 50)
    const gateway = createReadGateway(h.store.db)
    const first = gateway.listDecisionsFor('assertion:Elliott:likes:coffee')
    const second = gateway.listDecisionsFor('assertion:Elliott:likes:tea')
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    // Op positions are 1-based everywhere: an off-by-one here would file the
    // pointer under the op above it, and no other case would notice.
    expect(first[0]?.payload['affected']).not.toContain(pointerKey)
    expect(second[0]?.payload['affected']).toContain(pointerKey)
    expect(second[0]?.payload['op_id']).toMatch(/^[^:]+:2:/u)
  })

  it('gives each op its own pointer when one table declares two ranges', async () => {
    const { source } = sourceOf({
      51: messageEvent({ type: 'text', text: '第一段来源。' }),
      52: messageEvent({ type: 'text', text: '第二段来源。' }),
    })
    const h = harness(source)
    await h.port.remember({
      ops: [
        assertOp({ pred: 'likes', obj: 'coffee', evidence: { seq_from: 51, seq_to: 51 } }),
        assertOp({ pred: 'likes', obj: 'tea', evidence: { seq_from: 52, seq_to: 52 } }),
      ],
    }, 'model', 'remember', SESSION)

    const gateway = createReadGateway(h.store.db)
    const first = gateway.listDecisionsFor('assertion:Elliott:likes:coffee')[0]
    const second = gateway.listDecisionsFor('assertion:Elliott:likes:tea')[0]
    expect(first?.payload['affected']).toContain(evidenceMemKey(SESSION, 51, 51))
    expect(first?.payload['affected']).not.toContain(evidenceMemKey(SESSION, 52, 52))
    expect(second?.payload['affected']).toContain(evidenceMemKey(SESSION, 52, 52))
    expect(second?.payload['affected']).not.toContain(evidenceMemKey(SESSION, 51, 51))
  })
})

describe('a refused declared range', () => {
  it('refuses an inverted range and writes nothing but the rejection', async () => {
    const { source, reads } = sourceOf({ 30: messageEvent({ type: 'text', text: '不会被读到' }) })
    const h = harness(source)
    const before = h.store.db.nodeCount()
    const answer = await h.port.remember({ ops: [assertOp({ evidence: { seq_from: 30, seq_to: 3 } })] }, 'model', 'remember', SESSION)
    expect(answer.ok).toBe(false)
    expect(answer.code).toBe('E_BOUNDARY')
    expect(answer.message).toContain('seq_to 不能小于 seq_from')
    // The invalid range never reaches the host, and only the rejection lands.
    expect(reads).toEqual([])
    expect(h.store.db.nodeCount()).toBe(before + 1)
    expect(createEvidenceTemplates(h.store.db).findByKey(evidenceMemKey(SESSION, 30, 3))).toBeUndefined()
    const rejected = h.rows().filter(row => row.kind === 'write' && row.outcome === 'rejected')
    expect(rejected).toHaveLength(1)
  })

  it('refuses an evidence object that carries an extra key', async () => {
    const h = harness()
    const answer = await h.port.remember({
      ops: [assertOp({ evidence: { seq_from: 1, seq_to: 1, session_id: 'smuggled' } })],
    }, 'model', 'remember', SESSION)
    expect(answer.ok).toBe(false)
    expect(answer.code).toBe('E_BOUNDARY')
  })
})

describe('a table that declares no source', () => {
  it('writes no pointer and no edge, exactly as before this story', async () => {
    const h = harness()
    const before = h.store.db.nodeCount()
    const answer = await h.port.remember({ ops: [assertOp()] }, 'model', 'remember', SESSION)
    expect(answer.ok).toBe(true)
    // assertion plus decision, and nothing else.
    expect(h.store.db.nodeCount()).toBe(before + 2)
  })
})

describe('the reader behind /omw evidence', () => {
  it('answers with the pointers of one key, without any node id', async () => {
    const { source } = sourceOf({ 40: messageEvent({ type: 'text', text: '来源句子。' }) })
    const h = harness(source)
    await h.port.remember({ ops: [assertOp({ evidence: { seq_from: 40, seq_to: 40 } })] }, 'model', 'remember', SESSION)
    const reader = createEvidenceReader({ db: h.store.db, readQuote: source })
    const answer = await reader.read('assertion:Elliott:likes:coffee')
    expect(answer.ok).toBe(true)
    expect(answer.degraded).toBeUndefined()
    expect(answer.pointers).toEqual([{
      session_id: SESSION,
      seq_from: 40,
      seq_to: 40,
      quote: '来源句子。',
      quote_truncated: false,
      deidentified: false,
    }])
    expect(JSON.stringify(answer)).not.toMatch(/"(?:id|node_id)"/u)
    reader.dispose()
  })

  it('says the host cannot resolve the pointer when it cannot be read back', async () => {
    const { source } = sourceOf({ 41: messageEvent({ type: 'text', text: '仍然存着。' }) })
    const h = harness(source)
    await h.port.remember({ ops: [assertOp({ evidence: { seq_from: 41, seq_to: 41 } })] }, 'model', 'remember', SESSION)
    const reader = createEvidenceReader({ db: h.store.db })
    const answer = await reader.read('assertion:Elliott:likes:coffee')
    expect(answer.ok).toBe(true)
    expect(answer.degraded).toBe('evidence-unresolvable')
    // The stored quote is still served: reading back is what failed, not storage.
    expect(answer.pointers[0]?.quote).toBe('仍然存着。')
    reader.dispose()
  })

  it('answers an unsupported key with no pointers rather than an error', async () => {
    const h = harness()
    const reader = createEvidenceReader({ db: h.store.db })
    await h.port.remember({ ops: [assertOp()] }, 'model', 'remember', SESSION)
    const answer = await reader.read('assertion:Elliott:likes:coffee')
    expect(answer.ok).toBe(true)
    expect(answer.pointers).toEqual([])
    expect(answer.message).toContain('没有证据指针')
    reader.dispose()
  })

  it('answers an unknown key with a boundary code', async () => {
    const h = harness()
    const reader = createEvidenceReader({ db: h.store.db })
    const answer = await reader.read('assertion:Nobody:likes:nothing')
    expect(answer.ok).toBe(false)
    expect(answer.code).toBe('E_BOUNDARY')
    expect(answer.message).toContain('未找到该业务键')
    reader.dispose()
  })

  it('refuses to read after it was disposed, and never closes the shared handle', async () => {
    const h = harness()
    const reader = createEvidenceReader({ db: h.store.db })
    reader.dispose()
    const answer = await reader.read('assertion:Elliott:likes:coffee')
    expect(answer.ok).toBe(false)
    expect(answer.code).toBe('E_GATE_DOWN')
    // The handle still belongs to the runtime: a reader must not take it down.
    expect(h.store.db.nodeCount()).toBeGreaterThanOrEqual(0)
  })
})

describe('the /omw evidence command', () => {
  function registry(): CommandRegistryLike & { invoke(name: string, rawInput?: string): Promise<unknown> } {
    const definitions: CommandDefinitionLike[] = []
    return {
      register(definition: CommandDefinitionLike) {
        definitions.push(definition)
        return () => {}
      },
      async invoke(name: string, rawInput = '') {
        const definition = definitions.find(entry => entry.name === name)
        if (definition === undefined) throw new Error(`no command registered as ${name}`)
        return definition.handler({ rawInput })
      },
    }
  }

  it('renders a human line and a JSON line, and never a node id', async () => {
    const { source } = sourceOf({ 50: messageEvent({ type: 'text', text: '命令行里的来源。' }) })
    const h = harness(source)
    await h.port.remember({ ops: [assertOp({ evidence: { seq_from: 50, seq_to: 50 } })] }, 'model', 'remember', SESSION)
    const reader = createEvidenceReader({ db: h.store.db, readQuote: source })
    const commands = registry()
    registerOmwCommands(commands, () => { throw new Error('the doctor view is not used here') }, undefined, () => reader)

    const result = await commands.invoke('omw-evidence', 'assertion:Elliott:likes:coffee') as { kind: string; text?: string }
    expect(result.kind).toBe('success')
    const text = result.text ?? ''
    expect(text).toContain('session-alpha #50-50')
    expect(text).toContain('命令行里的来源。')
    const last = text.split('\n').at(-1)!
    const json = JSON.parse(last) as { pointers: { session_id: string }[] }
    expect(json.pointers[0]?.session_id).toBe(SESSION)
    expect(text).not.toMatch(/\bnode_id\b/u)
    reader.dispose()
  })

  it('keeps the key case-sensitive, which the lowercased dispatch would not', async () => {
    const h = harness()
    const reader = createEvidenceReader({ db: h.store.db })
    await h.port.remember({ ops: [assertOp()] }, 'model', 'remember', SESSION)
    const commands = registry()
    registerOmwCommands(commands, () => { throw new Error('unused') }, undefined, () => reader)
    const result = await commands.invoke('omw-evidence', 'assertion:Elliott:likes:coffee') as { kind: string; text?: string }
    expect(result.kind).toBe('success')
    expect(result.text ?? '').toContain('assertion:Elliott:likes:coffee')
    reader.dispose()
  })

  it('asks for a key when none was given', async () => {
    const commands = registry()
    registerOmwCommands(commands, () => { throw new Error('unused') })
    const result = await commands.invoke('omw-evidence') as { kind: string; text: string }
    expect(result.kind).toBe('error')
    expect(result.text).toContain('需要给出一个业务键')
  })

  it('says the store is unreadable when no reader is wired', async () => {
    const commands = registry()
    registerOmwCommands(commands, () => { throw new Error('unused') })
    const result = await commands.invoke('omw-evidence', 'assertion:Elliott:likes:coffee') as { kind: string; text: string }
    expect(result.kind).toBe('error')
    expect(result.text).toContain('不可读')
  })
})

describe('cutting the key out of an invocation', () => {
  it('keeps the key as typed, colons and all', () => {
    // The command name is the host's, so the text starts at the key.
    expect(parseEvidenceKey('assertion:Elliott:likes:coffee'))
      .toEqual({ ok: true, key: 'assertion:Elliott:likes:coffee' })
    expect(parseEvidenceKey('  evidence:s1#5-6 ')).toEqual({ ok: true, key: 'evidence:s1#5-6' })
    expect(parseEvidenceKey('')).toEqual({ ok: true, key: '' })
  })

  it('reports a second word instead of dropping it into a confident not-found', () => {
    const parsed = parseEvidenceKey('assertion:Elliott:likes:coffee 谢谢')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toContain('谢谢')
  })
})

describe('a fact that already exists', () => {
  it('still gets its pointer, linked to the assertion that was already there', async () => {
    const { source } = sourceOf({ 60: messageEvent({ type: 'text', text: '这条事实我早就说过了。' }) })
    const h = harness(source)
    await h.port.remember({ ops: [assertOp()] }, 'model', 'remember', SESSION)
    const stored = createAssertionTemplates(h.store.db).findLiveByKey('assertion:Elliott:likes:coffee')!
    const answer = await h.port.remember({ ops: [assertOp({ evidence: { seq_from: 60, seq_to: 60 } })] }, 'model', 'remember', SESSION)

    expect(answer.ok).toBe(true)
    expect(answer.items[0]?.outcome).toBe('existing')
    const pointer = createEvidenceTemplates(h.store.db).findByKey(evidenceMemKey(SESSION, 60, 60))!
    expect(pointer).toBeDefined()
    // The pointer points at the assertion node that was already there, not at a new one.
    const edges = h.store.db.getEdges(pointer.id).filter(edge => edge.label === 'supports')
    expect(edges).toHaveLength(1)
    expect(edges[0]?.targetId).toBe(stored.id)
  })
})

describe('a range wider than the read budget', () => {
  it('refuses the whole table instead of reading twenty-one events', async () => {
    const { source, reads } = sourceOf({})
    const h = harness(source)
    const answer = await h.port.remember({ ops: [assertOp({ evidence: { seq_from: 1, seq_to: 21 } })] }, 'model', 'remember', SESSION)
    expect(answer.ok).toBe(false)
    expect(answer.code).toBe('E_BOUNDARY')
    expect(answer.message).toContain('最多覆盖 20 条事件')
    expect(reads).toEqual([])
  })
})

describe('a range that covers several events', () => {
  it('reads every event in turn and joins what it found', async () => {
    const { source, reads } = sourceOf({
      70: messageEvent({ type: 'text', text: '第一句。' }),
      71: messageEvent({ type: 'reasoning', text: '这一段不该出现。' }),
      72: messageEvent({ type: 'text', text: '第二句。' }),
    })
    const h = harness(source)
    const answer = await h.port.remember({ ops: [assertOp({ evidence: { seq_from: 70, seq_to: 72 } })] }, 'model', 'remember', SESSION)

    expect(answer.ok).toBe(true)
    expect(reads.map(read => read.seq)).toEqual([70, 71, 72])
    const pointer = createEvidenceTemplates(h.store.db).findByKey(evidenceMemKey(SESSION, 70, 72))!
    // A boundary event inside the range contributes nothing, and does not void it.
    expect(pointer.payload['quote']).toBe('第一句。\n第二句。')
  })

  it('degrades the pointer when an event inside the range cannot be read', async () => {
    const { source } = sourceOf({ 80: messageEvent({ type: 'text', text: '只有这一句。' }) })
    const h = harness(source)
    const answer = await h.port.remember({ ops: [assertOp({ evidence: { seq_from: 80, seq_to: 81 } })] }, 'model', 'remember', SESSION)
    expect(answer.ok).toBe(true)
    const pointer = createEvidenceTemplates(h.store.db).findByKey(evidenceMemKey(SESSION, 80, 81))!
    expect(pointer.payload['quote']).toBe('')
    expect(pointer.payload['deidentified']).toBe(false)
    expect(h.warnings).toContain('OMW_EVIDENCE_UNREADABLE')
  })
})

describe('the reader with several pointers', () => {
  it('calls the pointer resolvable only when every one of them reads back', async () => {
    const { source } = sourceOf({
      90: messageEvent({ type: 'text', text: '第一条来源。' }),
      91: messageEvent({ type: 'text', text: '第二条来源。' }),
    })
    const h = harness(source)
    // The same fact, restated later from a different range: two pointers, one assertion.
    await h.port.remember({ ops: [assertOp({ evidence: { seq_from: 90, seq_to: 90 } })] }, 'model', 'remember', SESSION)
    await h.port.remember({ ops: [assertOp({ evidence: { seq_from: 91, seq_to: 91 } })] }, 'model', 'remember', SESSION)
    // One event of the two is gone: the pointer pair is not fully resolvable.
    const partial: QuoteSource = {
      async readQuote(request) {
        return request.seq === 90 ? messageEvent({ type: 'text', text: '第一条来源。' }) : undefined
      },
    }
    const reader = createEvidenceReader({ db: h.store.db, readQuote: partial })
    const answer = await reader.read('assertion:Elliott:likes:coffee')
    expect(answer.pointers).toHaveLength(2)
    // The stored quotes are still served; what failed is the read back.
    expect(answer.pointers.map(pointer => pointer.quote)).toEqual(['第一条来源。', '第二条来源。'])
    expect(answer.degraded).toBe('evidence-unresolvable')
    reader.dispose()
  })
})

describe('the export rule at the store read', () => {
  it('holds back a redacted quote unless the caller asks for it', async () => {
    const { source } = sourceOf({
      95: messageEvent({ type: 'text', text: '打这个电话找我：13812345678。' }),
      96: messageEvent({ type: 'text', text: '普通的一句。' }),
    })
    const h = harness(source)
    // One fact, two sources: one redacted, one not.
    await h.port.remember({ ops: [assertOp({ evidence: { seq_from: 95, seq_to: 95 } })] }, 'model', 'remember', SESSION)
    await h.port.remember({ ops: [assertOp({ evidence: { seq_from: 96, seq_to: 96 } })] }, 'model', 'remember', SESSION)
    const gateway = createReadGateway(h.store.db)
    const key = 'assertion:Elliott:likes:coffee'

    const exported = gateway.listEvidenceFor(key)
    expect(exported).toHaveLength(1)
    expect(exported[0]?.payload['deidentified']).toBe(false)
    const everything = gateway.listEvidenceFor(key, { includeSensitive: true })
    expect(everything).toHaveLength(2)
  })
})

describe('a key that names a pointer', () => {
  it('is refused rather than answered as a fact without a source', async () => {
    const { source } = sourceOf({ 97: messageEvent({ type: 'text', text: '某个来源。' }) })
    const h = harness(source)
    await h.port.remember({ ops: [assertOp({ evidence: { seq_from: 97, seq_to: 97 } })] }, 'model', 'remember', SESSION)
    const reader = createEvidenceReader({ db: h.store.db, readQuote: source })
    const answer = await reader.read(evidenceMemKey(SESSION, 97, 97))
    expect(answer.ok).toBe(false)
    expect(answer.code).toBe('E_BOUNDARY')
    expect(answer.message).toContain('证据节点本身')
    reader.dispose()
  })
})

describe('a declared source in a write that names no session', () => {
  it('says so in the answer and in the log instead of dropping the range', async () => {
    const h = harness(undefined)
    const answer = await h.port.remember({ ops: [assertOp({ evidence: { seq_from: 40, seq_to: 40 } })] }, 'model', 'remember')
    expect(answer.ok).toBe(true)
    // The fact lands; the range is reported as dropped rather than quietly gone.
    expect(h.warnings).toContain('OMW_EVIDENCE_NO_SESSION')
    expect(answer.evidence).toMatchObject({ declared: 1, created: 0, reused: 0, dropped: 1 })
  })

  it('leaves every other write silent about evidence', async () => {
    const h = harness(undefined)
    const answer = await h.port.remember({ ops: [assertOp()] }, 'model', 'remember')
    expect(answer.evidence).toBeUndefined()
    expect(h.warnings).toEqual([])
  })
})

describe('a declared source on a write that degrades to a scene', () => {
  it('keeps the pointer and points it at the scene node', async () => {
    const { source } = sourceOf({ 50: messageEvent({ type: 'text', text: '今天心情不错。' }) })
    const h = harness(source, { maxNewPredsPerDay: 1 })
    await h.port.remember({ ops: [assertOp({ pred: 'mood', obj: 'calm' })] }, 'model', 'remember', SESSION)
    const answer = await h.port.remember({
      ops: [assertOp({ pred: 'hobby', obj: 'chess', evidence: { seq_from: 50, seq_to: 50 } })],
    }, 'model', 'remember', SESSION)

    expect(answer.code).toBe('E_DEGRADED')
    expect(answer.evidence).toMatchObject({ declared: 1, created: 1, unreadable: 0, dropped: 0 })
    const pointer = createEvidenceTemplates(h.store.db).findByKey(evidenceMemKey(SESSION, 50, 50))!
    expect(pointer.payload['quote']).toBe('今天心情不错。')
    // The scene node is the thing this pointer supports: degradation moves the
    // fact, not its provenance.
    const scene = createAssertionTemplates(h.store.db).findLiveByKey('scene:Elliott:hobby:chess')!
    const edges = h.store.db.getEdges(pointer.id).filter(edge => edge.label === 'supports')
    expect(edges.map(edge => edge.targetId)).toEqual([scene.id])
  })
})
