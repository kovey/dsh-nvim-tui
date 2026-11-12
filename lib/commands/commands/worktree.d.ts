import type { App } from '../../kernel/app.js';
export declare const worktreeCommand: (app: App, a?: string) => Promise<void>;
export declare function installWorktreeCommand(app: App): void;
