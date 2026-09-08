/** dsh_tui command: /model — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js';
import { applyModelSelection } from '../core.js';
/** /model [provider/model]: picker without an argument, direct switch with. */
export const pickModel = async (app, arg) => {
    const sel = app.slices.agent.currentSelection();
    if (arg) {
        const [provider, model] = arg.includes('/') ? arg.split('/') : [sel.provider, arg];
        if (!model) {
            app.notice(`用法: /model [provider/model]`);
            return;
        }
        try {
            await applyModelSelection(app, { provider, model, reasoningEffort: sel.reasoningEffort });
        }
        catch (err) {
            app.notice(`模型切换失败: ${err.message}`);
        }
        return;
    }
    const items = [{ label: `${sel.provider}/${sel.model} · 当前`, value: JSON.stringify(sel), active: true }];
    const picked = await app.openPicker(t('选择模型'), items);
    if (picked === null)
        return;
    try {
        await applyModelSelection(app, JSON.parse(picked));
    }
    catch (err) {
        app.notice(`模型切换失败: ${err.message}`);
    }
};
export function installModelCommand(app) {
    app.registerCommands([{ name: '/model', desc: t('选择/切换模型'), usage: t('[provider/model]'), group: t('模型'), fn: (a) => pickModel(app, a) }]);
}
