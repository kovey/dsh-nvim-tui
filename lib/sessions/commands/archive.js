/** dsh_tui command: /archive — one command per file. */
import { t } from '../../kernel/i18n.js';
/** /archive [id] — hide a session from every list (non-destructive). */
export const archiveCommand = async (app, a) => {
    const ws = app.svc('workspaceRegistry');
    if (typeof ws?.archiveSession !== 'function') {
        app.notice(t('归档不可用（workspaceRegistry 服务未装配）'));
        return;
    }
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    const target = (a ?? '').trim() || rec?.id;
    if (target === undefined || target === '') {
        app.notice(t('用法: /archive [会话id]（无参数归档当前会话）'));
        return;
    }
    try {
        await ws.archiveSession(target);
        app.slices.sessions.refreshList();
        app.notice(`已归档 ${target}（从各列表隐藏）`);
    }
    catch (err) {
        app.notice(`归档失败: ${err.message}`);
    }
};
export function installArchiveCommand(app) {
    app.registerCommands([{ name: '/archive', desc: t('归档会话（从列表隐藏）'), usage: t('[会话id]'), group: t('会话'), fn: (a) => archiveCommand(app, a) }]);
}
