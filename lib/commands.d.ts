import type { App } from './app.js';
/** Fill the commands module's App slots and register its commands. */
export declare function installCommands(app: App): void;
/** Boot-phase drain (moved out of boot): input that arrived before the
 *  first agent was ready. */
export declare function drainPendingInput(app: App): void;
