/**
 * The closed tool-error vocabulary (AD-25) and engine-text sanitisation (AD-3).
 *
 * A tool never lets a raw engine exception reach the model: the vocabulary is
 * closed so a caller can branch on the code, and every message is scrubbed of
 * node ids before it leaves the process. `E_CONFLICT` is the one code this story
 * adds to AD-25's five; the review loop records it so the spine can be corrected
 * in the retrospective rather than edited during a build.
 * @module
 */
import type { WriteFailure } from '../store/commits/engine.ts'
import type { WriteQueueError } from '../store/commits/queue.ts'

/**
 * Every code a tool may return.
 *
 * `E_NOT_IMPLEMENTED` belongs to the placeholder tools, which stay in place for
 * `recall`/`forget`/`explain` until their stories land.
 */
export const TOOL_ERROR_CODES = [
  'E_BUDGET',
  'E_TIMEOUT',
  'E_DEGRADED',
  'E_BOUNDARY',
  'E_GATE_DOWN',
  'E_CONFLICT',
  'E_NOT_IMPLEMENTED',
] as const

/** One code from {@link TOOL_ERROR_CODES}. */
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number]

/** Whether a value is a code this plugin may return. */
export function isToolErrorCode(value: unknown): value is ToolErrorCode {
  return typeof value === 'string' && (TOOL_ERROR_CODES as readonly string[]).includes(value)
}

/** A tool failure: a closed code plus a message that is already safe to show. */
export class ToolError extends Error {
  readonly code: ToolErrorCode

  constructor(code: ToolErrorCode, message: string) {
    super(message)
    this.name = 'ToolError'
    this.code = code
  }
}

/** Build a tool failure without `new`. */
export function toolError(code: ToolErrorCode, message: string): ToolError {
  return new ToolError(code, message)
}

/**
 * The tool code a write failure maps to.
 *
 * A uniqueness violation is the one failure with an identity meaning, so it
 * keeps `E_CONFLICT`; a handle that cannot write at all is a gate, not a
 * conflict, and must never be reported as one — the difference decides whether a
 * caller retries or gives up.
 * @param failure - the failure `src/store/commits/engine.ts` translated.
 * @returns the code a tool returns.
 */
export function toolCodeForWriteFailure(failure: WriteFailure): ToolErrorCode {
  return failure.kind === 'unique' ? 'E_CONFLICT' : 'E_GATE_DOWN'
}

/**
 * Turn one engine write failure into a tool error.
 *
 * The engine's own message never reaches the caller: `engine.ts` already dropped
 * it, so the sentence here is one `core` wrote and therefore knows is id-free.
 * @param failure - the translated failure.
 * @param operation - what the caller was trying to do, in Chinese.
 * @returns the error to throw.
 */
export function writeFailureError(failure: WriteFailure, operation: string): ToolError {
  const code = toolCodeForWriteFailure(failure)
  switch (failure.kind) {
    case 'unique':
      return toolError(code, `${operation}：业务键已被另一条活动版本占用（改写属 2.3）`)
    case 'read-only':
      return toolError(code, `${operation}：数据库句柄只读，写面未就绪（${failure.operation}）`)
    case 'closed':
      return toolError(code, `${operation}：数据库句柄已关闭`)
    case 'engine':
      return toolError(code, `${operation}：引擎拒绝写入（${failure.code}，${failure.outcome ?? 'unknown'}）`)
  }
}

/**
 * Turn one queue failure into a tool error.
 *
 * The queue carries the closed code as data rather than importing this module:
 * `src/store/**` may not depend on `src/core/**` (AD-15), so the vocabulary is
 * closed here and the queue only names a member of it.
 * @param error - the queue error.
 * @returns the error to throw.
 */
export function writeQueueError(error: WriteQueueError): ToolError {
  return toolError(error.toolCode, error.message)
}

/**
 * A three- or four-segment business key.
 *
 * The engine's own conflict message quotes node ids next to field names, and
 * `assertion:Elliott:id:12` is a *legal* key whose third segment happens to be
 * the word `id`. The pattern therefore has to be recognised before any bare-id
 * rule runs, or a sanitised message would silently rename a real key.
 */
const MEM_KEY_FRAGMENT = /\b[a-z_]+:[^\s:]+:[^\s:]+(?::[^\s:]+)?/gu

/** Placeholder marker used while real keys are held aside. */
const HOLD = '\u0000'

/** Rules that remove a node id from an engine message, applied in order. */
const NODE_ID_RULES: readonly (readonly [RegExp, string])[] = [
  // `existing_id: 3` / `conflicting_id=3` — the structured fields.
  [/(?:existing_id|conflicting_id)\s*[:=]\s*\d+/gu, '<id>'],
  // A bare `existing_id` / `conflicting_id` mention with no value.
  [/\b(?:existing_id|conflicting_id)\b/gu, '<id>'],
  // The engine's Chinese conflict wording: 节点 1 / 冲突节点 2 / 节点 ID 3.
  [/(?:冲突)?节点(?:\s*(?:ID|id))?\s*[:：]?\s*\d+/gu, '<id>'],
  // `id: 12` — but never inside a key, which is held aside above.
  [/\bid\s*[:=]\s*\d+/gu, '<id>'],
]

/**
 * Remove every node id from an engine-supplied string.
 *
 * The store's node id never leaves the process (AD-3): not through a tool
 * message, not through an audit row, not through a flag payload. Business keys
 * are preserved verbatim, including the ones that contain the word `id`.
 * @param text - engine message, possibly containing ids.
 * @returns the same message with ids replaced by `<id>`.
 */
export function sanitizeEngineText(text: string): string {
  const held: string[] = []
  const masked = text.replace(MEM_KEY_FRAGMENT, fragment => {
    held.push(fragment)
    return `${HOLD}${held.length - 1}${HOLD}`
  })
  let output = masked
  for (const [pattern, replacement] of NODE_ID_RULES) output = output.replace(pattern, replacement)
  return output.replace(/\u0000(\d+)\u0000/gu, (_match, index: string) => held[Number(index)] ?? '')
}
