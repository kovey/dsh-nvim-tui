/** dsh_tui command: /status — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js';
import { modeLabel } from '../../feed/stats.js';
/** /status — active session snapshot. */
export const statusCommand = (app) => {
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec) {
        app.notice(t('无活跃会话'));
        return;
    }
    app.notice(`${rec.id} · ${rec.title ?? '（无标题）'} · ${rec.status ?? '○ idle'}`);
    app.notice(`模型 ${rec.model ?? '?'} · 权限 ${modeLabel(rec.mode)} · 审批 ${rec.policy ?? 'ask'}`);
};
export function installStatusCommand(app) {
    app.registerCommands([{ name: '/status', desc: t('会话快照'), usage: t('会话快照'), group: t('信息'), fn: () => statusCommand(app) }]);
}
