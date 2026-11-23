/**
 * The only embedding channel (AD-23).
 *
 * Everything that can go wrong is named here as a transport-level failure kind;
 * mapping those kinds onto the closed runtime codes is the caller's job
 * (`seams/runtime.ts`), because `store/` may not depend on `core/`.
 *
 * Three rules are load-bearing: the credential is read from the environment and
 * never leaves this function, a single call is capped at 2s so a write never
 * blocks on it, and `401`/`402` are terminal for the vector path — they are
 * never retried (AD-19).
 * @module
 */
/** How one embedding call failed, in transport terms. */
export type EmbeddingFailureKind =
  /** The configured environment variable is unset or empty. */
  | 'missing-credential'
  /** The provider rejected the credential (`401`/`403`). */
  | 'auth'
  /** The provider reports an exhausted balance (`402`). */
  | 'quota'
  /** The call exceeded the per-call ceiling. */
  | 'timeout'
  /** The provider returned vectors of a different width than the database. */
  | 'dimension'
  /** Anything else: network error, 5xx, unparsable body. Retryable, closes nothing. */
  | 'transient'

/** One transport-level failure, carrying only what a diagnostic may print. */
export interface EmbeddingFailure {
  readonly kind: EmbeddingFailureKind
  /** Provider status, when the failure came from an HTTP response. */
  readonly status?: number
  readonly message: string
  /** Environment-variable name, never its value. */
  readonly apiKeyEnv?: string
  /** Expected width, for `dimension` failures. */
  readonly expected?: number
  /** Actual width, for `dimension` failures. */
  readonly actual?: number
}

/** Result of one embedding call. */
export type EmbeddingResult =
  | { readonly ok: true; readonly vectors: readonly (readonly number[])[]; readonly model: string }
  | { readonly ok: false; readonly failure: EmbeddingFailure }

/** Everything one call needs. */
export interface EmbeddingOptions {
  /** Absolute endpoint URL. */
  readonly endpoint: string
  readonly model: string
  /** Name of the environment variable holding the key — never the key itself. */
  readonly apiKeyEnv: string
  /** Environment to read the key from; defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>
  /** Per-call ceiling in milliseconds (AD-19: 2s). */
  readonly timeoutMs: number
  /** Expected vector width; a different width closes the vector path. */
  readonly dim: number
  /** Injectable transport, so tests assert zero network calls. */
  readonly fetchImpl?: typeof fetch
  /** Caller cancellation, combined with the per-call ceiling. */
  readonly signal?: AbortSignal
}

/** Shape of the OpenAI-compatible embeddings response we consume. */
interface EmbeddingResponseBody {
  data?: { embedding?: unknown; index?: unknown }[]
  model?: string
}

/** Turn an unknown body into an ordered list of vectors, or report why not. */
function parseVectors(body: unknown): number[][] | null {
  if (typeof body !== 'object' || body === null) return null
  const entries = (body as EmbeddingResponseBody).data
  if (!Array.isArray(entries)) return null
  const ordered = [...entries].sort((left, right) => {
    const leftIndex = typeof left.index === 'number' ? left.index : 0
    const rightIndex = typeof right.index === 'number' ? right.index : 0
    return leftIndex - rightIndex
  })
  const vectors: number[][] = []
  for (const entry of ordered) {
    if (!Array.isArray(entry.embedding)) return null
    const vector = entry.embedding.filter((value): value is number => typeof value === 'number')
    if (vector.length !== entry.embedding.length) return null
    vectors.push(vector)
  }
  return vectors
}

/**
 * Embed a batch of texts.
 *
 * Never throws: every failure is a value, because the write path must complete
 * whether or not the vector can be produced.
 * @param texts - up to 16 texts (AD-23); longer batches are rejected as transient.
 * @param options - endpoint, model, credential variable, budgets and transport.
 * @returns the vectors, or the transport-level failure.
 */
export async function embed(texts: readonly string[], options: EmbeddingOptions): Promise<EmbeddingResult> {
  // An empty batch needs no credential: nothing is sent, so nothing is missing.
  if (texts.length === 0) return { ok: true, vectors: [], model: options.model }
  const env = options.env ?? process.env
  const key = env[options.apiKeyEnv]
  if (key === undefined || key.trim() === '') {
    return {
      ok: false,
      failure: { kind: 'missing-credential', message: `${options.apiKeyEnv} is not set`, apiKeyEnv: options.apiKeyEnv },
    }
  }
  if (texts.length > 16) {
    return { ok: false, failure: { kind: 'transient', message: `batch of ${texts.length} exceeds the 16-item limit` } }
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  let response: Response
  try {
    response = await fetchImpl(options.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model: options.model, input: texts }),
      signal,
    })
  } catch (error) {
    const name = (error as { name?: unknown }).name
    const kind: EmbeddingFailureKind = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'transient'
    return { ok: false, failure: { kind, message: error instanceof Error ? error.message : String(error) } }
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      failure: {
        kind: 'auth',
        status: response.status,
        message: 'the provider rejected the credential',
        apiKeyEnv: options.apiKeyEnv,
      },
    }
  }
  if (response.status === 402) {
    return { ok: false, failure: { kind: 'quota', status: 402, message: 'the provider reports an exhausted balance' } }
  }
  if (!response.ok) {
    return { ok: false, failure: { kind: 'transient', status: response.status, message: `HTTP ${response.status}` } }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    return { ok: false, failure: { kind: 'transient', message: error instanceof Error ? error.message : String(error) } }
  }
  const vectors = parseVectors(body)
  if (vectors === null) {
    return { ok: false, failure: { kind: 'transient', message: 'the response did not contain vectors' } }
  }
  if (vectors.length !== texts.length) {
    return {
      ok: false,
      failure: {
        kind: 'transient',
        message: `expected ${texts.length} vectors, received ${vectors.length}`,
      },
    }
  }
  for (const vector of vectors) {
    if (vector.length !== options.dim) {
      return {
        ok: false,
        failure: {
          kind: 'dimension',
          message: 'embedding width does not match db.dim',
          expected: options.dim,
          actual: vector.length,
        },
      }
    }
  }
  return { ok: true, vectors, model: options.model }
}
