import type { App, AppSlices } from '../kernel/app.js';
type DepStatus = 'ok' | 'warn' | 'missing';
export interface DepReport {
    id: string;
    label: string;
    /** Display group label (translated at render time). */
    group: string;
    status: DepStatus;
    detail: string;
    /** RowTemplate key: the item can be assembled with /deps install. */
    fixId?: string | undefined;
}
export declare const dshHome: () => string;
/** The profile patch path: the RUNNING profile's cordis.patch.yml.
 *  The running profile always bundles dsh-nvim-tui (the TUI is mounted
 *  through it), so a loader/argv resolution is authoritative; the directory
 *  scan runs ONLY when the running profile cannot be resolved at all. */
export declare function findProfilePatchPath(app: App): string | null;
/** Structural row ids already present in the patch file (comments ignored). */
export declare function readPatchRowIds(path: string): Set<string>;
export declare function packageExists(pkg: string, file: string): boolean;
export declare function checkAll(app: App, s: AppSlices['agent'], patchPath: string | null): Promise<DepReport[]>;
export declare const installCommand: (app: App, s: AppSlices['agent']) => Promise<void>;
export {};
