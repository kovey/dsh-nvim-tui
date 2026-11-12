import type { App } from '../../kernel/app.js';
export declare const mcpCommand: (app: App, a?: string) => Promise<void>;
export declare function installMcpCommand(app: App): void;
