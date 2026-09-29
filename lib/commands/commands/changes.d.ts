import type { App } from '../../kernel/app.js';
/** `/changes` — every file THIS SESSION has changed, newest first.
 *
 * The distinction from its neighbours is the whole point:
 *   · `/deliverables` — files produced in the CURRENT TURN (turn-scoped, and it
 *     tracks produced artefacts, not every diff);
 *   · `/diff [path]`  — side-by-side review of ONE file's latest shape;
 *   · `/changes`      — the session-wide ledger: which files, how many times,
 *     net line delta. This is the "what did this task actually touch?" view.
 *
 * A path argument narrows to one file and goes straight to the review, so the
 * command is a usable entry point even for a single file.
 */
export declare const changesCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installChangesCommand(app: App): void;
