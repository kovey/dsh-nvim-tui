/**
 * dsh_tui kernel module: vision-model resolution for image messages.
 *
 * dsh 0.1.5 ships `deepseek-flash` (DeepSeek-V41-Flash, text+image) as the
 * DEFAULT model and keeps `deepseek-v4-flash-vision-exp`; `deepseek-vl2` /
 * `deepseek-vl` only exist in custom catalogs. Instead of hardcoding one
 * catalog generation, resolution prefers the known image-capable ids and
 * falls back to scanning the provider's full model list for ANY model that
 * declares the image modality.
 *
 * @module dsh-nvim-tui/kernel/vision
 */
import type { App } from './app.js';
/** Model-info facts the TUI reads (duck-typed subset of the host catalog). */
export interface ModelInfoLike {
    inputModalities?: readonly string[];
    reasoning?: {
        efforts?: ReadonlyArray<{
            id?: string;
        }>;
    };
}
/** Is `wanted` accepted by `info`? An absent `reasoning` block means the host
 *  REJECTS any effort (UNSUPPORTED_REASONING_EFFORT), so unknown = not
 *  supported — callers then drop the effort instead of failing the turn. */
export declare const effortSupported: (info: ModelInfoLike | undefined, wanted: string | undefined) => boolean;
export declare function findVisionModel(app: App, provider: string): Promise<string | undefined>;
