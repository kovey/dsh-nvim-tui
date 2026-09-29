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
/** How a path was changed, by the strongest thing that happened to it. */
export type ChangeStatus = 'added' | 'modified' | 'deleted';
export interface FileChange {
    path: string;
    /** Status of the FIRST touch, and of the LAST — kept separately so the
     *  summary can be derived by an explicit rule instead of a ternary chain. */
    firstStatus: ChangeStatus;
    lastStatus: ChangeStatus;
    /** Summary for review: see `summarize`. */
    status: ChangeStatus;
    /** How many separate diffs touched this path. */
    edits: number;
    /** Net lines added / removed, summed over every diff of this path. */
    added: number;
    removed: number;
    /** Epoch ms of the first and last touch. */
    firstAt: number;
    lastAt: number;
}
/** One observed diff, as the host reports it. */
export interface ChangeInput {
    path: string;
    /** `undefined` means "that side did not exist" (added / deleted). */
    oldText: string | null | undefined;
    newText: string | null | undefined;
    added: number;
    removed: number;
    at: number;
}
/**
 * Which status a diff represents.
 *
 * `null` and `undefined` both mean "absent", but they arrive from different
 * places (the host omits the key vs. explicitly passes null), so both are
 * accepted rather than letting a missing side read as an empty file.
 */
export declare const changeStatus: (oldText: string | null | undefined, newText: string | null | undefined) => ChangeStatus;
/**
 * Fold one diff into the ledger. Pure: returns a NEW map so callers can decide
 * where to keep it (we key by feed, so a session's ledger cannot leak into
 * another's) and so the accumulation is asserted without any I/O.
 */
export declare const recordChange: (ledger: ReadonlyMap<string, FileChange>, input: ChangeInput) => Map<string, FileChange>;
/**
 * Collapse the first and last touch into the status a reviewer needs.
 *
 * Rule, in order (each clause earns its place):
 *   1. created here, still here → `added`. Saying "modified" would hide that the
 *      task is what brought the file into being.
 *   2. gone now → `deleted`, whatever happened in between.
 *   3. otherwise → `modified`.
 */
export declare const summarize: (firstStatus: ChangeStatus, lastStatus: ChangeStatus) => ChangeStatus;
/** Ledger rows, most recently touched first (the order a review wants). */
export declare const ledgerRows: (ledger: ReadonlyMap<string, FileChange>) => FileChange[];
/** Totals for a one-line summary. */
export declare const ledgerTotals: (ledger: ReadonlyMap<string, FileChange>) => {
    files: number;
    added: number;
    removed: number;
};
