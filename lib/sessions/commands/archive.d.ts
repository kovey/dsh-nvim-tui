import type { App } from '../../kernel/app.js';
/** /archive [id] — hide a session from every list (non-destructive). */
export declare const archiveCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installArchiveCommand(app: App): void;
