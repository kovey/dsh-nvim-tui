import type { ApprovalRecord } from '../../kernel/app.js';
import type { App } from '../../kernel/app.js';
/**
 * Render the history as float lines. Pure so the smoke suite can pin the
 * format (newest first, stable glyphs) without an App.
 */
export declare const approvalHistoryLines: (all: readonly ApprovalRecord[], max: number) => string[];
export declare const approvalsCommand: (app: App) => Promise<void>;
export declare function installApprovalsCommand(app: App): void;
