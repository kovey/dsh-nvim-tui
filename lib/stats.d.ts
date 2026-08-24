/**
 * Statusline statistics: token formatting, cost estimation (built-in public
 * price table), and per-event usage folding.
 *
 * Reference: tianshu's glance segments — usage accumulates per session from
 * `assistant/message` events' `data.usage` (disjoint TokenUsage counts);
 * cache hit rate and context ratio derive from the billed input.
 */
import type { TokenUsage, Usage } from './types.js';
export declare const EMPTY_USAGE: Usage;
/** Fold one TokenUsage record into the session accumulator. */
export declare function foldUsage(acc: Usage, usage: TokenUsage): Usage;
/** Billed input tokens (input + cache reads + cache writes). */
export declare function billedInput(usage: Usage): number;
/** Cache hit ratio, null when the adapter never reported cache fields. */
export declare function cacheHitRate(usage: Usage, cacheReported: boolean): number | null;
/** Estimated USD cost; undefined for unknown models or zero tokens. */
export declare function estimateCost(modelName: string | undefined, usage: Usage): number | undefined;
/** 512600 → '512.6k'; 1000000 → '1.00M'. */
export declare function formatTokens(n: number): string;
/** 102510 ms → '1m 42s'; 95000 → '1m 35s'; 234 → '234ms'. */
export declare function formatElapsed(ms: number): string;
/** Escape a literal % for the statusline format (% is the item prefix). */
export declare function escapeStatusline(s: unknown): string;
/** Human permission-mode label (SandboxMode). */
export declare function modeLabel(mode: string | undefined): string;
