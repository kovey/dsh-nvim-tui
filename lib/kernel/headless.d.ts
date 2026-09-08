import type { App } from './app.js';
export declare function installHeadless(app: App): {
    /** Dump the active chat + session list to the dump path, then quit. */
    dumpAndQuit: () => Promise<void>;
    /** Arm the headless watchdog (boot calls this where the timer used to
     *  start, after the resume sequence — timing unchanged). */
    startWatchdog: () => void;
    /** Headless e2e: kick one real agent turn with the configured prompt. */
    kick: () => void;
};
