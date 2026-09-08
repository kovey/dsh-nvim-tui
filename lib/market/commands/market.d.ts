import type { App } from '../../kernel/app.js';
export declare const marketCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installMarketCommand(app: App): void;
