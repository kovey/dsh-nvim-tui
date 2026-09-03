import type { App } from './app.js';
/** Structural row ids already present in the patch file (comments ignored). */
export declare function readPatchRowIds(path: string): Set<string>;
/** Does the package exist inside the dsh install (hoisted or nested pnpm)?
 *  The install root derives from the dsh bin path; tests override it via
 *  `DSH_NVIM_TUI_INSTALL_ROOT`. */
export declare function packageExists(pkg: string, file: string): boolean;
export declare function installDeps(app: App): void;
