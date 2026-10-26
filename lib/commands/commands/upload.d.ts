import type { App } from '../../kernel/app.js';
export declare const uploadCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installUploadCommand(app: App): void;
