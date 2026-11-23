/**
 * The runtime log: one JSON event per line, written to `<dataDir>/omw.log`.
 *
 * The line shape is fixed — `{ts, level, code, detail}` — because it is what a
 * user greps when the plugin misbehaves. Values are redacted by key, so a
 * credential can never reach the file even if a caller passes one by accident;
 * key names and environment-variable names stay readable on purpose, because
 * "which variable is missing" is the whole point of the message.
 * @module
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Severity of one log event. */
export type LogLevel = 'info' | 'warn' | 'error'

/** One line of `omw.log`. */
export interface LogEvent {
  /** ISO-8601 UTC instant with milliseconds. */
  readonly ts: string
  readonly level: LogLevel
  /** One of the eight closed runtime codes, or a doctor-only structural code. */
  readonly code: string
  /** Structured context; secrets are already redacted. */
  readonly detail: Readonly<Record<string, unknown>>
}

/** Destination of rendered log lines. */
export interface LogSink {
  /** Append exactly one rendered line (the newline is the caller's). */
  write(line: string): void
}

/** Keys whose values must never reach the log. */
const SECRET_KEY = /(^|[._-])(api[-_]?key|token|secret|password|passwd|authorization|credential|bearer)($|[._-])/i
/** Keys ending in `env` name an environment variable and are intentionally printable. */
const ENV_NAME_KEY = /env$/i

/** How deep redaction follows nested structures before it stops and summarizes. */
const MAX_REDACT_DEPTH = 6

/** Render a value as a type name when it is not printable. */
function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * Deep-redact a detail object.
 *
 * A secret-looking key becomes `"[redacted]"`; a key naming an environment
 * variable is kept, because it holds a name rather than a value.
 * @param value - the value to copy with redaction applied.
 * @param key - the key this value was reached by, if any.
 * @returns a redacted structural copy.
 */
export function redact(
  value: unknown,
  key?: string,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (key !== undefined && SECRET_KEY.test(key) && !ENV_NAME_KEY.test(key)) return '[redacted]'
  // Diagnostics are the reason a detail object exists: an Error must stay
  // readable as name+message instead of collapsing to `{}`, and an instant must
  // stay an instant.
  if (value instanceof Error) {
    const error: Record<string, unknown> = { name: value.name, message: value.message }
    if (typeof value.stack === 'string' && depth < MAX_REDACT_DEPTH) error['stack'] = value.stack
    return error
  }
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Map) {
    if (depth >= MAX_REDACT_DEPTH) return `Map(${value.size})`
    const entries: Record<string, unknown> = {}
    for (const [entryKey, entryValue] of value) {
      entries[String(entryKey)] = redact(entryValue, String(entryKey), depth + 1, seen)
    }
    return entries
  }
  if (value instanceof Set) {
    if (depth >= MAX_REDACT_DEPTH) return `Set(${value.size})`
    return [...value].map(entry => redact(entry, undefined, depth + 1, seen))
  }
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) return '[circular]'
    if (depth >= MAX_REDACT_DEPTH) return typeName(value)
    seen.add(value)
    if (Array.isArray(value)) return value.map(entry => redact(entry, undefined, depth + 1, seen))
    const copy: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      copy[childKey] = redact(childValue, childKey, depth + 1, seen)
    }
    return copy
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return typeName(value)
  return value
}

/** A sink that appends to a file, creating the directory on first write. */
export function createAppendFileSink(file: string): LogSink {
  return {
    write(line: string): void {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, line, 'utf8')
    },
  }
}

/** A sink that keeps every line in memory, for tests and for the doctor. */
export interface MemorySink extends LogSink {
  readonly lines: string[]
  clear(): void
}

/** Create an in-memory sink. */
export function createMemorySink(): MemorySink {
  const lines: string[] = []
  return {
    lines,
    write(line: string): void { lines.push(line) },
    clear(): void { lines.length = 0 },
  }
}

/** The logger facade handed to every other module. */
export interface Logger {
  /** Append one event and return it. */
  log(level: LogLevel, code: string, detail?: Record<string, unknown>): LogEvent
  info(code: string, detail?: Record<string, unknown>): LogEvent
  warn(code: string, detail?: Record<string, unknown>): LogEvent
  error(code: string, detail?: Record<string, unknown>): LogEvent
  /** Every event this logger emitted, in order (test and doctor observation). */
  readonly events: readonly LogEvent[]
}

/** Options for {@link createLogger}. */
export interface LoggerOptions {
  /** Clock, injectable so timestamps are deterministic in tests. */
  readonly now?: () => Date
  /** Whether to also keep events in memory. Defaults to true. */
  readonly keepEvents?: boolean
}

/**
 * Create a logger over a sink.
 *
 * Writing is synchronous: "exactly one line" is an assertion other epics rely
 * on, and an asynchronous append would make it unobservable.
 * @param sink - destination of rendered lines.
 * @param options - clock and retention overrides.
 * @returns the logger facade.
 */
export function createLogger(sink: LogSink, options: LoggerOptions = {}): Logger {
  const now = options.now ?? (() => new Date())
  const keep = options.keepEvents !== false
  const events: LogEvent[] = []
  const emit = (level: LogLevel, code: string, detail: Record<string, unknown> = {}): LogEvent => {
    const event: LogEvent = Object.freeze({
      ts: now().toISOString(),
      level,
      code,
      detail: redact(detail) as Record<string, unknown>,
    })
    if (keep) events.push(event)
    sink.write(`${JSON.stringify(event)}\n`)
    return event
  }
  return {
    events,
    log: emit,
    info: (code, detail) => emit('info', code, detail),
    warn: (code, detail) => emit('warn', code, detail),
    error: (code, detail) => emit('error', code, detail),
  }
}
