/**
 * dsh_tui subagents module: child-agent directory (/subagents), the
 * read-only thinking-chain replay float, and the continuable child chat
 * window (send user messages to a child like chatting with the main agent).
 *
 * @module dsh-nvim-tui/subagents
 */
import { FeedRenderer } from './feed.js';
import { t } from './i18n.js';
import { ageLabel, isExpired, orderSubagentChildren, readCleanedIds, writeCleanedIds } from './subagent-clean.js';
import { queueSubagentPromptKey } from './types.js';
/** Enumerate the active session's subagent children (live + persisted).
 *  Preferred path: the official `subagents.listChildren` directory.
 *  Fallback: scan the live session store + sessionPersistence.list() for
 *  headers with parentSession === parentId and origin 'subagent'. */
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
/** Seed the running-subagents registry from the host: a session may have
 *  children started before the TUI attached (workflow kicked off from
 *  elsewhere, or a resume mid-run). Best-effort. */
const seedRunningSubagents = async (app, parentId) => {
    try {
        const children = await listSubagentChildren(app, parentId);
        let changed = false;
        for (const c of children) {
            if (!c.running || app.runningSubagents.has(c.id))
                continue;
            app.runningSubagents.set(c.id, {
                parentId,
                label: c.label,
                startedAt: c.createdAt ?? Date.now(),
            });
            changed = true;
        }
        if (changed) {
            app.ensureSpinner();
            app.updateStatusline();
        }
    }
    catch { /* best-effort */ }
};
/** Clean one settled chain: hide it from the /subagents list (ledger),
 *  and truncate the stored events where the host exposes it (dsh
 *  0.1.1-rc.2 keeps logs append-only — truncation is best-effort). */
const cleanSubagentChain = async (app, parentId, childId) => {
    const persistence = app.svc('sessionPersistence');
    let first;
    if (typeof persistence?.truncateStored === 'function') {
        try {
            const inspection = await persistence.inspect?.(childId);
            const events = (inspection?.events ?? []);
            first = events[0]?.seq;
            if (typeof first === 'number') {
                await persistence.truncateStored(childId, first);
                const live = app.runtimeCtx.sessions.get(childId);
                if (live !== undefined && typeof live.truncate === 'function') {
                    ;
                    live.truncate(first);
                }
            }
        }
        catch { }
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
/** Open a read-only replay of one subagent's session log in a float. */
const openSubagentView = async (app, childId, label) => {
    // One float family at a time: the chat window closes (its close handler
    // drops the routing state).
    if (app.subagentChat !== null) {
        await app.luaCall('require("dsh_tui").close_subagent_chat()', []).catch(() => { });
        app.subagentChat = null;
    }
    // Gather the event log: live children stream from the in-memory store
    // (new events keep arriving via session/event routing); settled children
    // are read from persistence without resuming or publishing an agent.
    const live = app.runtimeCtx.sessions.get(childId);
    let events = [];
    if (live) {
        events = [...app.sessionEvents(live)];
    }
    else {
        try {
            const persistence = app.svc('sessionPersistence');
            const inspection = await persistence?.inspect?.(childId);
            events = (inspection?.events ?? []);
        }
        catch (err) {
            app.notice(`读取子代理会话失败: ${err.message}`);
            return;
        }
    }
    if (events.length === 0) {
        app.notice(t('子代理会话无事件（可能尚未开始）'));
        return;
    }
    const ids = await app.luaCall('return require("dsh_tui").open_subagent_view(...)', [label]);
    if (!ids || !Number.isInteger(ids.buf) || !Number.isInteger(ids.win)) {
        app.notice(t('子代理视图打开失败（nvim 浮窗未创建）'));
        return;
    }
    const feed = new FeedRenderer(app.nvim, ids.buf, ids.win, {
        idsProvider: () => app.luaCall('return require("dsh_tui").subagent_view_ids()', []),
        activeChecker: () => true,
        // No separate reasoning panel: reasoning blocks render inline, dim.
        reasoningBuf: null,
        reasoningView: () => null,
        inlineReasoning: true,
    });
    app.subagentView = { childId, feed };
    for (const e of events) {
        feed.applyEvent(e, { history: true });
        app.maybePushFileDiff(feed, e);
    }
    // Close the snapshot/live gap: events appended while the view opened.
    if (live) {
        const liveEvents = app.sessionEvents(live);
        for (let i = events.length; i < liveEvents.length; i++) {
            feed.applyEvent(liveEvents[i], { history: true });
            app.maybePushFileDiff(feed, liveEvents[i]);
        }
    }
    await feed.flush();
    if (!live) {
        // Settled replay: land on the FIRST thinking block — the window
        // otherwise opens scrolled to the transcript tail (the final answer),
        // which makes the thinking details look missing. Live views keep
        // tail-following the running stream.
        await app.luaCall('require("dsh_tui").subagent_view_goto_thinking()', []).catch(() => { });
    }
    app.notice(`子代理视图: ${label}（${events.length} 事件 · q/Esc 关闭${live ? ' · 实时跟随' : ''}）`);
};
/**
 * Open the subagent CHAT window for one continuable child: the child's
 * live transcript streams into the upper feed (inline reasoning + answer
 * + tool cards), and the lower input row sends user messages to the child
 * through the official `subagents.followup` queue (human prompt → the
 * child's next turn; a settled child cold-resumes, a running child admits
 * it after the current turn converges).
 */
const openSubagentChat = async (app, childId, label) => {
    if (app.activeId === null) {
        app.notice(t('无活跃会话'));
        return;
    }
    // One float family at a time: the read-only view closes (its close
    // handler drops the routing state).
    if (app.subagentView !== null) {
        await app.luaCall('require("dsh_tui").close_subagent_view()', []).catch(() => { });
        app.subagentView = null;
    }
    const live = app.runtimeCtx.sessions.get(childId);
    let events = [];
    if (live) {
        events = [...app.sessionEvents(live)];
    }
    else {
        try {
            const persistence = app.svc('sessionPersistence');
            const inspection = await persistence?.inspect?.(childId);
            events = (inspection?.events ?? []);
        }
        catch (err) {
            app.notice(`读取子代理会话失败: ${err.message}`);
            return;
        }
    }
    if (events.length === 0) {
        app.notice(t('子代理会话无事件（可能尚未开始）'));
        return;
    }
    const ids = await app.luaCall('return require("dsh_tui").open_subagent_chat(...)', [label]);
    if (!ids || !Number.isInteger(ids.buf) || !Number.isInteger(ids.win) ||
        !Number.isInteger(ids.inputBuf) || !Number.isInteger(ids.inputWin)) {
        app.notice(t('子代理对话窗打开失败（nvim 浮窗未创建）'));
        return;
    }
    // The window takes over the "next input goes to the child" quick path.
    app.pendingSubagentFollowup = null;
    const feed = new FeedRenderer(app.nvim, ids.buf, ids.win, {
        idsProvider: () => app.luaCall('return require("dsh_tui").subagent_chat_ids()', []),
        activeChecker: () => true,
        // No separate reasoning panel: reasoning blocks render inline, dim.
        reasoningBuf: null,
        reasoningView: () => null,
        inlineReasoning: true,
    });
    app.subagentChat = { childId, parentId: app.activeId, label, feed };
    for (const e of events) {
        feed.applyEvent(e, { history: true });
        app.maybePushFileDiff(feed, e);
    }
    // Close the snapshot/live gap: events appended while the window opened.
    if (live) {
        const liveEvents = app.sessionEvents(live);
        for (let i = events.length; i < liveEvents.length; i++) {
            feed.applyEvent(liveEvents[i], { history: true });
            app.maybePushFileDiff(feed, liveEvents[i]);
        }
    }
    await feed.flush();
    if (!live) {
        // Settled replay: land on the FIRST thinking block, like the view.
        await app.luaCall('require("dsh_tui").subagent_chat_goto_thinking()', []).catch(() => { });
    }
    app.notice(`子代理对话窗: ${label}（Enter 发送 · Esc 关闭${live ? ' · 实时' : ''}）`);
};
/**
 * Send one user message from the subagent chat window to its child.
 * Optimistic echo (deduped against the harness's user/message replay),
 * queued through `subagents.followup` with user provenance.
 */
const sendToSubagent = (app, text) => {
    const chat = app.subagentChat;
    if (chat === null || app.disposed)
        return;
    const clean = text.trim();
    if (clean === '')
        return;
    const parentRec = app.sessions.get(chat.parentId);
    if (parentRec === undefined) {
        chat.feed.pushError(t('父会话已不存在，无法发送'));
        return;
    }
    // Optimistic echo: render the bubble now; the matching user/message
    // replay is skipped in the session/event routing (FIFO per session).
    chat.feed.pushUser(clean, []);
    const q = app.pendingEchoes.get(chat.childId) ?? [];
    q.push(clean);
    if (q.length > 4)
        q.shift();
    app.pendingEchoes.set(chat.childId, q);
    const subagentsSvc = app.svc('subagents');
    if (typeof subagentsSvc?.[queueSubagentPromptKey] !== 'function') {
        chat.feed.pushError(t('子代理续聊不可用（subagents 服务未装配）'));
        return;
    }
    if (app.runningSubagents.has(chat.childId)) {
        chat.feed.appendNotice(t('⏳ 已排队：子代理当前回合结束后处理'));
    }
    void (async () => {
        try {
            await app.queueSubagentPrompt(parentRec.handle.agent, chat.childId, clean);
            parentRec.feed?.appendNotice(`➤ 已发给子代理 ${chat.label}: ${FeedRenderer.truncate(clean, 60)}`);
        }
        catch (err) {
            chat.feed.pushError(`${t('发送失败')}: ${err.message}`);
        }
    })();
};
/** /subagents — child-agent directory; pick one to view its thinking. */
const subagentsCommand = async (app) => {
    const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId);
    if (!rec || app.activeId === null) {
        app.notice(t('无活跃会话'));
        return;
    }
    try {
        let children = await listSubagentChildren(app, app.activeId);
        // TTL cleanup: settled chains past the retention window are truncated
        // (only the first event survives) and hidden from the list.
        const ttlHours = Number(app.config.subagentTtlHours ?? 72);
        const expired = children.filter((c) => !c.running && isExpired(c.createdAt, ttlHours));
        if (expired.length > 0) {
            let cleaned = 0;
            for (const c of expired) {
                if (await cleanSubagentChain(app, app.activeId, c.id))
                    cleaned++;
            }
            if (cleaned > 0) {
                app.notice(`🧹 已清理 ${cleaned} 条过期子代理思考链（>${ttlHours}h），列表不再显示`);
                children = await listSubagentChildren(app, app.activeId);
            }
        }
        if (children.length === 0) {
            app.notice(t('该会话没有子代理（workflow/subagent 运行后此处可回放其思考链）'));
            return;
        }
        // Running children first, then newest-first — the live work leads.
        children = orderSubagentChildren(children);
        const settledCount = children.filter((c) => !c.running).length;
        const rows = [];
        let cleanRowInserted = false;
        for (const c of children) {
            if (!c.running && !cleanRowInserted) {
                cleanRowInserted = true;
                if (settledCount > 0) {
                    rows.push({ label: `🧹 清理全部已结束思考链（${settledCount} 条）`, value: 'act:clean' });
                }
            }
            rows.push({
                label: `${c.label}${c.running ? ' · 运行中' : ` · 已结束${ageLabel(c.createdAt) !== '' ? ` · ${ageLabel(c.createdAt)}` : ''}`}`,
                value: c.id,
            });
        }
        const sel = await app.openPicker(t('子代理（选择查看思考链）'), rows);
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
                if (!c.running && await cleanSubagentChain(app, app.activeId, c.id))
                    done++;
            }
            app.notice(`🧹 已清理 ${done} 条思考链`);
            return;
        }
        const child = children.find((c) => c.id === sel);
        const action = child?.mode === 'continuable'
            ? await app.openPicker(t('子代理操作'), [
                { label: '打开对话窗口（像主聊天一样发消息）', value: 'chat' },
                { label: '继续对话（下一条输入发给它）', value: 'continue' },
                { label: '查看思考链回放', value: 'view' },
            ])
            : 'view';
        if (action === 'continue') {
            app.pendingSubagentFollowup = { childId: sel, label: child?.label ?? sel.slice(0, 8) };
            app.notice(`下一条输入将发给子代理 ${app.pendingSubagentFollowup.label}（/subagents 可取消，直接输入即发送）`);
            return;
        }
        if (action === null)
            return;
        if (action === 'chat') {
            await openSubagentChat(app, sel, child?.label ?? sel.slice(0, 8));
            return;
        }
        await openSubagentView(app, sel, child?.label ?? sel.slice(0, 8));
    }
    catch (err) {
        app.notice(`subagents 失败: ${err.message}`);
    }
};
/** Fill the subagents module's App slots and register its commands. */
export function installSubagents(app) {
    app.listSubagentChildren = (parentId) => listSubagentChildren(app, parentId);
    app.seedRunningSubagents = (parentId) => seedRunningSubagents(app, parentId);
    app.cleanSubagentChain = (parentId, childId) => cleanSubagentChain(app, parentId, childId);
    app.openSubagentView = (childId, label) => openSubagentView(app, childId, label);
    app.openSubagentChat = (childId, label) => openSubagentChat(app, childId, label);
    app.sendToSubagent = (text) => sendToSubagent(app, text);
    const specs = [
        { name: '/subagents', desc: t('子代理目录（回放/续聊思考链）'), usage: t(''), group: t('会话'), fn: () => subagentsCommand(app) },
    ];
    app.registerCommands(specs);
}
