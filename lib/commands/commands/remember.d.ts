import type { App } from '../../kernel/app.js';
/** /remember <text> — append to .dsh/memory/global.md. */
export declare const rememberCommand: (app: App, a: string | undefined) => void;
export declare function installRememberCommand(app: App): void;
