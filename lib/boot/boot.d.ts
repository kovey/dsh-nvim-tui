import type { App } from '../kernel/app.js';
/** Synchronous runtime-domain defaults — MUST run before every other
 *  install: install bodies push disposers into runtime.hostDisposers
 *  (statusline/commands/…), so the domain needs its shape from t=0.
 *  Also registers the runtime-owned notifications (quit / reasoning). */
export declare function installRuntime(app: App): void;
export declare function boot(app: App): Promise<void>;
