import type { App } from '../../kernel/app.js';
/**
 * OS "open with the default application" argv, or undefined when this platform
 * has no known opener.
 *
 * WHY: a produced file has no business living only inside nvim — a PDF, an
 * image or a spreadsheet is meant to be handed to the system. macOS `open`
 * covers it; Linux falls back to `xdg-open`.
 *
 * Platform is a parameter (not read from `process` inline) so the mapping is
 * testable without pretending to run on another OS.
 */
export declare const systemOpenArgv: (path: string, platform?: string) => string[] | undefined;
/** Same, but selecting the file in the platform's file manager. Only macOS has
 *  a portable spelling; elsewhere the action is simply not offered. */
export declare const systemRevealArgv: (path: string, platform?: string) => string[] | undefined;
/** /deliverables — files this session's current turn produced (mutation
 *  tools' follow-along paths, derived from tool/call arguments). */
export declare const deliverablesCommand: (app: App) => Promise<void>;
export declare function installDeliverablesCommand(app: App): void;
