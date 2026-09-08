const handlers = new Map();
/** Register a host-event handler (install time). Idempotent by design: the
 *  runner row can be reloaded (hmr) in the same process — a re-apply must
 *  overwrite the same owner's handler, never throw. An overwrite is always
 *  a same-owner re-apply in practice; log it so a real double-registration
 *  mistake is still visible. */
export function registerHostHandler(name, fn) {
    if (handlers.has(name))
        console.warn(`[dsh-nvim-tui] host handler overwritten: ${name}`);
    handlers.set(name, fn);
}
/** Subscribe every registered handler (boot calls this once, after nvim
 *  connects; events cannot fire before any session exists). */
export function wireHostEvents(app) {
    for (const [name, fn] of handlers) {
        app.slices.runtime.hostDisposers.push(app.runtimeCtx.on(name, (...args) => fn(app, ...args)));
    }
}
