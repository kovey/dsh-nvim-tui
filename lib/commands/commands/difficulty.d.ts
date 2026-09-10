import type { App } from '../../kernel/app.js';
/** /difficulty [easy|medium|hard|auto|off] — 按任务难度自动选择模型。 */
export declare const difficultyCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installDifficultyCommand(app: App): void;
