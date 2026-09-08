import type { App } from '../../kernel/app.js';
export declare const exportCommand: (app: App) => Promise<void>;
/** /rewind — pick a user-message boundary, truncate the session after
 *  it, and rebuild the chat from the remaining events. */
export declare function installExportCommand(app: App): void;
