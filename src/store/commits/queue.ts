/**
 * The single write queue (AD-4).
 *
 * Exactly one task runs at a time: a patch table plans and commits inside one
 * task, so the live version it read cannot be replaced between the read and the
 * write. Tasks arrive on three lanes — conversation outranks snapshot, snapshot
 * outranks solidify — and lane order decides who runs next: a waiting
 * conversation task goes before a snapshot task queued earlier.

 * Lane order alone would starve the lower lanes, because the conversation lane
 * can keep arriving for as long as the user keeps typing. So an entry also
 * counts how often it was passed over, and one that reaches
 * {@link STARVATION_BOUND} skips is served next regardless of lane: priority
 * decides the order of the work, but it may not postpone a write forever.
 *
 * The queue is *closable*, and closing is part of shutting down: `close()` makes
 * every later `run` fail with `E_GATE_DOWN` instead of queueing behind a handle
 * that is about to be closed, and `idle()` resolves once the running task and
 * everything queued before the close have finished.
 *
 * This module imports nothing from `src/core/`: the store layer below the
 * domain layer may not depend on it (AD-15), so a queue failure is a local
 * error carrying one of the closed codes, and `src/core/tool-errors.ts` turns
 * it into a tool error.
 * @module
 */

/** The three lanes, highest priority first. */
export const WRITE_LANES = ['conversation', 'snapshot', 'solidify'] as const

/** One lane. */
export type WriteLane = (typeof WRITE_LANES)[number]

/**
 * How many times a waiting task may be passed over before lane order stops
 * applying to it.
 *
 * Smaller than {@link DEFAULT_MAX_PENDING} by orders of magnitude on purpose:
 * the bound exists so a solidify task cannot be postponed indefinitely by a
 * steady stream of conversation writes, not so that the lanes race.
 */
export const STARVATION_BOUND = 8

/** Default most tasks that may wait before the queue refuses more. */
export const DEFAULT_MAX_PENDING = 1000

/** Default time one task may run before it is reported as timed out. */
export const DEFAULT_TASK_TIMEOUT_MS = 30_000

/** Logger codes the queue emits, each with a closed meaning. */
export const QUEUE_LOG_CODES = {
  /** The queue was full: the task was refused before it ran. */
  full: 'OMW_WRITE_QUEUE_FULL',
  /** The task ran past its timeout: the result is a failure, the work is not undone. */
  timeout: 'OMW_WRITE_TIMEOUT',
} as const

/** One queued task. */
export interface QueueTask<T> {
  readonly lane: WriteLane
  readonly run: () => Promise<T> | T
}

/** What a queue needs to report its own failures. */
export interface QueueReporter {
  /**
   * Record one operational failure.
   * @param code - one of {@link QUEUE_LOG_CODES}.
   * @param detail - a short, id-free description.
   */
  report(code: (typeof QUEUE_LOG_CODES)[keyof typeof QUEUE_LOG_CODES], detail: string): void
}

/** Options for {@link createWriteQueue}. */
export interface WriteQueueOptions {
  /** Most tasks that may wait; the default is {@link DEFAULT_MAX_PENDING}. */
  readonly maxPending?: number
  /** Time one task may run; the default is {@link DEFAULT_TASK_TIMEOUT_MS}. */
  readonly taskTimeoutMs?: number
  /** Where queue-level failures are reported. */
  readonly reporter?: QueueReporter
  /** A clock, injectable so a test can drive the timeout without waiting. */
  readonly now?: () => number
}

/** A failure the queue produced, before `core` turns it into a tool error. */
export class WriteQueueError extends Error {
  /** One of the closed tool codes the caller may report. */
  readonly toolCode: 'E_GATE_DOWN' | 'E_TIMEOUT'

  constructor(toolCode: 'E_GATE_DOWN' | 'E_TIMEOUT', message: string) {
    super(message)
    this.name = 'WriteQueueError'
    this.toolCode = toolCode
  }
}

/** The queue's public surface. */
export interface WriteQueue {
  /**
   * Run one task after every task ahead of it.
   * @param task - the lane and the work.
   * @returns the task's value.
   * @throws {WriteQueueError} when the queue is closed, full, or the task timed out.
   */
  run<T>(task: QueueTask<T>): Promise<T>
  /** Stop accepting work. Tasks already queued still run. */
  close(): void
  /** Resolve once nothing is running and nothing is waiting. */
  idle(): Promise<void>
  /** Tasks waiting or running. */
  readonly pending: number
  /** Whether {@link WriteQueue.close} has been called. */
  readonly closed: boolean
}

/** One task, with the promise its caller waits on. */
interface Entry {
  readonly lane: WriteLane
  readonly run: () => Promise<unknown> | unknown
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: unknown) => void
  /** How many times this task was passed over in favour of a higher lane. */
  skips: number
}

/**
 * Order two entries: lane first, then arrival.
 *
 * A comparator, not a priority heap: at most a few tasks are ever queued (the
 * depth limit is 1000 and the write path is one task per patch table), so a
 * linear scan is cheaper than maintaining a heap and much easier to reason about
 * when explaining why a task ran when it did.
 * @param lane - the lane to rank.
 * @returns the lane's rank, lower is sooner.
 */
function rank(lane: WriteLane): number {
  return WRITE_LANES.indexOf(lane)
}

/**
 * Create the process-wide write queue.
 *
 * `pending` counts the task that is running as well as the ones waiting: a
 * caller that sees `pending === 0` knows no write is in flight, which is exactly
 * the condition `dispose()` must wait for before closing the handle.
 * @param options - limits, reporter and clock.
 * @returns the queue.
 */
export function createWriteQueue(options: WriteQueueOptions = {}): WriteQueue {
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING
  const taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS
  const reporter = options.reporter
  const now = options.now ?? Date.now
  const waiting: Entry[] = []
  /** Resolvers for callers of {@link WriteQueue.idle}. */
  const idleWaiters: (() => void)[] = []
  let running = false
  let closed = false
  let depth = 0
  /** Set when a task timed out: its write may still be running, so no more may start. */
  let poisoned = false

  /** Wake every waiter the instant the queue is empty. */
  const settleIdle = (): void => {
    if (running || waiting.length > 0) return
    while (idleWaiters.length > 0) idleWaiters.shift()?.()
  }

  /** Run one task, then take the next. */
  const drain = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      while (waiting.length > 0 && !poisoned) {
        const next = takeNext()
        if (next === undefined) break
        await execute(next)
      }
      if (poisoned) {
        // Nothing may run behind a write whose outcome is unknown, so the work
        // still waiting is refused rather than left hanging forever.
        for (const entry of waiting.splice(0, waiting.length)) {
          depth -= 1
          entry.reject(new WriteQueueError('E_GATE_DOWN', '写队列已停用（上一次写入超时，库内状态未知），本次没有落库'))
        }
      }
    } finally {
      running = false
      settleIdle()
    }
  }

  /**
   * Remove and return the next task: the most-starved one, else the top lane.
   *
   * A task that has been passed over {@link STARVATION_BOUND} times is served
   * before any ranking, oldest first, so a steady stream of conversation writes
   * cannot postpone a snapshot or solidify write forever. Every task the pick
   * passes over has its counter raised, which is what makes the bound reachable.
   * @returns the task, or `undefined` when nothing is waiting.
   */
  function takeNext(): Entry | undefined {
    if (waiting.length === 0) return undefined
    const starved = waiting.findIndex(entry => entry.skips >= STARVATION_BOUND)
    if (starved >= 0) {
      // Already the most-starved entry: serving it costs nobody a skip.
      return waiting.splice(starved, 1)[0]
    }
    let best = 0
    for (let index = 1; index < waiting.length; index += 1) {
      const candidate = waiting[index]
      const current = waiting[best]
      if (candidate === undefined || current === undefined) break
      if (rank(candidate.lane) < rank(current.lane)) best = index
    }
    const [next] = waiting.splice(best, 1)
    for (const waitingEntry of waiting) waitingEntry.skips += 1
    return next
  }

  /**
   * Run one task, applying the timeout without cancelling the work.
   *
   * The timeout reports a failure; it does not abort the write. An engine call
   * already issued may still land, so the honest reading of a timeout is "this
   * write's outcome is unknown", not "this write failed".
   *
   * That is why a timeout *stops the queue*: one write at a time is the
   * guarantee every reader relies on, and it cannot be re-established around a
   * call that may still be executing. The task keeps its pending slot until it
   * really settles, so `pending === 0` keeps meaning nothing is in flight, and
   * `idle()` does not resolve while a straggler runs.
   *
   * A task that loses the race still settles its own promise here, so a late
   * outcome never becomes an unhandled rejection.
   * @param entry - the task.
   */
  async function execute(entry: Entry): Promise<void> {
    const startedAt = now()
    const work = Promise.resolve().then(() => entry.run())
    work.catch(() => {})
    let fired = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        fired = true
        const elapsed = now() - startedAt
        reporter?.report(QUEUE_LOG_CODES.timeout, `写任务超过 ${taskTimeoutMs}ms 未完成（${entry.lane}）`)
        reject(new WriteQueueError('E_TIMEOUT', `写任务超过 ${taskTimeoutMs}ms 未完成（${entry.lane}，已跑 ${elapsed}ms）`))
      }, taskTimeoutMs)
    })
    try {
      const value = await Promise.race([work, timedOut])
      if (timer !== undefined) clearTimeout(timer)
      // Settle the caller last: a caller that saw its promise settle while
      // `pending` still counted its own task would read an inconsistent queue.
      depth -= 1
      entry.resolve(value)
    } catch (thrown) {
      if (timer !== undefined) clearTimeout(timer)
      if (!fired) {
        depth -= 1
        entry.reject(thrown)
        return
      }
      poisoned = true
      entry.reject(thrown)
      // The slot stays occupied: the engine call may still be running, and
      // freeing the slot would let a second write overlap it. Release it only
      // when the straggler really settles -- `idle()` waits for exactly that.
      void work
        .catch(() => {})
        .then(() => {
          depth -= 1
          settleIdle()
        })
    }
  }

  return {
    run<T>(task: QueueTask<T>): Promise<T> {
      if (closed) {
        return Promise.reject(new WriteQueueError('E_GATE_DOWN', '写队列已关闭，不再接受写入'))
      }
      if (poisoned) {
        // A timed-out write may still be executing inside the engine; starting
        // another one would break the one-write-at-a-time guarantee that every
        // planner read depends on. Refuse until the next start.
        return Promise.reject(new WriteQueueError('E_GATE_DOWN', '写队列已停用（上一次写入超时，库内状态未知），请重启后再写'))
      }
      if (depth >= maxPending) {
        reporter?.report(QUEUE_LOG_CODES.full, `写队列深度已达 ${maxPending}，拒绝新任务（${task.lane}）`)
        return Promise.reject(new WriteQueueError('E_GATE_DOWN', `写队列已满（${maxPending}），请稍后重试`))
      }
      depth += 1
      return new Promise<T>((resolve, reject) => {
        waiting.push({
          lane: task.lane,
          run: task.run as () => Promise<unknown> | unknown,
          resolve: resolve as (value: unknown) => void,
          reject,
          skips: 0,
        })
        void drain()
      })
    },
    close(): void {
      closed = true
      // Tasks already queued still run: their callers are waiting on them.
      settleIdle()
    },
    idle(): Promise<void> {
      if (!running && waiting.length === 0) return Promise.resolve()
      return new Promise<void>(resolve => {
        idleWaiters.push(resolve)
      })
    },
    get pending(): number {
      return depth
    },
    get closed(): boolean {
      return closed
    },
  }
}
