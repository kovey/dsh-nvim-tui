/** One session's on-disk health, for /doctor. */
export interface SessionHealth {
    id: string;
    /** Log file inspected (relative name), or '' when none was found. */
    log: string;
    status: 'ok' | 'unreadable' | 'empty' | 'backup-only';
    /** Bytes of the log, when it was found. */
    bytes: number;
    /**
     * A `*.corrupt-backup` sibling exists: the host left it after a log fault.
     * This is the ONLY on-disk evidence that a session ever went wrong — the log
     * may decompress perfectly and still carry the bad envelope, which is exactly
     * the case that motivated this check (real session: a backup sibling next to
     * a healthy-looking log, and every projection of it threw
     * `invalid persisted inbox splice`). Decompression alone reported it "ok",
     * so the backup has to be reported separately.
     */
    hadFault: boolean;
}
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
export declare function checkSessionLog(dir: string): SessionHealth;
