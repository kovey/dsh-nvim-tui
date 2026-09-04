/**
 * Subagent thought-chain TTL + cleanup bookkeeping.
 *
 * The dsh host persists settled child-session events forever and exposes no
 * delete API, so the TUI does the cleanup itself:
 *  - expired settled chains are truncated via `sessionPersistence.truncateStored`
 *    (keeps only the first event — the bulk of the stored chain is freed);
 *  - cleaned ids are recorded in `$DSH_HOME/dsh-nvim-tui-subagent-clean.json`
 *    (keyed by parent session) and hidden from the /subagents listing, so the
 *    list stops growing.
 */
/** Encode a session log in the backend's own physical format: one Zstandard
 *  frame per record (header line first, then one JSON event per line). The
 *  host decoder accepts frames without the writer's checksum param, and
 *  unpacked (expanded) events are valid storage records — chunk packing is
 *  an optimization, not a requirement. */
export declare function encodeSessionLog(headerLine: string, events: readonly unknown[]): Buffer;
/** Header-only variant (the settled-chain cleanup keeps no events). */
export declare function encodeHeaderOnlyLog(headerLine: string): Buffer;
/** Human age suffix for list rows ('' when unknown). */
export declare function ageLabel(createdAt: number | undefined, now?: number): string;
/** Whether a settled chain has passed the retention window (0 = disabled). */
export declare function isExpired(createdAt: number | undefined, ttlHours: number, now?: number): boolean;
/** /subagents list ordering: running children first (the live work is what
 *  matters), then newest-first within each group. */
export declare function orderSubagentChildren<T extends {
    running?: boolean;
    createdAt?: number;
}>(children: T[]): T[];
/** Read the cleaned-id ledger: parentSessionId -> childIds. */
export declare function readCleanedIds(): Record<string, string[]>;
/** Persist the cleaned-id ledger (best-effort). */
export declare function writeCleanedIds(cleaned: Record<string, string[]>): void;
