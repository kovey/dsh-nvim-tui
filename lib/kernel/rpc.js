const handlers = new Map();
/** Register a `dsh-*` notification handler (install time). Idempotent by
 *  design: the runner row can be reloaded (hmr) in the same process — a
 *  re-apply must overwrite the same owner's handler, never throw. An
 *  overwrite is always a same-owner re-apply in practice; log it so a
 *  real double-registration mistake is still visible. */
export function registerNvimNotification(method, label, fn) {
    if (handlers.has(method))
        console.warn(`[dsh-nvim-tui] nvim notification handler overwritten: ${method}`);
    handlers.set(method, { label, fn });
}
/** The whole nvim-notification surface: one guarded table lookup. Unknown
 *  methods are diag-logged (never fail-loud); every handler runs inside the
 *  shared guard — a throw becomes an error-log line + chat notice instead
 *  of an unhandled rejection killing the dsh process. */
export function dispatchNvimNotification(app, method, args) {
    const entry = handlers.get(method);
    if (entry === undefined) {
        app.exitDiag('unknown-notification', method);
        return Promise.resolve();
    }
    return app.guard(entry.label, () => Promise.resolve(entry.fn(app, args)))();
}
