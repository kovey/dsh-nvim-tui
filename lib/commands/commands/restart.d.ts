import type { App } from '../../kernel/app.js';
/** /restart — respawn the dsh command and exit this process. */
export declare const restartCommand: (app: App) => Promise<void>;
export declare function installRestartCommand(app: App): void;
