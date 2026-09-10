import type { App, SessionRec } from './app.js';
import type { DifficultyRoutingConfig, DifficultyTier } from './types.js';
/** Statusline / notice icons and labels per tier. */
export declare const TIER_ICONS: Record<DifficultyTier, string>;
export declare function routingConfig(app: App): DifficultyRoutingConfig;
/** Full selection for a tier (provider omitted = inherit current). */
export declare function tierRoute(cfg: DifficultyRoutingConfig, tier: DifficultyTier, current: {
    provider: string;
    model: string;
}): {
    provider: string;
    model: string;
    reasoningEffort?: string;
} | null;
export interface RuleContext {
    planActive: boolean;
    goal: boolean;
    toolErrors: number;
    hasImages: boolean;
}
export declare function estimateByRules(text: string, ctx: RuleContext): DifficultyTier;
export declare function estimateDifficulty(app: App, rec: SessionRec, text: string, hasImages: boolean): Promise<{
    tier: DifficultyTier;
    source: 'pin' | 'rules' | 'classifier';
} | null>;
/** Called by followup() before every main-session send. Never throws. */
export declare function routeDifficultyForTurn(app: App, rec: SessionRec, text: string, hasImages: boolean): Promise<void>;
/** Called at turn/end (after the vision restore). `notify` = active session. */
export declare function restoreDifficulty(app: App, rec: SessionRec, notify: boolean): void;
/** Apply /difficulty <arg>. Returns 0..n notice lines. */
export declare function applyDifficultyCommand(app: App, rec: SessionRec, arg: 'auto' | 'off' | DifficultyTier): Promise<string[]>;
/** Status lines for bare /difficulty. */
export declare function difficultyStatusLines(app: App, rec: SessionRec): string[];
