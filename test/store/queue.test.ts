/**
 * Story 2.1 — the single write queue: one task at a time, three lanes, and a
 * close that still drains (AC22, AC31).
 *
 * The queue is where the read-then-write guarantee lives, so the tests care
 * about ordering as much as results: a patch table must not observe a live
 * version that another task replaced in between.
 * @module
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createWriteQueue,
  DEFAULT_MAX_PENDING,
  QUEUE_LOG_CODES,
  STARVATION_BOUND,
  WriteQueueError,
  type WriteQueue,
} from '../../src/store/commits/queue.ts'

/** Collect every report a queue emits. */
function recorder(): { codes: string[]; report: (code: string, detail: string) => void } {
  const codes: string[] = []
  return { codes, report: (code: string) => { codes.push(code) } }
}

/** A promise plus its resolver, for tests that need to hold a task open. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => {}
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}

describe('queue: one task at a time', () => {
  it('runs tasks in arrival order and never overlaps them', async () => {
    const queue = createWriteQueue()
    const events: string[] = []
    const hold = gate()

    const first = queue.run({ lane: 'conversation', run: async () => {
      events.push('first:start')
      await hold.promise
      events.push('first:end')
    } })
    const second = queue.run({ lane: 'conversation', run: () => { events.push('second') } })

    await Promise.resolve()
    expect(events).toEqual(['first:start'])
    hold.open()
    await Promise.all([first, second])

    expect(events).toEqual(['first:start', 'first:end', 'second'])
  })

  it('returns the task value to its own caller', async () => {
    const queue = createWriteQueue()

    await expect(queue.run({ lane: 'conversation', run: () => 7 })).resolves.toBe(7)
  })

  it('counts the running task as pending, so idle means nothing is in flight', async () => {
    const queue = createWriteQueue()
    const hold = gate()
    const running = queue.run({ lane: 'conversation', run: () => hold.promise })

    expect(queue.pending).toBe(1)
    hold.open()
    await running
    expect(queue.pending).toBe(0)
  })
})

describe('queue: lanes', () => {
  it('runs a waiting conversation task before a waiting snapshot task', async () => {
    const queue = createWriteQueue()
    const order: string[] = []
    const hold = gate()
    const blocker = queue.run({ lane: 'conversation', run: () => hold.promise })

    const snapshot = queue.run({ lane: 'snapshot', run: () => { order.push('snapshot') } })
    const conversation = queue.run({ lane: 'conversation', run: () => { order.push('conversation') } })
    const solidify = queue.run({ lane: 'solidify', run: () => { order.push('solidify') } })

    hold.open()
    await Promise.all([blocker, snapshot, conversation, solidify])

    expect(order).toEqual(['conversation', 'snapshot', 'solidify'])
  })

  it('serves the higher lane first even when it arrived last', async () => {
    const queue = createWriteQueue()
    const order: string[] = []
    const hold = gate()
    const blocker = queue.run({ lane: 'conversation', run: () => hold.promise })

    const first = queue.run({ lane: 'solidify', run: () => { order.push('first-solidify') } })
    const second = queue.run({ lane: 'snapshot', run: () => { order.push('second-snapshot') } })
    const third = queue.run({ lane: 'conversation', run: () => { order.push('third-conversation') } })

    hold.open()
    await Promise.all([blocker, first, second, third])

    expect(order).toEqual(['third-conversation', 'second-snapshot', 'first-solidify'])
  })

  it('serves a stranded lower lane once it has been passed over enough times', async () => {
    const queue = createWriteQueue()
    const order: string[] = []
    const hold = gate()
    const blocker = queue.run({ lane: 'conversation', run: () => hold.promise })

    // One solidify task, then more conversation work than the starvation bound:
    // lane order alone would run every conversation task first.
    const stranded = queue.run({ lane: 'solidify', run: () => { order.push('solidify') } })
    const chatty = Array.from({ length: STARVATION_BOUND + 2 }, (_unused, index) =>
      queue.run({ lane: 'conversation', run: () => { order.push(`conversation-${index}`) } }))

    hold.open()
    await Promise.all([blocker, stranded, ...chatty])

    // The solidify write lands inside the window instead of after every chat turn.
    const position = order.indexOf('solidify')
    expect(position).toBeGreaterThanOrEqual(0)
    expect(position).toBeLessThan(order.length - 1)
  })
})

describe('queue: refusing work', () => {
  it('refuses a task once the queue is closed, with E_GATE_DOWN', async () => {
    const queue = createWriteQueue()
    queue.close()

    const refused = queue.run({ lane: 'conversation', run: () => 1 })

    await expect(refused).rejects.toBeInstanceOf(WriteQueueError)
    await expect(refused).rejects.toMatchObject({ toolCode: 'E_GATE_DOWN' })
    expect(queue.closed).toBe(true)
  })

  it('still runs the tasks that were queued before the close', async () => {
    const queue = createWriteQueue()
    const hold = gate()
    const ran: string[] = []
    const blocker = queue.run({ lane: 'conversation', run: () => hold.promise })
    const queued = queue.run({ lane: 'conversation', run: () => { ran.push('queued') } })

    queue.close()
    hold.open()
    await Promise.all([blocker, queued])

    expect(ran).toEqual(['queued'])
  })

  it('reports and refuses once the depth limit is reached', async () => {
    const log = recorder()
    const queue: WriteQueue = createWriteQueue({ maxPending: 1, reporter: log })
    const hold = gate()
    const running = queue.run({ lane: 'conversation', run: () => hold.promise })

    const refused = queue.run({ lane: 'conversation', run: () => 2 })

    await expect(refused).rejects.toMatchObject({ toolCode: 'E_GATE_DOWN' })
    await expect(refused).rejects.toThrow('写队列已满（1），请稍后重试')
    expect(log.codes).toEqual([QUEUE_LOG_CODES.full])
    hold.open()
    await running
  })

  it('defaults to the documented limits', () => {
    expect(DEFAULT_MAX_PENDING).toBe(1000)
  })
})

describe('queue: a task that runs too long', () => {
  it('fails the caller with E_TIMEOUT and reports it, without undoing the work', async () => {
    vi.useFakeTimers()
    try {
      const log = recorder()
      const queue = createWriteQueue({ taskTimeoutMs: 50, reporter: log })
      const ran: string[] = []
      const slow = queue.run({ lane: 'conversation', run: () => { ran.push('started'); return new Promise<void>(() => {}) } })

      const settled = expect(slow).rejects.toMatchObject({ toolCode: 'E_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(50)
      await settled

      expect(log.codes).toContain(QUEUE_LOG_CODES.timeout)
      expect(ran).toEqual(['started'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops the queue after a timeout, because a straggler may still be writing', async () => {
    vi.useFakeTimers()
    try {
      const queue = createWriteQueue({ taskTimeoutMs: 20 })
      const after: string[] = []
      // The task never settles: the engine call it issued may still be running,
      // so nothing may start behind it without breaking one-write-at-a-time.
      const slow = queue.run({ lane: 'conversation', run: () => new Promise<void>(() => {}) })
      const queued = queue.run({ lane: 'conversation', run: () => { after.push('next') } })

      // Attach both expectations before the timeout fires: the queue refuses the
      // waiting task the moment the straggler poisons it, and a rejection with no
      // handler attached yet reads as an unhandled rejection.
      const slowSettled = expect(slow).rejects.toMatchObject({ toolCode: 'E_TIMEOUT' })
      const queuedSettled = expect(queued).rejects.toThrow('写队列已停用')
      await vi.advanceTimersByTimeAsync(20)
      await slowSettled
      await queuedSettled

      expect(after).toEqual([])
      // The slot stays occupied: the write may still land inside the engine.
      expect(queue.pending).toBe(1)
      await expect(queue.run({ lane: 'conversation', run: () => 1 })).rejects.toThrow('写队列已停用')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('queue: idling', () => {
  it('resolves immediately when nothing is in flight', async () => {
    const queue = createWriteQueue()

    await expect(queue.idle()).resolves.toBeUndefined()
  })

  it('resolves only after the running task finished', async () => {
    const queue = createWriteQueue()
    const hold = gate()
    const running = queue.run({ lane: 'conversation', run: () => hold.promise })
    let idle = false
    const waiting = queue.idle().then(() => { idle = true })

    await Promise.resolve()
    expect(idle).toBe(false)
    hold.open()
    await Promise.all([running, waiting])

    expect(idle).toBe(true)
  })
})