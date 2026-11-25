/**
 * A recording host context for offline verification.
 *
 * Tests mount the real `apply` against this context and inspect what the plugin
 * registered: sections, runtime contexts, tool definitions, disposers. No live
 * host, no model turn, no network, no business writes.
 * @module
 */
import { join } from 'node:path'
import type { HomePath } from '../../src/seams/config.ts'
import type { PromptAssemblyContext, SystemPromptLike } from '../../src/seams/prompt-composer.ts'
import type { ToolDefinitionLike, ToolRegistryLike } from '../../src/seams/tools.ts'

/** One recorded `systemPrompt.section` call. */
export interface RecordedSection {
  readonly name: string
  readonly order: number
  /** The text as a host would read it at registration time. */
  readonly text: string
  /** The raw registration value, when it is a provider. */
  readonly render?: (context?: PromptAssemblyContext) => string
}

/** One recorded `systemPrompt.context` call. */
export interface RecordedContext {
  readonly name: string
  readonly order: number
  /** The text as a host would read it at registration time. */
  readonly text: string
  /** The raw registration value, when it is a provider. */
  readonly render?: (context?: PromptAssemblyContext) => string
}

/** Options for {@link createRecordingContext}. */
export interface RecordingContextOptions {
  /** Home root used by the recorded `dshHomePath`. */
  readonly home?: string
  /** Whether to record a tool registry. Defaults to true. */
  readonly withTools?: boolean
  /** Whether to provide `dshHomePath`. Defaults to true. */
  readonly withHomePath?: boolean
  /**
   * Whether to expose the registry only through `get('tools')`.
   *
   * A live Cordis context has no `tools` property worth reading; the plugin has to
   * resolve the optional service through `ctx.get`. This option lets a test
   * observe exactly that path.
   */
  readonly toolsViaGet?: boolean
  /**
   * Extra host services, resolvable through `get(name)`.
   *
   * The plugin reads `sessions` and `sessionProjections` behind `ctx.get` so an
   * absent service degrades instead of throwing. Providing them here is how a
   * test exercises the branch that reads a real cache reading.
   */
  readonly services?: Readonly<Record<string, unknown>>
}

/** A context that records instead of rendering. */
export interface RecordingContext {
  readonly ctx: {
    systemPrompt: SystemPromptLike
    tools?: ToolRegistryLike
    /** Optional-service accessor; present when `toolsViaGet` is set. */
    get?: (name: string) => unknown
    dshHomePath?: HomePath
    /** Cordis effect registrar; `dispose()` runs everything registered through it. */
    effect: (callback: () => (() => void) | undefined) => (() => void) | undefined
  }
  /** Sections registered so far, in call order. */
  readonly sections: readonly RecordedSection[]
  /** Runtime contexts registered so far, in call order. */
  readonly contexts: readonly RecordedContext[]
  /** Tool names registered so far, in call order. */
  readonly tools: readonly string[]
  /** Full definitions registered so far, in call order. */
  readonly definitions: readonly ToolDefinitionLike[]
  /** How many disposers have run. */
  readonly disposed: number
  /**
   * Render the prompt the way a host would for one session.
   *
   * Sections and contexts registered as providers are called with
   * `{ session: { id } }`, in registration order; string ones read back as-is.
   * This is the only way a test can drive the injection audit row, because the
   * session id is handed over at assembly time and nowhere else.
   * @param sessionId - the session the host is assembling for.
   * @returns every rendered entry and their concatenation.
   */
  assemble(sessionId: string): { sections: RenderedEntry[]; text: string }
  /**
   * Run every recorded disposer, newest first.
   *
   * Awaited, because a disposer may drain a write queue before its handle goes
   * away: a caller that only fires and forgets would delete a scratch
   * directory while a transaction is still being written into it.
   */
  dispose(): Promise<void>
}

/** A section or context as it reads for one assembly. */
export interface RenderedEntry {
  readonly name: string
  readonly order: number
  readonly text: string
}

/** Resolve the text a host would see for one assembly context. */
function textOf(value: string | ((context?: PromptAssemblyContext) => string), context?: PromptAssemblyContext): string {
  return typeof value === 'function' ? value(context) : value
}

/**
 * Build a recording context.
 * @param options - home root and which surfaces to expose.
 * @returns the recorder and the context it exposes.
 */
export function createRecordingContext(options: RecordingContextOptions = {}): RecordingContext {
  const home = options.home ?? join(process.cwd(), '.omw-test')
  const sections: RecordedSection[] = []
  const contexts: RecordedContext[] = []
  const tools: string[] = []
  const definitions: ToolDefinitionLike[] = []
  const disposers: Array<() => void | Promise<void>> = []
  let disposed = 0

  /** Register a disposer that removes one recorded entry by identity. */
  const track = <T,>(list: T[], entry: T): (() => void) => {
    list.push(entry)
    const dispose = (): void => {
      const index = list.indexOf(entry)
      if (index >= 0) list.splice(index, 1)
    }
    disposers.push(dispose)
    return dispose
  }

  const effect = (callback: () => (() => void) | undefined): (() => void) | undefined => {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  }

  const systemPrompt: SystemPromptLike = {
    section(section) {
      const render = typeof section.text === 'function' ? section.text : undefined
      return track(sections, {
        name: section.name,
        order: section.order,
        text: textOf(section.text),
        ...(render === undefined ? {} : { render }),
      })
    },
    context(context) {
      const render = typeof context.text === 'function' ? context.text : undefined
      return track(contexts, {
        name: context.name,
        order: context.order,
        text: textOf(context.text),
        ...(render === undefined ? {} : { render }),
      })
    },
  }

  const registry: ToolRegistryLike = {
    register(definition) {
      const dispose = track(definitions, definition)
      tools.push(definition.name)
      return () => {
        dispose()
        const index = tools.indexOf(definition.name)
        if (index >= 0) tools.splice(index, 1)
      }
    },
  }

  return {
    ctx: {
      systemPrompt,
      effect,
      ...(options.toolsViaGet === true
        ? {
            get: (name: string) => {
              if (name === 'tools') return registry
              return options.services?.[name]
            },
          }
        : {
            ...(options.withTools === false ? {} : { tools: registry }),
            // Services are reached through `get` in the plugin, so a test that
            // provides them must also provide the accessor.
            ...(options.services === undefined
              ? {}
              : { get: (name: string) => (name === 'tools' ? registry : options.services?.[name]) }),
          }),
      ...(options.withHomePath === false ? {} : { dshHomePath: (...segments: string[]) => join(home, ...segments) }),
    },
    sections,
    contexts,
    tools,
    definitions,
    get disposed() {
      return disposed
    },
    assemble(sessionId: string) {
      const context: PromptAssemblyContext = { session: { id: sessionId } }
      const entries = [...sections, ...contexts]
        .slice()
        .sort((left, right) => left.order - right.order)
        .map(entry => ({
          name: entry.name,
          order: entry.order,
          text: entry.render === undefined ? entry.text : entry.render(context),
        }))
      return { sections: entries, text: entries.map(entry => entry.text).join('\n\n') }
    },
    async dispose() {
      while (disposers.length > 0) await disposers.pop()?.()
      disposed += 1
    },
  }
}