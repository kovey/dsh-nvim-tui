/** dsh_tui command: /worktree — rc.2 Git worktree create/list/restore/diff.
 *
 *  The host owns branch/checkout creation and changes the calling session's
 *  working directory; the TUI never shells out to git for creation. Removal is
 *  not exposed by the host (archive cleanup owns it), so this command does not
 *  promise a delete operation.
 */
import { execFileSync } from 'node:child_process';
import { t, tf } from '../../kernel/i18n.js';
import { projectionValue } from '../../kernel/app.js';
const serviceOf = (app) => app.svc('worktrees');
const rowsOf = (app, rec) => {
    const value = projectionValue(app, rec.handle.agent.session, 'worktree');
    if (!Array.isArray(value))
        return [];
    return value.filter((v) => typeof v === 'object' && v !== null &&
        typeof v.worktree?.path === 'string' &&
        typeof v.worktree?.branch === 'string');
};
const showList = async (app, rows) => {
    if (rows.length === 0) {
        app.notice(t('本会话没有创建过 worktree'));
        return;
    }
    const lines = [t('Worktree'), '', ...rows.map((row) => {
            const w = row.worktree;
            return `${row.owned ? '●' : '○'} ${w.branch}  ${w.path}\n  base ${w.baseCommit.slice(0, 12)} · ${w.repositoryRoot}`;
        })];
    await app.luaCall('require("dsh_tui").show_lines_float(...)', [t('Worktree'), lines]).catch((err) => {
        app.notice(tf('Worktree 浮窗打开失败: {0}', [err.message]));
    });
};
const choose = async (app, rows, title) => {
    const picked = await app.openPicker(title, rows.map((r) => ({
        label: `${r.worktree.branch} · ${r.worktree.path}`,
        value: r.worktree.path,
    })));
    return picked === null ? undefined : rows.find((r) => r.worktree.path === picked);
};
const targetOf = async (app, rows, tail, title) => rows.find((r) => r.worktree.path === tail) ?? (tail === '' ? await choose(app, rows, title) : undefined);
const createAction = async (app, rec, svc, rest) => {
    const [name, from] = rest;
    if (name !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
        app.notice(t('worktree 名称只能是小写字母/数字/连字符，且以字母开头'));
        return;
    }
    const created = await svc.create(rec.handle.agent, {
        ...(name === undefined ? {} : { name }),
        ...(from === undefined ? {} : { from }),
    }, AbortSignal.timeout(300_000));
    app.notice(tf('已创建并进入 worktree {0}（{1}）', [created.branch, created.path]));
};
const restoreAction = async (app, rec, svc, tail) => {
    const rows = rowsOf(app, rec).filter((r) => r.owned);
    if (rows.length === 0) {
        app.notice(t('没有可恢复的 worktree（本会话未创建过 checkout）'));
        return;
    }
    const target = await targetOf(app, rows, tail, t('恢复 worktree'));
    if (target === undefined) {
        app.notice(t('找不到该 worktree 记录'));
        return;
    }
    const restored = await svc.restore(rec.handle.agent, target.worktree, AbortSignal.timeout(300_000));
    app.notice(tf('已恢复 worktree {0}{1}', [restored.path, restored.branchRecreated ? t('（分支已重新创建）') : '']));
};
/** Review command for one checkout: `--stat` diff of the working tree against
 *  the recorded base commit. Exported so the smoke suite can assert the exact
 *  argv without shelling out to git. */
export const worktreeDiffArgv = (path, baseCommit) => ['-C', path, 'diff', '--stat', baseCommit];
/** Float body for one `git diff --stat` output (empty → explicit placeholder). */
export const worktreeDiffLines = (stat) => {
    const trimmed = stat.trim();
    return trimmed === '' ? [t('（相对 base 没有差异）')] : ['```diff', ...trimmed.split('\n'), '```'];
};
const diffAction = async (app, rec, tail) => {
    const rows = rowsOf(app, rec).filter((r) => r.owned);
    const target = await targetOf(app, rows, tail, t('审阅 worktree'));
    if (target === undefined) {
        app.notice(t('找不到该 worktree 记录'));
        return;
    }
    try {
        const stat = execFileSync('git', worktreeDiffArgv(target.worktree.path, target.worktree.baseCommit), {
            encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
        });
        const lines = worktreeDiffLines(stat);
        await app.luaCall('require("dsh_tui").show_lines_float(...)', [tf('Worktree diff: {0}', [target.worktree.branch]), lines]);
    }
    catch (err) {
        app.notice(tf('Worktree diff 失败: {0}', [err.message]));
    }
};
export const worktreeCommand = async (app, a) => {
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec) {
        app.notice(t('无活跃会话'));
        return;
    }
    const svc = serviceOf(app);
    if (svc === undefined) {
        app.notice(t('当前宿主未装配 worktrees（需要 dsh 0.2.2-rc.2 的 experimental worktree）'));
        return;
    }
    const [verb = 'list', ...rest] = (a ?? '').trim() === '' ? [] : (a ?? '').trim().split(/\s+/);
    const tail = rest.join(' ').trim();
    try {
        if (verb === 'list')
            await showList(app, rowsOf(app, rec));
        else if (verb === 'new')
            await createAction(app, rec, svc, rest);
        else if (verb === 'restore')
            await restoreAction(app, rec, svc, tail);
        else if (verb === 'diff')
            await diffAction(app, rec, tail);
        else
            app.notice(t('用法: /worktree [new [名称] [起点] | list | restore [路径] | diff [路径]]'));
    }
    catch (err) {
        app.notice(tf('worktree 操作失败: {0}', [err.message]));
    }
};
export function installWorktreeCommand(app) {
    app.registerCommands([{
            name: '/worktree',
            desc: t('Git worktree 创建/列出/恢复/diff（rc.2）'),
            usage: t('[new [名称] [起点] | list | restore [路径] | diff [路径]]'),
            group: t('会话'),
            args: [{ kind: 'oneof', values: ['new', 'list', 'restore', 'diff'] }],
            fn: (a) => worktreeCommand(app, a),
        }]);
}
