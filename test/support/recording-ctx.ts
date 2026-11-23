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
import type { SystemPromptLike } from '../../src/seams/prompt-composer.ts'
import type { ToolDefinitionLike, ToolRegistryLike } from '../../src/seams/tools.ts'

/** One recorded `systemPrompt.section` call. */
export interface RecordedSection {
  readonly name: string
  readonly order: number
  readonly text: string
}

/** One recorded `systemPrompt.context` call. */
export interface RecordedContext {
  readonly name: string
  readonly order: number
  readonly text: string
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
  /** Run every recorded disposer, newest first. */
  dispose(): void
}

/** Resolve the text a host would see (the composer passes a string). */
function textOf(value: string | (() => string)): string {
  return typeof value === 'function' ? value() : value
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
  const disposers: Array<() => void> = []
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
      return track(sections, { name: section.name, order: section.order, text: textOf(section.text) })
    },
    context(context) {
      return track(contexts, { name: context.name, order: context.order, text: textOf(context.text) })
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
        ? { get: (name: string) => (name === 'tools' ? registry : undefined) }
        : options.withTools === false ? {} : { tools: registry }),
      ...(options.withHomePath === false ? {} : { dshHomePath: (...segments: string[]) => join(home, ...segments) }),
    },
    sections,
    contexts,
    tools,
    definitions,
    get disposed() {
      return disposed
    },
    dispose() {
      while (disposers.length > 0) disposers.pop()?.()
      disposed += 1
    },
  }
}