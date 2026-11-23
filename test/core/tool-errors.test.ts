/**
 * `src/core/tool-errors.ts`: the closed vocabulary and the id scrubbing (AD-3, AD-25).
 *
 * Every assertion here is about a boundary the rest of the plugin relies on: a
 * caller branches on the code, and no engine message leaves the process carrying
 * a node id while a business key that merely contains `id` survives intact.
 */
import { describe, expect, it } from 'vitest'

import {
  TOOL_ERROR_CODES,
  ToolError,
  isToolErrorCode,
  sanitizeEngineText,
  toolCodeForWriteFailure,
  toolError,
  writeFailureError,
  writeQueueError,
} from '../../src/core/tool-errors.ts'
import { WriteQueueError } from '../../src/store/commits/queue.ts'
import type { WriteFailure } from '../../src/store/commits/engine.ts'

const UNIQUE: WriteFailure = {
  kind: 'unique',
  details: { fields: ['mem_key', 'active_slot'], existingId: 3, conflictingId: 7 },
}
const READ_ONLY: WriteFailure = { kind: 'read-only', operation: 'commitTransaction' }
const CLOSED: WriteFailure = { kind: 'closed' }
const ENGINE: WriteFailure = { kind: 'engine', code: 'TDB_INVALID_INPUT', outcome: 'not_committed' }

describe('tool errors: the closed vocabulary', () => {
  it('names seven codes, with E_CONFLICT as the one this story added', () => {
    expect([...TOOL_ERROR_CODES]).toEqual([
      'E_BUDGET',
      'E_TIMEOUT',
      'E_DEGRADED',
      'E_BOUNDARY',
      'E_GATE_DOWN',
      'E_CONFLICT',
      'E_NOT_IMPLEMENTED',
    ])
  })

  it('recognises a code and rejects anything else', () => {
    expect(isToolErrorCode('E_CONFLICT')).toBe(true)
    expect(isToolErrorCode('E_NOT_A_CODE')).toBe(false)
    expect(isToolErrorCode(undefined)).toBe(false)
    expect(isToolErrorCode(7)).toBe(false)
  })

  it('carries the code on a real Error so a caller can branch and still throw it', () => {
    const failure = toolError('E_GATE_DOWN', '写面未就绪')
    expect(failure).toBeInstanceOf(ToolError)
    expect(failure).toBeInstanceOf(Error)
    expect(failure.name).toBe('ToolError')
    expect(failure.code).toBe('E_GATE_DOWN')
    expect(failure.message).toBe('写面未就绪')
  })
})

describe('tool errors: a write failure becomes a tool code', () => {
  it('keeps E_CONFLICT for a uniqueness violation only', () => {
    expect(toolCodeForWriteFailure(UNIQUE)).toBe('E_CONFLICT')
  })

  it('calls every other failure a gate, never a conflict', () => {
    expect(toolCodeForWriteFailure(READ_ONLY)).toBe('E_GATE_DOWN')
    expect(toolCodeForWriteFailure(CLOSED)).toBe('E_GATE_DOWN')
    expect(toolCodeForWriteFailure(ENGINE)).toBe('E_GATE_DOWN')
  })
})

describe('tool errors: one sentence per failure kind', () => {
  it('explains a uniqueness violation as an identity change that is not this story', () => {
    const failure = writeFailureError(UNIQUE, '写入补丁表')
    expect(failure.code).toBe('E_CONFLICT')
    expect(failure.message).toBe('写入补丁表：业务键已被另一条活动版本占用（改写属 2.3）')
  })

  it('names the read-only handle and the operation it refused', () => {
    const failure = writeFailureError(READ_ONLY, '写入补丁表')
    expect(failure.code).toBe('E_GATE_DOWN')
    expect(failure.message).toBe('写入补丁表：数据库句柄只读，写面未就绪（commitTransaction）')
  })

  it('says the handle is closed', () => {
    const failure = writeFailureError(CLOSED, '写入补丁表')
    expect(failure.code).toBe('E_GATE_DOWN')
    expect(failure.message).toBe('写入补丁表：数据库句柄已关闭')
  })

  it('quotes the engine code and outcome without quoting the engine message', () => {
    const failure = writeFailureError(ENGINE, '写入补丁表')
    expect(failure.code).toBe('E_GATE_DOWN')
    expect(failure.message).toBe('写入补丁表：引擎拒绝写入（TDB_INVALID_INPUT，not_committed）')
  })

  it('falls back to unknown when the engine reported no outcome', () => {
    const failure = writeFailureError({ kind: 'engine', code: 'TDB_GENERIC', outcome: undefined }, '写入补丁表')
    expect(failure.message).toBe('写入补丁表：引擎拒绝写入（TDB_GENERIC，unknown）')
  })

  it('passes a queue failure through with its own code and message', () => {
    const failure = writeQueueError(new WriteQueueError('E_TIMEOUT', '写任务超过 30ms 未完成'))
    expect(failure.code).toBe('E_TIMEOUT')
    expect(failure.message).toBe('写任务超过 30ms 未完成')
  })
})

describe('tool errors: scrubbing an engine message', () => {
  it('replaces the structured conflict fields with a placeholder', () => {
    expect(sanitizeEngineText('existing_id: 3 与 conflicting_id=7')).toBe('<id> 与 <id>')
  })

  it('replaces the engine wording that names a node in Chinese', () => {
    // The `冲突` prefix is part of the match, so it is replaced with the id — the
    // reader still learns that a conflict happened from the surrounding sentence.
    expect(sanitizeEngineText('字段 ["mem_key"] 的键已被节点 1 占用，冲突节点 2')).toBe(
      '字段 ["mem_key"] 的键已被<id> 占用，<id>',
    )
    expect(sanitizeEngineText('节点 ID 12 不可写')).toBe('<id> 不可写')
    expect(sanitizeEngineText('节点：9 已失效')).toBe('<id> 已失效')
  })

  it('replaces a bare id assignment', () => {
    expect(sanitizeEngineText('id: 12 / id=34')).toBe('<id> / <id>')
  })

  it('keeps a business key whose third segment is the word id', () => {
    const text = 'assertion:Elliott:id:12 与节点 5'
    expect(sanitizeEngineText(text)).toBe('assertion:Elliott:id:12 与<id>')
  })

  it('keeps every legal three- and four-segment key', () => {
    const text = 'pref:Elliott:reply_style:concise / pred:mood / scene:Elliott:mood:xx'
    expect(sanitizeEngineText(text)).toBe(text)
  })

  it('leaves a message with no ids untouched', () => {
    expect(sanitizeEngineText('写队列已关闭，不再接受写入')).toBe('写队列已关闭，不再接受写入')
  })
})
