/** dsh_tui command: /rename — one command per file. */
import { t, tf } from '../../kernel/i18n.js';
/** /rename <title> — pin the active session's title. */
export const renameCommand = (app, a) => {
    const title = (a ?? '').trim();
    if (title === '') {
        app.notice(t('用法: /rename <新标题>'));
        return;
    }
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec) {
        app.notice(t('无活跃会话'));
        return;
    }
    const sessionTitle = app.svc('sessionTitle');
    if (sessionTitle === undefined) {
        app.notice(t('session-title 服务未装配'));
        return;
    }
    try {
        const live = app.liveSessions.get(rec.id);
        if (live === undefined) {
            app.notice(t('会话已不在线（可能已退出或未成功恢复），无法重命名'));
            return;
        }
        sessionTitle.rename(live, title);
        app.notice(t('标题已更新'));
    }
    catch (err) {
        app.notice(tf('重命名失败: {0}', [err.message]));
    }
};
export function installRenameCommand(app) {
    app.registerCommands([{ name: '/rename', desc: t('重命名会话'), usage: t('<新标题>'), group: t('会话'), fn: (a) => renameCommand(app, a) }]);
}
