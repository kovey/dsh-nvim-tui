import type { App } from '../../kernel/app.js';
/** /history — input history browser: newest first, Enter fills the input
 *  box with the selected entry (multi-line entries round-trip intact). */
export declare const historyCommand: (app: App) => void;
export declare function installHistoryCommand(app: App): void;
