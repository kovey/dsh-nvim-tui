import type { App } from '../kernel/app.js';
import type { Context } from '@deepseek-ai/cordis';
export interface ScheduleSessionController {
    resolveAgent: (sessionId: string) => Promise<{
        agent: {
            followup: (message: unknown) => unknown;
        };
    } | {
        error: Error;
    }>;
}
/** Install the adapter unless a real controller already owns the name. */
export declare const installSessionController: (app: App, ctx: Context) => void;
