import type { App } from '../../kernel/app.js';
export declare const rewindCommand: (app: App, a: string | undefined) => Promise<void>;
/** /queue — pending-message queue (official QueueDock counterpart):
 *  view queued turns and next-step input, edit / remove rows, clear all. */
export declare function installRewindCommand(app: App): void;
