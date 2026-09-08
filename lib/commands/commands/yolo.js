/** dsh_tui command: /yolo — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js';
/** /yolo [on|off] — approval policy ask/never. */
export const yoloCommand = (app, a) => {
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec)
        return;
    const policy = a === 'on' ? 'never' : a === 'off' ? 'ask' : rec.policy === 'never' ? 'ask' : 'never';
    try {
        rec.handle.agent.session.append('approval/policy', { policy });
        rec.policy = policy;
        app.slices.ui.updateStatusline();
        app.notice(`审批策略: ${policy === 'never' ? 'never（不再询问 · 需要审批的操作自动拒绝）' : 'ask（逐项询问）'}`);
    }
    catch (err) {
        app.notice(`yolo 失败: ${err.message}`);
    }
};
export function installYoloCommand(app) {
    app.registerCommands([{ name: '/yolo', desc: t('审批策略开关'), usage: t('on|off'), group: t('审批'), fn: (a) => yoloCommand(app, a) }]);
}
