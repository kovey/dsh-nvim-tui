import type { App } from '../../kernel/app.js';
/** /todo — the standing task list is AGENT-owned (the dsh todo_write
 *  tool rejects non-agent callers, the official web UI only renders it),
 *  so adding a task = asking the agent to update its list; with no
 *  argument the current list pops up (read-only, from todo/write folds). */
export declare const todoCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installTodoCommand(app: App): void;
