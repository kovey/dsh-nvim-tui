import type { App } from '../../kernel/app.js';
export declare const queueCommand: (app: App) => Promise<void>;
export declare function installQueueCommand(app: App): void;
