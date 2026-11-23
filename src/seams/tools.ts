/**
 * The model-facing tool surface (AD-25).
 *
 * Epic 1 registers the four names so the surface exists and is observable, but
 * every call answers with a structured "not implemented in this version" error.
 * No tool writes to the store and no tool injects anything: the business
 * behaviour belongs to Epic 2.
 *
 * When the plugin is in `no-op`, not one of these is registered — that is the
 * whole point of the story ("四个工具一个都不注册").
 * @module
 */
import type { JsonSchemaNode } from './json-schema.ts'

/** The four fixed tool names. Renaming one is a breaking change (AD-25). */
export const PLACEHOLDER_TOOL_NAMES = ['remember', 'recall', 'forget', 'explain'] as const

/** One of the four fixed tool names. */
export type PlaceholderToolName = (typeof PLACEHOLDER_TOOL_NAMES)[number]

/** Error code every placeholder returns. */
export const E_NOT_IMPLEMENTED = 'E_NOT_IMPLEMENTED'

/** A registered tool, as the host understands it. */
export interface ToolDefinitionLike {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchemaNode
  readonly output: { readonly schema: JsonSchemaNode }
  execute(args: unknown, exec: unknown): Promise<unknown>
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

/** Output schema shared by all four placeholders. */
const OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    code: { type: 'string' },
    tool: { type: 'string' },
    message: { type: 'string' },
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

/** Parameter schemas of the four tools, fixed by AD-25. */
const PARAMETERS: Record<PlaceholderToolName, JsonSchemaNode> = {
  recall: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1 },
      topK: { type: 'integer', minimum: 1, maximum: 8 },
    },
    required: ['query'],
    additionalProperties: false,
  } as JsonSchemaNode,
  remember: {
    type: 'object',
    properties: {
      patch: { type: 'object' },
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
  recall: '按需检索长期记忆（本版本占位，调用返回 E_NOT_IMPLEMENTED）。',
  remember: '写入一条记忆补丁（本版本占位，调用返回 E_NOT_IMPLEMENTED）。',
  forget: '按 mem_key 撤销一条记忆（本版本占位，调用返回 E_NOT_IMPLEMENTED）。',
  explain: '解释一条记忆的来龙去脉（本版本占位，调用返回 E_NOT_IMPLEMENTED）。',
}

/**
 * Build the four placeholder definitions, in the fixed order of AD-25.
 * @returns one definition per tool name.
 */
export function placeholderTools(): ToolDefinitionLike[] {
  return PLACEHOLDER_TOOL_NAMES.map(name => ({
    name,
    description: DESCRIPTIONS[name],
    parameters: PARAMETERS[name],
    output: { schema: OUTPUT_SCHEMA },
    execute: async (): Promise<unknown> => notImplemented(name),
  }))
}

/**
 * Register the four placeholders.
 * @param tools - the host registry, or `undefined` when the surface is absent.
 * @returns the names actually registered (empty when `tools` is absent).
 */
export function registerPlaceholderTools(tools: ToolRegistryLike | undefined): string[] {
  if (tools === undefined) return []
  const registered: string[] = []
  const disposers: (() => void)[] = []
  try {
    for (const definition of placeholderTools()) {
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
