import type { App, AppSlices } from '../kernel/app.js';
type DepStatus = 'ok' | 'warn' | 'missing';
export interface DepReport {
    id: string;
    label: string;
    group: '主机插件' | '配置生效性' | '系统命令';
    status: DepStatus;
    detail: string;
    /** RowTemplate key: the item can be assembled with /deps install. */
    fixId?: string;
}
export declare const dshHome: () => string;
/** The profile patch path: profile whose bundles include dsh-nvim-tui. */
export declare function findProfilePatchPath(): string | null;
/** Structural row ids already present in the patch file (comments ignored). */
export declare function readPatchRowIds(path: string): Set<string>;
/** Does the package exist inside the dsh install (hoisted or nested pnpm)?
 *  The install root derives from the dsh bin path; tests override it via
 *  `DSH_NVIM_TUI_INSTALL_ROOT`. */
export declare function packageExists(pkg: string, file: string): boolean;
export declare function checkAll(app: App, s: AppSlices['agent'], patchPath: string | null): Promise<DepReport[]>;
export declare const installCommand: (app: App, s: AppSlices['agent']) => Promise<void>;
export {};
