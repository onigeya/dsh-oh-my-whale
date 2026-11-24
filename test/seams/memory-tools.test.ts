/**
 * The tool surface and the command surface, tested as a host sees them.
 *
 * Both files are seams: what matters is the shape a caller receives and the
 * fact that a disabled write side is reported honestly rather than as a
 * rejection of the caller's request.
 * @module
 */
import { describe, expect, it } from 'vitest'
import {
  memoryTools,
  registerPlaceholderTools,
  type ToolDefinitionLike,
  type ToolRegistryLike,
} from '../../src/seams/tools.ts'
import { parsePromote, registerOmwCommand, type DoctorView } from '../../src/seams/commands.ts'
import { E_OK } from '../../src/core/tool-errors.ts'
import { DEFAULT_CANDIDATE_POOL, DEFAULT_TOP_K, MAX_TOP_K } from '../../src/core/recall.ts'
import type { RecallAnswer, RecallReader } from '../../src/seams/recall-reader.ts'
import type { WritePort, WriteAnswer } from '../../src/seams/write-port.ts'

function byName(
  name: string,
  writer?: Parameters<typeof memoryTools>[0],
  recall?: Parameters<typeof memoryTools>[1],
): ToolDefinitionLike {
  const found = memoryTools(writer, recall).find(tool => tool.name === name)
  if (found === undefined) throw new Error(`no tool named ${name}`)
  return found
}

/** A recall reader that records the raw arguments it was handed. */
function stubReader(answer: RecallAnswer): RecallReader & { readonly calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    recall: (query: unknown, topK?: unknown) => {
      calls.push(`${JSON.stringify(query)}:${JSON.stringify(topK)}`)
      return answer
    },
    dispose: () => {},
  }
}

const RECALL_ANSWER: RecallAnswer = {
  ok: true,
  code: E_OK,
  message: '找到 1 条未失效记忆，全部返回。',
  top_k: 5,
  candidate_pool: 12,
  candidates: 1,
  matched: 1,
  hits: [{ mem_key: 'assertion:Elliott:likes:coffee', kind: 'assertion', value: 'coffee' }],
  elapsed_ms: 3,
  degraded: false,
  degraded_reason: [],
}

function recorder(): ToolRegistryLike & { readonly names: string[] } {
  const names: string[] = []
  return {
    names,
    register(definition: ToolDefinitionLike): () => void {
      names.push(definition.name)
      return () => {
        const at = names.indexOf(definition.name)
        if (at >= 0) names.splice(at, 1)
      }
    },
  }
}

/** A write port that answers with a fixed result and records its calls. */
function stubPort(answer: WriteAnswer): WritePort & { readonly calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    remember: async (raw: unknown, caller, tool, sessionId) => {
      calls.push(`remember:${caller}:${tool}:${JSON.stringify(raw)}:${sessionId ?? '-'}`)
      return answer
    },
    promote: async (name, cardinality, reason) => {
      calls.push(`promote:${name}:${cardinality}:${reason}`)
      return answer
    },
    dispose: async () => {},
  }
}

const OK_ANSWER: WriteAnswer = {
  ok: true,
  code: 'OK',
  tool: 'remember',
  message: '写入 1 条新事实。',
  mem_keys: ['assertion:Elliott:likes:coffee'],
  items: [],
}

describe('the remember tool', () => {
  it('passes the patch through as a model write', async () => {
    const port = stubPort(OK_ANSWER)
    const remember = byName('remember', port)
    const patch = { ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'likes', obj: 'coffee' }] }
    const answer = await remember.execute({ patch }, {})

    expect(answer).toEqual(OK_ANSWER)
    expect(port.calls).toEqual([`remember:model:remember:${JSON.stringify(patch)}:-`])
  })

  it('hands the session id of the start to the store', async () => {
    const port = stubPort(OK_ANSWER)
    const remember = byName('remember', port)
    const patch = { ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'likes', obj: 'coffee' }] }
    // The host passes the whole execution context; the session id lives on its agent.
    await remember.execute({ patch }, { agent: { id: 'session-alpha' } })

    expect(port.calls).toEqual([`remember:model:remember:${JSON.stringify(patch)}:session-alpha`])
  })

  it('writes without a session when the execution context carries none', async () => {
    const port = stubPort(OK_ANSWER)
    const remember = byName('remember', port)
    const patch = { ops: [{ op: 'assert', kind: 'assertion', subj: 'Elliott', pred: 'likes', obj: 'coffee' }] }
    for (const exec of [{}, { agent: {} }, { agent: { id: '' } }, { agent: { id: 7 } }, undefined]) {
      await remember.execute({ patch }, exec)
    }

    // An id that is not a non-empty string is no session at all, never a stringified object.
    expect(port.calls.every(call => call.endsWith(':-'))).toBe(true)
    expect(port.calls).toHaveLength(5)
  })
  it('refuses arguments that carry no patch, without calling the store', async () => {
    const port = stubPort(OK_ANSWER)
    const remember = byName('remember', port)

    for (const args of [undefined, null, 'x', {}, { patch: undefined }]) {
      const answer = await remember.execute(args, {}) as WriteAnswer
      expect(answer.ok).toBe(false)
      expect(answer.code).toBe('E_BOUNDARY')
      expect(answer.items).toEqual([])
    }
    expect(port.calls).toEqual([])
  })

  it('says the store is unwritable, not that the tool is missing', async () => {
    const remember = byName('remember')
    const answer = await remember.execute({ patch: { ops: [] } }, {}) as WriteAnswer

    expect(answer.ok).toBe(false)
    expect(answer.code).toBe('E_GATE_DOWN')
    expect(answer.message).toContain('不可写')
    expect(answer.mem_keys).toEqual([])
  })

  it('keeps forget and explain as placeholders', async () => {
    for (const name of ['forget', 'explain']) {
      const answer = await byName(name).execute({}, {}) as { ok: boolean; code: string; tool: string }
      expect(answer.ok).toBe(false)
      expect(answer.code).toBe('E_NOT_IMPLEMENTED')
      expect(answer.tool).toBe(name)
    }
  })

  it('describes the patch table in the tool description', () => {
    const remember = byName('remember')
    expect(remember.description).toContain('op=assert')
    expect(remember.description).toContain('整表要么全成')
  })

  it('registers all four names or none, in the fixed order', () => {
    const registry = recorder()
    expect(registerPlaceholderTools(registry, undefined, stubReader(RECALL_ANSWER))).toEqual(['remember', 'recall', 'forget', 'explain'])
    expect(registry.names).toEqual(['remember', 'recall', 'forget', 'explain'])
    expect(registerPlaceholderTools(undefined)).toEqual([])
  })

  it('hands the recall arguments to the reader unchanged', async () => {
    // The host does not validate a call against the advertised schema, so an
    // out-of-range topK arrives intact. Rewriting or clamping it here would move
    // the boundary into the tool surface, where no test of the reader sees it.
    const reader = stubReader(RECALL_ANSWER)
    const recall = byName('recall', undefined, reader)

    const answer = await recall.execute({ query: 'whale', topK: 9 }, {}) as { ok: boolean; tool: string; mem_keys: string[] }

    expect(reader.calls).toEqual(['"whale":9'])
    expect(answer).toMatchObject({ ok: true, tool: 'recall', mem_keys: ['assertion:Elliott:likes:coffee'] })
  })

  it('passes a missing query through as missing rather than filling it in', async () => {
    const reader = stubReader(RECALL_ANSWER)
    const recall = byName('recall', undefined, reader)

    await recall.execute({}, {})

    expect(reader.calls).toEqual(['undefined:undefined'])
  })

  it('flattens the hits into mem_keys and items for the transcript', async () => {
    const recall = byName('recall', undefined, stubReader(RECALL_ANSWER))

    const answer = await recall.execute({ query: 'whale' }, {}) as Record<string, unknown>

    expect(answer['items']).toEqual([
      { mem_key: 'assertion:Elliott:likes:coffee', kind: 'assertion', value: 'coffee' },
    ])
    // The reader's own fields are not swallowed: the caller sees both widths.
    expect(answer).toMatchObject({ top_k: 5, candidate_pool: 12, candidates: 1, degraded: false })
  })

  it('refuses non-object arguments without calling the reader', async () => {
    const reader = stubReader(RECALL_ANSWER)
    const recall = byName('recall', undefined, reader)

    for (const args of [undefined, null, 'whale', 7]) {
      const answer = await recall.execute(args, {}) as { ok: boolean; code: string }
      expect(answer.ok).toBe(false)
      expect(answer.code).toBe('E_BOUNDARY')
    }
    expect(reader.calls).toEqual([])
  })

  it('says the store is unreadable rather than that the tool is missing', async () => {
    const recall = byName('recall')

    const answer = await recall.execute({ query: 'whale' }, {}) as { ok: boolean; code: string; message: string }

    expect(answer.ok).toBe(false)
    expect(answer.code).toBe('E_GATE_DOWN')
    expect(answer.message).toContain('不可读')
  })


  it('answers with exactly the fields the output schema declares', async () => {
    // The schema says `additionalProperties: false`, so a field the code returns
    // but the schema does not declare is a contract violation the host could
    // enforce. This test exists because it was one: `...answer` leaked the
    // reader's `hits` array, and a subset match never noticed.
    const recall = byName('recall', undefined, stubReader(RECALL_ANSWER))
    const declared = memoryTools()
      .find(tool => tool.name === 'recall')
      ?.output.schema as { properties: Record<string, unknown> }

    const answer = await recall.execute({ query: 'whale' }, {}) as Record<string, unknown>

    expect(Object.keys(answer).sort()).toEqual(Object.keys(declared.properties).sort())
  })

  it('declares every field it returns, including the two counts', async () => {
    const declared = memoryTools()
      .find(tool => tool.name === 'recall')
      ?.output.schema as { properties: Record<string, unknown> }
    const recall = byName('recall', undefined, stubReader(RECALL_ANSWER))

    const answer = await recall.execute({ query: 'whale' }, {}) as Record<string, unknown>

    // `matched` and `candidates` answer different questions and both are part of
    // the answer; a schema that declared only one would make the other invisible
    // to any consumer that validates against it.
    expect(declared.properties['matched']).toEqual({ type: 'integer' })
    expect(declared.properties['candidates']).toEqual({ type: 'integer' })
    expect(answer['matched']).toBe(RECALL_ANSWER.matched)
    expect(answer['candidates']).toBe(RECALL_ANSWER.candidates)
  })
  it('advertises no way to page a recall, and says how wide it can get', () => {
    // AC⑧ is satisfied by not adding fields, which is exactly the kind of
    // satisfaction nothing fails when it breaks: a later `offset` added to the
    // parameters would pass every behavioural test in this suite. The
    // description is asserted too, because it is the only place a model learns
    // the two widths before calling.
    const recall = byName('recall', undefined, stubReader(RECALL_ANSWER))
    const declared = recall.parameters as {
      properties: Record<string, unknown>
    }

    expect(Object.keys(declared.properties).sort()).toEqual(['query', 'topK'])
    for (const absent of ['offset', 'page', 'cursor']) {
      expect(declared.properties[absent]).toBeUndefined()
    }
    expect(recall.description).toContain(`默认 ${DEFAULT_TOP_K} 条`)
    expect(recall.description).toContain(`最多 ${MAX_TOP_K} 条`)
    expect(recall.description).toContain(`默认先截到 ${DEFAULT_CANDIDATE_POOL} 条`)
  })

  it('keeps the advertised topK ceiling equal to the one the reader enforces', () => {
    // Three places name the ceiling: the core constant, the parameter schema and
    // the description. A hard-coded 8 in the schema would pass every test that
    // only calls the reader, which is how the drift survived the first review.
    const recall = byName('recall', undefined, stubReader(RECALL_ANSWER))
    const declared = recall.parameters as {
      properties: { topK: { minimum?: number; maximum?: number } }
    }

    expect(declared.properties.topK.maximum).toBe(MAX_TOP_K)
    expect(declared.properties.topK.minimum).toBe(1)
  })
  it('stores the write answer schema once, for every tool', () => {
    const schemas = memoryTools().map(tool => JSON.stringify(tool.output.schema))
    expect(new Set(schemas).size).toBe(1)
    expect(JSON.parse(schemas[0] as string)).toMatchObject({
      required: ['ok', 'code', 'tool', 'message'],
      additionalProperties: false,
    })
  })
})

describe('parsing /omw pred promote', () => {
  it('accepts a single-valued promotion', () => {
    expect(parsePromote('pred promote mood --single --reason 用户要求单值')).toEqual({
      ok: true,
      request: { name: 'mood', cardinality: 'single', reason: '用户要求单值' },
    })
  })

  it('reads flags case-insensitively and keeps the reason as written', () => {
    const parsed = parsePromote('PRED PROMOTE mood --SINGLE --Reason 用户要求 Single 值')
    expect(parsed).toEqual({
      ok: true,
      request: { name: 'mood', cardinality: 'single', reason: '用户要求 Single 值' },
    })
  })

  it('treats a flag word inside the reason as prose', () => {
    const parsed = parsePromote('pred promote mood --single --reason 之前是多值，不是 --multi')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.request.cardinality).toBe('single')
    expect(parsed.request.reason).toBe('之前是多值，不是 --multi')
  })

  it('refuses an unrecognised token before the reason', () => {
    const parsed = parsePromote('pred promote mood --single --quiet --reason 用户要求')
    expect(parsed).toEqual({ ok: false, reason: '无法识别的参数 "--quiet"（参数必须写在 --reason 之前）' })
  })

  it('refuses both cardinalities at once', () => {
    const parsed = parsePromote('pred promote mood --single --multi --reason 用户要求')
    expect(parsed).toEqual({ ok: false, reason: '--single 与 --multi 只能选一个' })
  })

  it('names what is missing', () => {
    expect(parsePromote('pred promote')).toEqual({
      ok: false,
      reason: '缺少谓词名：/omw pred promote <谓词名> --single|--multi --reason <理由>',
    })
    expect(parsePromote('pred promote mood --reason 用户要求')).toEqual({
      ok: false,
      reason: '必须用 --single 或 --multi 指定基数',
    })
    expect(parsePromote('pred promote mood --single')).toEqual({
      ok: false,
      reason: '必须用 --reason 给出理由',
    })
  })
})

describe('the /omw command', () => {
  function view(): DoctorView {
    return {
      state: 'ok',
      config: {} as DoctorView['config'],
      paths: { dataDir: 'x', dbFile: 'x', logFile: 'x', snapshotsDir: 'x' },
      logger: { log: () => {}, info: () => {}, warn: () => {}, error: () => {}, events: [] } as unknown as DoctorView['logger'],
      sectionRegistered: true,
      sectionChars: 10,
      tools: ['remember', 'recall', 'forget', 'explain'],
    }
  }

  function mount(write?: () => WritePort | undefined) {
    let handler: ((invocation: { rawInput: string }) => unknown) | undefined
    const registry = {
      register(definition: { handler: (invocation: { rawInput: string }) => unknown }): () => void {
        handler = definition.handler
        return () => { handler = undefined }
      },
    }
    registerOmwCommand(registry as never, view, write)
    return async (rawInput: string) => await handler?.({ rawInput }) as { kind: string; text: string }
  }

  it('promotes through the write side', async () => {
    const port = stubPort({ ...OK_ANSWER, tool: 'omw', message: '写入 1 条新事实。' })
    const invoke = mount(() => port)
    const result = await invoke(' pred promote mood --single --reason 用户要求单值')

    expect(result.kind).toBe('success')
    expect(result.text).toBe('已更新谓词登记表：写入 1 条新事实。')
    expect(port.calls).toEqual(['promote:mood:single:用户要求单值'])
  })

  it('reports a failed promotion with its closed code', async () => {
    const port = stubPort({ ...OK_ANSWER, ok: false, code: 'E_CONFLICT', message: '业务键已被占用' })
    const invoke = mount(() => port)
    const result = await invoke('pred promote mood --single --reason 用户要求单值')

    expect(result.kind).toBe('error')
    expect(result.text).toBe('未能更新谓词登记表（E_CONFLICT）：业务键已被占用')
  })

  it('says the write side is not ready rather than failing silently', async () => {
    const invoke = mount(() => undefined)
    const result = await invoke('pred promote mood --single --reason 用户要求单值')

    expect(result.kind).toBe('error')
    expect(result.text).toContain('写面未就绪')
  })

  it('explains a bad request instead of pretending to promote', async () => {
    const port = stubPort(OK_ANSWER)
    const invoke = mount(() => port)
    const result = await invoke('pred promote mood')

    expect(result.kind).toBe('error')
    expect(result.text).toContain('必须用 --single 或 --multi 指定基数')
    expect(port.calls).toEqual([])
  })

  it('keeps doctor, help and the unknown-subcommand answer', async () => {
    const invoke = mount()
    const help = await invoke(' help')
    expect(help.kind).toBe('success')
    expect(help.text).toContain('/omw doctor')
    expect(help.text).toContain('pred promote')

    const unknown = await invoke(' nope')
    expect(unknown.kind).toBe('error')
    expect(unknown.text).toContain('未知子命令')
  })
})