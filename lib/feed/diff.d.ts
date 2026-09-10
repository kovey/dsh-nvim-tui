export interface DiffStats {
    added: number;
    removed: number;
}
export interface DiffBlock {
    /** Rendered block lines (`  ` context / `+ ` / `- ` / `· …` notice). */
    lines: string[];
    stats: DiffStats;
    truncated: boolean;
}
export interface DiffOptions {
    /** Unchanged context lines around each hunk (default 2). */
    context?: number;
    /** Cap on rendered lines (default 40). */
    maxLines?: number;
}
/** One file-change entry from a tool result's official presentationMeta. */
export interface FileDiffMeta {
    path?: string;
    oldText?: string;
    newText?: string;
}
/**
 * Extract the official render-intent diffs from a tool/result event's meta
 * (dsh tools emit `meta.diffs = [{ path, oldText, newText }]` via their
 * output.presentationMeta). Returns null when the payload carries none.
 */
export declare function fileDiffsFromMeta(meta: unknown): FileDiffMeta[] | null;
/** Diff two file snapshots (null = file absent). */
export declare function diffTexts(before: string | null, after: string | null, opts?: DiffOptions): DiffBlock;
