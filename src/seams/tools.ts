/**
 * The model-facing tool surface (AD-25).
 *
 * Four names, fixed: `remember`, `recall`, `forget`, `explain`. Story 2.1 turned
 * `remember` into a real write and Story 2.5 turned `recall` into a real bounded
 * read; `forget` and `explain` still answer `E_NOT_IMPLEMENTED`, so the surface
 * stays observable while the behaviour arrives story by story.
 *
 * `remember` is registered even when the write side is unavailable, and then
 * refuses with `E_GATE_DOWN` rather than `E_NOT_IMPLEMENTED`: the tool exists, the
 * store does not, and a caller must be able to tell those two apart. `recall`
 * follows the same rule for a read side that is absent. When the plugin is in
 * `no-op`, not one of the four is registered — that is what the state means.
 * @module
 */
import { ASSERTABLE_KINDS, PATCH_TABLE_MAX_OPS, TEXT_MAX_CODE_POINTS } from '../core/patch.ts'
import { DEFAULT_CANDIDATE_POOL, DEFAULT_TOP_K, MAX_TOP_K } from '../core/recall.ts'
import type { JsonSchemaNode } from './json-schema.ts'
import type { RecallReader } from './recall-reader.ts'
import type { WriteAnswer, WritePort } from './write-port.ts'

/** Highest event sequence a declared range may name (a sanity bound, not a host limit). */
const MAX_SEQ = 1_000_000_000

/** The four fixed tool names. Renaming one is a breaking change (AD-25). */
export const PLACEHOLDER_TOOL_NAMES = ['remember', 'recall', 'forget', 'explain'] as const

/** One of the four fixed tool names. */
export type PlaceholderToolName = (typeof PLACEHOLDER_TOOL_NAMES)[number]

/** Error code every placeholder returns. */
export const E_NOT_IMPLEMENTED = 'E_NOT_IMPLEMENTED'

/** A rendered content block, as the host accepts it. */
export interface ContentBlockLike {
  readonly type: 'text'
  readonly text: string
}

/** A registered tool, as the host understands it. */
export interface ToolDefinitionLike {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchemaNode
  /**
   * Canonical output contract. `render` is mandatory: the host rejects a tool
   * without it ("must declare output { schema, render, presentationMeta? }"),
   * which is exactly how the real host refused all four placeholders.
   */
  readonly output: {
    readonly schema: JsonSchemaNode
    render(args: unknown, value: unknown): readonly ContentBlockLike[]
    presentationMeta?(args: unknown, value: unknown): unknown
  }
  execute(args: unknown, exec?: unknown): Promise<unknown>
}

/**
 * The slice of the host's tool-run context this module reads.
 *
 * `agent.id` is the session id: the agent runs inside this one session, and the
 * evidence pointer has to name the session its sentences came from. Declared
 * structurally like every other host type here — the plugin does not import
 * host packages — so an older host that passes nothing simply yields no
 * session id, and the pointer degrades instead of the write failing.
 */
export interface ToolRunContextLike {
  readonly agent?: { readonly id?: unknown }
}

/** The slice of `ctx.tools` this module needs. */
export interface ToolRegistryLike {
  register(definition: ToolDefinitionLike, options?: unknown): () => void
}

/** The structured answer every placeholder produces. */
export interface NotImplementedAnswer {
  readonly ok: false
  readonly code: typeof E_NOT_IMPLEMENTED
  readonly tool: string
  readonly message: string
}

/**
 * Output schema shared by all four tools.
 *
 * Every field is optional except the four used by a refusal, because four tools
 * with different answers share one schema. `additionalProperties: false` still
 * holds, so an answer that grows a field has to grow it here first — which is why
 * the recall fields below are declared before any of them is ever set.
 */
const OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    code: { type: 'string' },
    tool: { type: 'string' },
    message: { type: 'string' },
    mem_keys: { type: 'array', items: { type: 'string' } },
    items: { type: 'array', items: { type: 'object' } },
    // Recall reports its two widths and its timing, so a caller can tell
    // "only five matched" from "five were kept out of thirty" without a second
    // call. `degraded` is present from this story on even though nothing
    // degrades yet: Epic 5 fills the same field, and a field that appears later
    // is a contract change (AD-20).
    top_k: { type: 'integer' },
    candidate_pool: { type: 'integer' },
    // `candidates` is what entered the pool; `matched` is what matched before
    // either cut. Both are reported because one number cannot answer "did the
    // store hold five or five hundred" on its own.
    candidates: { type: 'integer' },
    matched: { type: 'integer' },
    elapsed_ms: { type: 'integer' },
    degraded: { type: 'boolean' },
    degraded_reason: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'code', 'tool', 'message'],
  additionalProperties: false,
} as JsonSchemaNode

/** Build the "not implemented" answer for one tool. */
function notImplemented(tool: string): NotImplementedAnswer {
  return {
    ok: false,
    code: E_NOT_IMPLEMENTED,
    tool,
    message: `${tool} 属于记忆语义，本版本（Epic 1 底座）尚未实现；插件已加载、配置已校验。`,
  }
}

/**
 * The slice of the write service `remember` needs.
 *
 * Narrowed to one method on purpose: the tool surface has no business promoting
 * predicates, and a test can stand in for the write side without a store.
 */
export type RememberWriter = Pick<WritePort, 'remember'>

/**
 * The answer a write returns when the write side is not available.
 *
 * `E_GATE_DOWN`, not `E_NOT_IMPLEMENTED`: the tool is implemented, the store it
 * needs is not usable on this start.
 * @param tool - the tool being called.
 * @returns the refusal.
 */
function writeUnavailable(tool: string): WriteAnswer {
  return {
    ok: false,
    code: 'E_GATE_DOWN',
    tool,
    message: '记忆库本次启动不可写（schema 未就绪或句柄只读），本次调用没有落库。',
    mem_keys: [],
    items: [],
  }
}

/**
 * Pick the session id out of a tool-run context.
 *
 * The host passes a live object; a test may pass nothing at all. An id of the
 * wrong type is treated as absent rather than stringified: a pointer naming
 * "[object Object]" would look resolvable and never be.
 * @param exec - the second argument the host hands to `execute`.
 * @returns the session id, or `undefined` when the host supplied none.
 */
function sessionIdOf(exec: unknown): string | undefined {
  if (typeof exec !== 'object' || exec === null) return undefined
  const agent = (exec as ToolRunContextLike).agent
  if (typeof agent !== 'object' || agent === null) return undefined
  const id = agent.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Normalise the one argument `remember` takes.
 *
 * The host hands us whatever the model produced; a patch that is not an object
 * is a boundary problem, not a crash.
 * @param args - the raw argument object.
 * @returns the patch table, or a refusal reason.
 */
function readPatchArgument(args: unknown): { ok: true; patch: unknown } | { ok: false; reason: string } {
  if (typeof args !== 'object' || args === null) {
    return { ok: false, reason: '参数必须是对象，且带 patch 字段' }
  }
  const patch = (args as { patch?: unknown }).patch
  if (patch === undefined) {
    return { ok: false, reason: '缺少 patch 字段' }
  }
  return { ok: true, patch }
}

/** Parameter schemas of the four tools, fixed by AD-25. */
const PARAMETERS: Record<PlaceholderToolName, JsonSchemaNode> = {
  recall: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1 },
      // The advertised ceiling is the one the reader enforces, taken from the
      // same constant. A literal here would let the schema promise a width the
      // reader refuses (or worse, refuse one the schema allowed).
      topK: { type: 'integer', minimum: 1, maximum: MAX_TOP_K },
    },
    required: ['query'],
    additionalProperties: false,
  } as JsonSchemaNode,
  remember: {
    type: 'object',
    properties: {
      // The patch table is advertised, not just described: a caller reads the
      // schema, and an opaque `object` would make every rejection look like a
      // bug in the caller rather than a shape it was told about.
      patch: {
        type: 'object',
        properties: {
          ops: {
            type: 'array',
            minItems: 1,
            maxItems: PATCH_TABLE_MAX_OPS,
            items: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    op: { type: 'string', const: 'assert' },
                    kind: { type: 'string', enum: [...ASSERTABLE_KINDS] },
                    subj: { type: 'string', minLength: 1, maxLength: TEXT_MAX_CODE_POINTS },
                    pred: { type: 'string', minLength: 1 },
                    obj: { type: 'string', minLength: 1, maxLength: TEXT_MAX_CODE_POINTS },
                    // The pointer is declared, not inferred: the writer cannot
                    // guess which sentences a fact came from, and a wrong
                    // guess would make AD-6 traceability a lie.
                    evidence: {
                      type: 'object',
                      properties: {
                        seq_from: { type: 'integer', minimum: 1 },
                        seq_to: { type: 'integer', minimum: 1, maximum: MAX_SEQ },
                      },
                      required: ['seq_from', 'seq_to'],
                      additionalProperties: false,
                    },
                  },
                  required: ['op', 'kind', 'subj', 'pred'],
                  additionalProperties: false,
                },
                {
                  type: 'object',
                  properties: {
                    op: { type: 'string', const: 'pred' },
                    pred: { type: 'string', minLength: 1 },
                    cardinality: { type: 'string', enum: ['single', 'multi'] },
                    aliases: { type: 'array', items: { type: 'string' } },
                    reason: { type: 'string' },
                  },
                  required: ['op', 'pred', 'cardinality'],
                  additionalProperties: false,
                },
              ],
            },
          },
          reason: { type: 'string' },
        },
        required: ['ops'],
        additionalProperties: false,
      },
    },
    required: ['patch'],
    additionalProperties: false,
  } as JsonSchemaNode,
  forget: {
    type: 'object',
    properties: {
      mem_key: { type: 'string', minLength: 1 },
      reason: { type: 'string' },
    },
    required: ['mem_key'],
    additionalProperties: false,
  } as JsonSchemaNode,
  explain: {
    type: 'object',
    properties: {
      mem_key: { type: 'string', minLength: 1 },
    },
    required: ['mem_key'],
    additionalProperties: false,
  } as JsonSchemaNode,
}

/** One-line descriptions; they are prompt text and therefore part of the contract. */
const DESCRIPTIONS: Record<PlaceholderToolName, string> = {
  // Numbers are interpolated from the constants rather than written out: the
  // description is prompt text read by the model, so a stale literal here is a
  // contract the implementation no longer honours (AD-26).
  recall: `按需检索长期记忆：只返回未失效的版本，默认 ${DEFAULT_TOP_K} 条、最多 ${MAX_TOP_K} 条（越界直接拒收，不静默截断）；query 最多 200 个字符。topK 决定返回几条；候选池是更外层的闸门，默认先截到 ${DEFAULT_CANDIDATE_POOL} 条打分结果再取前 topK，两者不互相替代。结果带 candidates、elapsed_ms、degraded 与封闭取值的 degraded_reason。只读，不写库，不支持翻页。`,
  remember: '写入一张记忆补丁表。patch 形如 {"ops":[{"op":"assert","kind":"pref","subj":"Elliott","pred":"reply_style","obj":"concise"}],"reason":"用户明确要求"}：op=assert 必填 kind/subj/pred，obj 缺省即三段键；op=pred 只接受用户调用方。整表要么全成、要么整表拒收。assert 可选 evidence:{seq_from,seq_to} 指明这条事实出自当前会话哪几条事件——只声明区间，引文由写入路径回读原文生成；区间最多覆盖 20 条事件，越宽整表拒收。',
  forget: '按 mem_key 撤销一条记忆（本版本占位，调用返回 E_NOT_IMPLEMENTED）。',
  explain: '解释一条记忆的来龙去脉（本版本占位，调用返回 E_NOT_IMPLEMENTED）。',
}

/**
 * Run one recall through the reader, or refuse when there is no store to read.
 *
 * The arguments are read here, not passed through: the host does not validate
 * a call against the advertised schema, so `topK: '5'` or `topK: 9` arrives
 * intact. Handing the raw values to the reader is deliberate — it refuses them
 * with a reason that names the offending value, which a generic schema error
 * could not (AC②).
 * @param reader - the recall seam, absent when no handle is open.
 * @param args - the raw argument object the host supplied.
 * @returns the reader's answer, or a refusal naming the missing store.
 */
function recallTool(reader: RecallReader | undefined, args: unknown): unknown {
  if (reader === undefined) {
    return {
      ok: false,
      code: 'E_GATE_DOWN',
      tool: 'recall',
      message: '记忆库本次启动不可读（schema 未就绪或句柄已关闭），本次没有召回任何东西。',
      mem_keys: [],
      items: [],
    }
  }
  if (typeof args !== 'object' || args === null) {
    return {
      ok: false,
      code: 'E_BOUNDARY',
      tool: 'recall',
      message: '参数必须是对象，且带 query 字段',
      mem_keys: [],
      items: [],
    }
  }
  const record = args as { query?: unknown; topK?: unknown }
  const answer = reader.recall(record.query, record.topK)
  // Every field is named rather than spread: `...answer` also carried `hits`,
  // which OUTPUT_SCHEMA does not declare, and `additionalProperties: false`
  // makes that a contract the host could enforce against us. The flattened
  // `mem_keys` / `items` are the same information in the shape the schema
  // states, so spreading would have been a second, undeclared spelling.
  return {
    ok: answer.ok,
    code: answer.code,
    tool: 'recall',
    message: answer.message,
    mem_keys: answer.hits.map(hit => hit.mem_key),
    items: answer.hits.map(hit => ({ mem_key: hit.mem_key, kind: hit.kind, value: hit.value })),
    top_k: answer.top_k,
    candidate_pool: answer.candidate_pool,
    candidates: answer.candidates,
    matched: answer.matched,
    elapsed_ms: answer.elapsed_ms,
    degraded: answer.degraded,
    degraded_reason: [...answer.degraded_reason],
  }
}

/**
 * Build the four definitions, in the fixed order of AD-25.
 * @param writer - the write service `remember` calls, absent when the store is unusable.
 * @param recall - the read service `recall` calls, absent when no handle is open.
 * @returns one definition per tool name.
 */
export function memoryTools(writer?: RememberWriter, recall?: RecallReader): ToolDefinitionLike[] {
  return PLACEHOLDER_TOOL_NAMES.map(name => ({
    name,
    description: DESCRIPTIONS[name],
    parameters: PARAMETERS[name],
    output: {
      schema: OUTPUT_SCHEMA,
      // One text block carrying the canonical JSON, so a rejection is readable in
      // the transcript. Placeholders produce no presentation metadata.
      render: (_args: unknown, value: unknown): readonly ContentBlockLike[] => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
      ],
    },
    execute: async (args: unknown, exec?: unknown): Promise<unknown> => {
      if (name === 'recall') return recallTool(recall, args)
      if (name !== 'remember') return notImplemented(name)
      if (writer === undefined) return writeUnavailable(name)
      const read = readPatchArgument(args)
      if (!read.ok) {
        return { ok: false, code: 'E_BOUNDARY', tool: name, message: read.reason, mem_keys: [], items: [] }
      }
      return writer.remember(read.patch, 'model', name, sessionIdOf(exec))
    },
  }))
}

/**
 * Register the four tools.
 *
 * The name is historical — it dates from the story that only shipped the names —
 * and it stays because the call sites and the tests describe the same job: put
 * the whole surface up, or none of it.
 * @param tools - the host registry, or `undefined` when the surface is absent.
 * @param writer - the write service `remember` calls, absent when the store is unusable.
 * @param recall - the read service `recall` calls, absent when no handle is open.
 * @returns the names actually registered (empty when `tools` is absent).
 */
export function registerPlaceholderTools(
  tools: ToolRegistryLike | undefined,
  writer?: RememberWriter,
  recall?: RecallReader,
): string[] {
  if (tools === undefined) return []
  const registered: string[] = []
  const disposers: (() => void)[] = []
  try {
    for (const definition of memoryTools(writer, recall)) {
      disposers.push(tools.register(definition))
      registered.push(definition.name)
    }
  } catch (error) {
    // All-or-nothing: a half-registered surface would leave callable tools behind
    // while `loaded.tools` reports nothing.
    for (const dispose of [...disposers].reverse()) {
      try {
        dispose()
      } catch {
        // A failing undo must not mask the registration error.
      }
    }
    throw error
  }
  return registered
}
