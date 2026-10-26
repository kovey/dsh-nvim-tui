import type { App } from '../../kernel/app.js';
export declare const terminalCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installTerminalCommand(app: App): void;
