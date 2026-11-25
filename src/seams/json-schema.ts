/**
 * The JSON Schema node shape the host accepts for tool parameters and outputs.
 *
 * The host validates and projects these; the plugin only declares them. Keeping
 * the type here (rather than importing host internals) means the plugin has no
 * runtime dependency on the harness packages.
 * @module
 */

/** A JSON Schema node, permissive enough for the host's supported subset. */
export interface JsonSchemaNode {
  readonly type?: string | readonly string[]
  readonly description?: string
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>
  readonly required?: readonly string[]
  readonly items?: JsonSchemaNode
  readonly enum?: readonly unknown[]
  readonly const?: unknown
  readonly minimum?: number
  readonly maximum?: number
  readonly minLength?: number
  readonly maxLength?: number
  /** Lower bound of an array's length (`ops` must carry at least one entry). */
  readonly minItems?: number
  /** Upper bound of an array's length (a patch table is capped at 50 ops). */
  readonly maxItems?: number
  readonly additionalProperties?: boolean | JsonSchemaNode
  readonly anyOf?: readonly JsonSchemaNode[]
  readonly oneOf?: readonly JsonSchemaNode[]
  readonly default?: unknown
}
