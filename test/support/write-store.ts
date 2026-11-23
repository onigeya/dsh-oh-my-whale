/**
 * A throwaway write store for the Story 2.1 tests.
 *
 * Every test in this story needs the same three things: a temp home, an open
 * writable handle with a small dimension (so a zero vector costs nothing) and a
 * teardown that closes the handle before deleting the directory. The handle is
 * closed first because Windows refuses to remove a file that is still open.
 * @module
 */
import { mkdirSync } from 'node:fs'
import { afterEach } from 'vitest'
import { closeDatabase, openDatabase, type Database } from '../../src/store/db.ts'
import { tempHome, type TempHome } from './fake-ctx.ts'

/** Dimensions used by the write tests: enough to be a real vector, cheap to fill. */
export const TEST_DIM = 4

/** One opened store, with the home it lives in. */
export interface WriteStore {
  readonly home: TempHome
  readonly db: Database
  readonly dbFile: string
  readonly dataDir: string
}

const homes: TempHome[] = []
const handles: Database[] = []

/**
 * Open a fresh, writable store in a temp home.
 * @param prefix - a name that says which test file leaked a handle.
 * @returns the open store.
 */
export function openWriteStore(prefix = 'omw-write-'): WriteStore {
  const home = tempHome(prefix)
  homes.push(home)
  const dataDir = home.path('oh-my-whale')
  mkdirSync(dataDir, { recursive: true })
  const dbFile = home.path('oh-my-whale', 'oh-my-whale.tdb')
  const opened = openDatabase({ file: dbFile, dim: TEST_DIM, memoryLimitMb: 256 })
  if (!opened.ok) throw new Error(opened.reason)
  handles.push(opened.db)
  return { home, db: opened.db, dbFile, dataDir }
}

/**
 * Create the two indexes bootstrap would have created.
 *
 * Tests about uniqueness need the index to exist: without it the engine happily
 * stores two live versions of one key, which is exactly the state the gateway
 * promises cannot happen. `ensureIndexes` is private, so the shapes are repeated
 * here, and `test/store/schema.test.ts` is what pins them to the real bootstrap.
 * @param store - an open, writable store.
 */
export function installWriteIndexes(store: WriteStore): void {
  store.db.createUniqueCompositeIndex(['mem_key', 'active_slot'])
  store.db.createCompositeIndex(['mem_key', 'valid_from'])
}

/** Close every handle this file opened, then delete every home. */
export function closeWriteStores(): void {
  while (handles.length > 0) {
    const db = handles.pop()
    if (db !== undefined) closeDatabase(db)
  }
  while (homes.length > 0) homes.pop()?.remove()
}

afterEach(closeWriteStores)