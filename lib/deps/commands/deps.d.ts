/** dsh_tui command: /deps — one command per file. */
import type { App, AppSlices } from '../../kernel/app.js';
export declare const depsCommand: (app: App, s: AppSlices['agent'], a: string | undefined) => Promise<void>;
export declare function installDepsCommand(app: App, s: AppSlices['agent']): void;
