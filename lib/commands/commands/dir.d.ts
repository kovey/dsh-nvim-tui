import type { App } from '../../kernel/app.js';
/** /dir [路径] — navigable directory browser: Enter on a file opens it in a
 *  fresh nvim tab (directories descend inside the float). */
export declare const dirCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installDirCommand(app: App): void;
