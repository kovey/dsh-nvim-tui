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
import type { App } from './app.js'
import type { LlmService } from './types.js'

/** Known image-capable model ids, in preference order (0.1.5 catalog). */
export const PREFERRED_VISION_MODEL_IDS: readonly string[] = [
  'deepseek-flash',
  'deepseek-v4-flash-vision-exp',
  'deepseek-vl2',
  'deepseek-vl',
]

export async function findVisionModel(app: App, provider: string): Promise<string | undefined> {
  const llm = app.runtimeCtx.get('llm') as LlmService | undefined
  if (llm === undefined) return undefined
  for (const id of PREFERRED_VISION_MODEL_IDS) {
    try {
      const info = await llm.resolveModelInfo(provider, id)
      if (info?.inputModalities?.includes('image') === true) return id
    } catch {}
  }
  // Catalog fallback: ANY image-capable model (custom catalogs).
  if (typeof llm.listModels === 'function') {
    try {
      const models = await llm.listModels(provider)
      for (const m of models ?? []) {
        if (m?.id !== undefined && m.inputModalities?.includes('image') === true) return m.id
      }
    } catch {}
  }
  return undefined
}
