/** Known image-capable model ids, in preference order (0.1.5 catalog). */
const PREFERRED_VISION_MODEL_IDS = [
    'deepseek-flash',
    'deepseek-v4-flash-vision-exp',
    'deepseek-vl2',
    'deepseek-vl',
];
/** Is `wanted` accepted by `info`? An absent `reasoning` block means the host
 *  REJECTS any effort (UNSUPPORTED_REASONING_EFFORT), so unknown = not
 *  supported — callers then drop the effort instead of failing the turn. */
export const effortSupported = (info, wanted) => {
    if (wanted === undefined || wanted === '')
        return true;
    const efforts = info?.reasoning?.efforts;
    if (efforts === undefined)
        return false;
    return efforts.some((e) => e?.id === wanted);
};
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
