/**
 * Approval picker bridge used by the public `tui.approval.pick()` surface.
 *
 * Kept separate from ext-api so the decision rules (headless, abort, outcome
 * vocabulary) are testable with a fake picker. The host waterfall owns
 * ordering; this helper only renders and returns.
 *
 * @module dsh-nvim-tui/ext-api/approval
 */
import type { App } from '../kernel/app.js';
import type { ExtApprovalOutcome, ExtApprovalRequest } from '../kernel/ext-types.js';
/** Approval picker rows (single source for the public bridge and tests). */
export declare const approvalPickerItems: () => Array<{
    label: string;
    value: ExtApprovalOutcome;
    active?: boolean;
}>;
/** Human-facing title for one approval; reason is bounded before display. */
export declare const approvalPickerTitle: (request: ExtApprovalRequest, override?: string) => string;
export type ApprovalApp = Pick<App, 'headless' | 'openPicker'>;
export declare const pickApproval: (app: ApprovalApp, request: ExtApprovalRequest, opts?: {
    title?: string;
}) => Promise<ExtApprovalOutcome>;
