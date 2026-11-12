import type { App } from '../../kernel/app.js';
/** Review command for one checkout: `--stat` diff of the working tree against
 *  the recorded base commit. Exported so the smoke suite can assert the exact
 *  argv without shelling out to git. */
export declare const worktreeDiffArgv: (path: string, baseCommit: string) => string[];
/** Float body for one `git diff --stat` output (empty → explicit placeholder). */
export declare const worktreeDiffLines: (stat: string) => string[];
export declare const worktreeCommand: (app: App, a?: string) => Promise<void>;
export declare function installWorktreeCommand(app: App): void;
