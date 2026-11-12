import type { App } from '../../kernel/app.js';
/** Bounded filename/path search for the TUI `/files search` picker. */
export declare const searchWorkspaceFiles: (root: string, query: string, limit?: number) => string[];
export declare const filesCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installFilesCommand(app: App): void;
