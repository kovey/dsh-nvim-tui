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
/** Known image-capable model ids, in preference order (0.1.5 catalog). */
export declare const PREFERRED_VISION_MODEL_IDS: readonly string[];
export declare function findVisionModel(app: App, provider: string): Promise<string | undefined>;
