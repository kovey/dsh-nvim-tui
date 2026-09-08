/**
 * Harness host-event wiring: owner modules register their handlers at
 * install time (statusline → agent/status, subagents → subagent/*,
 * transcript → workflow/*, commands → approval/questions); boot runs ONE
 * loop that subscribes them all. Keeps boot free of per-event registration
 * boilerplate.
 *
 * @module dsh-nvim-tui/host-events
 */
import type { App } from './app.js'

export type HostEventHandler = (app: App, ...args: unknown[]) => unknown

const handlers = new Map<string, HostEventHandler>()

/** Register a host-event handler (install time). Idempotent by design: the
 *  runner row can be reloaded (hmr) in the same process — a re-apply must
 *  overwrite the same owner's handler, never throw. An overwrite is always
 *  a same-owner re-apply in practice; log it so a real double-registration
 *  mistake is still visible. */
export function registerHostHandler(name: string, fn: HostEventHandler): void {
  if (handlers.has(name)) console.warn(`[dsh-nvim-tui] host handler overwritten: ${name}`)
  handlers.set(name, fn)
}

/** Subscribe every registered handler (boot calls this once, after nvim
 *  connects; events cannot fire before any session exists). */
export function wireHostEvents(app: App): void {
  for (const [name, fn] of handlers) {
    app.slices.runtime.hostDisposers.push(app.runtimeCtx.on(name, (...args: unknown[]) => {
      // A throwing handler must not kill the host (alpha.4 fail-loud turns
      // an unhandled rejection into process.exit) — diag-log and continue.
      try {
        return fn(app, ...args)
      } catch (err) {
        app.exitDiag('host-event-error', name, err instanceof Error ? (err.stack ?? err.message) : String(err))
        return undefined
      }
    }))
  }
}
