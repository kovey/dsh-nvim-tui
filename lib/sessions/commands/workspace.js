/** dsh_tui command: /workspace — one command per file. */
import { t, tf } from '../../kernel/i18n.js';
/** /workspace [add <目录> [标题] | delete <id>] — workspace management.
 *  Bare /workspace opens a sessions-style popup: workspace directory,
 *  create-via-directory-picker, rename (next input) and delete actions. */
export const workspaceCommand = async (app, a) => {
    const ws = app.svc('workspaceRegistry');
    if (ws === undefined || typeof ws.list !== 'function') {
        app.notice(t('workspaceRegistry 服务未装配（profile 加入 dsh-workspace 后可用）'));
        return;
    }
    const arg = (a ?? '').trim();
    // Optional-service guard: a missing create/delete must NEVER masquerade
    // as success ("已添加" after await undefined) — pre-review it did.
    const canCreate = typeof ws.create === 'function';
    const canDelete = typeof ws.delete === 'function';
    if (arg.startsWith('add ')) {
        if (!canCreate) {
            app.notice(t('workspaceRegistry 未实现 create（服务版本过旧）'));
            return;
        }
        const [path, ...rest] = arg.slice(4).trim().split(/\s+/);
        if (path === undefined || path === '') {
            app.notice(t('用法: /workspace add <目录> [标题]'));
            return;
        }
        try {
            const title = rest.join(' ').trim() || undefined;
            await ws.create?.(path, title);
            app.notice(tf('工作区已添加: {0}', [title ?? path]));
        }
        catch (err) {
            app.notice(tf('添加工作区失败: {0}', [err.message]));
        }
        return;
    }
    if (arg.startsWith('delete ')) {
        if (!canDelete) {
            app.notice(t('workspaceRegistry 未实现 delete（服务版本过旧）'));
            return;
        }
        const id = arg.slice(7).trim();
        try {
            const ok = await ws.delete?.(id);
            app.notice(ok === true ? tf('工作区已移除（其会话保留为未分组）: {0}', [id]) : tf('未知工作区: {0}', [id]));
        }
        catch (err) {
            app.notice(tf('移除失败: {0}', [err.message]));
        }
        return;
    }
    if (arg !== '') {
        app.notice(t('用法: /workspace [add <目录> [标题] | delete <id>]'));
        return;
    }
    // Sessions-style popup: workspace directory + per-workspace actions.
    const list = ws.list();
    const rows = [
        { label: '＋ 新建工作区（弹出目录选择）', value: 'act:new' },
    ];
    for (const w of list) {
        rows.push({ label: tf('📁 {0} · {1} · {2} 会话', [w.title, w.path, w.sessionIds.length]), value: `ws:${w.id}` });
    }
    const sel = await app.openPicker(t('工作区管理'), rows);
    if (sel === null)
        return;
    if (sel === 'act:new') {
        if (!canCreate) {
            app.notice(t('workspaceRegistry 未实现 create（服务版本过旧）'));
            return;
        }
        const dir = await app.slices.agent.openDirPicker(process.cwd());
        if (dir === null || dir === '')
            return;
        try {
            await ws.create?.(dir);
            app.notice(tf('工作区已添加: {0}', [dir]));
        }
        catch (err) {
            app.notice(tf('添加工作区失败: {0}', [err.message]));
        }
        return;
    }
    const wid = sel.slice(3);
    const w = list.find((x) => x.id === wid);
    if (w === undefined)
        return;
    const act = await app.openPicker(tf('工作区 {0}', [w.title]), [
        { label: '重命名（下一条输入作为新名称）', value: 'rename' },
        { label: '删除工作区（会话保留为未分组）', value: 'delete' },
        { label: t('取消'), value: 'cancel' },
    ]);
    if (act === 'rename') {
        app.slices.agent.setPendingRename({ kind: 'workspace', id: wid });
        app.notice(tf('下一条输入将作为工作区「{0}」的新名称', [w.title]));
        return;
    }
    if (act === 'delete') {
        if (!canDelete) {
            app.notice(t('workspaceRegistry 未实现 delete（服务版本过旧）'));
            return;
        }
        const ok = await app.openPicker(t('确认删除工作区'), [
            { label: `确认删除 ${w.title}（会话保留为未分组）`, value: 'yes' },
            { label: t('取消'), value: 'no' },
        ]);
        if (ok !== 'yes')
            return;
        try {
            const r = await ws.delete?.(wid);
            app.notice(r === true ? tf('工作区已移除: {0}', [w.title]) : tf('未知工作区: {0}', [wid]));
        }
        catch (err) {
            app.notice(tf('移除失败: {0}', [err.message]));
        }
    }
};
export function installWorkspaceCommand(app) {
    app.registerCommands([{ name: '/workspace', desc: t('工作区管理'), usage: t('[add <目录> [标题] | delete <id>]'), group: t('会话'), fn: (a) => workspaceCommand(app, a) }]);
}
