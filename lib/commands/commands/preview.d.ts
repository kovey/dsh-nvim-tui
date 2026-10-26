import type { App } from '../../kernel/app.js';
export declare const previewCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installPreviewCommand(app: App): void;
