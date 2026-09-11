/**
 * GENERATED — do not edit by hand. Regenerate with:
 *   node scripts/whale-gen.ts --emit src/feed/whale-art.ts
 *
 * The official DeepSeek mark rasterised to half-block cells. The mark is a
 * single closed cubic-Bézier silhouette (viewBox 23.16×17.04, ratio 1.359), not pixel art — the previous hand-drawn
 * 16×24 grid was an approximation and never matched. Deriving the cells from
 * the real path is what makes the TUI whale track the official mark, and it
 * re-derives at any size instead of needing a redraw per resolution.
 *
 * Geometry: packages/client/ui-primitives/src/FishLogo.tsx
 * (FISH_LOGO_VIEWBOX / FISH_LOGO_PATH), deepseek-harness.
 *
 * @module dsh-nvim-tui/feed/whale-art
 */
/** One rendered row: text plus byte-offset spans naming a highlight group.
 *  Groups use the feed palette convention fg=top pixel / bg=bottom pixel, so
 *  the whole silhouette needs only three (BB full, B- top, -B bottom). */
export interface WhaleArtRow {
    t: string;
    s: Array<{
        s: number;
        e: number;
        g: string;
    }>;
}
/** 24-column tier — 9 text rows. */
export declare const WHALE_24: WhaleArtRow[];
/** 32-column tier — 12 text rows. */
export declare const WHALE_32: WhaleArtRow[];
/** 48-column tier — 18 text rows. */
export declare const WHALE_48: WhaleArtRow[];
/** Tiers in ascending width; the hero picks the widest that fits. */
export declare const WHALE_TIER_WIDTHS: readonly number[];
