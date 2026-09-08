import type { App } from '../../kernel/app.js';
export declare const glanceCommand: (app: App, a: string | undefined) => void;
/** /cost — accumulated usage + cost for the active session. */
export declare function installGlanceCommand(app: App): void;
