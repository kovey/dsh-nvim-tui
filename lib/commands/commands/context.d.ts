import type { App } from '../../kernel/app.js';
/** /context — context composition breakdown (official client's
 *  occupancy ring panel counterpart): ~used/capacity, heuristic
 *  composition rows, claim window. */
export declare const contextCommand: (app: App) => Promise<void>;
export declare function installContextCommand(app: App): void;
