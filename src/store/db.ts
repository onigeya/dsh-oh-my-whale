/**
 * The only file in the repository that touches `triviumdb` (AD-2, AD-4).
 *
 * Opening, closing, dimension, node count and the snapshot primitives all live
 * here so that no other layer carries the storage engine's semantics. Nothing
 * in `src/store/` imports another layer of this plugin.
 * @module
 */
import { TriviumDB, restoreSnapshot, verifySnapshot } from 'triviumdb'
import type { SnapshotManifest, StorageInfo } from 'triviumdb'

/** The live database handle. Treat it as opaque outside `src/store/`. */
export type Database = TriviumDB

/** Re-exported so callers describe snapshots without importing `triviumdb`. */
export type { SnapshotManifest, StorageInfo }

/** How to open the single-file database. */
export interface OpenOptions {
  /** Absolute path of the `.tdb` file. */
  readonly file: string
  /** Vector dimension; a mismatch with an existing file is a gate failure, not a repair. */
  readonly dim: number
  /** Kernel memory budget in MiB. */
  readonly memoryLimitMb: number
  /**
   * Open without any possibility of writing. Used by `omw doctor`, which must
   * leave every node — and the file itself — untouched.
   */
  readonly readOnly?: boolean
}

/** Result of opening the database; a failure is a value, never an exception. */
export type OpenOutcome =
  | { readonly ok: true; readonly db: Database }
  | {
    readonly ok: false
    readonly reason: string
    readonly errorCode?: string
    /** For a dimension mismatch: the width stored in the file. */
    readonly fileDim?: number
    /** For a dimension mismatch: the width the caller asked for. */
    readonly requestedDim?: number
  }

/**
 * Open (or create) the database.
 *
 * A corrupt, locked or unreadable file must degrade the plugin rather than
 * crash the host, so every constructor failure is captured here.
 * @param options - file, dimension, memory budget and access mode.
 * @returns the handle, or a readable reason.
 */
export function openDatabase(options: OpenOptions): OpenOutcome {
  try {
    const db = new TriviumDB(options.file, {
      dim: options.dim,
      memoryLimitMb: options.memoryLimitMb,
      accessMode: options.readOnly === true ? 'readOnly' : 'readWrite',
      // Building the vector index on open would put engine work on the boot path.
      autoBuildQuiver: false,
    })
    return { ok: true, db }
  } catch (error) {
    const code = (error as { code?: unknown }).code
    const record = error as { details?: Record<string, unknown>; expected?: unknown; got?: unknown } | null
    // The engine reports a mismatch as `expected` = the width stored in the file
    // and `got` = the width the caller requested.
    const fileDim = numberOf(record?.details?.['expected'] ?? record?.expected)
    const requestedDim = numberOf(record?.details?.['got'] ?? record?.got)
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      ...(typeof code === 'string' ? { errorCode: code } : {}),
      ...(fileDim === undefined ? {} : { fileDim }),
      ...(requestedDim === undefined ? {} : { requestedDim }),
    }
  }
}

/** A finite number, or `undefined` for anything else. */
function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Close the handle. A failure is returned, never thrown, because closing happens
 * on teardown paths that must keep unwinding.
 * @param db - the handle to close.
 * @returns `undefined` on success, or the failure message.
 */
export function closeDatabase(db: Database): string | undefined {
  try {
    db.close()
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** The vector dimension actually stored in the file. */
export function databaseDim(db: Database): number {
  return db.dim()
}

/** Number of nodes stored in the file. */
export function nodeCount(db: Database): number {
  return db.nodeCount()
}

/** Storage metadata (format versions, access mode, node count). */
export function storageInfo(db: Database): StorageInfo {
  return db.storageInfo()
}

/** Every node id in the file. Read-only; used by the Epic 1 scans. */
export function allNodeIds(db: Database): number[] {
  return db.allNodeIds()
}

/** Read one node's payload, or `null` when the id is absent. */
export function readPayload(db: Database, id: number): unknown {
  const payload = db.getPayload(id)
  return payload ?? null
}

/**
 * Write a snapshot of the live database into `directory`.
 * @param db - an open handle.
 * @param directory - destination directory, which must not already exist.
 * @param generationId - caller-chosen generation label recorded in the manifest.
 * @returns the published manifest.
 */
export function createSnapshotTo(db: Database, directory: string, generationId: string): SnapshotManifest {
  return db.createSnapshot(directory, generationId)
}

/**
 * Verify a snapshot directory's manifest and file checksums.
 * @param directory - snapshot root to verify.
 * @returns the verified manifest; its `complete` flag is the caller's check.
 */
export function verifySnapshotDir(directory: string): SnapshotManifest {
  return verifySnapshot(directory)
}

/**
 * Restore a snapshot over a destination file.
 *
 * Every handle to `destination` must already be closed: on Windows an open
 * handle makes this fail, which is exactly the readable error the restore path
 * promises to surface.
 * @param source - verified snapshot directory.
 * @param destination - database file to replace.
 * @returns the restored manifest.
 */
export function restoreSnapshotFrom(source: string, destination: string): SnapshotManifest {
  return restoreSnapshot(source, destination)
}
