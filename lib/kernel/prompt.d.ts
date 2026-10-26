import type { App } from './app.js';
/** Ask for one line. Resolves null on cancel / UI failure. */
export declare const promptLine: (app: App, title: string, defaultValue?: string) => Promise<string | null>;
/** Settle one prompt from the nvim notification. */
export declare const settlePrompt: (app: App, id: string, value: string | null) => void;
/** Settle every outstanding prompt (UI teardown / session switch). */
export declare const drainPrompts: (app: App) => void;
