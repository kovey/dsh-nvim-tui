import type { App } from '../../kernel/app.js';
export declare const hiddenGlance: Set<string>;
/** Restore the persisted visibility set (boot reads vim.g.dsh_tui_glance). */
export declare const restoreGlance: (saved: unknown) => void;
export declare const glanceCommand: (app: App, a: string | undefined) => void;
/** /cost — accumulated usage + cost for the active session. */
export declare function installGlanceCommand(app: App): void;
