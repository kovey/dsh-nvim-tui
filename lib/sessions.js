/**
 * dsh_tui sessions module: session lifecycle (create/resume/attach/switch/
 * fork), the empty-state welcome banner, and the session commands (/sessions
 * /workspace /archive /layout /rename /new /clear /fork /branch /btw).
 *
 * @module dsh-nvim-tui/sessions
 */
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { FeedRenderer } from './feed.js';
import { t } from './i18n.js';
import { BUILD_STAMP, BUILD_VERSION } from './app.js';
/** Own one live agent: chat buffer + feed + registry entry. */
const attachSession = async (app, handle, modelRef) => {
    const id = handle.agent.session.id;
    const ids = await app.lua.ensureChat(id);
    app.chatWinId = ids.chatWin;
    const rids = await app.lua.ensureReasoning(id);
    if (rids?.reasoningWin !== null && rids?.reasoningWin !== undefined)
        app.reasoningWinId = rids.reasoningWin;
    app.reasoningOpen = rids?.reasoningOpen === true;
    const feed = new FeedRenderer(app.nvim, ids.chatBuf, ids.chatWin, {
        idsProvider: () => app.luaCall('return require("dsh_tui").ensure_chat(...)', [id]),
        activeChecker: () => id === app.activeId,
        reasoningBuf: rids?.reasoningBuf ?? null,
        reasoningView: () => ({ open: app.reasoningOpen, win: app.reasoningWinId }),
        whale: app.config.whaleArt !== 'off',
        welcome: welcomeLines,
    });
    app.sessions.set(id, {
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
        pendingToolCalls: new Map(),
        visionTmp: null,
        lastTurnStartAt: 0,
        bgJobs: 0,
    });
    // Boot banner: version + build stamp + channel (proves which code runs).
    feed.appendNotice(`dsh-nvim-tui ${BUILD_VERSION} (build ${BUILD_STAMP}) · channel ${app.channelIdValue}`);
    // Heal a poisoned session (a scheduler crash left a tool/call with no
    // tool/result → the DeepSeek API rejects every later request with
    // "insufficient tool messages following tool_calls message"): synthesize
    // the missing error results once at open so the history re-pairs.
    try {
        const rec = app.sessions.get(id);
        if (rec !== undefined) {
            const repaired = app.repairOrphanToolCalls(rec);
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
    const selection = app.currentSelection();
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
    app.refreshList();
    void app.refreshCommandCatalog();
    app.notice(`session ${id} (${selection.provider}/${selection.model}${cwdPath ? ` · ${cwd}` : ''})`);
    return id;
};
/** Resume a persisted session, replay its history into the chat. */
const resumeSession = async (app, id) => {
    const selection = app.currentSelection();
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
    const rec = app.sessions.get(sid);
    const events = app.sessionEvents(handle.agent.session);
    rec.feed.appendNotice(`history replay: ${events.length} events`);
    for (const event of events) {
        app.foldEvent(rec, event);
        rec.feed.applyEvent(event, { history: true });
        app.maybePushFileDiff(rec.feed, event);
    }
    await switchTo(app, sid);
    app.refreshList();
    app.notice(`已恢复 ${sid}`);
    return sid;
};
/** Terminal title: active session title + model (OSC 2 via nvim). */
const updateTitle = (app) => {
    if (app.nvim === null || app.disposed)
        return;
    const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId);
    const title = rec?.title ?? 'dsh';
    void app.luaCall('require("dsh_tui").set_title(...)', [title]).catch(() => { });
};
const switchTo = async (app, id) => {
    app.activeId = id;
    await app.lua.setActive(id);
    app.ensureSpinner();
    app.updateStatusline();
    updateTitle(app);
    void app.seedRunningSubagents(id);
    if (app.sessions.has(id))
        app.recordState(id);
};
const selectSession = async (app, id) => {
    if (app.disposed)
        return;
    if (app.sessions.has(id)) {
        await switchTo(app, id);
        app.refreshList();
    }
    else if (app.historyHeaders.some((h) => h.id === id) || app.historyById.has(id)) {
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
    if (app.activeId === null) {
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
        const parent = app.runtimeCtx.sessions.get(app.activeId);
        const events = parent === undefined ? [] : app.sessionEvents(parent);
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
        const selection = app.currentSelection();
        const modelRef = { current: selection, assembled: void 0 };
        const handle = await app.runtimeCtx.agents.create({
            sessionId: `session-${randomUUID()}`,
            seed: events.slice(0, cut),
            inheritedEventCount: cut,
            meta: {
                cwd: parent?.header?.cwd ?? process.cwd(),
                parentSession: app.activeId,
                isSeeded: true,
            },
            agentOptions: { provider: selection.provider, model: selection.model },
            setup: (agentCtx) => { installModelSelection(agentCtx, modelRef); },
        });
        const id = await attachSession(app, handle, modelRef);
        await switchTo(app, id);
        app.refreshList();
        app.notice(`已分叉到 ${id}（继承 ${cut} 条历史事件）`);
        if (directive && directive.trim())
            app.send(directive.trim());
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
    await app.refreshHistory();
    app.refreshList();
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
            const rec = app.sessions.get(sid);
            const hist = app.historyById.get(sid);
            const title = rec?.title ?? hist?.title ?? '';
            rows.push({ label: `    ${sid === app.activeId ? '▸' : ' '} ${title || sid.slice(0, 8)} · ${sid}`, value: `sess:${sid}` });
        }
    }
    rows.push({ label: '未分组', value: 'ws:none' });
    for (const s of app.runtimeCtx.sessions.list()) {
        if (inWs.has(s.id) || archived.has(s.id) || s.header?.origin === 'subagent' || !/^session-/.test(s.id))
            continue;
        const rec = app.sessions.get(s.id);
        rows.push({ label: `    ${s.id === app.activeId ? '▸' : ' '} ${rec?.title ?? ''} · ${s.id}`, value: `sess:${s.id}` });
    }
    for (const h of app.historyHeaders) {
        if (inWs.has(h.id) || archived.has(h.id) || app.sessions.has(h.id))
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
        await selectSession(app, sel.slice(5));
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
            app.pendingRename = { kind: 'workspace', id: wid };
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
        const dir = await app.openDirPicker(process.cwd());
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
        app.pendingRename = { kind: 'workspace', id: wid };
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
    const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId);
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
    const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId);
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
export function installSessions(app) {
    app.attachSession = (handle, modelRef) => attachSession(app, handle, modelRef).then(() => { });
    app.welcomeLines = welcomeLines;
    app.createSession = (cwdPath) => createSession(app, cwdPath).then(() => { });
    app.resumeSession = (id) => resumeSession(app, id).then(() => { });
    app.updateTitle = () => updateTitle(app);
    app.switchTo = (id) => switchTo(app, id);
    app.selectSession = (id) => selectSession(app, id);
    app.forkSession = (directive) => forkSession(app, directive);
    const specs = [
        { name: '/sessions', desc: t('会话浏览器（工作区分组）'), usage: t('会话列表'), group: t('系统'), fn: () => sessionsCommand(app) },
        { name: '/workspace', desc: t('工作区管理'), usage: t('[add <目录> [标题] | delete <id>]'), group: t('会话'), fn: (a) => workspaceCommand(app, a) },
        { name: '/archive', desc: t('归档会话（从列表隐藏）'), usage: t('[会话id]'), group: t('会话'), fn: (a) => archiveCommand(app, a) },
        { name: '/new', desc: t('新建会话（可带目录）'), usage: t('[目录]'), group: t('会话'), fn: (a) => createSession(app, (a ?? '').trim() || undefined) },
        { name: '/clear', desc: t('清空当前会话屏幕'), usage: t(''), group: t('会话'), fn: () => app.activeFeed()?.clear() },
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
}
