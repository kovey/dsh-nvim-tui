import type { App } from '../../kernel/app.js';
export declare const scheduleCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installScheduleCommand(app: App): void;
