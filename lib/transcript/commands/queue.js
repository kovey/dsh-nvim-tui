/** dsh_tui command: /queue — one command per file. */
import { t, tf } from '../../kernel/i18n.js';
import { FeedRenderer } from '../../feed/feed.js';
export const queueCommand = async (app) => {
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec) {
        app.notice(t('无活跃会话'));
        return;
    }
    const inbox = rec.handle.agent.inbox;
    const nextTurn = (inbox?.nextTurn ?? []);
    const nextStep = (inbox?.nextStep ?? []);
    if (nextTurn.length === 0 && nextStep.length === 0) {
        app.notice(t('（没有排队中的消息）'));
        return;
    }
    const rows = [];
    const add = (list, msgs, prefix) => {
        for (const m of msgs) {
            const id = m.id;
            const text = FeedRenderer.messageText(m);
            rows.push({
                label: `${prefix}${FeedRenderer.truncate(text.replace(/\s+/g, ' '), 60)}`,
                value: JSON.stringify({ list, id: String(id ?? '') }),
            });
        }
    };
    if (nextTurn.length > 0)
        rows.push({ label: tf('── 排队回合 {0} 条', [nextTurn.length]), value: 'none' });
    add('nextTurn', nextTurn, '  ');
    if (nextStep.length > 0)
        rows.push({ label: tf('── 下一步输入 {0} 条', [nextStep.length]), value: 'none' });
    add('nextStep', nextStep, '  ');
    rows.push({ label: t('🗑 清空全部排队'), value: 'clear' });
    const sel = await app.openPicker(t('消息队列'), rows);
    if (sel === null || sel === 'none')
        return;
    if (sel === 'clear') {
        if (typeof inbox?.clear !== 'function') {
            app.notice(t('inbox 不可用'));
            return;
        }
        try {
            inbox.clear();
            app.notice(t('已清空排队消息'));
            app.slices.ui.updateStatusline();
        }
        catch (err) {
            app.notice(tf('清空失败: {0}', [err.message]));
        }
        return;
    }
    let picked;
    try {
        picked = JSON.parse(sel);
    }
    catch { }
    if (picked === undefined)
        return;
    const act = await app.openPicker(t('队列操作'), [
        { label: '删除该条', value: 'del' },
        { label: '编辑该条（下一条输入作为新内容）', value: 'edit' },
    ]);
    if (act === 'del') {
        if (typeof inbox?.remove !== 'function') {
            app.notice(t('inbox 不可用'));
            return;
        }
        try {
            const ok = inbox.remove(picked.id);
            app.notice(ok === true ? t('已从队列移除') : t('该消息已被处理'));
            app.slices.ui.updateStatusline();
        }
        catch (err) {
            app.notice(tf('移除失败: {0}', [err.message]));
        }
    }
    else if (act === 'edit') {
        app.slices.agent.setPendingQueueEdit({ list: picked.list, messageId: picked.id });
        app.notice(t('下一条输入将替换该排队消息'));
    }
};
export function installQueueCommand(app) {
    app.registerCommands([{ name: '/queue', desc: t('消息队列（编辑/删除/清空）'), usage: t('消息队列'), group: t('会话'), fn: () => queueCommand(app) }]);
}
