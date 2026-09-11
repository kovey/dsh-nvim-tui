/** dsh_tui command: /effort — one command per file (self-registering,
 *  wired by the commands module index). */
import { t, tf } from '../../kernel/i18n.js';
import { applyModelSelection } from '../core.js';
/** /effort [off|high|max|auto] */
export const effortCommand = async (app, a) => {
    if (!a) {
        app.notice(`当前推理等级: ${app.slices.agent.currentSelection().reasoningEffort ?? t('auto（模型默认）')}`);
        return;
    }
    if (!['off', 'high', 'max', 'auto'].includes(a)) {
        app.notice(t('用法: /effort [off|high|max|auto]'));
        return;
    }
    const effort = a === 'auto' ? undefined : a;
    const next = {
        ...app.slices.agent.currentSelection(),
        // Absent (not undefined) means "model default" to the host.
        ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    };
    try {
        await applyModelSelection(app, next);
    }
    catch (err) {
        app.notice(tf('切换失败: {0}', [err.message]));
    }
};
export function installEffortCommand(app) {
    app.registerCommands([{ name: '/effort', desc: t('推理等级'), usage: t('off|high|max|auto'), group: t('模型'), fn: (a) => effortCommand(app, a) }]);
}
