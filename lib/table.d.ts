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
 * @param {string[]} block raw table lines (block[1] is the separator)
 * @param {boolean} closed whether to draw the bottom border
 */
export declare function renderTable(block: string[], closed: boolean): RenderedRow[];
/**
 * Detect table blocks across raw view lines (fence-aware) and return the
 * FINAL output entry stream: one entry per OUTPUT line (a table block expands
 * to bordered lines — more entries than raw lines), or `{table:false, raw}`
 * for lines that parse normally.
 * @param {string[]} lines raw view lines
 * @param {boolean} streamOpen whether the last line may still grow
 */
export declare function transformTables(lines: string[], streamOpen?: boolean): TableEntry[];
export {};
