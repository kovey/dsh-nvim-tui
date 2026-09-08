import type { App } from '../../kernel/app.js';
/** /workspace [add <目录> [标题] | delete <id>] — workspace management.
 *  Bare /workspace opens a sessions-style popup: workspace directory,
 *  create-via-directory-picker, rename (next input) and delete actions. */
export declare const workspaceCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installWorkspaceCommand(app: App): void;
