import type { App } from '../../kernel/app.js';
/** `/diff` — review the turn's file changes side by side.
 *
 * The feed already renders a UNIFIED diff inline, which is the right thing for
 * reading a turn top to bottom. It is the wrong thing for REVIEWING a change:
 * you cannot see the two versions against each other. This opens the same data
 * as two bound `diff` windows in a new nvim tab, where line matching,
 * intra-line highlighting and scroll sync are nvim's own.
 *
 * The two sides come from the render-intent metadata captured when the tool
 * result arrived — NOT from re-reading the files, which may have changed since
 * (and then the review would silently show something other than what changed).
 */
export declare const diffCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installDiffCommand(app: App): void;
