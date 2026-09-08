import type { App } from '../../kernel/app.js';
/** /rename <title> — pin the active session's title. */
export declare const renameCommand: (app: App, a: string | undefined) => void;
export declare function installRenameCommand(app: App): void;
