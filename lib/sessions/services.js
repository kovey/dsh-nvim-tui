/** dsh_tui sessions module SERVICES: session lifecycle + fork (shared by
 *  the command files, the slots and the boot sequence). */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { FeedRenderer } from '../feed/feed.js';
import { statSync } from 'node:fs';
import { t } from '../kernel/i18n.js';
import { BUILD_STAMP, BUILD_VERSION } from '../kernel/app.js';
const WSS = (d) => d;
export const attachSession = async (app, handle, modelRef, opts) => {
    const id = handle.agent.session.id;
    const ids = await app.lua.ensureChat(id);
    // Background resume (row actions like rename) must NOT touch the global
    // view state — the active session owns the visible chat/reasoning
    // pointers; writing them here used to point the active view at the
    // background session's buffers.
    if (opts?.background !== true) {
        app.slices.runtime.setChatWin(ids.chatWin);
    }
    const rids = await app.lua.ensureReasoning(id);
    if (opts?.background !== true) {
        app.slices.runtime.setReasoning(rids?.reasoningOpen === true, (rids?.reasoningWin ?? null));
    }
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
        committedJobKeys: new Set(),
        pendingToolCalls: new Map(),
        visionTmp: null,
        difficulty: { tier: null, pinned: null, enabled: true, tmp: null, source: null, syncedRoutesKey: null },
        toolErrors: 0,
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
export const createSession = async (app, cwdPath) => {
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
/** In-flight resume dedupe: a concurrent second caller for the same id must
 *  await the SAME resume instead of racing a second agents.resume past the
 *  live.has check (pre-review: double live records, a leaked first
 *  AgentHandle, and two FeedRenderers writing the same buffers). */
const resuming = new Map();
export const ensureLiveSession = (app, id) => {
    if (app.slices.sessions.live.has(id))
        return Promise.resolve(id);
    const inflight = resuming.get(id);
    if (inflight !== undefined)
        return inflight;
    const p = doResumeSession(app, id).finally(() => {
        if (resuming.get(id) === p)
            resuming.delete(id);
    });
    resuming.set(id, p);
    return p;
};
const doResumeSession = async (app, id) => {
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
    const sid = await attachSession(app, handle, modelRef, { background: true });
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
/** Dispose one live session that is NOT the active view (background-resumed
 *  sessions must not accumulate forever — each holds an agent handle, a feed
 *  and nvim chat/reasoning buffers). */
export const disposeLiveSession = async (app, id) => {
    if (id === app.slices.sessions.activeId)
        return;
    const rec = app.slices.sessions.live.get(id);
    if (rec === undefined)
        return;
    app.slices.sessions.live.delete(id);
    try {
        await rec.handle.dispose();
    }
    catch (err) {
        app.exitDiag('disposeLiveSession', err.message);
    }
    // Reclaim the chat buffer on the nvim side (runner-side LRU close_chat).
    void app.luaCall('return require("dsh_tui").close_chat(...)', [id]).catch(() => { });
    app.slices.sessions.refreshList();
};
export const resumeSession = async (app, id) => {
    const sid = await ensureLiveSession(app, id);
    if (sid === undefined)
        return;
    await switchTo(app, sid);
    app.notice(`已恢复 ${sid}`);
    return sid;
};
/** Terminal title: active session title + model (OSC 2 via nvim). */
export const switchTo = async (app, id) => {
    // Transient input-flow state is session-scoped: switching mid-flow must
    // not leak it into the new session (queued edits / rename prompts /
    // pending images / card inputs / subagent followups).
    const hadPending = app.slices.agent.pendingImages.length > 0 ||
        app.slices.agent.pendingRename !== null ||
        app.slices.agent.pendingQueueEdit !== null ||
        app.slices.agent.pendingSubagentFollowup !== null ||
        app.slices.ext.pendingCardInput !== null;
    if (hadPending)
        app.notice(t('已切换会话（未完成的输入操作已取消）'));
    app.slices.agent.clearPendings();
    app.slices.ext.setPendingCardInput(null);
    WSS(app.slices.sessions).activeId = id;
    await app.lua.setActive(id);
    // Sync the runtime's GLOBAL view pointers with the Lua side. The resume
    // path attaches with background:true (S6 — row actions must not move the
    // visible view), so setChatWin/setReasoning never ran for it; without this
    // sync updateStatusline early-returns (chatWinId === null) and the stats
    // bar stays blank for the whole resumed session. chatWin is the SHARED
    // chat window and reasoningWin the global panel state, so ids() (not
    // ensure_chat) is the accurate source right after set_active.
    try {
        const ids = await app.luaCall('return require("dsh_tui").ids()', []);
        if (ids !== null && ids !== undefined && typeof ids === 'object') {
            if (Number.isInteger(ids.chatWin)) {
                app.slices.runtime.setChatWin(ids.chatWin);
            }
            app.slices.runtime.setReasoning(ids.reasoningOpen === true, Number.isInteger(ids.reasoningWin) ? ids.reasoningWin : null);
        }
    }
    catch { /* best-effort: the next session event re-syncs the view */ }
    app.slices.ui.ensureSpinner();
    app.slices.ui.updateStatusline();
    updateTitle(app);
    app.slices.ext.extFire('tui:active-session', { id });
    void app.slices.sessions.seedRunningSubagents(id);
    if (app.slices.sessions.live.has(id))
        app.slices.sessions.recordState(id);
};
export const selectSession = async (app, id) => {
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
export const forkSession = async (app, directive) => {
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
        const parent = app.liveSessions.get(app.slices.sessions.activeId);
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
export const welcomeLines = () => {
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
export const updateTitle = (app) => {
    if (app.slices.runtime.nvim === null || app.slices.runtime.disposed)
        return;
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    const title = rec?.title ?? 'dsh';
    void app.luaCall('require("dsh_tui").set_title(...)', [title]).catch(() => { });
};
