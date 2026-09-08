/**
 * dsh_tui statusline module: fold transcript events into the session's
 * statusline stats, render the statusline (permission mode + hints on the
 * left, model/effort/cache/context/tokens/elapsed/cost/route on the right),
 * drive the whale spinner while the active agent runs, and own the /glance
 * /density /whale /cost display commands.
 *
 * @module dsh-nvim-tui/statusline
 */
import { WHALE_EMOJI_FRAMES } from './whale.js';
import { EMPTY_USAGE, foldUsage, billedInput, cacheHitRate, estimateCost, formatTokens, formatElapsed, modeLabel, escapeStatusline, } from './stats.js';
import { t } from './kernel/i18n.js';
import { registerHostHandler } from './kernel/host-events.js';
/** Fold one transcript event into the session's statusline stats. */
const foldEvent = (app, rec, event) => {
    if (event.type === 'assistant/message' && event.data?.usage) {
        rec.usage = foldUsage(rec.usage ?? EMPTY_USAGE, event.data.usage);
        // The CURRENT context proxy: only the latest step's billed input is
        // comparable against the context window (the session total is not).
        rec.lastUsage = foldUsage(EMPTY_USAGE, event.data.usage);
        rec.cacheReported = rec.cacheReported ||
            event.data.usage.cacheReadTokens !== undefined ||
            event.data.usage.cacheWriteTokens !== undefined;
    }
    else if (event.type === 'request/context') {
        if (typeof event.data?.contextWindow === 'number') {
            rec.contextWindow = event.data.contextWindow;
        }
        if (typeof event.data?.provider === 'string')
            rec.provider = event.data.provider;
    }
    else if (event.type === 'sandbox/mode') {
        rec.mode = event.data?.mode ?? rec.mode;
    }
    else if (event.type === 'approval/policy') {
        rec.policy = event.data?.policy ?? rec.policy;
    }
    else if (event.type === 'todo/write') {
        const todos = event.data?.todos ?? [];
        const count = (st) => todos.filter((t) => t.status === st).length;
        rec.todos = { completed: count('completed'), inProgress: count('in_progress'), pending: count('pending') };
        rec.todosItems = todos;
        if (rec.id === app.slices.sessions.activeId)
            app.slices.ui.updateStatusline();
        // LIVE todo popup: re-render the open /todo float in place.
        const pop = app.slices.agent.livePopup;
        if (pop !== null && pop.kind === 'todo') {
            const marks = { pending: '○', in_progress: '◐', completed: '✓' };
            pop.update(todos.map((it) => ({ label: `  ${marks[it.status] ?? '·'} ${it.content}`, value: it.content })));
        }
    }
};
// The running-subagents BADGE lives in the feed's activity line (same
// slot and transient logic as the thinking line) — the registry here
// only drives the statusline running state + spinner.
const ensureSpinner = (app) => {
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    const running = rec?.status === '● running' ||
        app.slices.sessions.runningSubagentsOf(app.slices.sessions.activeId).length > 0 ||
        (rec?.bgJobs ?? 0) > 0;
    if (running && app.slices.runtime.spinnerTimer === null) {
        app.slices.runtime.spinnerSet(setInterval(() => {
            app.slices.runtime.spinnerStep(WHALE_EMOJI_FRAMES.length);
            app.slices.ui.updateStatusline();
        }, 450));
    }
    else if (!running && app.slices.runtime.spinnerTimer !== null) {
        clearInterval(app.slices.runtime.spinnerTimer);
        app.slices.runtime.spinnerSet(null);
    }
};
/**
 * The right-side running badge (pure): main turn → '● running'; live
 * subagents → '● running ◇N'; otherwise background jobs keep the whale
 * spinning with '🔧 后台 N'; nothing running → null (statusline shows idle).
 */
export function runningBadge(mainRunning, subRunning, bgJobs) {
    if (mainRunning)
        return '● running';
    if (subRunning > 0)
        return `● running ◇${subRunning}`;
    if (bgJobs > 0)
        return `🔧 后台 ${bgJobs}`;
    return null;
}
/** Re-read the ACTIVE session's live background jobs (running + stopping). */
const refreshBgJobs = (app) => {
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (rec === undefined)
        return;
    const jobs = app.svc('jobs');
    let count = 0;
    let listed = [];
    if (jobs !== undefined) {
        try {
            listed = jobs.list(rec.handle.agent);
        }
        catch { }
    }
    const cache = rec.jobsCache ?? new Map();
    rec.jobsCache = cache;
    // Merge the live list into the cache; a cached running/stopping job that
    // VANISHED from the list (finished without a callback) turns terminal.
    const liveIds = new Set(listed.map((j) => j.id));
    for (const j of listed) {
        const prev = cache.get(j.id);
        cache.set(j.id, { label: j.label ?? prev?.label, status: j.status, startedAt: j.startedAt ?? prev?.startedAt });
    }
    for (const [id, c] of cache) {
        if (!liveIds.has(id) && (c.status === 'running' || c.status === 'stopping')) {
            cache.set(id, { ...c, status: 'killed' });
        }
    }
    count = [...cache.values()].filter((c) => c.status === 'running' || c.status === 'stopping').length;
    rec.bgJobs = count;
    // Board rows from the CACHE (final states survive the live-list drop).
    const icon = (st) => st === 'running' ? '⏳' : st === 'completed' ? '✓' : st === 'killed' ? '✗' : st === 'failed' ? '⚠' : '·';
    const entries = [...cache.entries()];
    const rows = [];
    if (entries.length > 0) {
        rows.push('', `${t('⚙ 任务')} ${entries.length} ${t('项')} · ${count} ${t('运行中')}`);
        for (const [, c] of entries) {
            const elapsed = c.startedAt !== undefined ? ` · ${((Date.now() - c.startedAt) / 1000).toFixed(0)}s` : '';
            rows.push(`  ${icon(c.status)} ${c.label ?? '?'}${elapsed}`);
        }
    }
    const pop = app.slices.agent.livePopup;
    if (pop !== null && pop.kind === 'jobs') {
        pop.update(entries.map(([id, c]) => {
            const elapsed = c.startedAt !== undefined ? ` · ${((Date.now() - c.startedAt) / 1000).toFixed(0)}s` : '';
            return { label: `${icon(c.status)} ${c.label ?? '?'} · ${id}${elapsed}`, value: `kill:${id}` };
        }));
    }
    if (entries.length > 0 && count === 0) {
        // EVERY job is terminal: the final board commits into the chat flow
        // and the pinned slot clears. The harness's jobs.list KEEPS returning
        // terminal jobs, so the 30s idle heartbeat would re-populate the cache
        // and re-commit the same batch forever — the committed-batch key
        // (ids+statuses, NO elapsed) makes the commit one-shot.
        const key = entries.map(([id, c]) => `${id}:${c.status}`).sort().join('|');
        if (key !== rec.committedJobsKey) {
            rec.feed.commitJobsBoard(rows);
            rec.committedJobsKey = key;
        }
    }
    else {
        rec.feed.setJobsBoard(rows);
    }
};
/** Statusline: left = permission mode + hints; right = model/effort,
 *  cache, context, tokens, elapsed, cost, route (+ spinner while running). */
const updateStatusline = (app) => {
    if (app.slices.runtime.chatWinId === null)
        return;
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    const subRunning = app.slices.sessions.runningSubagentsOf(app.slices.sessions.activeId);
    const mainRunning = rec?.status === '● running';
    const bgJobs = rec?.bgJobs ?? 0;
    const badge = runningBadge(mainRunning, subRunning.length, bgJobs);
    const running = badge !== null;
    // -- left: dynamic permission mode + key hints (literal % escaped:
    //    statusline treats % as the item prefix → E539 otherwise)
    const mode = modeLabel(rec?.mode);
    const policy = rec?.policy ?? 'ask';
    const left = escapeStatusline(`${mode} · ${policy} · / ${t('命令')} · ctrl+o ${t('面板')} · ctrl+p ${t('历史')}`);
    // Extension-contributed segments (P1 ext API): sorted by priority,
    // appended after the built-in left block.
    const extSegs = [...app.slices.ext.extStatusSegments.values()]
        .sort((a, b) => a.priority - b.priority)
        .map((s) => escapeStatusline(s.text));
    const leftFull = extSegs.length > 0 ? `${left}  ${extSegs.join('  ')}` : left;
    // -- right: live statistics
    const right = [];
    // The fat whale emoji + bubble cycle replaces the braille spinner.
    if (running) {
        right.push(`${WHALE_EMOJI_FRAMES[app.slices.runtime.spinnerIndex]} ${escapeStatusline(badge)}`);
    }
    else
        right.push(escapeStatusline(rec?.status ?? '○ idle'));
    if (mainRunning && rec?.runningSince) {
        right.push(escapeStatusline(`${((Date.now() - rec.runningSince) / 1000).toFixed(1)}s`));
    }
    if (rec?.model) {
        const effort = app.slices.agent.currentSelection().reasoningEffort;
        right.push(escapeStatusline(rec.model + (effort ? ` ◎${effort}` : '')));
    }
    const usage = rec?.usage;
    const cacheRate = usage ? cacheHitRate(usage, rec?.cacheReported === true) : null;
    if (cacheRate !== null)
        right.push(escapeStatusline(`缓存 ${Math.round(cacheRate * 100)}%`));
    // Context = the LATEST step's billed input vs the context window
    // (the session total is a different number — shown as Σ).
    const last = rec?.lastUsage;
    const lastBilled = last ? billedInput(last) : 0;
    if (rec?.contextWindow && lastBilled > 0) {
        const ratio = Math.min(1, lastBilled / rec.contextWindow);
        right.push(escapeStatusline(`上下文 ${Math.round(ratio * 100)}%`));
        right.push(escapeStatusline(`◧ ${formatTokens(lastBilled)}/${formatTokens(rec.contextWindow)}`));
    }
    else if (lastBilled > 0) {
        right.push(escapeStatusline(`◧ ${formatTokens(lastBilled)}`));
    }
    if (usage) {
        const total = billedInput(usage) + usage.output;
        if (total > 0)
            right.push(escapeStatusline(`Σ ${formatTokens(total)}`));
    }
    // Whole-log performance projection (official client's TTFT/throughput
    // stats): sessionStats unit, read live from the projection registry.
    const projections = app.svc('sessionProjections');
    if (rec !== undefined && typeof projections?.stateOf === 'function') {
        try {
            const stats = projections.stateOf(rec.handle.agent.session, 'sessionStats');
            if (stats !== undefined && (stats.ttftSteps ?? 0) > 0) {
                right.push(escapeStatusline(`TTFT ${((stats.ttftMs ?? 0) / (stats.ttftSteps ?? 1) / 1000).toFixed(1)}s`));
            }
            if (stats !== undefined && (stats.decodeMs ?? 0) > 0 && (stats.decodeTokens ?? 0) > 0) {
                right.push(escapeStatusline(`${Math.round((stats.decodeTokens ?? 0) / ((stats.decodeMs ?? 1) / 1000))} tok/s`));
            }
        }
        catch { }
    }
    // Goal / plan mode indicators (folded from session events, cached).
    if (rec?.planActive)
        right.push('📋 plan');
    // Background jobs badge (official client's session-header jobs entry).
    const jobs = app.svc('jobs');
    if (rec !== undefined && jobs !== undefined) {
        try {
            const running = (jobs.list(rec.handle.agent) ?? []).filter((j) => j.status === 'running').length;
            if (running > 0)
                right.push(escapeStatusline(`⚙ ${running}`));
        }
        catch { }
    }
    // Addressed child session (continuable followup): lineage indicator.
    if (app.slices.agent.pendingSubagentFollowup !== null) {
        right.push(escapeStatusline(`⇢ ${app.slices.agent.pendingSubagentFollowup.label}`));
    }
    // Queued messages (inbox projection): the QueueDock counterpart.
    if (rec !== undefined) {
        try {
            const inbox = rec.handle.agent.inbox;
            const queued = ((inbox?.nextTurn?.length ?? 0) + (inbox?.nextStep?.length ?? 0));
            if (queued > 0)
                right.push(escapeStatusline(`⏳ ${queued}`));
        }
        catch { }
    }
    // Standing todos (todo/write fold): the TodoDock counterpart.
    if (rec?.todos) {
        const t = rec.todos;
        if (t.completed + t.inProgress + t.pending > 0) {
            right.push(`📋 ${t.completed}✓ ${t.inProgress}… ${t.pending}·`);
        }
    }
    if (rec?.goal) {
        const g = rec.goal;
        right.push(escapeStatusline(`🎯 ${g.phase === 'active' ? '' : g.phase + ' '}${g.maxGoalRounds > 0 ? `${Math.min(g.roundsStarted ?? 0, g.maxGoalRounds)}/${g.maxGoalRounds}` : (g.roundsStarted ?? 0)}`));
    }
    if (rec?.createdAt)
        right.push(escapeStatusline(formatElapsed(Date.now() - rec.createdAt)));
    if (rec?.model && usage) {
        const cost = estimateCost(rec.model, usage);
        if (cost !== undefined)
            right.push(escapeStatusline(`$${cost.toFixed(2)}`));
    }
    right.push(escapeStatusline(rec?.provider ?? app.slices.agent.currentSelection().provider));
    const text = `%#DshTuiStatus# ${leftFull} %= ${right.join(' · ')} `;
    // Owned by the Lua side: window events re-apply it so statusline
    // plugins cannot clobber it on window switches.
    void app.luaCall('require("dsh_tui").set_statusline(...)', [text]).catch(() => { });
};
// -- glance segments (statusline visibility toggles) ---------------------
const GLANCE_SEGMENTS = ['cache', 'context', 'tokens', 'cost', 'elapsed', 'total'];
const hiddenGlance = new Set();
/** /density — compact tool cards (title line only). */
/** /whale [on|off] — blue whale wallpaper/watermark toggle. */
const whaleCommand = (app, a) => {
    const feed = app.slices.ui.activeFeed();
    if (!feed)
        return;
    const on = a === 'on' ? true : a === 'off' ? false : !feed.whale;
    feed.setWhale(on);
    app.notice(on ? '蓝鲸背景已开启（空态居中壁纸 + 有内容时底部水印）' : '蓝鲸背景已关闭');
};
const densityCommand = (app) => {
    const feed = app.slices.ui.activeFeed();
    if (!feed)
        return;
    feed.dense = !feed.dense;
    app.notice(`紧凑模式: ${feed.dense ? '开' : '关'}`);
};
/** /glance [segment…] — toggle statusline segments. */
const glanceCommand = (app, a) => {
    if (!a) {
        const shown = GLANCE_SEGMENTS.filter((s) => !hiddenGlance.has(s));
        app.notice(`glance 段: ${shown.join(' ') || '（全部隐藏）'} · 用法: /glance <segment>`);
        return;
    }
    const seg = GLANCE_SEGMENTS.find((s) => a.startsWith(s));
    if (!seg) {
        app.notice(`未知段 ${a}（可选: ${GLANCE_SEGMENTS.join(' ')})`);
        return;
    }
    if (hiddenGlance.has(seg))
        hiddenGlance.delete(seg);
    else
        hiddenGlance.add(seg);
    app.slices.ui.updateStatusline();
    app.notice(`glance ${seg}: ${hiddenGlance.has(seg) ? '隐藏' : '显示'}`);
};
/** /cost — accumulated usage + cost for the active session. */
const costCommand = (app) => {
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec?.usage) {
        app.notice(t('本会话暂无用量数据'));
        return;
    }
    const u = rec.usage;
    const billed = billedInput(u);
    const cost = rec.model ? estimateCost(rec.model, u) : undefined;
    app.notice(`输入 ${formatTokens(u.input)} · 缓存读 ${formatTokens(u.cacheRead)} · 输出 ${formatTokens(u.output)}`);
    app.notice(`billed 输入 ${formatTokens(billed)} · 总计 ${formatTokens(billed + u.output)}` +
        (cost !== undefined ? ` · 预估 $${cost.toFixed(2)}` : ''));
};
/** Fill the statusline module's App slots and register its commands. */
export function installStatusline(app) {
    // -- ui surface domain defaults (I2; transcript owns the diff part) --
    Object.assign(app.slices.ui, {
        welcomeLines: () => ({ above: [], below: [] }),
        ensureSpinner: () => { },
        updateStatusline: () => { },
        refreshBgJobs: () => { },
        foldEvent: () => { },
    });
    app.slices.ui.foldEvent = (rec, event) => foldEvent(app, rec, event);
    app.slices.ui.updateStatusline = () => updateStatusline(app);
    app.slices.ui.ensureSpinner = () => ensureSpinner(app);
    app.slices.ui.refreshBgJobs = () => refreshBgJobs(app);
    // Background jobs keep the statusline honest while the agent is idle:
    // every visible-set change re-reads the active session's live jobs and
    // re-arms the spinner; a settled job notices its label when it belongs
    // to the active session.
    const jobs = app.svc('jobs');
    if (typeof jobs?.onJobsChanged === 'function') {
        app.slices.runtime.hostDisposers.push(jobs.onJobsChanged(() => {
            app.slices.ui.refreshBgJobs();
            app.slices.ui.ensureSpinner();
            app.slices.ui.updateStatusline();
        }));
    }
    if (typeof jobs?.onJobDone === 'function') {
        app.slices.runtime.hostDisposers.push(jobs.onJobDone((snap, owner) => {
            // Merge the terminal state BEFORE the board refreshes (the live list
            // may already have dropped the job).
            const sid = owner?.session?.id;
            const snapId = snap?.id;
            if (sid !== undefined) {
                const rec2 = app.slices.sessions.live.get(sid);
                if (rec2 !== undefined && snapId !== undefined) {
                    const cache2 = rec2.jobsCache ?? new Map();
                    rec2.jobsCache = cache2;
                    const prev = cache2.get(snapId);
                    cache2.set(snapId, { label: snap.label ?? prev?.label, status: snap.status ?? 'completed', startedAt: prev?.startedAt });
                }
            }
            app.slices.ui.refreshBgJobs();
            app.slices.ui.ensureSpinner();
            app.slices.ui.updateStatusline();
            if (sid !== undefined && sid === app.slices.sessions.activeId) {
                app.notice(`✓ 后台任务 ${snap?.label ?? '?'} · ${snap?.status ?? '结束'}`);
            }
        }));
    }
    const specs = [
        { name: '/glance', desc: t('状态栏段显隐'), usage: t('<cache|context|tokens|cost|elapsed|total>'), group: t('显示'), fn: (a) => glanceCommand(app, a) },
        { name: '/density', desc: t('紧凑卡片模式'), usage: t('紧凑卡片'), group: t('显示'), fn: () => densityCommand(app) },
        { name: '/whale', desc: t('蓝鲸背景开关'), usage: t('on|off'), group: t('显示'), fn: (a) => whaleCommand(app, a) },
        { name: '/cost', desc: t('用量与成本'), usage: t('用量成本'), group: t('信息'), fn: () => costCommand(app) },
    ];
    app.registerCommands(specs);
    // -- host events this module owns (wired by boot via host-events.ts) ----
    // Agent lifecycle status → statusline.
    registerHostHandler('agent/status', (app, payload) => {
        if (app.slices.runtime.disposed)
            return;
        const { agent, status } = (payload ?? {});
        const sid = agent?.session?.id;
        const rec = sid === undefined ? undefined : app.slices.sessions.live.get(sid);
        if (!rec)
            return;
        if (status === 'running') {
            rec.status = '● running';
            rec.runningSince = Date.now();
        }
        else {
            rec.status = '○ idle';
            rec.runningSince = null;
        }
        if (rec.id === app.slices.sessions.activeId) {
            app.slices.ui.ensureSpinner();
            app.slices.ui.updateStatusline();
        }
    });
}
