/**
 * Line diff for file-change blocks in the chat: mutation tools (write / edit
 * / replace / append / patch / str_replace_editor / fs) get a beautified
 * +/− block under their ✓ tool line, so every turn shows what changed.
 *
 * LCS over prefix/suffix-trimmed lines; hunks carry `context` unchanged
 * lines; the whole block is capped at `maxLines` so a giant rewrite can
 * never flood the chat (a `· …` notice line reports the rest).
 *
 * Rendered lines use the feed's diff prefixes:
 *   `  ` context · `- ` removed · `+ ` added · `· …` omission notice
 *
 * @module dsh-nvim-tui/diff
 */
/** LCS DP cell cap: beyond this the diff falls back to a whole-block replace. */
const LCS_CELL_CAP = 1_000_000;
/**
 * Extract the official render-intent diffs from a tool/result event's meta
 * (dsh tools emit `meta.diffs = [{ path, oldText, newText }]` via their
 * output.presentationMeta). Returns null when the payload carries none.
 */
export function fileDiffsFromMeta(meta) {
    if (typeof meta !== 'object' || meta === null)
        return null;
    const diffs = meta.diffs;
    if (!Array.isArray(diffs) || diffs.length === 0)
        return null;
    const out = [];
    for (const d of diffs) {
        if (typeof d !== 'object' || d === null)
            continue;
        const o = d;
        if (typeof o.path !== 'string' || o.path === '')
            continue;
        if (typeof o.oldText !== 'string' && typeof o.newText !== 'string')
            continue;
        out.push({ path: o.path, oldText: o.oldText, newText: o.newText });
    }
    return out.length > 0 ? out : null;
}
function addOnly(text, maxLines) {
    const raw = text.split('\n');
    const room = Math.max(1, maxLines - 1);
    const keep = raw.slice(0, room);
    const lines = keep.map((l) => '+ ' + l);
    const truncated = raw.length > room;
    if (truncated)
        lines.push(`· 其余新增 ${raw.length - room} 行省略 ·`);
    return { lines, stats: { added: raw.length, removed: 0 }, truncated };
}
function delOnly(text, maxLines) {
    const raw = text.split('\n');
    const room = Math.max(1, maxLines - 1);
    const keep = raw.slice(0, room);
    const lines = keep.map((l) => '- ' + l);
    const truncated = raw.length > room;
    if (truncated)
        lines.push(`· 其余删除 ${raw.length - room} 行省略 ·`);
    return { lines, stats: { added: 0, removed: raw.length }, truncated };
}
function wholeReplace(a, b, maxLines) {
    const lines = [];
    const room = Math.max(1, maxLines - 1);
    let kept = 0;
    let truncated = false;
    for (const l of a) {
        if (kept >= room) {
            truncated = true;
            break;
        }
        lines.push('- ' + l);
        kept++;
    }
    for (const l of b) {
        if (kept >= room) {
            truncated = true;
            break;
        }
        lines.push('+ ' + l);
        kept++;
    }
    const total = a.length + b.length;
    if (truncated)
        lines.push(`· 其余 ${total - kept} 行省略 ·`);
    return { lines, stats: { added: b.length, removed: a.length }, truncated };
}
/** Diff two file snapshots (null = file absent). */
export function diffTexts(before, after, opts = {}) {
    const context = opts.context ?? 2;
    const maxLines = Math.max(4, opts.maxLines ?? 40);
    if (before === after)
        return { lines: [], stats: { added: 0, removed: 0 }, truncated: false };
    if (before === null)
        return addOnly(after ?? '', maxLines);
    if (after === null)
        return delOnly(before, maxLines);
    const a = before.split('\n');
    const b = after.split('\n');
    // Trim the common prefix/suffix (unchanged head/tail act as context), then
    // pad both sides with the trimmed `context` lines again — they are equal in
    // both arrays, so LCS renders them as ordinary context rows and hunks at
    // the file's edges still show their surroundings (git-style).
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p])
        p++;
    let s = 0;
    while (s < a.length - p && s < b.length - p &&
        a[a.length - 1 - s] === b[b.length - 1 - s])
        s++;
    const pre = a.slice(Math.max(0, p - context), p);
    const post = a.slice(a.length - s, a.length - s + context);
    const A = [...pre, ...a.slice(p, a.length - s), ...post];
    const B = [...pre, ...b.slice(p, b.length - s), ...post];
    if ((A.length + 1) * (B.length + 1) > LCS_CELL_CAP) {
        return wholeReplace(A, B, maxLines);
    }
    // LCS DP (row-major (m+1)×(n+1)); then backtrack into ops:
    // 0 = unchanged, 1 = removed (from A), 2 = added (from B).
    const m = A.length;
    const n = B.length;
    const dp = new Int32Array((m + 1) * (n + 1));
    const at = (i, j) => (i + 1) * (n + 1) + (j + 1);
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[at(i, j)] = A[i - 1] === B[j - 1]
                ? dp[at(i - 1, j - 1)] + 1
                : Math.max(dp[at(i - 1, j)], dp[at(i, j - 1)]);
        }
    }
    const ops = [];
    let i = m;
    let j = n;
    while (i > 0 && j > 0) {
        if (A[i - 1] === B[j - 1]) {
            ops.push(0);
            i--;
            j--;
        }
        else if (dp[at(i - 1, j)] >= dp[at(i, j - 1)]) {
            ops.push(1);
            i--;
        }
        else {
            ops.push(2);
            j--;
        }
    }
    while (i > 0) {
        ops.push(1);
        i--;
    }
    while (j > 0) {
        ops.push(2);
        j--;
    }
    ops.reverse();
    // Parallel source-line cursors so each op can render its own line.
    const aIdx = [];
    const bIdx = [];
    let ai = 0;
    let bj = 0;
    for (const op of ops) {
        aIdx.push(ai);
        bIdx.push(bj);
        if (op === 0) {
            ai++;
            bj++;
        }
        else if (op === 1) {
            ai++;
        }
        else {
            bj++;
        }
    }
    // Changed op ranges, expanded with context and merged when adjacent.
    const ranges = [];
    for (let k = 0; k < ops.length; k++) {
        if (ops[k] === 0)
            continue;
        const lo = Math.max(0, k - context);
        const hi = Math.min(ops.length - 1, k + context);
        if (ranges.length > 0 && lo <= (ranges[ranges.length - 1]?.[1] ?? -1) + 1) {
            ranges[ranges.length - 1][1] = Math.max(ranges[ranges.length - 1][1], hi);
        }
        else {
            ranges.push([lo, hi]);
        }
    }
    const lines = [];
    let added = 0;
    let removed = 0;
    let rendered = 0;
    let truncated = false;
    const room = Math.max(1, maxLines - 1);
    const totalRender = ranges.reduce((acc, r) => acc + (r[1] - r[0] + 1), 0);
    for (let r = 0; r < ranges.length; r++) {
        const [lo, hi] = ranges[r];
        const chunk = [];
        let cAdded = 0;
        let cRemoved = 0;
        for (let k = lo; k <= hi; k++) {
            const op = ops[k];
            if (op === 0) {
                chunk.push('  ' + A[aIdx[k]]);
            }
            else if (op === 1) {
                chunk.push('- ' + A[aIdx[k]]);
                cRemoved++;
            }
            else {
                chunk.push('+ ' + B[bIdx[k]]);
                cAdded++;
            }
        }
        if (lines.length + chunk.length > room) {
            // Even the first chunk overflows the cap (one giant hunk): render its
            // HEAD — a partial block with real stats is infinitely better than an
            // empty block with +0 −0 (which the caller then drops entirely).
            const keep = Math.max(0, room - lines.length);
            const part = chunk.slice(0, keep);
            lines.push(...part);
            for (const l of part) {
                if (l.startsWith('+ '))
                    added++;
                else if (l.startsWith('- '))
                    removed++;
                rendered++;
            }
            truncated = true;
            break;
        }
        lines.push(...chunk);
        rendered += chunk.length;
        added += cAdded;
        removed += cRemoved;
    }
    if (truncated) {
        lines.push(`· 其余 ${totalRender - rendered} 行省略 ·`);
    }
    return { lines, stats: { added, removed }, truncated };
}
