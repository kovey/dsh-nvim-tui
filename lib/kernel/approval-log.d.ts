import type { ApprovalRecord } from './app.js';
/** Retained in memory / shown by `/approvals`. */
export declare const APPROVAL_HISTORY_MAX = 50;
/** Retained on disk before the file is rewritten to the newest slice. */
export declare const APPROVAL_LOG_MAX = 500;
/** `<cwd>/.dsh/approvals.jsonl` ('' when the cwd is unusable). */
export declare const approvalLogPath: (cwd: string) => string;
/** One record → one line. Compact JSON: no indent, no trailing spaces. */
export declare const approvalLine: (r: ApprovalRecord) => string;
/**
 * Parse a JSONL log body. Tolerant by design: a half-written last line (the
 * process died mid-append) or a hand-edited file must not break `/approvals`,
 * so unparseable lines are dropped rather than thrown.
 */
export declare const parseApprovalLines: (body: string) => ApprovalRecord[];
/** Newest `max` records from disk, oldest-first (the caller reverses). */
export declare const loadApprovalHistory: (cwd: string, max?: number) => ApprovalRecord[];
/**
 * Append one decision. Best-effort: this runs inside the approval settle path,
 * where a throw would strand the host waiting on a decision already made.
 * Rewrites the file once it outgrows APPROVAL_LOG_MAX so it cannot grow without
 * bound across a long-lived workspace.
 */
export declare const appendApproval: (cwd: string, r: ApprovalRecord) => void;
