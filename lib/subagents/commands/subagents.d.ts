import type { App, AppSlices } from '../../kernel/app.js';
type Child = Awaited<ReturnType<AppSlices['sessions']['listSubagentChildren']>>[number];
/** Picker rows are rendered as REAL nvim buffer lines, and nvim_buf_set_lines
 *  rejects any line carrying CR/LF ("'replacement string' item contains
 *  newlines"). A child's label is often its whole multi-line task prompt, so
 *  /subagents failed before the float opened (the Lua picker folds its own
 *  labels too — this is the second layer, so no other caller can bypass it).
 *  Fold CR/LF/TAB runs into one space; an empty label stays empty. */
export declare const singleLineLabel: (label: string) => string;
/** Picker rows, newest/running order already applied by the caller. */
export declare const childRows: (children: Child[], settledCount: number) => Array<{
    label: string;
    value: string;
}>;
export declare const subagentsCommand: (app: App) => Promise<void>;
export declare function installSubagentsCommand(app: App): void;
export {};
