/** dsh_tui command: /models — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js';
/** /models — provider/model catalog + current selection (official
 *  model-selection settings counterpart). */
export const modelsCommand = (app) => {
    const sel = app.slices.agent.currentSelection();
    app.notice(`当前模型: ${sel.provider}/${sel.model}${sel.reasoningEffort ? ` ◎${sel.reasoningEffort}` : ''}`);
    const llm = app.runtimeCtx.get('llm');
    if (llm === undefined) {
        app.notice(t('（llm 服务未装配）'));
        return;
    }
    try {
        const live = llm.listProviders?.() ?? [];
        const configurable = llm.listConfigurableProviders?.() ?? [];
        if (live.length === 0 && configurable.length === 0) {
            app.notice(t('（没有已注册的 provider；用 /settings 查看模型配置）'));
            return;
        }
        for (const p of live)
            app.notice(`● ${String(p.id ?? p.provider ?? '?')} · ${String(p.name ?? '')}`);
        for (const p of configurable) {
            if (live.some((l) => String(l.id ?? l.provider) === String(p.provider)))
                continue;
            app.notice(`○ ${String(p.provider ?? '?')} · ${String(p.displayName ?? '')} · 配置段 ${String(p.settingsNs ?? '?')}`);
        }
    }
    catch (err) {
        app.notice(`models 失败: ${err.message}`);
    }
};
export function installModelsCommand(app) {
    app.registerCommands([{ name: '/models', desc: t('模型/供应商目录'), usage: t('模型目录'), group: t('模型'), fn: () => modelsCommand(app) }]);
}
