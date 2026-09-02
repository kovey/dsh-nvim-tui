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
export declare function transformTables(lines: string[], streamOpen?: boolean, trailingStatic?: number): TableEntry[];
