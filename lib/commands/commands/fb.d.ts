import type { App } from '../../kernel/app.js';
/** /fb up|down [note] — feedback on the last assistant message. */
export declare const feedbackCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installFbCommand(app: App): void;
