import type { App } from '../../kernel/app.js';
/** /model [provider/model]: picker without an argument, direct switch with. */
export declare const pickModel: (app: App, arg: string | undefined) => Promise<void>;
export declare function installModelCommand(app: App): void;
