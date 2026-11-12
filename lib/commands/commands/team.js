/** dsh_tui command: /team — rc.2 AgentTeam mode and shared task board.
 *  The service is optional: older hosts simply do not expose it, and the
 *  command says so instead of failing the rest of the TUI. */
import { t, tf } from '../../kernel/i18n.js';
export const teamCommand = async (app, a) => {
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec) {
        app.notice(t('无活跃会话'));
        return;
    }
    const arg = (a ?? '').trim();
    if (arg !== '' && arg !== 'on' && arg !== 'off' && arg !== 'tasks') {
        app.notice(t('用法: /team [on|off|tasks]'));
        return;
    }
    const svc = app.svc('agentTeams');
    if (svc === undefined) {
        app.notice(t('当前宿主未装配 AgentTeam（dsh < 0.2.2-rc.2 或未加载 agent-team）'));
        return;
    }
    if (arg === 'on' || arg === 'off') {
        try {
            await svc.setEnabled(rec.handle.agent, arg === 'on', AbortSignal.timeout(30000));
            app.notice(arg === 'on' ? t('AgentTeam 已开启（共享任务板）') : t('AgentTeam 已关闭'));
        }
        catch (err) {
            app.notice(tf('AgentTeam 切换失败: {0}', [err.message]));
        }
        return;
    }
    let tasks;
    try {
        tasks = svc.listTasks(rec.handle.agent);
    }
    catch (err) {
        app.notice(tf('读取 Team 任务失败: {0}', [err.message]));
        return;
    }
    const enabled = (() => { try {
        return svc.isEnabled(rec.handle.agent);
    }
    catch {
        return false;
    } })();
    if (tasks.length === 0) {
        app.notice(tf('AgentTeam {0} · 暂无任务', [enabled ? t('已开启') : t('未开启；/team on 开启')]));
        return;
    }
    const mark = (status) => status === 'completed' ? '✓' : status === 'in_progress' ? '…' : status === 'deleted' ? '×' : '·';
    const lines = [
        `${t('AgentTeam')}: ${enabled ? t('已开启') : t('未开启')} · ${tf('{0} 个任务', [tasks.length])}`,
        '',
        ...tasks.slice(0, 100).map((task) => {
            const owner = task.ownerName ?? (task.ownerId !== undefined ? task.ownerId.slice(0, 8) : '');
            return `${mark(task.status)} ${task.id}  ${task.subject}${owner === '' ? '' : ` · ${owner}`}${task.ready === false ? ` · ${t('被阻塞')}` : ''}`;
        }),
    ];
    await app.luaCall('require("dsh_tui").show_lines_float(...)', [t('AgentTeam 任务'), lines]).catch((err) => {
        app.notice(tf('Team 任务浮窗打开失败: {0}', [err.message]));
    });
};
export function installTeamCommand(app) {
    app.registerCommands([{
            name: '/team',
            desc: t('AgentTeam 开关与共享任务板（rc.2）'),
            usage: t('[on|off|tasks]'),
            group: t('会话'),
            args: [{ kind: 'oneof', values: ['on', 'off', 'tasks'], hint: t('不填显示任务板') }],
            fn: (a) => teamCommand(app, a),
        }]);
}
