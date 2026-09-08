/**
 * dsh_tui sessions module: session lifecycle (create/resume/attach/switch/
 * fork), the empty-state welcome banner, and the session commands (/sessions
 * /workspace /archive /layout /rename /new /clear /fork /branch /btw).
 *
 * @module dsh-nvim-tui/sessions
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { appendFileSync } from 'node:fs';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { FeedRenderer } from './feed.js';
import { t } from './i18n.js';
import { encodeHeaderOnlyLog, readCleanedIds, writeCleanedIds } from './subagent-clean.js';
import { BUILD_STAMP, BUILD_VERSION } from './app.js';
import { registerNvimNotification } from './rpc.js';
const WSS = (d) => d;
/** Own one live agent: chat buffer + feed + registry entry. */
const attachSession = async (app, handle, modelRef) => {
    const id = handle.agent.session.id;
    const ids = await app.lua.ensureChat(id);
    app.slices.runtime.setChatWin(ids.chatWin);
    const rids = await app.lua.ensureReasoning(id);
    app.slices.runtime.setReasoning(rids?.reasoningOpen === true, (rids?.reasoningWin ?? null));
    const feed = new FeedRenderer(app.slices.runtime.nvim, ids.chatBuf, ids.chatWin, {
        idsProvider: () => app.luaCall('return require("dsh_tui").ensure_chat(...)', [id]),
        activeChecker: () => id === app.slices.sessions.activeId,
        reasoningBuf: rids?.reasoningBuf ?? null,
        reasoningView: () => ({ open: app.slices.runtime.reasoningOpen, win: app.slices.runtime.reasoningWinId }),
        whale: app.config.whaleArt !== 'off',
        welcome: welcomeLines,
    });
    app.slices.sessions.live.set(id, {
        id, handle, feed, title: undefined, status: undefined, modelRef,
        model: modelRef?.current ? modelRef.current.model : undefined,
        createdAt: handle.agent.session.header?.createdAt ?? Date.now(),
        usage: undefined,
        contextWindow: undefined,
        mode: undefined,
        policy: undefined,
        provider: undefined,
        cacheReported: false,
        lastAssistantMessageId: null,
        goal: null,
        planActive: false,
        imagePoisonWarned: false,
        deliverables: { turn: undefined, paths: [] },
        todos: null,
        todosItems: [],
        jobsCache: new Map(),
        committedJobsKey: '',
        pendingToolCalls: new Map(),
        visionTmp: null,
        lastTurnStartAt: 0,
        bgJobs: 0,
    });
    // Boot banner: version + build stamp + channel (proves which code runs).
    feed.appendNotice(`dsh-nvim-tui ${BUILD_VERSION} (build ${BUILD_STAMP}) · channel ${app.slices.runtime.channelIdValue}`);
    // Heal a poisoned session (a scheduler crash left a tool/call with no
    // tool/result → the DeepSeek API rejects every later request with
    // "insufficient tool messages following tool_calls message"): synthesize
    // the missing error results once at open so the history re-pairs.
    try {
        const rec = app.slices.sessions.live.get(id);
        if (rec !== undefined) {
            const repaired = app.slices.trans.repairOrphanToolCalls(rec);
            if (repaired > 0) {
                feed.appendNotice(`♻ ${t('已修复')} ${repaired} ${t('处损坏的工具调用记录——会话此前因 "insufficient tool messages" 被 400 拒绝的问题已解除')}`);
            }
        }
    }
    catch { }
    return id;
};
/** Empty-state hero: big DSH·TUI banner + title ABOVE the whale, usage
 *  hints BELOW it (the feed centers the whole block). */
const welcomeLines = () => {
    // 4×6 block font — bigger than the old 3×5, with real letter spacing.
    const font = {
        D: ['███▌', '█  █', '█  █', '█  █', '█  █', '███▌'],
        S: ['▄███▄', '███▀ ', '▀███▄', '▀  █', '▀  █', '▄███▀'],
        H: ['█  █', '█  █', '████', '█  █', '█  █', '█  █'],
        N: ['█  █', '██ █', '█ ██', '█  █', '█  █', '█  █'],
        V: ['█  █', '█  █', '█  █', '█  █', ' ██ ', ' ██ '],
        I: [' ██ ', ' ██ ', ' ██ ', ' ██ ', ' ██ ', ' ██ '],
        M: ['█▌ ▐█', '██ ██', '█ █ █', '█ █ █', '█   █', '█   █'],
        T: ['████', ' ██ ', ' ██ ', ' ██ ', ' ██ ', ' ██ '],
        U: ['█  █', '█  █', '█  █', '█  █', '█  █', '▀███▀'],
        ' ': ['  ', '  ', '  ', '  ', '  ', '  '],
    };
    const word = 'DSH NVIM TUI';
    const banner = ['', '', '', '', '', ''];
    for (const ch of word) {
        const glyph = font[ch] ?? font[' '];
        for (let i = 0; i < 6; i++)
            banner[i] += (banner[i] === '' ? '' : ' ') + glyph[i];
    }
    const BLUE = 'DshTuiWhaleB-';
    const TITLE = 'DshTuiUser';
    return {
        above: [
            ...banner.map((text) => ({ text, group: BLUE })),
            { text: '' },
            { text: `${t('Neovim 风格的 DeepSeek Harness 终端客户端')} · v${BUILD_VERSION}`, group: TITLE },
            { text: '' },
        ],
        below: [
            { text: t('直接输入问题开始对话，命令以 / 开头，自然语言也可以') },
            { text: '' },
            { text: `  /help ${t('全部命令')} · /new ${t('新建会话')} · /sessions ${t('切换会话')} · /market ${t('插件市场')}` },
            { text: '' },
            { text: `  /skills ${t('技能')} · /model ${t('切换模型')} · /whale off ${t('关闭背景鲸鱼')}` },
            { text: '' },
            { text: `  @${t('文件')} ${t('引用文件')} · Ctrl+O ${t('思考面板')} · Ctrl+P ${t('历史输入')} · Ctrl+C ${t('停止')}` },
        ],
    };
};
/** Create a fresh session+agent and switch to it. `cwdPath` (optional)
 *  overrides the process working directory (validated: must be a dir). */
const createSession = async (app, cwdPath) => {
    const selection = app.slices.agent.currentSelection();
    const modelRef = { current: selection, assembled: void 0 };
    let cwd = process.cwd();
    if (cwdPath) {
        const abs = resolve(cwdPath);
        try {
            if (!statSync(abs).isDirectory())
                throw new Error('不是目录');
            cwd = abs;
        }
        catch (err) {
            app.notice(`无效目录 ${cwdPath}: ${err.message}`);
            return;
        }
    }
    const handle = await app.runtimeCtx.agents.create({
        sessionId: `session-${randomUUID()}`,
        meta: { cwd },
        agentOptions: {
            provider: selection.provider,
            model: selection.model,
        },
        setup: (agentCtx) => {
            installModelSelection(agentCtx, modelRef);
        },
    });
    const id = await attachSession(app, handle, modelRef);
    await switchTo(app, id);
    app.slices.sessions.refreshList();
    void app.refreshCommandCatalog();
    app.notice(`session ${id} (${selection.provider}/${selection.model}${cwdPath ? ` · ${cwd}` : ''})`);
    return id;
};
/** Resume a persisted session, replay its history into the chat. */
/** Resume a persisted session WITHOUT switching the active view — used by
 *  row actions (e.g. rename) that need a live session but must not move the
 *  user away from the current chat. Returns the live id, or undefined. */
const ensureLiveSession = async (app, id) => {
    if (app.slices.sessions.live.has(id))
        return id;
    const selection = app.slices.agent.currentSelection();
    const modelRef = { current: selection, assembled: void 0 };
    const handle = await app.runtimeCtx.agents.resume({
        resumeSessionId: id,
        agentOptions: {
            provider: selection.provider,
            model: selection.model,
        },
        setup: (agentCtx) => {
            installModelSelection(agentCtx, modelRef);
        },
    });
    const sid = await attachSession(app, handle, modelRef);
    const rec = app.slices.sessions.live.get(sid);
    const events = app.slices.trans.sessionEvents(handle.agent.session);
    rec.feed.appendNotice(`history replay: ${events.length} events`);
    for (const event of events) {
        app.slices.ui.foldEvent(rec, event);
        rec.feed.applyEvent(event, { history: true });
        app.slices.ui.maybePushFileDiff(rec.feed, event);
    }
    app.slices.sessions.refreshList();
    return sid;
};
const resumeSession = async (app, id) => {
    const sid = await ensureLiveSession(app, id);
    if (sid === undefined)
        return;
    await switchTo(app, sid);
    app.notice(`已恢复 ${sid}`);
    return sid;
};
/** Terminal title: active session title + model (OSC 2 via nvim). */
const updateTitle = (app) => {
    if (app.slices.runtime.nvim === null || app.slices.runtime.disposed)
        return;
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    const title = rec?.title ?? 'dsh';
    void app.luaCall('require("dsh_tui").set_title(...)', [title]).catch(() => { });
};
const switchTo = async (app, id) => {
    WSS(app.slices.sessions).activeId = id;
    await app.lua.setActive(id);
    app.slices.ui.ensureSpinner();
    app.slices.ui.updateStatusline();
    updateTitle(app);
    app.slices.ext.extFire('tui:active-session', { id });
    void app.slices.sessions.seedRunningSubagents(id);
    if (app.slices.sessions.live.has(id))
        app.slices.sessions.recordState(id);
};
const selectSession = async (app, id) => {
    if (app.slices.runtime.disposed)
        return;
    if (app.slices.sessions.live.has(id)) {
        await switchTo(app, id);
        app.slices.sessions.refreshList();
    }
    else if (app.slices.sessions.historyHeaders.some((h) => h.id === id) || app.slices.sessions.historyById.has(id)) {
        // Any persisted project session is openable — not just the current
        // cwd's (the workspace browser lists sessions from every workspace).
        await resumeSession(app, id);
    }
    else {
        app.notice(`未知会话 ${id}`);
    }
};
/** /fork [directive]: child session seeded with the active history;
 *  an optional directive is sent as its first message. */
const forkSession = async (app, directive) => {
    if (app.slices.sessions.activeId === null) {
        app.notice(t('没有活跃会话可分叉'));
        return;
    }
    try {
        // alpha.4 fork contract (mirrors the official api-session-controller):
        // a FRESH child id + agents.create carrying a balanced completed-turn
        // seed (seed + inheritedEventCount + meta.isSeeded). The old path
        // (sessions.fork → child.events → agents.create with meta.seedLength)
        // cannot work in alpha.4: fork() enters a live child that create()
        // then collides on, and Session.events / meta.seedLength are gone.
        const parent = app.runtimeCtx.sessions.get(app.slices.sessions.activeId);
        const events = parent === undefined ? [] : app.slices.trans.sessionEvents(parent);
        let lastEnd;
        for (let i = events.length - 1; i >= 0; i--) {
            if (events[i]?.type === 'turn/end') {
                lastEnd = events[i];
                break;
            }
        }
        if (lastEnd === undefined) {
            app.notice(t('没有已完成的回合可分叉（请先让当前回合跑完）'));
            return;
        }
        let cut = (lastEnd.seq ?? 0) + 1;
        while (cut < events.length && events[cut]?.type !== 'turn/start')
            cut++;
        const selection = app.slices.agent.currentSelection();
        const modelRef = { current: selection, assembled: void 0 };
        const handle = await app.runtimeCtx.agents.create({
            sessionId: `session-${randomUUID()}`,
            seed: events.slice(0, cut),
            inheritedEventCount: cut,
            meta: {
                cwd: parent?.header?.cwd ?? process.cwd(),
                parentSession: app.slices.sessions.activeId,
                isSeeded: true,
            },
            agentOptions: { provider: selection.provider, model: selection.model },
            setup: (agentCtx) => { installModelSelection(agentCtx, modelRef); },
        });
        const id = await attachSession(app, handle, modelRef);
        await switchTo(app, id);
        app.slices.sessions.refreshList();
        app.notice(`已分叉到 ${id}（继承 ${cut} 条历史事件）`);
        if (directive && directive.trim())
            app.slices.agent.send(directive.trim());
        return id;
    }
    catch (err) {
        app.notice(`分叉失败: ${err.message}`);
        return undefined;
    }
};
/** /sessions — session list float with full ids (no resident window). */
/** /sessions — workspace-grouped session browser (official client's
 *  sidebar counterpart): workspace headers + their sessions, an ungrouped
 *  section, archived sessions hidden, Enter opens, workspace rows carry
 *  actions. */
const sessionsCommand = async (app) => {
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
            if (app.runtimeCtx.sessions.get(sid)?.header?.origin === 'subagent')
                continue;
            const rec = app.slices.sessions.live.get(sid);
            const hist = app.slices.sessions.historyById.get(sid);
            const title = rec?.title ?? hist?.title ?? '';
            rows.push({ label: `    ${sid === app.slices.sessions.activeId ? '▸' : ' '} ${title || sid.slice(0, 8)} · ${sid}`, value: `sess:${sid}` });
        }
    }
    rows.push({ label: '未分组', value: 'ws:none' });
    for (const s of app.runtimeCtx.sessions.list()) {
        if (inWs.has(s.id) || archived.has(s.id) || s.header?.origin === 'subagent' || !/^session-/.test(s.id))
            continue;
        const rec = app.slices.sessions.live.get(s.id);
        rows.push({ label: `    ${s.id === app.slices.sessions.activeId ? '▸' : ' '} ${rec?.title ?? ''} · ${s.id}`, value: `sess:${s.id}` });
    }
    for (const h of app.slices.sessions.historyHeaders) {
        if (inWs.has(h.id) || archived.has(h.id) || app.slices.sessions.live.has(h.id))
            continue;
        rows.push({ label: `    ${h.title ?? ''} · ${h.id}（历史）`, value: `sess:${h.id}` });
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
        const act = await app.openPicker(`会话 ${sid}`, [
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
            if (app.runtimeCtx.sessions.get(sid) === undefined) {
                // Persisted-only session: resume it in the background — sessionTitle
                // .rename requires the exact LIVE session object, but renaming must
                // NOT switch the active view.
                await ensureLiveSession(app, sid);
            }
            app.slices.agent.setPendingRename({ kind: 'session', id: sid });
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
                app.notice(`已归档 ${sid}（从各列表隐藏）`);
                app.slices.sessions.refreshList();
            }
            catch (err) {
                app.notice(`归档失败: ${err.message}`);
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
                groupRows.push({ label: `🚫 移出分组（当前: ${current.title}）`, value: 'detach' });
            }
            const pick = await app.openPicker(`会话分组 ${sid}`, groupRows);
            if (pick === null)
                return;
            try {
                if (pick === 'detach') {
                    if (typeof current?.detachSession !== 'function') {
                        app.notice(t('移出分组不可用（工作区服务未提供 detachSession）'));
                        return;
                    }
                    await current.detachSession(sid);
                    app.notice(`已移出分组（会话保留为未分组）: ${sid}`);
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
                    app.notice(`已移入工作区 ${w.title} · ${sid}`);
                    return;
                }
            }
            catch (err) {
                app.notice(`分组操作失败: ${err.message}`);
            }
            return;
        }
        return;
    }
    if (sel.startsWith('ws:')) {
        const wid = sel.slice(3);
        const w = workspaceRows.find((x) => x.id === wid);
        if (w === undefined)
            return;
        const act = await app.openPicker(`工作区 ${w.title}`, [
            { label: '新建会话于此工作区', value: 'new' },
            { label: '重命名工作区（下一条输入作为新名称）', value: 'rename' },
        ]);
        if (act === 'new') {
            await createSession(app, w.path);
        }
        else if (act === 'rename') {
            app.slices.agent.setPendingRename({ kind: 'workspace', id: wid });
            app.notice(`下一条输入将作为工作区「${w.title}」的新名称（/sessions 期间可继续操作）`);
        }
        return;
    }
};
/** /workspace [add <目录> [标题] | delete <id>] — workspace management.
 *  Bare /workspace opens a sessions-style popup: workspace directory,
 *  create-via-directory-picker, rename (next input) and delete actions. */
const workspaceCommand = async (app, a) => {
    const ws = app.svc('workspaceRegistry');
    if (ws === undefined || typeof ws.list !== 'function') {
        app.notice(t('workspaceRegistry 服务未装配（profile 加入 dsh-workspace 后可用）'));
        return;
    }
    const arg = (a ?? '').trim();
    if (arg.startsWith('add ')) {
        const [path, ...rest] = arg.slice(4).trim().split(/\s+/);
        if (path === undefined || path === '') {
            app.notice(t('用法: /workspace add <目录> [标题]'));
            return;
        }
        try {
            const title = rest.join(' ').trim() || undefined;
            await ws.create?.(path, title);
            app.notice(`工作区已添加: ${title ?? path}`);
        }
        catch (err) {
            app.notice(`添加工作区失败: ${err.message}`);
        }
        return;
    }
    if (arg.startsWith('delete ')) {
        const id = arg.slice(7).trim();
        try {
            const ok = await ws.delete?.(id);
            app.notice(ok === true ? `工作区已移除（其会话保留为未分组）: ${id}` : `未知工作区: ${id}`);
        }
        catch (err) {
            app.notice(`移除失败: ${err.message}`);
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
        rows.push({ label: `📁 ${w.title} · ${w.path} · ${w.sessionIds.length} 会话`, value: `ws:${w.id}` });
    }
    const sel = await app.openPicker(t('工作区管理'), rows);
    if (sel === null)
        return;
    if (sel === 'act:new') {
        const dir = await app.slices.agent.openDirPicker(process.cwd());
        if (dir === null || dir === '')
            return;
        try {
            await ws.create?.(dir);
            app.notice(`工作区已添加: ${dir}`);
        }
        catch (err) {
            app.notice(`添加工作区失败: ${err.message}`);
        }
        return;
    }
    const wid = sel.slice(3);
    const w = list.find((x) => x.id === wid);
    if (w === undefined)
        return;
    const act = await app.openPicker(`工作区 ${w.title}`, [
        { label: '重命名（下一条输入作为新名称）', value: 'rename' },
        { label: '删除工作区（会话保留为未分组）', value: 'delete' },
        { label: t('取消'), value: 'cancel' },
    ]);
    if (act === 'rename') {
        app.slices.agent.setPendingRename({ kind: 'workspace', id: wid });
        app.notice(`下一条输入将作为工作区「${w.title}」的新名称`);
        return;
    }
    if (act === 'delete') {
        const ok = await app.openPicker(t('确认删除工作区'), [
            { label: `确认删除 ${w.title}（会话保留为未分组）`, value: 'yes' },
            { label: t('取消'), value: 'no' },
        ]);
        if (ok !== 'yes')
            return;
        try {
            const r = await ws.delete?.(wid);
            app.notice(r === true ? `工作区已移除: ${w.title}` : `未知工作区: ${wid}`);
        }
        catch (err) {
            app.notice(`移除失败: ${err.message}`);
        }
    }
};
/** /archive [id] — hide a session from every list (non-destructive). */
const archiveCommand = async (app, a) => {
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
        app.notice(`已归档 ${target}（从各列表隐藏）`);
    }
    catch (err) {
        app.notice(`归档失败: ${err.message}`);
    }
};
/** /layout [default|panel] — window layout presets (bare cycles). */
let layoutIdx = 0;
const layoutCommand = (app, a) => {
    const order = ['default', 'panel'];
    let name = (a ?? '').trim();
    if (name === '') {
        layoutIdx = (layoutIdx + 1) % order.length;
        name = order[layoutIdx];
    }
    else if (!order.includes(name)) {
        app.notice(`未知布局 ${name}（可用: ${order.join(' ')})`);
        return;
    }
    else {
        layoutIdx = order.indexOf(name);
    }
    void app.luaCall('require("dsh_tui").apply_layout(...)', [name]).catch(() => { });
    app.notice(`布局: ${name}`);
};
/** /rename <title> — pin the active session's title. */
const renameCommand = (app, a) => {
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
        sessionTitle.rename(app.runtimeCtx.sessions.get(rec.id), title);
        app.notice(t('标题已更新'));
    }
    catch (err) {
        app.notice(`重命名失败: ${err.message}`);
    }
};
/** Fill the sessions module's App slots and register its commands. */
/** Children of one parent session (live + history, TTL-cleaned chains
 *  hidden) — the /subagents directory source. */
const listSubagentChildren = async (app, parentId) => {
    const persistence = app.svc('sessionPersistence');
    let histMap = new Map();
    if (typeof persistence?.list === 'function') {
        try {
            for (const h of await persistence.list())
                histMap.set(h.id, h);
        }
        catch { }
    }
    const cleaned = readCleanedIds()[parentId] ?? [];
    const hidden = new Set(cleaned); // TTL-cleaned chains stay hidden
    const createdAtOf = (id) => histMap.get(id)?.createdAt;
    const subagentsSvc = app.svc('subagents');
    if (typeof subagentsSvc?.listChildren === 'function') {
        try {
            const entries = await subagentsSvc.listChildren(parentId);
            const children = entries.filter((e) => e?.kind === 'child').map((e) => ({
                id: e.id,
                label: e.label ?? e.id.slice(0, 8),
                running: e.activity === 'running',
                mode: e.mode,
                createdAt: createdAtOf(e.id),
            })).filter((c) => c.running || !hidden.has(c.id));
            if (children.length > 0 || entries.some((e) => e?.kind === 'child'))
                return children;
        }
        catch { }
    }
    const seen = new Set();
    const children = [];
    const add = (id, label, running, mode) => {
        if (seen.has(id) || (!running && hidden.has(id)))
            return;
        seen.add(id);
        children.push({ id, label: label ?? id.slice(0, 8), running, mode, createdAt: createdAtOf(id) });
    };
    for (const s of app.runtimeCtx.sessions.list?.() ?? []) {
        if (s?.header?.parentSession === parentId && s.header.origin === 'subagent') {
            add(s.id, undefined, true, undefined);
        }
    }
    for (const [id, h] of histMap) {
        if (h?.parentSession === parentId && h.origin === 'subagent') {
            add(id, undefined, false, undefined);
        }
    }
    return children;
};
/** Seed the running-subagents registry from the host (children may have
 *  started before the TUI attached). Best-effort. */
const seedRunningSubagents = async (app, parentId) => {
    try {
        const children = await listSubagentChildren(app, parentId);
        let changed = false;
        for (const c of children) {
            if (!c.running || app.slices.sessions.runningSubagents.has(c.id))
                continue;
            app.slices.sessions.runningSubagents.set(c.id, {
                parentId,
                label: c.label,
                startedAt: c.createdAt ?? Date.now(),
            });
            changed = true;
        }
        if (changed) {
            app.slices.ui.ensureSpinner();
            app.slices.ui.updateStatusline();
        }
    }
    catch { /* best-effort */ }
};
/** Zstandard frame magic (0xFD2FB528 little-endian). */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const isZstdArtifact = (path) => {
    try {
        const head = readFileSync(path).subarray(0, 4);
        return head.length === 4 && head.every((b, i) => b === ZSTD_MAGIC[i]);
    }
    catch {
        return false;
    }
};
/** Clean one settled chain: hide it (ledger + workspace archive) and free
 *  the stored bulk via the official raw-artifact rewrite. */
const cleanSubagentChain = async (app, parentId, childId) => {
    const persistence = app.svc('sessionPersistence');
    let truncated = false;
    try {
        if (persistence?.supportsRawArtifacts === true &&
            app.runtimeCtx.sessions.get(childId) === undefined) {
            const inspection = await persistence.inspect?.(childId);
            const meta = inspection?.meta;
            if (meta?.id === childId) {
                const loc = persistence.locate?.(meta);
                const path = typeof loc?.path === 'string' ? loc.path : undefined;
                const raw = await persistence.readRaw?.(childId);
                const headerLine = (raw?.content ?? '').split('\n', 1)[0] ?? '';
                if (path !== undefined && headerLine !== '' && isZstdArtifact(path)) {
                    writeFileSync(path + '.tmp', encodeHeaderOnlyLog(headerLine));
                    renameSync(path + '.tmp', path);
                    truncated = true;
                }
            }
        }
    }
    catch { }
    if (truncated) {
        const ws = app.svc('workspaceRegistry');
        if (typeof ws?.archiveSession === 'function') {
            try {
                await ws.archiveSession(childId);
            }
            catch { }
        }
    }
    const cleaned = readCleanedIds();
    const arr = cleaned[parentId] ?? [];
    if (!arr.includes(childId)) {
        arr.push(childId);
        cleaned[parentId] = arr;
        writeCleanedIds(cleaned);
    }
    return true;
};
export function installSessions(app) {
    // -- sessions + ui.activeFeed domain defaults (I2) --
    Object.assign(app.slices.sessions, {
        live: new Map(),
        activeId: null,
        historyHeaders: [],
        historyById: new Map(),
        sessionEntries: [],
        runningSubagents: new Map(),
        childParent: new Map(),
        refreshHistory: async () => { },
        refreshList: () => { },
        readState: () => null,
        recordState: () => { },
        createSession: async () => { },
        resumeSession: async () => { },
        updateTitle: () => { },
        switchTo: async () => { },
        selectSession: async () => { },
        forkSession: async () => undefined,
        attachSession: async () => { },
        listSubagentChildren: async () => [],
        seedRunningSubagents: async () => { },
        cleanSubagentChain: async () => false,
        runningSubagentsOf: () => [],
    });
    /** Running subagents of one parent (pure sessions-domain projection). */
    app.slices.sessions.runningSubagentsOf = (parentId) => parentId === null ? [] : [...app.slices.sessions.runningSubagents.values()].filter((s) => s.parentId === parentId);
    app.slices.sessions.listSubagentChildren = (parentId) => listSubagentChildren(app, parentId);
    app.slices.sessions.seedRunningSubagents = (parentId) => seedRunningSubagents(app, parentId);
    app.slices.sessions.cleanSubagentChain = (parentId, childId) => cleanSubagentChain(app, parentId, childId);
    app.slices.ui.activeFeed = () => {
        const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
        return rec?.feed;
    };
    // -- core services this module owns (moved out of createApp, I1) --
    // -- last-active-session state (claude --continue behaviour) -------------------
    const statePath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-nvim-tui-state.json');
    app.slices.sessions.readState = () => {
        try {
            return JSON.parse(readFileSync(statePath, 'utf8'));
        }
        catch {
            return null;
        }
    };
    app.slices.sessions.recordState = (id) => {
        try {
            // Record the SESSION's own cwd, not the shell's: an old session opened
            // from another directory should resume from ITS project dir on the next
            // launch (claude --continue per-project semantics).
            const hdr = app.slices.sessions.live.get(id)?.handle.agent.session.header;
            const cwd = typeof hdr?.cwd === 'string' ? hdr.cwd : process.cwd();
            writeFileSync(statePath, JSON.stringify({ sessionId: id, cwd, at: Date.now() }));
        }
        catch { }
    };
    /** (Re)load the persisted session directory. `historyHeaders` keeps the
     *  current-cwd slice (boot auto-resume); `historyById` holds everything
     *  openable via /sessions. */
    app.slices.sessions.refreshHistory = async () => {
        const persistence = app.svc('sessionPersistence');
        if (typeof persistence?.list !== 'function')
            return;
        try {
            const all = await persistence.list();
            const cwd = process.cwd();
            // Persisted titles live in the projection cache (SessionHeader carries
            // no title field): read the cached `title` projection per header so a
            // user rename survives restarts in /sessions without opening the log.
            // The cache is its own service (`sessionProjectionCache`); fall back to
            // the base registry for profiles that expose the read there.
            const projections = app.svc('sessionProjectionCache') ?? app.svc('sessionProjections');
            const cachedTitle = (h) => {
                if (typeof projections?.cachedSnapshot !== 'function')
                    return undefined;
                try {
                    const snap = projections.cachedSnapshot(h, h.inheritedEventCount ?? 0, ['title']);
                    const title = snap?.values?.title;
                    return typeof title === 'string' && title !== '' ? title : undefined;
                }
                catch {
                    return undefined;
                }
            };
            WSS(app.slices.sessions).historyHeaders = all
                .filter((h) => h.cwd === cwd && /^session-/.test(h.id) && h.origin !== 'subagent')
                .map((h) => ({ ...h, title: cachedTitle(h) ?? h.title }));
            app.slices.sessions.historyById.clear();
            for (const h of all) {
                if (/^session-/.test(h.id) && h.origin !== 'subagent') {
                    app.slices.sessions.historyById.set(h.id, { ...h, title: cachedTitle(h) ?? h.title });
                }
            }
        }
        catch { }
    };
    app.slices.sessions.refreshList = () => {
        const entries = [...app.slices.sessions.live.values()].map((s) => ({
            id: s.id,
            title: s.title ?? '', // never undefined — msgpack turns it into vim.NIL
            active: s.id === app.slices.sessions.activeId,
            kind: 'live',
        }));
        for (const h of app.slices.sessions.historyHeaders) {
            if (!app.slices.sessions.live.has(h.id)) {
                entries.push({ id: h.id, title: h.title ?? '', active: false, kind: 'history' });
            }
        }
        WSS(app.slices.sessions).sessionEntries = entries;
    };
    app.slices.sessions.attachSession = (handle, modelRef) => attachSession(app, handle, modelRef).then(() => { });
    app.slices.ui.welcomeLines = welcomeLines;
    app.slices.sessions.createSession = (cwdPath) => createSession(app, cwdPath).then(() => { });
    app.slices.sessions.resumeSession = (id) => resumeSession(app, id).then(() => { });
    app.slices.sessions.updateTitle = () => updateTitle(app);
    app.slices.sessions.switchTo = (id) => switchTo(app, id);
    app.slices.sessions.selectSession = (id) => selectSession(app, id);
    app.slices.sessions.forkSession = (directive) => forkSession(app, directive);
    const specs = [
        { name: '/sessions', desc: t('会话浏览器（打开/重命名/归档）'), usage: t('会话列表'), group: t('系统'), fn: () => sessionsCommand(app) },
        { name: '/workspace', desc: t('工作区管理'), usage: t('[add <目录> [标题] | delete <id>]'), group: t('会话'), fn: (a) => workspaceCommand(app, a) },
        { name: '/archive', desc: t('归档会话（从列表隐藏）'), usage: t('[会话id]'), group: t('会话'), fn: (a) => archiveCommand(app, a) },
        { name: '/new', desc: t('新建会话（可带目录）'), usage: t('[目录]'), group: t('会话'), fn: (a) => createSession(app, (a ?? '').trim() || undefined) },
        { name: '/clear', desc: t('清空当前会话屏幕'), usage: t(''), group: t('会话'), fn: () => app.slices.ui.activeFeed()?.clear() },
        { name: '/fork', desc: t('分叉当前会话'), usage: t('[directive]'), group: t('会话'), fn: (a) => forkSession(app, a) },
        { name: '/branch', desc: t('分叉（/fork 别名）'), usage: t(''), group: t('会话'), fn: (a) => forkSession(app, a) },
        { name: '/btw', desc: t('侧问：分叉新会话并发送问题'), usage: t('<问题>'), group: t('会话'), fn: (a) => {
                if (!a) {
                    app.notice(t('用法: /btw <question>（分叉新会话并发送该问题）'));
                    return;
                }
                return forkSession(app, a);
            } },
        { name: '/rename', desc: t('重命名会话'), usage: t('<新标题>'), group: t('会话'), fn: (a) => renameCommand(app, a) },
        { name: '/layout', desc: t('布局预设'), usage: t('default|panel'), group: t('显示'), fn: (a) => layoutCommand(app, a) },
    ];
    app.registerCommands(specs);
    // -- nvim notifications this module owns (dispatched by boot via rpc.ts) --
    registerNvimNotification('dsh-session-select', '切换会话', (app, args) => app.slices.sessions.selectSession(String(args?.[0] ?? '')));
    registerNvimNotification('dsh-session-new', '新建会话', () => app.slices.sessions.createSession());
}
/** Boot-time session selection (moved out of boot): explicit resume id
 *  (env/config) wins; otherwise auto-resume the LAST active session of this
 *  project (claude --continue behaviour), falling back to the newest
 *  persisted one; a fresh session only when there is no history (or
 *  resumeLatest is disabled). Opening an OLD-version session can throw
 *  (legacy/incompatible log): that must NOT take the whole process down —
 *  log the failure, open a fresh session instead, and tell the user in the
 *  chat window that the restore failed. */
export async function resumeOrCreate(app) {
    // History list for resume: only THIS project's project-level sessions.
    // Subagent children are bare-UUID ids (no `session-` prefix) — excluded,
    // as are sessions created in other working directories.
    await app.slices.sessions.refreshHistory();
    const resumeId = app.config.resumeSessionId ?? process.env.DSH_NVIM_TUI_RESUME;
    const autoResume = app.config.resumeLatest !== false && process.env.DSH_NVIM_TUI_RESUME_LATEST !== '0';
    const resumeOrFresh = async (targetId) => {
        try {
            await app.slices.sessions.resumeSession(targetId);
            return true;
        }
        catch (err) {
            const message = err instanceof Error ? (err.message || String(err)) : String(err);
            try {
                appendFileSync(app.errorLogPath, `${new Date().toISOString()} ${t('恢复会话失败')} ${targetId}: ${message}\n`);
            }
            catch { }
            // Fall back to a fresh session — the UI stays up; the failure is
            // shown in the new session's chat window instead of killing dsh.
            await app.slices.sessions.createSession();
            app.notice(`⚠ ${t('恢复会话失败')} ${targetId}${message ? ` — ${message}` : ''}（${t('已新建会话')}）`);
            return false;
        }
    };
    if (resumeId) {
        await resumeOrFresh(resumeId);
    }
    else if (autoResume && app.slices.sessions.historyHeaders.length > 0) {
        const state = app.slices.sessions.readState();
        const fromState = state?.sessionId && state.cwd === process.cwd() &&
            app.slices.sessions.historyHeaders.some((h) => h.id === state.sessionId)
            ? state.sessionId
            : null;
        const newest = [...app.slices.sessions.historyHeaders]
            .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]?.id;
        const target = fromState ?? newest;
        if (target) {
            if (await resumeOrFresh(target))
                app.notice(t('已自动恢复上次会话（/new 新建）'));
        }
        else {
            await app.slices.sessions.createSession();
        }
    }
    else {
        await app.slices.sessions.createSession();
    }
    app.slices.sessions.refreshList();
}
