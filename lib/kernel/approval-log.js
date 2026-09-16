/**
 * dsh_tui kernel module: APPROVAL DECISION LOG (durable).
 *
 * The in-memory `approvalHistory` slice died with the process, so `/approvals`
 * showed nothing after a restart — exactly when the question "why did I allow
 * that?" usually gets asked. This module is the on-disk side.
 *
 * Storage: `<session cwd>/.dsh/approvals.jsonl`, one COMPACT JSON object per
 * line (never pretty-printed — a multi-line record destroys JSONL semantics).
 * The workspace `.dsh/` is gitignored, so this stays out of the repo while
 * remaining per-project: decisions made while working in another project do not
 * show up here.
 *
 * @module dsh-nvim-tui/kernel/approval-log
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
/** Retained in memory / shown by `/approvals`. */
export const APPROVAL_HISTORY_MAX = 50;
/** Retained on disk before the file is rewritten to the newest slice. */
export const APPROVAL_LOG_MAX = 500;
/** `<cwd>/.dsh/approvals.jsonl` ('' when the cwd is unusable). */
export const approvalLogPath = (cwd) => cwd === '' ? '' : join(cwd, '.dsh', 'approvals.jsonl');
/** One record → one line. Compact JSON: no indent, no trailing spaces. */
export const approvalLine = (r) => JSON.stringify(r) + '\n';
/**
 * Parse a JSONL log body. Tolerant by design: a half-written last line (the
 * process died mid-append) or a hand-edited file must not break `/approvals`,
 * so unparseable lines are dropped rather than thrown.
 */
export const parseApprovalLines = (body) => {
    const out = [];
    for (const line of body.split('\n')) {
        const text = line.trim();
        if (text === '')
            continue;
        try {
            const v = JSON.parse(text);
            if (typeof v?.at !== 'number' || typeof v?.outcome !== 'string')
                continue;
            out.push({
                at: v.at,
                toolName: typeof v.toolName === 'string' ? v.toolName : '?',
                reason: typeof v.reason === 'string' ? v.reason : '',
                outcome: v.outcome,
                sessionId: typeof v.sessionId === 'string' ? v.sessionId : undefined,
            });
        }
        catch { /* skip the bad line, keep the rest */ }
    }
    return out;
};
/** Newest `max` records from disk, oldest-first (the caller reverses). */
export const loadApprovalHistory = (cwd, max = APPROVAL_HISTORY_MAX) => {
    const path = approvalLogPath(cwd);
    if (path === '')
        return [];
    try {
        return parseApprovalLines(readFileSync(path, 'utf8')).slice(-max);
    }
    catch {
        return []; // no file yet, or unreadable: an empty history is the right answer
    }
};
/**
 * Append one decision. Best-effort: this runs inside the approval settle path,
 * where a throw would strand the host waiting on a decision already made.
 * Rewrites the file once it outgrows APPROVAL_LOG_MAX so it cannot grow without
 * bound across a long-lived workspace.
 */
export const appendApproval = (cwd, r) => {
    const path = approvalLogPath(cwd);
    if (path === '')
        return;
    try {
        mkdirSync(join(cwd, '.dsh'), { recursive: true });
        appendFileSync(path, approvalLine(r));
        const all = parseApprovalLines(readFileSync(path, 'utf8'));
        if (all.length > APPROVAL_LOG_MAX) {
            const kept = all.slice(-APPROVAL_LOG_MAX);
            // Same file, compacted: the write is small and atomic enough for a log
            // that is only ever read back for display.
            appendFileSync(path + '.tmp', kept.map(approvalLine).join(''));
            renameSync(path + '.tmp', path);
        }
    }
    catch { /* history is a nicety; never break the approval path */ }
};
