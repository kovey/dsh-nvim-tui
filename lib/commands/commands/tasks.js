/** dsh_tui command: /tasks — one command per file (self-registering,
 *  wired by the commands module index). */
import { t, tf } from '../../kernel/i18n.js';
/** /tasks [kill <id>] — job registry view / cancel one job. */
export const tasksCommand = async (app, a) => {
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec) {
        app.notice(t('无活跃会话'));
        return;
    }
    const jobs = app.svc('jobs');
    if (jobs === undefined) {
        app.notice(t('jobs 服务未装配'));
        return;
    }
    const arg = (a ?? '').trim();
    if (arg.startsWith('kill ')) {
        const id = arg.slice(5).trim();
        if (id === '') {
            app.notice(t('用法: /tasks kill <job-id>'));
            return;
        }
        const r = jobs.kill(id, rec.handle.agent, 'user asked');
        app.notice(r === 'requested' ? tf('已请求取消 {0}', [id]) : tf('{0} 已结束', [id]));
        return;
    }
    const list = jobs.list(rec.handle.agent);
    if (list.length === 0) {
        app.notice(t('（没有运行中的任务）'));
        return;
    }
    const icon = (st) => st === 'running' ? '⏳' : st === 'completed' ? '✓' : st === 'killed' ? '✗' : st === 'failed' ? '⚠' : '·';
    const items = list.map((j) => {
        const elapsed = j.startedAt !== undefined ? ` · ${((Date.now() - j.startedAt) / 1000).toFixed(0)}s` : '';
        return { label: `${icon(j.status)} ${j.label ?? j.id} · ${j.id}${elapsed}`, value: `kill:${j.id}` };
    });
    // LIVE popup: jobs events re-render the open float in place.
    const live = app.openLivePicker(t('任务列表（选中取消该任务）'), items);
    app.slices.agent.setLivePopup({ kind: 'jobs', update: live.update });
    const sel = await live.pick;
    app.slices.agent.setLivePopup(null);
    if (sel === null)
        return;
    if (sel.startsWith('kill:')) {
        const id = sel.slice(5);
        const r = jobs.kill(id, rec.handle.agent, 'user asked');
        app.notice(r === 'requested' ? tf('已请求取消 {0}', [id]) : tf('{0} 已结束', [id]));
    }
};
export function installTasksCommand(app) {
    app.registerCommands([{ name: '/tasks', desc: t('任务列表/取消'), usage: t('[kill <job-id>]'), group: t('会话'), fn: (a) => tasksCommand(app, a) }]);
}
