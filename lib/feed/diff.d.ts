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
