import type { App } from '../../kernel/app.js';
/** /models — provider/model catalog popup (sessions-style browse + act):
 *  current selection, live providers with their configured models
 *  (Enter switches), and not-yet-assembled providers pointing at their
 *  settings section. */
export declare const modelsCommand: (app: App) => Promise<void>;
export declare function installModelsCommand(app: App): void;
