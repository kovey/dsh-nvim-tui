/**
 * dsh_tui sessions module: session lifecycle (create/resume/attach/switch/
 * fork), the empty-state welcome banner, and the session commands (/sessions
 * /workspace /archive /layout /rename /new /clear /fork /branch /btw).
 *
 * @module dsh-nvim-tui/sessions
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appendFileSync } from 'node:fs';
import { t } from '../kernel/i18n.js';
import { encodeHeaderOnlyLog, readCleanedIds, writeCleanedIds } from '../kernel/subagent-clean.js';
import { registerNvimNotification } from '../kernel/rpc.js';
import { attachSession, createSession, resumeSession, switchTo, selectSession, forkSession, welcomeLines, updateTitle, } from './services.js';
import { installSessionsCommand } from './commands/sessions.js';
import { installWorkspaceCommand } from './commands/workspace.js';
import { installArchiveCommand } from './commands/archive.js';
import { installNewCommand } from './commands/new.js';
import { installClearCommand } from './commands/clear.js';
import { installForkCommand } from './commands/fork.js';
import { installBranchCommand } from './commands/branch.js';
import { installBtwCommand } from './commands/btw.js';
import { installRenameCommand } from './commands/rename.js';
import { installLayoutCommand } from './commands/layout.js';
const WSS = (d) => d;
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
    if (!truncated)
        return false;
    {
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
    // -- the 10 slash commands, one file each (self-registering) --
    installSessionsCommand(app);
    installWorkspaceCommand(app);
    installArchiveCommand(app);
    installNewCommand(app);
    installClearCommand(app);
    installForkCommand(app);
    installBranchCommand(app);
    installBtwCommand(app);
    installRenameCommand(app);
    installLayoutCommand(app);
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
        // Archived sessions stay archived: auto-resume must not resurrect them.
        const wsSvc = app.svc('workspaceRegistry');
        const archived = new Set(wsSvc?.archivedSessionIds ?? []);
        const candidates = app.slices.sessions.historyHeaders.filter((h) => !archived.has(h.id));
        const newest = [...candidates]
            .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]?.id;
        const target = (fromState !== null && !archived.has(fromState) ? fromState : null) ?? newest;
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
