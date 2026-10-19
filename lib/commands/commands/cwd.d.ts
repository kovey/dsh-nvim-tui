import type { App } from '../../kernel/app.js';
/** The host's committed directory for the active session, or undefined when
 *  the service is missing (pre-0.2.1 hosts) or nothing is active. */
export declare const sessionWorkingDir: (app: App) => string | undefined;
/** /cwd [路径] — show the session working directory, or move it.
 *  A relative path resolves against the CURRENT directory, which is what a
 *  person expects from `cd`. */
export declare const cwdCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installCwdCommand(app: App): void;
