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
/** Human age suffix for list rows ('' when unknown). */
export declare function ageLabel(createdAt: number | undefined, now?: number): string;
/** Whether a settled chain has passed the retention window (0 = disabled). */
export declare function isExpired(createdAt: number | undefined, ttlHours: number, now?: number): boolean;
/** Cleaned-id ledger path under DSH_HOME. */
export declare function cleanStatePath(): string;
/** Read the cleaned-id ledger: parentSessionId -> childIds. */
export declare function readCleanedIds(): Record<string, string[]>;
/** Persist the cleaned-id ledger (best-effort). */
export declare function writeCleanedIds(cleaned: Record<string, string[]>): void;
