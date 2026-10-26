import type { App } from '../../kernel/app.js';
export declare const cordisCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installCordisCommand(app: App): void;
