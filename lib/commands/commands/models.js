/** dsh_tui command: /models — one command per file (self-registering,
 *  wired by the commands module index). */
import { t, tf } from '../../kernel/i18n.js';
import { applyModelSelection } from '../core.js';
/** Model ids configured for one provider — read from the settings section
 *  (`llm-<provider>.models`, the same catalog the vision-model switch and
 *  /settings overview use). Best-effort: returns [] when the section is
 *  absent or the schema is unrecognized. */
/** Settings namespace for one provider route. The route id and the settings
 *  section name are NOT derivable from each other — 0.1.5 ships provider
 *  `deepseek-official` with ns `llm-deepseek` — so resolve it from the host's
 *  configurable-provider directory instead of guessing `llm-<id>` only. */
export const providerSettingsNs = (app, providerId) => {
    const llm = app.svc('llm');
    try {
        for (const p of llm?.listConfigurableProviders?.() ?? []) {
            const id = String(p?.provider ?? '');
            const ns = String(p?.settingsNs ?? '');
            if (id === providerId && ns !== '')
                return ns;
        }
    }
    catch { }
    return undefined;
};
export const configuredModels = (app, providerId, settingsNs) => {
    const settings = app.svc('settings');
    if (typeof settings?.describe !== 'function')
        return [];
    const wanted = new Set([`llm-${providerId}.models`]);
    if (settingsNs !== undefined && settingsNs !== '')
        wanted.add(settingsNs);
    try {
        for (const d of settings.describe()) {
            if (d.ns === undefined || !wanted.has(d.ns))
                continue;
            const extract = (v) => {
                if (Array.isArray(v)) {
                    return v.map((m) => String(m?.id ?? m ?? ''))
                        .filter((x) => x !== '' && x !== 'undefined');
                }
                const arr = v?.models;
                if (Array.isArray(arr)) {
                    return arr.map((m) => String(typeof m === 'string' ? m : m?.id ?? '')).filter((x) => x !== '');
                }
                return [];
            };
            const ids = extract(d.value);
            if (ids.length > 0)
                return ids;
        }
    }
    catch { /* catalog read is best-effort */ }
    return [];
};
/** Shared catalog rows for the /models directory AND the /model picker:
 *  current header (`act:current`), provider group rows (`prov:<id>`),
 *  switchable model rows (`switch:{provider,model}`). null = llm service
 *  absent; [] = no providers registered. */
export const modelCatalogRows = (app) => {
    const sel = app.slices.agent.currentSelection();
    const llm = app.runtimeCtx.get('llm');
    if (llm === undefined)
        return null;
    const live = llm.listProviders?.() ?? [];
    const configurable = llm.listConfigurableProviders?.() ?? [];
    if (live.length === 0 && configurable.length === 0)
        return [];
    const rows = [{
            label: `▸ 当前模型: ${sel.provider}/${sel.model}${sel.reasoningEffort ? ` ◎${sel.reasoningEffort}` : ''}`,
            value: 'act:current',
            active: true,
        }];
    const liveIds = new Set();
    for (const p of live) {
        const id = String(p.id ?? p.provider ?? '?');
        liveIds.add(id);
        const models = configuredModels(app, id, providerSettingsNs(app, id));
        if (models.length > 0) {
            rows.push({ label: `● ${id} · ${String(p.name ?? '')}`, value: `prov:${id}` });
            for (const m of models) {
                const isCur = sel.provider === id && sel.model === m;
                rows.push({
                    label: `    ${isCur ? '▸ ' : ' '}${m}${isCur ? '（当前）' : ''}`,
                    value: `switch:${JSON.stringify({ provider: id, model: m })}`,
                });
            }
        }
        else {
            rows.push({ label: tf('● {0} · {1}（用 /model {2}/<模型名> 切换）', [id, String(p.name ?? ''), id]), value: `prov:${id}` });
        }
    }
    for (const p of configurable) {
        const pid = String(p.provider ?? '?');
        if (liveIds.has(pid))
            continue;
        rows.push({
            label: tf('○ {0} · {1} · 未装配（配置段 {2}）', [pid, String(p.displayName ?? ''), String(p.settingsNs ?? '?')]),
            value: `prov:${pid}`,
        });
    }
    return rows;
};
/** /models — provider/model catalog popup (sessions-style browse + act):
 *  current selection, live providers with their configured models
 *  (Enter switches), and not-yet-assembled providers pointing at their
 *  settings section. */
export const modelsCommand = async (app) => {
    const sel = app.slices.agent.currentSelection();
    const rows = modelCatalogRows(app);
    if (rows === null) {
        app.notice(t('（llm 服务未装配）'));
        return;
    }
    if (rows.length === 0) {
        app.notice(t('（没有已注册的 provider；用 /settings 查看模型配置）'));
        return;
    }
    const picked = await app.openPicker(t('模型目录（Enter 切换 · 复用 /model 语义）'), rows);
    if (picked === null)
        return;
    if (picked === 'act:current') {
        app.notice(t('已是当前模型'));
        return;
    }
    if (picked.startsWith('switch:')) {
        try {
            await applyModelSelection(app, { ...JSON.parse(picked.slice(7)), reasoningEffort: sel.reasoningEffort });
        }
        catch (err) {
            app.notice(tf('模型切换失败: {0}', [err.message]));
        }
        return;
    }
    // prov:<id>: informational rows (unconfigured / non-enumerable providers).
    app.notice(t('该 provider 未装配或模型目录不可枚举（settings.yaml 配置后 /restart）'));
};
export function installModelsCommand(app) {
    app.registerCommands([{ name: '/models', desc: t('模型/供应商目录'), usage: t('模型目录'), group: t('模型'), fn: () => modelsCommand(app) }]);
}
