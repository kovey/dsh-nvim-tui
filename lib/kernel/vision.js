/** Known image-capable model ids, in preference order (0.1.5 catalog). */
export const PREFERRED_VISION_MODEL_IDS = [
    'deepseek-flash',
    'deepseek-v4-flash-vision-exp',
    'deepseek-vl2',
    'deepseek-vl',
];
export async function findVisionModel(app, provider) {
    const llm = app.runtimeCtx.get('llm');
    if (llm === undefined)
        return undefined;
    for (const id of PREFERRED_VISION_MODEL_IDS) {
        try {
            const info = await llm.resolveModelInfo(provider, id);
            if (info?.inputModalities?.includes('image') === true)
                return id;
        }
        catch { }
    }
    // Catalog fallback: ANY image-capable model (custom catalogs).
    if (typeof llm.listModels === 'function') {
        try {
            const models = await llm.listModels(provider);
            for (const m of models ?? []) {
                if (m?.id !== undefined && m.inputModalities?.includes('image') === true)
                    return m.id;
            }
        }
        catch { }
    }
    return undefined;
}
