/**
 * Blue whale background art for the chat window.
 * The big whale is the classic terminal whale by SSt ("The Pines of Rome"),
 * sourced from the ascii.co.uk whale art archive (https://ascii.co.uk/art/whale).
 *
 * Two layouts, per the chosen UX:
 *  - WHALE_BIG: centered empty-state wallpaper (shown while the transcript
 *    has no content);
 *  - WHALE_SMALL: persistent bottom watermark once content exists.
 *
 * Rows carry their highlight group (DshTuiWhale1..4 = a blue gradient from
 * light spout to deep body); layout helpers indent/center them for any
 * window size.
 */
export interface WhaleRow {
    text: string;
    group: string;
}
/**
 * Big whale: the classic terminal whale drawing ("The Pines of Rome" by SSt,
 * from the ascii.co.uk whale archive) — a detailed line-art whale with
 * splashes, 15 rows × 64 cols.
 */
export declare const WHALE_BIG: WhaleRow[];
export declare const WHALE_SMALL: WhaleRow[];
export declare function whaleMaxWidth(rows: WhaleRow[]): number;
/**
 * Lay the art out for a window: horizontally centered, vertically centered
 * via leading empty rows. Returns null when the window is too small.
 */
export declare function layoutWhaleRows(rows: WhaleRow[], height: number, width: number): WhaleRow[] | null;
