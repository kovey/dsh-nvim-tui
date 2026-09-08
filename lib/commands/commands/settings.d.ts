import type { App } from '../../kernel/app.js';
/** /settings [edit] — settings overview; `edit` opens settings.yaml in
 *  a new nvim tab (the official document is hot-reloaded). */
export declare const settingsCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installSettingsCommand(app: App): void;
