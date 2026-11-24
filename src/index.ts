/**
 * dsh-oh-my-whale — plugin entry (FR-15, Story 1.1).
 *
 * `apply` is the only thing the host calls. It validates the entry's `config:`
 * block against the single zod schema (AD-26), assembles the runtime, and writes
 * exactly one load-confirmation line to stderr.
 *
 * The line is written by the plugin itself rather than through `ctx.logger`,
 * because the host keeps plugin logs in an in-memory ring buffer whose only
 * exporter is inside boot and only forwards `warn`/`error`. It is deliberately
 * *not* written to `omw.log`: Story 1.3 asserts that a broken database produces
 * exactly one `omw.log` line, and a load line there would break that count.
 * @module
 */
import { registerOmwCommand, type CommandRegistryLike, type DoctorView } from './seams/commands.ts'
import { parseConfig } from './seams/config.ts'
import type { Logger } from './seams/logger.ts'
import { PERSONA_SECTION_NAME } from './seams/prompt-composer.ts'
import { startRuntime, type RuntimeContext } from './seams/runtime.ts'

/** Cordis service the plugin needs before it mounts. */
export const inject = ['systemPrompt']

/**
 * Validated configuration type.
 *
 * Exported as a type only. The host's own `Config` export expects a schemastery
 * schema; the single source of truth here is the zod schema in
 * `seams/config.ts`, which `apply` applies at mount time. A runtime schema
 * export would be a second, divergent source of truth.
 */
export type { Config } from './seams/config.ts'

/** The zod schema, re-exported for tests and the doctor. */
export { configSchema, parseConfig, resolvePaths } from './seams/config.ts'

/**
 * Seams the caller may override.
 *
 * Production never passes this. `omw doctor` does: its fifth check mounts the
 * built entry for real, and a file logger there would append a second `omw.log`
 * line to a run that is allowed exactly one.
 */
export interface ApplySeams {
  readonly logger?: Logger
}

/** The context slice `apply` relies on. */
export interface ApplyContext extends RuntimeContext {
  /**
   * Cordis effect registrar; used to tie the runtime to the plugin fiber.
   *
   * The disposer may return a promise: shutting the runtime down drains queued
   * writes before the handle closes, and a host that honours the return value
   * waits for that.
   */
  effect?: (callback: () => (() => void | Promise<void>) | undefined) => unknown
}

/**
 * Render the one load-confirmation line.
 * @param state - degradation state after assembly.
 * @param dataDir - resolved plugin data directory.
 * @param sectionRegistered - whether the identity section really reached the host.
 * @returns the line, terminated with a newline.
 */
export function loadedLine(state: string, dataDir: string, sectionRegistered = true): string {
  // A rejected section must not be reported as if it had been injected.
  const section = sectionRegistered ? PERSONA_SECTION_NAME : 'none'
  return `[omw] loaded state=${state} section=${section} data=${dataDir}\n`
}

/**
 * Mount the plugin.
 *
 * An invalid configuration throws instead of degrading: a wrong config is a
 * deployment mistake the operator must see, not a runtime fault to hide. The
 * message names the key and the received type, never a value of a secret.
 * @param ctx - the host context.
 * @param config - the entry's `config:` block (unknown keys are preserved).
 * @param seams - optional logger override, used by `omw doctor`.
 * @throws when the configuration fails validation.
 */
export function apply(ctx: ApplyContext, config?: unknown, seams?: ApplySeams): void {
  const parsed = parseConfig(config ?? {})
  if (!parsed.ok) {
    const summary = parsed.issues
      .map(issue => `${issue.key} (received ${issue.received}; ${issue.message})`)
      .join('; ')
    throw new Error(`omw: invalid config: ${summary}`)
  }

  const runtime = startRuntime({
    ctx,
    config: parsed.config,
    ...(seams?.logger === undefined ? {} : { logger: seams.logger }),
  })
  process.stderr.write(loadedLine(runtime.state, runtime.paths.dataDir, runtime.loaded.sectionRegistered))

  // The chat surface is user-facing, so it is registered in every state: a plugin
  // that stepped aside is exactly when `/omw doctor` has something to report. A
  // registry failure must not cost the load, so it is contained here.
  const disposeCommand = (() => {
    const commands = resolveCommandRegistry(ctx)
    if (commands === undefined) return undefined
    try {
      return registerOmwCommand(commands, (): DoctorView => ({
        state: runtime.state,
        ...(runtime.code === undefined ? {} : { code: runtime.code }),
        config: runtime.config,
        paths: runtime.paths,
        ...(runtime.db === undefined ? {} : { db: runtime.db }),
        logger: runtime.logger,
        sectionRegistered: runtime.loaded.sectionRegistered,
        sectionChars: runtime.sectionChars,
        tools: runtime.loaded.tools,
      }), () => runtime.write, () => runtime.evidence)
    } catch {
      return undefined
    }
  })()

  if (typeof ctx.effect === 'function') {
    // The cleanup returns the drain promise on purpose: disposing while a write
    // is still queued must not close the handle underneath it. A host that
    // awaits its effect disposers therefore waits for the queue, and one that
    // does not still gets the same ordering inside the promise.
    ctx.effect(() => () => {
      disposeCommand?.()
      return runtime.dispose()
    })
  }
}

/**
 * Find the command registry without triggering Cordis's injection guard.
 * @param ctx - the context slice the plugin holds.
 * @returns the registry, or `undefined` when this harness exposes no command surface.
 */
function resolveCommandRegistry(ctx: RuntimeContext): CommandRegistryLike | undefined {
  if (typeof ctx.get !== 'function') return undefined
  try {
    const service = ctx.get('commands')
    return typeof service === 'object' && service !== null
      && typeof (service as { register?: unknown }).register === 'function'
      ? service as CommandRegistryLike
      : undefined
  } catch {
    return undefined
  }
}
