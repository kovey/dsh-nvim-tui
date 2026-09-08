import type { App } from '../../kernel/app.js';
/** /memory [delete <id>] — list / delete project memory files. */
export declare const memoryCommand: (app: App, a: string | undefined) => void;
export declare function installMemoryCommand(app: App): void;
