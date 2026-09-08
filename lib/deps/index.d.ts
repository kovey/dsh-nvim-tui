/**
 * dsh_tui deps module: dependency health check + one-click assembly.
 *
 * `/deps` reports every harness/third-party dependency the TUI's commands
 * consume, grouped with a ✓/✗/⚠ status. `/deps install` writes the missing
 * host-plugin rows into the profile's cordis.patch.yml (idempotent — row ids
 * already present are skipped) and the loader's user-patch watcher hot-reloads
 * the composition.
 *
 * @module dsh-nvim-tui/deps
 */
import type { App, AppSlices } from '../kernel/app.js';
/** Patch-row templates, keyed by the loader row id (or a special fix id). */
export declare function installDeps(app: App, s: AppSlices['agent']): void;
export { readPatchRowIds, packageExists } from './services.js';
