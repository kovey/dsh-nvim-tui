/**
 * Session-wide ledger of every file a session has touched.
 *
 * WHY A LEDGER AND NOT THE EXISTING MAPS: the plugin already tracks file changes
 * twice, and neither answers "which files did this task change?":
 *   · `recentDiffs` keeps ONE entry per path, overwritten on every edit — so a
 *     file edited three times looks like one edit, and the earlier shapes are
 *     gone;
 *   · `/deliverables` is scoped to the CURRENT TURN and drops the rest.
 *
 * The ledger ACCUMULATES instead: one row per path, carrying how many times it
 * was touched, the net line delta, and when it was first/last written. That is
 * the shape a person reviews at the end of a task ("what did this actually
 * change?"), and it is deliberately cheap to keep — metadata only, never file
 * contents, so a long session cannot grow it into a second copy of the repo.
 *
 * @module dsh-nvim-tui/kernel/change-ledger
 */
/**
 * Which status a diff represents.
 *
 * `null` and `undefined` both mean "absent", but they arrive from different
 * places (the host omits the key vs. explicitly passes null), so both are
 * accepted rather than letting a missing side read as an empty file.
 */
export const changeStatus = (oldText, newText) => {
    if (oldText === undefined || oldText === null)
        return 'added';
    if (newText === undefined || newText === null)
        return 'deleted';
    return 'modified';
};
/**
 * Fold one diff into the ledger. Pure: returns a NEW map so callers can decide
 * where to keep it (we key by feed, so a session's ledger cannot leak into
 * another's) and so the accumulation is asserted without any I/O.
 */
export const recordChange = (ledger, input) => {
    const next = new Map(ledger);
    const prev = next.get(input.path);
    const now = changeStatus(input.oldText, input.newText);
    const firstStatus = prev?.firstStatus ?? now;
    next.set(input.path, {
        path: input.path,
        firstStatus,
        lastStatus: now,
        status: summarize(firstStatus, now),
        edits: (prev?.edits ?? 0) + 1,
        added: (prev?.added ?? 0) + input.added,
        removed: (prev?.removed ?? 0) + input.removed,
        firstAt: prev?.firstAt ?? input.at,
        lastAt: input.at,
    });
    return next;
};
/**
 * Collapse the first and last touch into the status a reviewer needs.
 *
 * Rule, in order (each clause earns its place):
 *   1. created here, still here → `added`. Saying "modified" would hide that the
 *      task is what brought the file into being.
 *   2. gone now → `deleted`, whatever happened in between.
 *   3. otherwise → `modified`.
 */
export const summarize = (firstStatus, lastStatus) => {
    if (lastStatus === 'deleted')
        return 'deleted';
    if (firstStatus === 'added')
        return 'added';
    return 'modified';
};
/** Ledger rows, most recently touched first (the order a review wants). */
export const ledgerRows = (ledger) => [...ledger.values()].sort((a, b) => b.lastAt - a.lastAt);
/** Totals for a one-line summary. */
export const ledgerTotals = (ledger) => {
    let added = 0;
    let removed = 0;
    for (const c of ledger.values()) {
        added += c.added;
        removed += c.removed;
    }
    return { files: ledger.size, added, removed };
};
