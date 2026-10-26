import type { DeliverablesState, PresentedFile } from './types.js';
/** Fresh per-turn state. */
export declare const emptyDeliverables: (turn?: number) => DeliverablesState;
/** Merge declared files into the turn's state, de-duplicated by path. */
export declare const mergePresentedFiles: (state: DeliverablesState, turn: number | undefined, files: readonly PresentedFile[]) => DeliverablesState;
/** All deliverable paths in display order: explicit declarations first. */
export declare const deliverablePaths: (state: DeliverablesState | undefined) => string[];
/** Resolve a deliverable path against the session cwd (present allows both). */
export declare const resolveDeliverablePath: (cwd: string, path: string) => string;
