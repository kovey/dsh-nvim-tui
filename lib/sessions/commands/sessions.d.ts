import type { App } from '../../kernel/app.js';
export declare const sessionsCommand: (app: App, arg?: string) => Promise<void>;
export declare function installSessionsCommand(app: App): void;
