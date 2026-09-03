import type { App } from './app.js';
/**
 * The right-side running badge (pure): main turn → '● running'; live
 * subagents → '● running ◇N'; otherwise background jobs keep the whale
 * spinning with '🔧 后台 N'; nothing running → null (statusline shows idle).
 */
export declare function runningBadge(mainRunning: boolean, subRunning: number, bgJobs: number): string | null;
/** Fill the statusline module's App slots and register its commands. */
export declare function installStatusline(app: App): void;
