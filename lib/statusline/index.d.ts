import type { App, SessionRec } from '../kernel/app.js';
/**
 * The right-side running badge (pure): main turn → '● running'; live
 * subagents → '● running ◇N'; otherwise background jobs keep the whale
 * spinning with '🔧 后台 N'; nothing running → null (statusline shows idle).
 */
/**
 * Recompute the statusline todo badge from the LIVE standing list.
 *
 * Idempotent and safe to call twice per event: `foldEvent` calls it before the
 * feed runs, and the session-event router calls it again after
 * `feed.applyEvent`. The second call is what matters — once the feed has
 * committed the finished items into the transcript they leave
 * `todoVisibleItems`, so the counts drop to zero and the badge disappears
 * together with the pinned panel.
 */
export declare function refreshTodoBadge(app: App, rec: SessionRec): void;
export declare function runningBadge(mainRunning: boolean, subRunning: number, bgJobs: number): string | null;
/** /density — compact tool cards (title line only). */
/** /whale [on|off] — blue whale wallpaper/watermark toggle. */
/** Fill the statusline module's App slots and register its commands. */
export declare function installStatusline(app: App): void;
