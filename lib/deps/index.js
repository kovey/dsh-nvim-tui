import { installDepsCommand } from './commands/deps.js';
/** Patch-row templates, keyed by the loader row id (or a special fix id). */
export function installDeps(app, s) {
    installDepsCommand(app, s);
}
// Public surface for tests (scripts/smoke.ts).
export { readPatchRowIds, packageExists } from './services.js';
