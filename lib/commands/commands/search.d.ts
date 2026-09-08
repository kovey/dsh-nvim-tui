import type { App } from '../../kernel/app.js';
/** /search <query> — cross-session full-text search → picker → resume. */
export declare const searchCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installSearchCommand(app: App): void;
