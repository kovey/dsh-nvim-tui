/** One rendered table row (or a table-false passthrough entry). */
export type TableEntry = {
    table: true;
    text: string;
    group: string | null;
    spans: Array<{
        s: number;
        e: number;
        group: string;
    }>;
} | {
    table: false;
    raw: string;
};
declare const isTableRow: (line: string) => boolean;
declare const isSeparator: (line: string) => boolean;
export { isTableRow, isSeparator };
/** One bordered row with per-cell bold spans. */
interface RenderedRow {
    text: string;
    group: string | null;
    spans: Array<{
        s: number;
        e: number;
        group: string;
    }>;
}
/**
 * Render one validated table block (header + separator + body lines).
 * Exported so the chat feed can render blocks inline against its own
 * fence/diff state machine (a whole-view pre-pass desyncs its fence state
 * on fence markers inside verbatim diff rows).
 * @param {string[]} block raw table lines (block[1] is the separator)
 * @param {boolean} closed whether to draw the bottom border
 * @param {number} maxWidth total display-width cap (Infinity = natural).
 *   Overflow shrinks columns (widest first, floor 3) and wraps cell text
 *   into bordered continuation lines.
 */
export declare function renderTable(block: string[], closed: boolean, maxWidth?: number): RenderedRow[];
/**
 * Detect table blocks across raw view lines (fence-aware) and return the
 * FINAL output entry stream: one entry per OUTPUT line (a table block expands
 * to bordered lines — more entries than raw lines), or `{table:false, raw}`
 * for lines that parse normally.
 * @param {string[]} lines raw view lines
 * @param {boolean} streamOpen whether the last line may still grow
 * @param {number} trailingStatic number of trailing non-content rows (the
 *   feed's transient activity lines) that must not count as content after a
 *   table block — the open-table check ignores them.
 */
export declare function transformTables(lines: string[], streamOpen?: boolean, trailingStatic?: number, maxWidth?: number): TableEntry[];
