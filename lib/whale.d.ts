/**
 * Blue whale background art (DeepSeek mascot) for the chat window.
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
export declare const WHALE_BIG: WhaleRow[];
export declare const WHALE_SMALL: WhaleRow[];
export declare function whaleMaxWidth(rows: WhaleRow[]): number;
/**
 * Lay the art out for a window: horizontally centered, vertically centered
 * via leading empty rows. Returns null when the window is too small.
 */
export declare function layoutWhaleRows(rows: WhaleRow[], height: number, width: number): WhaleRow[] | null;
