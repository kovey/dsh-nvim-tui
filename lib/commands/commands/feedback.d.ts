import { type FeedbackCategory } from '../../kernel/types.js';
import type { App } from '../../kernel/app.js';
/** Parse `/feedback [category] [text…]`. Exported for a pure assertion: a
 *  category token wins only when it is EXACTLY one of the durable ids. */
export declare const parseFeedbackArgs: (a: string | undefined) => {
    category?: FeedbackCategory;
    text: string;
};
export declare const feedbackCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installFeedbackCommand(app: App): void;
