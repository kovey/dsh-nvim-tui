import type { App } from '../../kernel/app.js';
/** /steer <directive> — inject steering for the nearest step. */
export declare const steerCommand: (app: App, a: string | undefined) => void;
export declare function installSteerCommand(app: App): void;
