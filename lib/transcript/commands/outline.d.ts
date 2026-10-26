import type { App } from '../../kernel/app.js';
import type { SessionEvent } from '../../kernel/types.js';
export interface TurnOutlineRow {
    turn: number;
    user: string;
    steps: number;
    tools: number;
    reason: string;
    at: number;
}
/** Pure fold: turns in log order. Exported so the outline shape is asserted
 *  without a live session. */
export declare const turnOutlineRows: (events: readonly SessionEvent[]) => TurnOutlineRow[];
export declare const outlineCommand: (app: App) => Promise<void>;
export declare function installOutlineCommand(app: App): void;
