import type { App } from '../kernel/app.js';
export declare function installSessions(app: App): void;
/** Boot-time session selection (moved out of boot): explicit resume id
 *  (env/config) wins; otherwise auto-resume the LAST active session of this
 *  project (claude --continue behaviour), falling back to the newest
 *  persisted one; a fresh session only when there is no history (or
 *  resumeLatest is disabled). Opening an OLD-version session can throw
 *  (legacy/incompatible log): that must NOT take the whole process down —
 *  log the failure, open a fresh session instead, and tell the user in the
 *  chat window that the restore failed. */
export declare function resumeOrCreate(app: App): Promise<void>;
