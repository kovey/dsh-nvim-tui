import type { ApprovalRecord } from './app.js';
/** Retained in memory / shown by `/approvals`. */
export declare const APPROVAL_HISTORY_MAX = 50;
/** Retained on disk before the file is rewritten to the newest slice. */
export declare const APPROVAL_LOG_MAX = 500;
/** `<DSH_HOME>/approvals/<sessionId>.jsonl` ('' when there is no session). */
export declare const approvalLogPath: (sessionId: string | undefined) => string;
/** `<DSH_HOME>/approvals` (created on first write). */
export declare const approvalLogDir: () => string;
/** One record → one line. Compact JSON: no indent, no trailing spaces. */
export declare const approvalLine: (r: ApprovalRecord) => string;
/**
 * Parse a JSONL log body. Tolerant by design: a half-written last line (the
 * process died mid-append) or a hand-edited file must not break `/approvals`,
 * so unparseable lines are dropped rather than thrown.
 */
export declare const parseApprovalLines: (body: string) => ApprovalRecord[];
/** Newest `max` records from disk, oldest-first (the caller reverses). */
export declare const loadApprovalHistory: (sessionId: string | undefined, max?: number) => ApprovalRecord[];
/**
 * Append one decision. Best-effort: this runs inside the approval settle path,
 * where a throw would strand the host waiting on a decision already made.
 * Rewrites the file once it outgrows APPROVAL_LOG_MAX so it cannot grow without
 * bound across a long-lived workspace.
 */
export declare const appendApproval: (sessionId: string | undefined, r: ApprovalRecord) => void;
/**
 * Refresh the active session's history from disk when the session changed.
 *
 * Called from BOTH the read path (`/approvals`) and the write path (every
 * settle), so session switches need no hook of their own: whichever happens
 * first for a new session reloads, and afterwards the marker makes it a no-op.
 * Returns the slice array (a live reference the caller may read or push to).
 */
export declare const ensureApprovalHistory: (slices: {
    approvalHistory: ApprovalRecord[];
    approvalHistoryFor: string | null;
}, sessionId: string | null | undefined) => ApprovalRecord[];
