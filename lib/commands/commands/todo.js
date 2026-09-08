/** dsh_tui command: /todo — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js';
import { followup } from '../core.js';
/** /todo — the standing task list is AGENT-owned (the dsh todo_write
 *  tool rejects non-agent callers, the official web UI only renders it),
 *  so adding a task = asking the agent to update its list; with no
 *  argument the current list pops up (read-only, from todo/write folds). */
export const todoCommand = async (app, a) => {
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec) {
        app.notice(t('无活跃会话'));
        return;
    }
    const text = (a ?? '').trim();
    if (text !== '') {
        const items = rec.todosItems ?? [];
        const keep = items.length > 0 ? `，保持其余 ${items.length} 项不变` : '';
        void followup(app, rec, `请更新任务清单：添加一项「${text}」${keep}`);
        return;
    }
    // Whole-log todos projection (dsh-tool-todo registers `todos` on
    // ctx.sessionProjections): authoritative on resumed sessions; fall back
    // to the live todo/write fold.
    let items = rec.todosItems ?? [];
    const projections = app.svc('sessionProjections');
    if (typeof projections?.stateOf === 'function') {
        const proj = projections.stateOf(rec.handle.agent.session, 'todos');
        if (Array.isArray(proj) && proj.length > 0)
            items = proj;
    }
    if (items.length === 0) {
        app.notice(t('（当前没有待办任务——直接告诉我要做什么，我会自己维护清单）'));
        return;
    }
    const marks = { pending: '○', in_progress: '◐', completed: '✓' };
    const pickItems = items.map((it) => ({ label: `  ${marks[it.status] ?? '·'} ${it.content}`, value: it.content }));
    // LIVE popup: todo/write events re-render the open float in place.
    const live = app.openLivePicker(t('📋 待办清单'), pickItems);
    app.slices.agent.setLivePopup({ kind: 'todo', update: live.update });
    await live.pick;
    app.slices.agent.setLivePopup(null);
};
export function installTodoCommand(app) {
    app.registerCommands([{ name: '/todo', desc: t('添加/查看待办任务'), usage: t('[任务内容]'), group: t('会话'), fn: (a) => todoCommand(app, a) }]);
}
