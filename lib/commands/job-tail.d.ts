import type { App } from '../kernel/app.js';
/**
 * Tail one job's output into the live float until it settles or the float is
 * closed. Returns immediately: the caller does not wait for the job.
 */
export declare const jobTailCommand: (app: App, jobId: string) => Promise<void>;
/** Test seam: is a tail currently polling for this app? */
export declare const jobTailActive: (app: App) => boolean;
