import type { App } from '../../kernel/app.js';
export declare const teamCommand: (app: App, a?: string) => Promise<void>;
export declare function installTeamCommand(app: App): void;
