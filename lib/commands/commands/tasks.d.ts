import type { App } from '../../kernel/app.js';
/** /tasks [kill <id>] — job registry view / cancel one job. */
export declare const tasksCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installTasksCommand(app: App): void;
