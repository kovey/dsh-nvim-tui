/** dsh_tui command: /model — one command per file (self-registering,
 *  wired by the commands module index). */
import { t, tf } from '../../kernel/i18n.js';
import { applyModelSelection } from '../core.js';
import { configuredModels, modelCatalogRows, providerSettingsNs } from './models.js';
/** /model [provider/model]: real catalog picker without an argument
 *  (pre-review: a decorative single-row picker — the catalog lived only in
 *  /models), validated direct switch with one. */
export const pickModel = async (app, arg) => {
    const sel = app.slices.agent.currentSelection();
    if (arg) {
        const parts = arg.split('/');
        if (parts.length > 2 || parts.some((p) => p.trim() === '')) {
            app.notice(t('用法: /model [provider/model]'));
            return;
        }
        const provider = parts.length === 2 ? parts[0] : sel.provider;
        const model = parts.length === 2 ? parts[1] : parts[0];
        // provider must be a LIVE provider id — a bogus id used to be persisted
        // straight into the default-model selection (writing corrupt config).
        const llm = app.runtimeCtx.get('llm');
        if (llm !== undefined) {
            const live = llm.listProviders?.() ?? [];
            if (!live.some((p) => String(p.id ?? p.provider ?? '') === provider)) {
                app.notice(tf('未知 provider: {0}（用 /models 查看目录）', [provider]));
                return;
            }
            // When the catalog IS enumerable, the model id must be in it.
            const models = configuredModels(app, provider, providerSettingsNs(app, provider));
            if (models.length > 0 && !models.includes(model)) {
                app.notice(tf('未知模型: {0}（provider {1} 的目录不含它；用 /models 查看）', [model, provider]));
                return;
            }
        }
        try {
            await applyModelSelection(app, { provider, model, reasoningEffort: sel.reasoningEffort });
        }
        catch (err) {
            app.notice(tf('模型切换失败: {0}', [err.message]));
        }
        return;
    }
    const rows = modelCatalogRows(app);
    if (rows === null) {
        app.notice(t('（llm 服务未装配）'));
        return;
    }
    if (rows.length === 0) {
        app.notice(t('（没有已注册的 provider；用 /settings 查看模型配置）'));
        return;
    }
    // Only switchable rows + the current header (drop prov: info rows).
    const pickable = rows.filter((r) => r.value === 'act:current' || r.value.startsWith('switch:'));
    const picked = await app.openPicker(t('选择模型'), pickable);
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
    app.notice(t('该 provider 未装配或模型目录不可枚举（settings.yaml 配置后 /restart）'));
};
export function installModelCommand(app) {
    app.registerCommands([{ name: '/model', desc: t('选择/切换模型'), usage: t('[provider/model]'), group: t('模型'), fn: (a) => pickModel(app, a) }]);
}
