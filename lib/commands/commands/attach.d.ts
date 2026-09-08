import type { App } from '../../kernel/app.js';
/** /attach [path] — image → durable attachment; file/dir → @-mention.
 *  Without an argument a directory picker selects the target. */
export declare const attachCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installAttachCommand(app: App): void;
