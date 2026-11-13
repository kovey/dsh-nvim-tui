/** dsh_tui command: /subagents — one command per file. */
import { t, tf } from '../../kernel/i18n.js';
import { ageLabel, isExpired, orderSubagentChildren } from '../../kernel/subagent-clean.js';
const W = (d) => d;
/** TTL cleanup: settled chains past the retention window are truncated and
 *  hidden. Kept out of the command body so the command stays reviewable. */
const cleanExpiredChildren = async (app, parentId, children) => {
    const ttlHours = Number(app.config['subagentTtlHours'] ?? 72);
    const expired = children.filter((c) => !c.running && isExpired(c.createdAt, ttlHours));
    if (expired.length === 0)
        return children;
    let cleaned = 0;
    for (const c of expired) {
        if (await app.slices.sessions.cleanSubagentChain(parentId, c.id))
            cleaned++;
    }
    if (cleaned === 0)
        return children;
    app.notice(tf('🧹 已清理 {0} 条过期子代理思考链（>{1}h），列表不再显示', [cleaned, ttlHours]));
    return await app.slices.sessions.listSubagentChildren(parentId);
};
/** One picker row label: path (or name/label), display label, then the rc.2
 *  name/depth. rc.1 rows have no name/path/depth and render exactly as before. */
const childDisplay = (c) => {
    const display = c.path ?? c.name ?? c.label;
    const detail = c.path !== undefined && c.label !== c.path ? ` · ${c.label}` : '';
    // rc.2 addresses a child by `name`; a path like `agents/7` does not carry it,
    // so keep the name visible (`agents/7 · reviewer`). Not repeated when the
    // path or the display label already contains it.
    const nameHidden = c.name !== undefined && c.name !== ''
        && c.path !== undefined && !c.path.includes(c.name) && !c.label.includes(c.name);
    // `L<n>` keeps the depth language-neutral (no new i18n dictionary entry in
    // an already oversized table).
    const depth = c.depth === undefined ? '' : ` · L${c.depth}`;
    return `${display}${detail}${nameHidden ? ` · ${c.name}` : ''}${depth}`;
};
/** Picker rows are rendered as REAL nvim buffer lines, and nvim_buf_set_lines
 *  rejects any line carrying CR/LF ("'replacement string' item contains
 *  newlines"). A child's label is often its whole multi-line task prompt, so
 *  /subagents failed before the float opened (the Lua picker folds its own
 *  labels too — this is the second layer, so no other caller can bypass it).
 *  Fold CR/LF/TAB runs into one space; an empty label stays empty. */
export const singleLineLabel = (label) => label.replace(/[\r\n\t]+/g, ' ');
/** Picker rows, newest/running order already applied by the caller. */
export const childRows = (children, settledCount) => {
    const rows = [];
    let cleanRowInserted = false;
    for (const c of children) {
        if (!c.running && !cleanRowInserted) {
            cleanRowInserted = true;
            if (settledCount > 0)
                rows.push({ label: tf('🧹 清理全部已结束思考链（{0} 条）', [settledCount]), value: 'act:clean' });
        }
        rows.push({
            label: singleLineLabel(`${childDisplay(c)}${c.running ? t(' · 运行中') : ` · 已结束${ageLabel(c.createdAt) !== '' ? ` · ${ageLabel(c.createdAt)}` : ''}`}`),
            value: c.id,
        });
    }
    return rows;
};
export const subagentsCommand = async (app) => {
    // The confirmation notice promises "/subagents 可取消" — a second
    // invocation with a pending followup CANCELS it instead of silently
    // re-addressing the next input.
    if (app.slices.agent.pendingSubagentFollowup !== null) {
        const pending = app.slices.agent.pendingSubagentFollowup;
        W(app.slices.agent).pendingSubagentFollowup = null;
        app.notice(tf('已取消发送给子代理 {0}（下一条输入按正常消息处理）', [pending.label]));
        return;
    }
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec || app.slices.sessions.activeId === null) {
        app.notice(t('无活跃会话'));
        return;
    }
    try {
        let children = await app.slices.sessions.listSubagentChildren(app.slices.sessions.activeId);
        children = await cleanExpiredChildren(app, app.slices.sessions.activeId, children);
        if (children.length === 0) {
            app.notice(t('该会话没有子代理（workflow/subagent 运行后此处可回放其思考链）'));
            return;
        }
        children = orderSubagentChildren(children);
        const settledCount = children.filter((c) => !c.running).length;
        const sel = await app.openPicker(t('子代理（选择查看思考链）'), childRows(children, settledCount));
        if (sel === null)
            return;
        if (sel === 'act:clean') {
            const ok = await app.openPicker(t('清理思考链'), [
                { label: `确认清理 ${settledCount} 条已结束思考链（列表隐藏；存储截断视 dsh 版本支持）`, value: 'yes' },
                { label: t('取消'), value: 'no' },
            ]);
            if (ok !== 'yes')
                return;
            let done = 0;
            for (const c of children) {
                if (!c.running && await app.slices.sessions.cleanSubagentChain(app.slices.sessions.activeId, c.id))
                    done++;
            }
            app.notice(tf('🧹 已清理 {0} 条思考链', [done]));
            return;
        }
        const child = children.find((c) => c.id === sel);
        const action = child?.mode === 'continuable'
            ? await app.openPicker(t('子代理操作'), [
                { label: t('打开对话窗口（像主聊天一样发消息）'), value: 'chat' },
                { label: t('继续对话（下一条输入发给它）'), value: 'continue' },
                { label: t('查看思考链回放'), value: 'view' },
            ])
            : 'view';
        if (action === 'continue') {
            W(app.slices.agent).pendingSubagentFollowup = { childId: sel, label: child?.label ?? sel.slice(0, 8) };
            app.notice(tf('下一条输入将发给子代理 {0}（/subagents 可取消，直接输入即发送）', [app.slices.agent.pendingSubagentFollowup.label]));
            return;
        }
        if (action === null)
            return;
        if (action === 'chat') {
            await app.slices.agent.openSubagentChat(sel, child?.label ?? sel.slice(0, 8));
            return;
        }
        await app.slices.agent.openSubagentView(sel, child?.label ?? sel.slice(0, 8));
    }
    catch (err) {
        app.notice(tf('subagents 失败: {0}', [err.message]));
    }
};
export function installSubagentsCommand(app) {
    app.registerCommands([{ name: '/subagents', desc: t('子代理目录（回放/续聊思考链）'), usage: t(''), group: t('会话'), fn: () => subagentsCommand(app) }]);
}
