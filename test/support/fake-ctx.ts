/**
 * Test support: recording contexts, temporary homes, and log readers.
 *
 * The recording context is the same one the plugin sees in tests, so a test and
 * a diagnosis observe exactly the same registrations.
 * @module
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger, createMemorySink, type Logger } from '../../src/seams/logger.ts'
import { createRecordingContext } from './recording-ctx.ts'

export { createRecordingContext }

/** A temporary `DSH_HOME`, removed by {@link TempHome.remove}. */
export interface TempHome {
  readonly dir: string
  /** Join a path inside the temp home. */
  path(...segments: string[]): string
  remove(): void
}

/**
 * Create a temporary `DSH_HOME`.
 * @param prefix - directory-name prefix, for readable failures.
 * @returns the handle.
 */
export function tempHome(prefix = 'omw-test-'): TempHome {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    path: (...segments: string[]) => join(dir, ...segments),
    remove: () => {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** A logger whose events are inspectable and never touch disk. */
export function memoryLogger(now: () => Date = () => new Date()): Logger {
  return createLogger(createMemorySink(), { now })
}

/** Read a JSONL file into parsed records; missing file yields `[]`. */
export function readJsonLines(file: string): Record<string, unknown>[] {
  try {
    return readFileSync(file, 'utf8')
      .split(/\r?\n/u)
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as Record<string, unknown>)
  } catch {
    return []
  }
}

/** Deterministic clock stepping one second per call from a fixed instant. */
export function steppingClock(start = Date.UTC(2026, 10, 23, 4, 0, 0)): () => Date {
  let current = start
  return () => {
    const value = new Date(current)
    current += 1000
    return value
  }
}
