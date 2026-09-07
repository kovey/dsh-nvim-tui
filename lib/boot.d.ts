import type { App } from './app.js';
/** Synchronous runtime-domain defaults — MUST run before every other
 *  install: install bodies push disposers into runtime.hostDisposers
 *  (statusline/commands/…), so the domain needs its shape from t=0. */
export declare function installRuntime(app: App): void;
export declare function boot(app: App): Promise<void>;
