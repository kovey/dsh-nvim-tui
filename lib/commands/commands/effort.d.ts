import type { App } from '../../kernel/app.js';
/** /effort [off|high|max|auto] */
export declare const effortCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installEffortCommand(app: App): void;
