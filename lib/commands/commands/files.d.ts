import type { App } from '../../kernel/app.js';
export declare const filesCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installFilesCommand(app: App): void;
