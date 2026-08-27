/**
 * Blue whale pixel art for the chat window — the DeepSeek brand whale
 * (rounded body, white belly, eye + blush, upturned tail) with nvim-tui
 * flavor on top of the base silhouette: the left eye winks, two bubbles
 * rise above the head, and a white sparkle sits in the sky.
 *
 * 16×24 pixel grid rendered with half-block glyphs (▀/▄/█), one highlight
 * group per cell color pair so the nvim extmark pass can color each glyph
 * with foreground/background (truecolor + 256-color).
 * Ported from the tianshu-tui welcome whale (huiliyi37/dsh-tianshu-tui,
 * src/format/whale.ts — the user's previous TUI).
 */
export interface WhaleRenderRow {
    text: string;
    spans: Array<{
        s: number;
        e: number;
        group: string;
    }>;
}
export declare const WHALE_COLS = 24;
export declare const WHALE_ROWS = 8;
/** Pre-rendered pixel rows (text + per-glyph color spans). */
export declare const WHALE_RENDER_ROWS: WhaleRenderRow[];
/**
 * One-line statusline animation (replaces the running spinner): a 6-cell
 * mini whale — white bubble pops above the head, eye fixed, tail fluke
 * flips ▖↔▘. Inline `%#Group#` markers let the statusline color each glyph
 * with the same pixel-pair highlight groups as the wallpaper.
 */
export declare const WHALE_STATUS_FRAMES: readonly string[];
/** Full-size animation frames (8 text rows × 24 cols). */
export declare function whaleFrames(): WhaleRenderRow[][];
/**
 * Watermark animation: the terminal's own emoji font renders the whale
 * (2 cells wide), so frames cycle the spouting whale ↔ plain whale — the
 * spout appears to pulse. No highlight groups: emoji carry their colors.
 */
export declare const WHALE_EMOJI_FRAMES: readonly string[];
/**
 * Horizontally indented whale rows (no vertical padding — the caller composes
 * the whole empty-state block and centers it as one unit).
 */
export declare function whaleRowsIndented(width: number, rows?: WhaleRenderRow[]): WhaleRenderRow[] | null;
/**
 * Center the whale for a window: leading empty rows for vertical centering
 * and a horizontal indent baked into the text. Returns null when the window
 * is too small (min 40×22, like tianshu).
 */
export declare function layoutWhaleRows(height: number, width: number, rows?: WhaleRenderRow[]): WhaleRenderRow[] | null;
