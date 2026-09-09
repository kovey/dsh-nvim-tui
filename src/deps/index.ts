/**
 * dsh_tui deps module: dependency health check + one-click assembly.
 *
 * `/deps` reports every harness/third-party dependency the TUI's commands
 * consume, grouped with a ✓/✗/⚠ status. `/deps install` writes the missing
 * host-plugin rows into the profile's cordis.patch.yml (idempotent — row ids
 * already present are skipped), waits for the loader's hot-reload to bring
 * the services live, and auto-restarts dsh when HMR alone cannot compose the
 * new rows — one command, fully assembled.
 *
 * @module dsh-nvim-tui/deps
 */
import type { App, AppSlices } from '../kernel/app.js'
import { installDepsCommand } from './commands/deps.js'

/** Patch-row templates, keyed by the loader row id (or a special fix id). */
export function installDeps(app: App, s: AppSlices['agent']): void {
  installDepsCommand(app, s)
}

// Public surface for tests (scripts/smoke.ts).
export { readPatchRowIds, packageExists } from './services.js'
