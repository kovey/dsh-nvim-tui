import type { App } from '../../kernel/app.js';
/** /goal [show|new <objective>|pause|resume|complete|clear] — the active
 *  goal (compare-and-set on the GoalRef). */
export declare const goalCommand: (app: App, a: string | undefined) => void;
export declare function installGoalCommand(app: App): void;
