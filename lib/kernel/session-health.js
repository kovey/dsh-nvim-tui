/**
 * dsh_tui kernel module: SESSION-LOG HEALTH.
 *
 * Motivation (real incident): a session carried an `invalid persisted inbox
 * splice` fault, so every projection of it threw and /sessions simply errored —
 * while the log itself was perfectly intact. Nothing on the UI side told the
 * user whether the session was lost or merely had one bad envelope, and there
 * was no repair entry point.
 *
 * This module only INSPECTS. It lives in kernel/ (not deps/) because the
 * command layer may import kernel/ + feed/ only.
 *
 * @module dsh-nvim-tui/kernel/session-health
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
/**
 * Inspect one session directory: is its log readable, and did it ever fault?
 *
 * Motivation (real incident): a session accumulated an `invalid persisted inbox
 * splice` fault, so every projection of it threw — while the log itself was
 * intact. The user could not tell "the log is fine, one envelope is bad" from
 * "this session is lost": /sessions just errored. This separates those cases.
 *
 * Readability is decided by DECOMPRESSING, not by looking at the magic bytes.
 * Measured behaviour (node:zlib): a torn write keeps a VALID header and
 * `zstdDecompressSync` then yields an EMPTY buffer rather than throwing, so
 * "decompresses to nothing" is reported as `empty` — that is the torn-write
 * signal, and it is why a header/magic-byte check would have called the file
 * fine.
 */
export function checkSessionLog(dir) {
    const id = basename(dir);
    let names = [];
    try {
        names = readdirSync(dir);
    }
    catch {
        return { id, log: '', status: 'unreadable', bytes: 0, hadFault: false };
    }
    const hadFault = names.some((n) => n.includes('corrupt-backup'));
    const log = names.find((n) => n.endsWith('.jsonl.zstd') && !n.includes('corrupt-backup')) ?? '';
    if (log === '') {
        return { id, log: '', status: hadFault ? 'backup-only' : 'unreadable', bytes: 0, hadFault };
    }
    const full = join(dir, log);
    let bytes = 0;
    try {
        bytes = statSync(full).size;
    }
    catch { }
    try {
        const raw = readFileSync(full);
        if (raw.length === 0)
            return { id, log, status: 'empty', bytes, hadFault };
        const plain = zstdDecompressSync(raw);
        if (plain.length === 0)
            return { id, log, status: 'empty', bytes, hadFault };
        return { id, log, status: 'ok', bytes, hadFault };
    }
    catch {
        return { id, log, status: 'unreadable', bytes, hadFault };
    }
}
