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
/** Directories whose `<dir>/node_modules` can hold the dsh packages, most
 *  authoritative first.
 *
 *  `dshDir` itself is first-class: the dsh package keeps its plugins under its
 *  OWN `node_modules` (`<dshDir>/node_modules/@deepseek-ai/<pkg>`) and that path
 *  is the real one for an npm-global install. Taking `dirname(dirname(dshDir))`
 *  instead lands on `…/lib/node_modules`, i.e. it yields the nonsense
 *  `…/lib/node_modules/node_modules/…` and never matches — which is why the
 *  probe only started working once the profile store happened to be present.
 *
 *  Then `<…/lib/node_modules>` (a flat/hoisted layout), the shared profile store
 *  `$DSH_HOME/profiles` (reachable from DSH_HOME alone, so it does not depend on
 *  the launch spelling), and finally the package root as a last resort. */
export declare const installRootCandidates: (dshDir: string | undefined) => string[];
export declare function packageExists(pkg: string, file: string): boolean;
/** True when at least one install root could be determined at all. When this
 *  is false the probe has NOT established that a package is absent — it only
 *  failed to find a place to look, which is a different (and actionable)
 *  condition. Callers must not report it as "package not installed". */
export declare function installRootResolved(): boolean;
export declare function checkAll(app: App, s: AppSlices['agent'], patchPath: string | null): Promise<DepReport[]>;
export declare const installCommand: (app: App, s: AppSlices['agent']) => Promise<void>;
export {};
