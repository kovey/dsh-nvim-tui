import type { App } from '../../kernel/app.js';
/** /lines [路径] — lightweight file viewer: read-only float with the file's
 *  lines, `i` opens it for editing in a fresh tab. No argument → the
 *  directory picker selects the target. */
export declare const linesCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installLinesCommand(app: App): void;
