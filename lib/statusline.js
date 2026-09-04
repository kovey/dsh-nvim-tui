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
import { t } from './i18n.js';
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
        if (rec.id === app.activeId)
            app.updateStatusline();
    }
};
const runningSubagentsOf = (app, parentId) => parentId === null ? [] : [...app.runningSubagents.values()].filter((s) => s.parentId === parentId);
// The running-subagents BADGE lives in the feed's activity line (same
// slot and transient logic as the thinking line) — the registry here
// only drives the statusline running state + spinner.
const ensureSpinner = (app) => {
    const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId);
    const running = rec?.status === '● running' ||
        runningSubagentsOf(app, app.activeId).length > 0 ||
        (rec?.bgJobs ?? 0) > 0;
    if (running && app.spinnerTimer === null) {
        app.spinnerTimer = setInterval(() => {
            app.spinnerIndex = (app.spinnerIndex + 1) % WHALE_EMOJI_FRAMES.length;
            app.updateStatusline();
        }, 450);
    }
    else if (!running && app.spinnerTimer !== null) {
        clearInterval(app.spinnerTimer);
        app.spinnerTimer = null;
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
    const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId);
    if (rec === undefined)
        return;
    const jobs = app.svc('jobs');
    let count = 0;
    if (jobs !== undefined) {
        try {
            count = jobs.list(rec.handle.agent)
                .filter((j) => j.status === 'running' || j.status === 'stopping').length;
        }
        catch { }
    }
    rec.bgJobs = count;
};
/** Statusline: left = permission mode + hints; right = model/effort,
 *  cache, context, tokens, elapsed, cost, route (+ spinner while running). */
const updateStatusline = (app) => {
    if (app.chatWinId === null)
        return;
    const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId);
    const subRunning = runningSubagentsOf(app, app.activeId);
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
    const extSegs = [...app.extStatusSegments.values()]
        .sort((a, b) => a.priority - b.priority)
        .map((s) => escapeStatusline(s.text));
    const leftFull = extSegs.length > 0 ? `${left}  ${extSegs.join('  ')}` : left;
    // -- right: live statistics
    const right = [];
    // The fat whale emoji + bubble cycle replaces the braille spinner.
    if (running) {
        right.push(`${WHALE_EMOJI_FRAMES[app.spinnerIndex]} ${escapeStatusline(badge)}`);
    }
    else
        right.push(escapeStatusline(rec?.status ?? '○ idle'));
    if (mainRunning && rec?.runningSince) {
        right.push(escapeStatusline(`${((Date.now() - rec.runningSince) / 1000).toFixed(1)}s`));
    }
    if (rec?.model) {
        const effort = app.currentSelection().reasoningEffort;
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
    if (app.pendingSubagentFollowup !== null) {
        right.push(escapeStatusline(`⇢ ${app.pendingSubagentFollowup.label}`));
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
    right.push(escapeStatusline(rec?.provider ?? app.currentSelection().provider));
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
    const feed = app.activeFeed();
    if (!feed)
        return;
    const on = a === 'on' ? true : a === 'off' ? false : !feed.whale;
    feed.setWhale(on);
    app.notice(on ? '蓝鲸背景已开启（空态居中壁纸 + 有内容时底部水印）' : '蓝鲸背景已关闭');
};
const densityCommand = (app) => {
    const feed = app.activeFeed();
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
    app.updateStatusline();
    app.notice(`glance ${seg}: ${hiddenGlance.has(seg) ? '隐藏' : '显示'}`);
};
/** /cost — accumulated usage + cost for the active session. */
const costCommand = (app) => {
    const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId);
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
    app.foldEvent = (rec, event) => foldEvent(app, rec, event);
    app.updateStatusline = () => updateStatusline(app);
    app.ensureSpinner = () => ensureSpinner(app);
    app.refreshBgJobs = () => refreshBgJobs(app);
    app.runningSubagentsOf = (parentId) => runningSubagentsOf(app, parentId);
    // Background jobs keep the statusline honest while the agent is idle:
    // every visible-set change re-reads the active session's live jobs and
    // re-arms the spinner; a settled job notices its label when it belongs
    // to the active session.
    const jobs = app.svc('jobs');
    if (typeof jobs?.onJobsChanged === 'function') {
        app.hostDisposers.push(jobs.onJobsChanged(() => {
            app.refreshBgJobs();
            app.ensureSpinner();
            app.updateStatusline();
        }));
    }
    if (typeof jobs?.onJobDone === 'function') {
        app.hostDisposers.push(jobs.onJobDone((snap, owner) => {
            app.refreshBgJobs();
            app.ensureSpinner();
            app.updateStatusline();
            const sid = owner?.session?.id;
            if (sid !== undefined && sid === app.activeId) {
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
}
