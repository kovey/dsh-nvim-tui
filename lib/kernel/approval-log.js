/**
 * dsh_tui kernel module: APPROVAL DECISION LOG (durable, PER SESSION).
 *
 * The in-memory `approvalHistory` slice died with the process, so `/approvals`
 * showed nothing after a restart — exactly when the question "why did I allow
 * that?" usually gets asked. This module is the on-disk side.
 *
 * Scope is deliberately ONE SESSION, not one project and not global:
 * `/approvals` answers "what did THIS conversation let through?", and mixing in
 * decisions from other conversations would be misleading (a rejection in another
 * session says nothing about this one).
 *
 * Storage: `<DSH_HOME>/approvals/<sessionId>.jsonl`, one COMPACT JSON object per
 * line (never pretty-printed — a multi-line record destroys JSONL semantics).
 * Kept out of the workspace on purpose: writing into the repo (even gitignored)
 * would surprise users, and the log is client state, not project state.
 *
 * @module dsh-nvim-tui/kernel/approval-log
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
/** Retained in memory / shown by `/approvals`. */
export const APPROVAL_HISTORY_MAX = 50;
/** Retained on disk before the file is rewritten to the newest slice. */
export const APPROVAL_LOG_MAX = 500;
/** `<DSH_HOME>/approvals/<sessionId>.jsonl` ('' when there is no session). */
export const approvalLogPath = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '')
        return '';
    // Sanitized: the id comes from the host, but this is a filesystem path.
    const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
    return join(approvalLogDir(), `${safe}.jsonl`);
};
/** `<DSH_HOME>/approvals` (created on first write). */
export const approvalLogDir = () => join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'approvals');
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
export const loadApprovalHistory = (sessionId, max = APPROVAL_HISTORY_MAX) => {
    const path = approvalLogPath(sessionId);
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
export const appendApproval = (sessionId, r) => {
    const path = approvalLogPath(sessionId);
    if (path === '')
        return;
    try {
        mkdirSync(approvalLogDir(), { recursive: true });
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
/**
 * Refresh the active session's history from disk when the session changed.
 *
 * Called from BOTH the read path (`/approvals`) and the write path (every
 * settle), so session switches need no hook of their own: whichever happens
 * first for a new session reloads, and afterwards the marker makes it a no-op.
 * Returns the slice array (a live reference the caller may read or push to).
 */
export const ensureApprovalHistory = (slices, sessionId) => {
    const sid = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null;
    if (slices.approvalHistoryFor === sid)
        return slices.approvalHistory;
    const loaded = sid === null ? [] : loadApprovalHistory(sid);
    slices.approvalHistory.length = 0;
    slices.approvalHistory.push(...loaded);
    slices.approvalHistoryFor = sid;
    return slices.approvalHistory;
};
