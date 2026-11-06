import type { App } from '../../kernel/app.js';
import type { SessionEvent } from '../../kernel/types.js';
export interface TurnStats {
    turn: number;
    steps: number;
    tools: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    durationMs?: number;
}
export interface SessionStats {
    turns: TurnStats[];
    totals: Omit<TurnStats, 'turn' | 'steps' | 'tools' | 'durationMs'> & {
        steps: number;
        tools: number;
    };
}
/** Fold session events into per-turn counters. Pure, so the arithmetic is
 *  testable without a live harness. */
export declare const collectTurnStats: (events: readonly SessionEvent[]) => SessionStats;
export declare const statsCommand: (app: App, a?: string) => Promise<void>;
export declare function installStatsCommand(app: App): void;
