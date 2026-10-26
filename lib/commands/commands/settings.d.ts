import type { App } from '../../kernel/app.js';
/** Type one setting value. Mirrors `/settings set`: booleans, null, numbers
 *  and JSON literals are typed; everything else is a plain string. Exported so
 *  the rule is asserted without touching a settings document. */
export declare const parseSettingValue: (raw: string) => unknown;
/** /settings [form|edit|set …] — overview; `form` edits a top-level field
 *  with a picker + prompt; `edit` opens the raw settings document. */
export declare const settingsCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installSettingsCommand(app: App): void;
