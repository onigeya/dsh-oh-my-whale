/**
 * The single source of truth for configuration (AD-26).
 *
 * Every key, default and bound lives here and nowhere else: no other module may
 * carry a fallback constant, because a second copy of a default is a silent
 * second configuration. Environment variables carry credentials only, and only
 * under the name `embedding.apiKeyEnv` selects.
 *
 * Unknown keys are preserved verbatim. The host passes the patch entry's
 * `config:` block straight through, and a key added by a later epic must not
 * turn an existing profile into a startup failure.
 * @module
 */
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'

/** Default vector dimension of the single-file database. */
export const DEFAULT_DIM = 1024
/** Default kernel memory budget, in MiB. */
export const DEFAULT_MEMORY_LIMIT_MB = 512
/** Default number of retained snapshots. */
export const DEFAULT_SNAPSHOT_KEEP = 7
/** Default identity-section budget, in characters (AD-7). */
export const DEFAULT_PERSONA_MAX_CHARS = 1200
/** Default state-tail budget, in estimated tokens (AD-7). */
export const DEFAULT_TAIL_MAX_TOKENS = 30
/** Default embedding model. */
export const DEFAULT_EMBEDDING_MODEL = 'BAAI/bge-m3'
/** Default environment variable holding the embedding credential. */
export const DEFAULT_API_KEY_ENV = 'SILICONFLOW_API_KEY'
/**
 * Default embedding endpoint, as an absolute URL.
 *
 * A relative path would make every call fail in `fetch` with a `TypeError` that the
 * write path has to swallow as `transient`, leaving the vector path unusable out
 * of the box and the failure invisible.
 */
export const DEFAULT_EMBEDDING_ENDPOINT = 'https://api.siliconflow.cn/v1/embeddings'
/** Default recall result count (AD-8). */
export const DEFAULT_TOP_K = 5
/**
 * Estimated tokens one recalled item is budgeted for, used only to derive the
 * injection pool (AD-7).
 *
 * AD-7 and NFR-9 bound the recall tier by item count ("≤5 条"), never by tokens, so the pool
 * needs a per-item estimate before the three tiers can be added up. 60 is the
 * conservative side of a one-sentence memory plus its label; it is a derivation
 * input, not a fourth budget the other documents have to agree with.
 */
export const RECALL_ITEM_BUDGET_TOKENS = 60
/** Most predicates a model may introduce in one local day (AD-27). */
export const DEFAULT_MAX_NEW_PREDS_PER_DAY = 20

const dbSchema = z.object({
  /** Explicit database file; when set, its directory becomes `<dataDir>`. */
  path: z.string().min(1).optional(),
  /** Vector dimension. Changing it after the database exists requires `migrate`. */
  dim: z.number().int().positive().default(DEFAULT_DIM),
  /** Kernel memory budget in MiB. */
  memoryLimitMb: z.number().int().positive().default(DEFAULT_MEMORY_LIMIT_MB),
})

const snapshotSchema = z.object({
  /** Number of snapshots retained under `<dataDir>/snapshots` (AD-14). */
  keep: z.number().int().min(1).default(DEFAULT_SNAPSHOT_KEEP),
})

const embeddingSchema = z.object({
  model: z.string().min(1).default(DEFAULT_EMBEDDING_MODEL),
  /** Name of the environment variable holding the key — never the key itself. */
  apiKeyEnv: z.string().min(1).default(DEFAULT_API_KEY_ENV),
  /** Absolute endpoint URL; a relative path is rejected at load, not at first write. */
  endpoint: z.url().default(DEFAULT_EMBEDDING_ENDPOINT),
  /** Per-call ceiling; the write path never waits longer than this (AD-19). */
  timeoutMs: z.number().int().positive().default(2000),
})

const injectSchema = z.object({
  /** Identity section character budget (AD-7). */
  personaMaxChars: z.number().int().positive().default(DEFAULT_PERSONA_MAX_CHARS),
  /** State-tail token budget (AD-7). */
  tailMaxTokens: z.number().int().positive().default(DEFAULT_TAIL_MAX_TOKENS),
})

const recallSchema = z.object({
  topK: z.number().int().min(1).max(8).default(DEFAULT_TOP_K),
  candidatePool: z.number().int().min(1).default(12),
})

const tboxSchema = z.object({
  /**
   * Predicates the model may introduce per local day before new facts degrade to
   * scene text. Reaching the cap is not an error: the assertion is still kept,
   * it just stops creating registry entries (AD-27).
   */
  maxNewPredsPerDay: z.number().int().min(1).default(DEFAULT_MAX_NEW_PREDS_PER_DAY),
})

/** The complete configuration schema: keys, defaults and bounds. */
// Every leaf carries its own `.default()`, so a partial block such as
// `{ db: { dim: 1024 } }` keeps the other keys. These group defaults only cover a
// block that is absent entirely; each is the value an empty block parses to.
const DEFAULT_DB = dbSchema.parse({})
const DEFAULT_SNAPSHOT = snapshotSchema.parse({})
const DEFAULT_EMBEDDING = embeddingSchema.parse({})
const DEFAULT_INJECT = injectSchema.parse({})
const DEFAULT_RECALL = recallSchema.parse({})
const DEFAULT_TBOX = tboxSchema.parse({})

export const configSchema = z.object({
  db: dbSchema.default(DEFAULT_DB),
  snapshot: snapshotSchema.default(DEFAULT_SNAPSHOT),
  embedding: embeddingSchema.default(DEFAULT_EMBEDDING),
  inject: injectSchema.default(DEFAULT_INJECT),
  recall: recallSchema.default(DEFAULT_RECALL),
  tbox: tboxSchema.default(DEFAULT_TBOX),
})

/** Validated configuration, with any host-supplied unknown keys preserved. */
export type Config = z.infer<typeof configSchema> & { readonly [key: string]: unknown }

/** Raw configuration as handed to `apply`, before validation. */
export type ConfigInput = unknown

/** One concrete configuration problem, addressed to the key the user must edit. */
export interface ConfigIssue {
  /** Dotted key path, e.g. `db.dim`. */
  readonly key: string
  /** JSON type actually received, e.g. `string`, `number`, `undefined`. */
  readonly received: string
  /** Human-readable constraint that was violated. */
  readonly message: string
}

/** Result of validating a configuration block. */
export type ConfigParseResult =
  | { readonly ok: true; readonly config: Config }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] }

/** Name of the JSON type a value carries, for diagnostics ("received: string"). */
export function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** Read the value at a dotted/bracketed zod issue path, without throwing. */
function valueAtPath(input: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = input
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<PropertyKey, unknown>)[segment]
  }
  return current
}

/**
 * Validate a raw configuration block.
 *
 * Unknown keys are retained: a key this epic does not know must not break a
 * profile that a later epic configured.
 * @param input - the patch entry's `config:` block.
 * @returns the validated configuration, or the list of offending keys.
 */
export function parseConfig(input: ConfigInput): ConfigParseResult {
  const raw = input ?? {}
  const parsed = configSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue): ConfigIssue => {
      const key = issue.path.length === 0 ? '<root>' : issue.path.join('.')
      const received = describeType(valueAtPath(raw, issue.path))
      return { key, received, message: issue.message }
    })
    return { ok: false, issues }
  }
  return { ok: true, config: { ...(raw as Record<string, unknown>), ...parsed.data } as Config }
}

/** Absolute paths derived from `<dataDir>` (all artifacts live under one root). */
export interface Paths {
  /** `<DSH_HOME>/oh-my-whale`, or the directory of an explicitly configured `db.path`. */
  readonly dataDir: string
  /** The single-file database. */
  readonly dbFile: string
  /** The one-line-per-event runtime log. */
  readonly logFile: string
  /** Snapshot root; only `ops/snapshots.ts` may write or delete here. */
  readonly snapshotsDir: string
}

/** Append path segments to the DeepSeek Harness home, as `ctx.dshHomePath` does. */
export type HomePath = (...segments: string[]) => string

/**
 * Resolve every artifact path from the configuration.
 *
 * `<dataDir>` is `ctx.dshHomePath('oh-my-whale')` unless `db.path` is set
 * explicitly, in which case the configured file wins and its directory becomes
 * the data root.
 * @param config - validated configuration.
 * @param home - the host's `dshHomePath` joiner.
 * @returns absolute artifact paths.
 */
export function resolvePaths(config: Config, home: HomePath): Paths {
  const configured = config.db.path
  const dataDir = configured === undefined
    ? home('oh-my-whale')
    : dirname(resolve(configured))
  const dbFile = configured === undefined ? join(dataDir, 'oh-my-whale.tdb') : resolve(configured)
  return {
    dataDir,
    dbFile,
    logFile: join(dataDir, 'omw.log'),
    snapshotsDir: join(dataDir, 'snapshots'),
  }
}

/**
 * Name of the audit file for one instant: `audit-YYYYMMDD.jsonl`, split by
 * local calendar day.
 * @param date - the instant to name.
 * @returns the file name, without a directory.
 */
export function auditFileName(date: Date): string {
  const stamp = `${String(date.getFullYear()).padStart(4, '0')}${
    String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  return `audit-${stamp}.jsonl`
}

/** Absolute audit-file path for one instant. */
export function auditFilePath(paths: Paths, date: Date): string {
  return join(paths.dataDir, auditFileName(date))
}
