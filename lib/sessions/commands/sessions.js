/** dsh_tui command: /sessions — one command per file. */
import { t, tf } from '../../kernel/i18n.js';
import { createSession, selectSession, ensureLiveSession } from '../services.js';
export const sessionsCommand = async (app) => {
    await app.slices.sessions.refreshHistory();
    app.slices.sessions.refreshList();
    const ws = app.svc('workspaceRegistry');
    const workspaceRows = typeof ws?.list === 'function' ? ws.list() : [];
    const archived = new Set(ws?.archivedSessionIds ?? []);
    const rows = [
        { label: '＋ 新建会话', value: 'act:new' },
    ];
    const inWs = new Set();
    for (const w of workspaceRows) {
        rows.push({ label: `📁 ${w.title} · ${w.path}`, value: `ws:${w.id}` });
        for (const sid of w.sessionIds) {
            inWs.add(sid);
            if (archived.has(sid))
                continue;
            // Project-level sessions only: `session-` prefixed ids; subagent
            // children (bare UUIDs / origin subagent) never appear here.
            if (!/^session-/.test(sid))
                continue;
            if (app.liveSessions.get(sid)?.header?.origin === 'subagent')
                continue;
            const rec = app.slices.sessions.live.get(sid);
            const hist = app.slices.sessions.historyById.get(sid);
            const title = rec?.title ?? hist?.title ?? '';
            rows.push({ label: `    ${sid === app.slices.sessions.activeId ? '▸' : ' '} ${title || sid.slice(0, 8)} · ${sid}`, value: `sess:${sid}` });
        }
    }
    rows.push({ label: t('未分组'), value: 'ws:none' });
    for (const s of app.liveSessions.list()) {
        if (inWs.has(s.id) || archived.has(s.id) || s.header?.origin === 'subagent' || !/^session-/.test(s.id))
            continue;
        const rec = app.slices.sessions.live.get(s.id);
        rows.push({ label: `    ${s.id === app.slices.sessions.activeId ? '▸' : ' '} ${rec?.title ?? ''} · ${s.id}`, value: `sess:${s.id}` });
    }
    for (const h of app.slices.sessions.historyHeaders) {
        if (inWs.has(h.id) || archived.has(h.id) || app.slices.sessions.live.has(h.id))
            continue;
        rows.push({ label: tf('    {0} · {1}（历史）', [h.title ?? '', h.id]), value: `sess:${h.id}` });
    }
    // Persisted sessions from OTHER working directories (historyById holds
    // everything): reachable here instead of being invisible outside their
    // own cwd — resume works cross-directory.
    for (const h of app.slices.sessions.historyById.values()) {
        if (h.cwd === undefined || h.cwd === process.cwd())
            continue;
        if (inWs.has(h.id) || archived.has(h.id) || app.slices.sessions.live.has(h.id))
            continue;
        if (app.slices.sessions.historyHeaders.some((x) => x.id === h.id))
            continue;
        rows.push({ label: tf('    {0} · {1}（其他目录）', [h.title ?? '', h.id]), value: `sess:${h.id}` });
    }
    const sel = await app.openPicker(t('会话（工作区分组 · Enter 打开）'), rows);
    if (sel === null)
        return;
    if (sel === 'act:new') {
        await createSession(app);
        return;
    }
    if (sel.startsWith('sess:')) {
        const sid = sel.slice(5);
        // Session row actions — the official workspace browser's per-row menu
        // counterpart: open / rename / archive / move to workspace. The harness
        // (0.1.2-rc.1) does not expose a durable session DELETE; archive is the
        // official way to remove a session from the lists.
        const act = await app.openPicker(tf('会话 {0}', [sid]), [
            { label: '打开会话', value: 'open' },
            { label: '重命名（下一条输入作为新名称）', value: 'rename' },
            { label: '归档（从列表隐藏）', value: 'archive' },
            { label: '移入工作区 / 移出分组', value: 'group' },
        ]);
        if (act === null)
            return;
        if (act === 'open') {
            await selectSession(app, sid);
            return;
        }
        if (act === 'rename') {
            let background = false;
            if (app.liveSessions.get(sid) === undefined) {
                // Persisted-only session: resume it in the background — sessionTitle
                // .rename requires the exact LIVE session object, but renaming must
                // NOT switch the active view. The background flag makes the rename
                // completion DISPOSE the temporary live session (pre-review it
                // accumulated forever).
                await ensureLiveSession(app, sid);
                background = true;
            }
            app.slices.agent.setPendingRename({ kind: 'session', id: sid, background });
            app.notice(t('下一条输入将作为该会话的新标题（空输入取消）'));
            return;
        }
        if (act === 'archive') {
            const ws2 = app.svc('workspaceRegistry');
            if (typeof ws2?.archiveSession !== 'function') {
                app.notice(t('归档不可用（workspaceRegistry 服务未装配）'));
                return;
            }
            try {
                await ws2.archiveSession(sid);
                app.notice(tf('已归档 {0}（从各列表隐藏）', [sid]));
                app.slices.sessions.refreshList();
            }
            catch (err) {
                app.notice(tf('归档失败: {0}', [err.message]));
            }
            return;
        }
        if (act === 'group') {
            // Move to a workspace / detach. The official registry has NO
            // auto-grouping: a session lands under a workspace only through an
            // explicit attach, and attach validates canonical cwd === workspace
            // path — a mismatch surfaces here as a notice, verbatim.
            const current = workspaceRows.find((w) => w.sessionIds.includes(sid));
            const groupRows = [];
            for (const w of workspaceRows) {
                groupRows.push({ label: `📁 ${w.title} · ${w.path}`, value: `attach:${w.id}` });
            }
            if (current !== undefined) {
                groupRows.push({ label: tf('🚫 移出分组（当前: {0}）', [current.title]), value: 'detach' });
            }
            const pick = await app.openPicker(tf('会话分组 {0}', [sid]), groupRows);
            if (pick === null)
                return;
            try {
                if (pick === 'detach') {
                    if (typeof current?.detachSession !== 'function') {
                        app.notice(t('移出分组不可用（工作区服务未提供 detachSession）'));
                        return;
                    }
                    await current.detachSession(sid);
                    app.notice(tf('已移出分组（会话保留为未分组）: {0}', [sid]));
                    return;
                }
                if (pick.startsWith('attach:')) {
                    const w = workspaceRows.find((x) => x.id === pick.slice(7));
                    if (w === undefined)
                        return;
                    if (typeof w.attachSession !== 'function') {
                        app.notice(t('移入工作区不可用（工作区服务未提供 attachSession——检查 dsh-workspaces-adapter）'));
                        return;
                    }
                    await w.attachSession(sid);
                    app.notice(tf('已移入工作区 {0} · {1}', [w.title, sid]));
                    return;
                }
            }
            catch (err) {
                app.notice(tf('分组操作失败: {0}', [err.message]));
            }
            return;
        }
        return;
    }
    if (sel.startsWith('ws:')) {
        const wid = sel.slice(3);
        if (wid === 'none') {
            // The 「未分组」 group the README promises: every session-* id that NO
            // workspace accounts for and that is not archived. This row used to be
            // a dead entry (host workspace ids are UUIDs, so `ws:none` never
            // resolved) and returned silently — sessions without a workspace were
            // unreachable from this browser.
            const grouped = new Set(workspaceRows.flatMap((w) => [...w.sessionIds]));
            const ungrouped = [];
            const seenU = new Set();
            const pushU = (id, title, suffix) => {
                if (seenU.has(id) || grouped.has(id) || archived.has(id))
                    return;
                if (!/^session-/.test(id))
                    return;
                if (app.liveSessions.get(id)?.header?.origin === 'subagent')
                    return;
                seenU.add(id);
                const mark = id === app.slices.sessions.activeId ? '▸' : ' ';
                ungrouped.push({ label: `    ${mark} ${title ?? ''} · ${id}${suffix}`, value: `sess:${id}` });
            };
            for (const live of app.liveSessions.list())
                pushU(live.id, app.slices.sessions.live.get(live.id)?.title, '');
            for (const h of app.slices.sessions.historyById.values()) {
                pushU(h.id, h.title, h.cwd !== undefined && h.cwd !== process.cwd() ? t('（其他目录）') : t('（历史）'));
            }
            if (ungrouped.length === 0) {
                app.notice(t('（没有未分组的会话）'));
                return;
            }
            const pickU = await app.openPicker(t('未分组会话'), ungrouped);
            if (pickU === null || !pickU.startsWith('sess:'))
                return;
            await selectSession(app, pickU.slice(5));
            return;
        }
        const w = workspaceRows.find((x) => x.id === wid);
        if (w === undefined) {
            app.notice(tf('未知工作区: {0}（/sessions 重新加载）', [wid]));
            return;
        }
        const act = await app.openPicker(tf('工作区 {0}', [w.title]), [
            { label: '新建会话于此工作区', value: 'new' },
            { label: '重命名工作区（下一条输入作为新名称）', value: 'rename' },
        ]);
        if (act === 'new') {
            await createSession(app, w.path);
        }
        else if (act === 'rename') {
            app.slices.agent.setPendingRename({ kind: 'workspace', id: wid });
            app.notice(tf('下一条输入将作为工作区「{0}」的新名称（/sessions 期间可继续操作）', [w.title]));
        }
        return;
    }
};
export function installSessionsCommand(app) {
    app.registerCommands([{ name: '/sessions', desc: t('会话浏览器（打开/重命名/归档）'), usage: t('会话列表'), group: t('系统'), fn: () => sessionsCommand(app) }]);
}
