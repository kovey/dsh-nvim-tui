import type { App } from '../../kernel/app.js';
/** /plugins — read-only host loader inventory (official Plugins
 *  settings tab counterpart), rendered in a scrollable float like
 *  /sessions and the other listing commands. */
export declare const pluginsCommand: (app: App) => Promise<void>;
export declare function installPluginsCommand(app: App): void;
