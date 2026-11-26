/**
 * `/omw history` and `/omw ledger`, driven the way the chat drives them.
 *
 * The two commands answer the same question from two sides: what did this key
 * say before, and why did it stop saying it. Each answer has a human half and a
 * machine half, and the tests pin both, because a script that trusted only the
 * prose would break the first time a word changed.
 * @module
 */
import { describe, expect, it } from 'vitest'
import { ensureSchema } from '../../src/store/schema.ts'
import { createWritePort, type WritePort } from '../../src/seams/write-port.ts'
import { createVersionReader, type VersionReader } from '../../src/seams/version-reader.ts'
import {
  parseMemKeyArgument,
  registerOmwCommands,
  type CommandDefinitionLike,
  type CommandRegistryLike,
} from '../../src/seams/commands.ts'
import { createAudit, createMemoryAuditSink } from '../../src/ops/audit.ts'
import { installWriteIndexes, openWriteStore, type WriteStore } from '../support/write-store.ts'

const NOW = Date.UTC(2026, 10, 23, 4, 0, 0)
const LATER = NOW + 60_000
const KEY = 'assertion:Elliott:lives_in'

interface Harness {
  readonly store: WriteStore
  readonly port: WritePort
  readonly reader: VersionReader
  readonly at: (ms: number) => void
}

function harness(): Harness {
  const store = openWriteStore('omw-vcmd-')
  // The unique index is what makes a retirement-then-insert a rewrite rather
  // than two live versions; a harness without it tests a looser store than the
  // one the command will meet.
  installWriteIndexes(store)
  const schema = ensureSchema(store.db, { now: () => NOW })
  if (!schema.ok || !schema.writable) throw new Error('bootstrap failed')
  const clock = { now: NOW }
  const port = createWritePort({
    db: store.db,
    audit: createAudit({ dataDir: store.dataDir, now: () => new Date(clock.now), sink: createMemoryAuditSink() }),
    logger: { warn: () => {} },
    maxNewPredsPerDay: 20,
    contractVersion: 1,
    now: () => clock.now,
  })
  return {
    store,
    port,
    reader: createVersionReader({ db: store.db }),
    at: (ms: number) => { clock.now = ms },
  }
}

function cityOp(obj: string): Record<string, unknown> {
  return { op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'lives_in', obj }
}

/** A registry that keeps the definition so a test can invoke the handler. */
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

interface CommandResult { readonly kind: string; readonly text?: string }

/** Wire the command with only the version reader, which is all these reads need. */
function commandFor(h: Harness, reader?: () => VersionReader | undefined) {
  const commands = registry()
  registerOmwCommands(
    commands,
    () => { throw new Error('the doctor view is not used here') },
    undefined,
    undefined,
    reader ?? (() => h.reader),
  )
  return commands
}

/** The JSON line every read command ends with. */
function jsonOf(text: string): Record<string, unknown> {
  return JSON.parse(text.split('\n').at(-1)!) as Record<string, unknown>
}

describe('/omw history', () => {
  it('shows every version with the old value intact', async () => {
    const h = harness()
    await h.port.remember({ ops: [cityOp('杭州')] }, 'model', 'remember')
    h.at(LATER)
    await h.port.remember({ ops: [cityOp('上海')] }, 'model', 'remember')

    const result = await commandFor(h).invoke('omw-history', KEY) as CommandResult
    expect(result.kind).toBe('success')
    const text = result.text ?? ''
    expect(text).toContain('2 个版本')
    expect(text).toContain('杭州')
    expect(text).toContain('上海')
    expect(text).toContain('[当前版本]')
    expect(text).toContain('[已退役]')

    const json = jsonOf(text) as { versions: { obj?: string; live: boolean; valid_to?: string }[] }
    expect(json.versions).toHaveLength(2)
    const live = json.versions.find(version => version.live)
    expect(live?.obj).toBe('上海')
    const retired = json.versions.find(version => !version.live)
    expect(retired?.obj).toBe('杭州')
    expect(retired?.valid_to).toBe(new Date(LATER).toISOString())
  })

  it('gives the retired version the instant it was retired', async () => {
    const h = harness()
    await h.port.remember({ ops: [cityOp('杭州')] }, 'model', 'remember')
    h.at(LATER)
    await h.port.remember({ ops: [cityOp('上海')] }, 'model', 'remember')
    const text = (await commandFor(h).invoke('omw-history', KEY) as CommandResult).text ?? ''
    expect(text).toContain(new Date(LATER).toISOString())
    expect(text).toContain('至今')
  })

  it('says a key was never rewritten rather than showing one lonely line', async () => {
    const h = harness()
    await h.port.remember({ ops: [cityOp('杭州')] }, 'model', 'remember')
    const text = (await commandFor(h).invoke('omw-history', KEY) as CommandResult).text ?? ''
    expect(text).toContain('从未被改写')
  })

  it('answers that a key was never written instead of refusing the question', async () => {
    const h = harness()
    // The question was well formed; the answer is that this store has never
    // seen the key. Reporting an error would make a script read 'never
    // written' as a broken request and retry it.
    const result = await commandFor(h).invoke('omw-history', 'assertion:Elliott:name') as CommandResult
    expect(result.kind).toBe('success')
    expect(result.text ?? '').toContain('没有找到这个业务键的任何版本')
    expect(jsonOf(result.text ?? '')).toMatchObject({ ok: true, mem_key: 'assertion:Elliott:name', versions: [] })
  })

  it('names a record that exists but has no chain, rather than calling it missing', async () => {
    const h = harness()
    // An evidence pointer has no active_slot by construction: it is written
    // once, beside the assertion it supports, and never rewritten. The node is
    // right there, so 'never written' would be a false sentence about it.
    h.store.db.insert(Array.from({ length: 4 }, () => 0), {
      kind: 'evidence', mem_key: 'evidence:session-alpha:12:12', session_id: 'session-alpha',
      seq_from: 12, seq_to: 12, quote: '一段来源。', quote_truncated: false, deidentified: false,
    })
    const result = await commandFor(h).invoke('omw-history', 'evidence:session-alpha:12:12') as CommandResult
    expect(result.kind).toBe('success')
    expect(result.text ?? '').toContain('没有版本链')
    expect(result.text ?? '').toContain('证据指针')
    expect(jsonOf(result.text ?? '')).toMatchObject({ ok: true, versions: [] })
  })

  it('refuses a ledger key, which has no chain', async () => {
    const h = harness()
    // A decision is a record of a change, not a memory that changes. Offering
    // it a version chain would invite treating the audit trail as mutable.
    const result = await commandFor(h).invoke('omw-history', 'decision:1:0:abcdef') as CommandResult
    expect(result.kind).toBe('error')
    expect(result.text ?? '').toContain('账本')
  })

  it('asks for a key when none was given', async () => {
    const h = harness()
    const result = await commandFor(h).invoke('omw-history') as CommandResult
    expect(result.kind).toBe('error')
    expect(result.text ?? '').toContain('需要给出一个业务键')
  })

  it('says the store is unreadable rather than that the key is missing', async () => {
    const h = harness()
    const result = await commandFor(h, () => undefined).invoke('omw-history', KEY) as CommandResult
    expect(result.kind).toBe('error')
    expect(result.text ?? '').toContain('不可读')
  })

  it('reports a reading failure instead of letting it escape', async () => {
    const h = harness()
    const broken: VersionReader = {
      history() { throw new Error('engine went away') },
      ledger() { throw new Error('engine went away') },
      dispose() {},
    }
    const result = await commandFor(h, () => broken).invoke('omw-history', KEY) as CommandResult
    expect(result.kind).toBe('error')
    expect(result.text ?? '').toContain('读取版本链时出错')
    expect(result.text ?? '').toContain('engine went away')
  })

  it('reports a second word instead of answering about the first', async () => {
    const h = harness()
    const result = await commandFor(h).invoke('omw-history', KEY + ' 谢谢') as CommandResult
    expect(result.kind).toBe('error')
    expect(result.text ?? '').toContain('谢谢')
  })
})

describe('/omw ledger', () => {
  it('lists one entry per change, oldest first', async () => {
    const h = harness()
    await h.port.remember({ ops: [cityOp('杭州')] }, 'model', 'remember')
    h.at(LATER)
    await h.port.remember({ ops: [cityOp('上海')], reason: '用户搬家' }, 'user', 'remember')

    const result = await commandFor(h).invoke('omw-ledger', KEY) as CommandResult
    expect(result.kind).toBe('success')
    const text = result.text ?? ''
    expect(text).toContain('2 条决策记录')
    expect(text).toContain('insert')
    expect(text).toContain('supersede')
    expect(text).toContain('用户搬家')

    const json = jsonOf(text) as { entries: { kind: string; actor: string; from?: unknown; to?: unknown }[] }
    expect(json.entries).toHaveLength(2)
    expect(json.entries[0]?.kind).toBe('insert')
    const rewrite = json.entries.find(entry => entry.kind === 'supersede')
    expect(rewrite?.actor).toBe('user')
    expect(rewrite?.from).toMatchObject({ value: '杭州' })
    expect(rewrite?.to).toMatchObject({ value: '上海' })
  })

  it('renders the from and to of a rewrite for a human', async () => {
    const h = harness()
    await h.port.remember({ ops: [cityOp('杭州')] }, 'model', 'remember')
    h.at(LATER)
    await h.port.remember({ ops: [cityOp('上海')] }, 'user', 'remember')
    const text = (await commandFor(h).invoke('omw-ledger', KEY) as CommandResult).text ?? ''
    expect(text).toContain('杭州')
    expect(text).toContain('上海')
    expect(text).toContain('操作号')
  })

  it('says so when a key has no ledger entries at all', async () => {
    const h = harness()
    await h.port.remember({ ops: [cityOp('杭州')] }, 'model', 'remember')
    // `pred:lives_in` is written by the seed installer, not by a patch table.
    const result = await commandFor(h).invoke('omw-ledger', 'pred:lives_in') as CommandResult
    expect(result.kind).toBe('success')
    expect(result.text ?? '').toContain('没有决策记录')
  })

  it('answers that a key was never written instead of refusing the question', async () => {
    const h = harness()
    const result = await commandFor(h).invoke('omw-ledger', 'assertion:Elliott:name') as CommandResult
    expect(result.kind).toBe('success')
    expect(result.text ?? '').toContain('没有找到这个业务键的任何决策记录')
    expect(jsonOf(result.text ?? '')).toMatchObject({ ok: true, entries: [] })
  })

  it('asks for a key when none was given', async () => {
    const h = harness()
    const result = await commandFor(h).invoke('omw-ledger') as CommandResult
    expect(result.kind).toBe('error')
    expect(result.text ?? '').toContain('需要给出一个业务键')
  })

  it('says the store is unreadable rather than that there is no ledger', async () => {
    const h = harness()
    const result = await commandFor(h, () => undefined).invoke('omw-ledger', KEY) as CommandResult
    expect(result.kind).toBe('error')
    expect(result.text ?? '').toContain('不可读')
  })
})

describe('a version reader that was disposed', () => {
  it('refuses to read, and never closes the handle the runtime owns', async () => {
    const h = harness()
    await h.port.remember({ ops: [cityOp('杭州')] }, 'model', 'remember')
    h.reader.dispose()
    const answer = h.reader.history(KEY)
    expect(answer.ok).toBe(false)
    expect(answer.code).toBe('E_GATE_DOWN')
    // The handle belongs to the runtime; a reader that closed it would take the
    // write side down with it.
    expect(h.store.db.nodeCount()).toBeGreaterThan(0)
  })
})

describe('cutting the key out of a version invocation', () => {
  it('keeps the key as typed, colons and all', () => {
    // The command name is the host's, so it is not part of the text any more.
    expect(parseMemKeyArgument('assertion:Elliott:lives_in', 'omw-history'))
      .toEqual({ ok: true, key: 'assertion:Elliott:lives_in' })
    expect(parseMemKeyArgument('pred:lives_in', 'omw-ledger'))
      .toEqual({ ok: true, key: 'pred:lives_in' })
    expect(parseMemKeyArgument('', 'omw-history')).toEqual({ ok: true, key: '' })
  })

  it('reports a second word rather than treating it as part of the key', () => {
    const parsed = parseMemKeyArgument('assertion:a:b 谢谢', 'omw-history')
    expect(parsed.ok).toBe(false)
    expect(parsed.ok ? '' : parsed.reason).toContain('一次只查一个业务键')
  })
})