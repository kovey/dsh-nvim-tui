import type { App } from '../../kernel/app.js';
/** /model [provider/model]: real catalog picker without an argument
 *  (pre-review: a decorative single-row picker — the catalog lived only in
 *  /models), validated direct switch with one. */
export declare const pickModel: (app: App, arg: string | undefined) => Promise<void>;
export declare function installModelCommand(app: App): void;
