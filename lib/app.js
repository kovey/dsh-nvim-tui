/**
 * dsh_tui App: the shared runner state + service surface on the Node side —
 * the analogue of nvim/lua/dsh_tui/state.lua. EVERY behavior module reads
 * state and services through this ONE object; modules never reach into each
 * other's closures. index.ts composes the modules over it (the analogue of
 * nvim/lua/dsh_tui/init.lua's facade).
 *
 * Composition contract:
 *  - `createApp(ctx, config)` builds the state + core services + no-op slots.
 *  - Each module's `install(app)` fills the slots it owns and registers its
 *    slash commands via `app.slices.agent.registerCommands([...])` (late binding: install
 *    order never matters, runtime calls always see the real implementations).
 *  - `boot(app)` (boot.ts) runs the main body LAST, after every install.
 *
 * @module dsh-nvim-tui/app
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { diffTexts, fileDiffsFromMeta } from './diff.js';
import { t } from './i18n.js';
/** Version + build stamp shown in the boot banner (proof of which code runs). */
export const BUILD_VERSION = '0.3.1';
export const BUILD_STAMP = new Date().toISOString().slice(0, 16).replace('T', ' ');
/** Build the App object. All state and core services live here; module-owned
 *  functions start as no-ops and are installed afterwards. `ctx` is the
 *  cordis plugin context (inject/effect); `runtimeCtx` is the injected
 *  runtime with the agent/session services. */
export function createApp(ctx, runtimeCtx, config) {
    const svc = (name) => runtimeCtx.get(name);
    /** msgpack-RPC boundary: nvim.lua results are structurally unknown. */
    const luaCall = (code, args = []) => {
        return app.slices.runtime.nvim === null ? Promise.reject(new Error('nvim not connected')) :
            app.slices.runtime.nvim.lua(code, args);
    };
    const headless = config.headless === true || process.env.DSH_NVIM_TUI_HEADLESS === '1';
    const watchdogMs = Number(config.watchdogMs ?? process.env.DSH_NVIM_TUI_WATCHDOG_MS ?? 120000);
    const dumpPath = config.dumpPath ?? process.env.DSH_NVIM_TUI_DUMP ??
        `/tmp/dsh-nvim-tui-e2e-${process.pid}.txt`;
    const errorLogPath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'nvim-tui-errors.log');
    const slices = {
        runtime: {
            nvim: null,
            child: null,
            channelIdValue: null,
            disposed: false,
            quitting: false,
            chatWinId: null,
            reasoningOpen: false,
            reasoningWinId: null,
            feedDisposer: null,
            hostDisposers: [],
            spinnerTimer: null,
            spinnerIndex: 0,
            idleRefreshTimer: null,
            boot: async () => { },
        },
        sessions: {
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
        },
        ui: {
            activeFeed: () => undefined,
            feedForSubagent: () => undefined,
            welcomeLines: () => ({ above: [], below: [] }),
            ensureSpinner: () => { },
            updateStatusline: () => { },
            refreshBgJobs: () => { },
            foldEvent: () => { },
            maybePushFileDiff: () => { },
            readFileSnapshot: async () => null,
            pendingFileSnaps: new Map(),
            renderedDiffCalls: new WeakMap(),
            pendingEchoes: new Map(),
        },
        ext: {
            extApi: null, // installExtApi fills it before boot
            extReadyResolve: null,
            extFire: () => { },
            extSessionSubs: [],
            extDispatchSessionEvent: () => { },
            extLuaSubs: new Map(),
            extNodeCleanup: null,
            pendingCardInput: null,
            extNodeHandlers: new Map(),
            extStatusSegments: new Map(),
        },
        trans: {
            sessionEvents: () => [],
            synthesizeToolResult: () => { },
            surfaceReplace: () => { },
            repairOrphanToolCalls: () => 0,
            workflowRuns: new Map(),
        },
        agent: {
            followup: async () => { },
            queueSubagentPrompt: async () => { },
            send: () => { },
            pasteClipboardImage: () => { },
            applyModelSelection: async () => { },
            pickModel: async () => { },
            stopCommand: () => { },
            onInput: () => { },
            onCommand: () => { },
            helpCommand: async () => { },
            restartCommand: () => { },
            openDirPicker: async () => null,
            atQuery: async () => { },
            currentSelection: () => runtimeCtx.agentDefaultModel.currentSelection(),
            commandSpecs: [],
            registerCommands: (specs) => {
                // Duplicate-name protection (internal modules register first, ext
                // commands land later at runtime): the second registrant is skipped
                // with a notice instead of shadowing the first handler.
                for (const s of specs) {
                    if (app.slices.agent.commandSpecs.some((e) => e.name === s.name)) {
                        app.notice(`⚠ 命令 ${s.name} 已注册，忽略重复`);
                        continue;
                    }
                    app.slices.agent.commandSpecs.push(s);
                }
            },
            commandCatalog: () => app.slices.agent.commandSpecs.map(({ name, desc }) => ({ name, desc })),
            refreshCommandCatalog: async () => { },
            pendingInput: [],
            pendingImages: [],
            pendingRename: null,
            pendingQueueEdit: null,
            approvalSettle: null,
            approvalReq: null,
            questionsResolve: null,
            pickerSettle: null,
            dirSettle: null,
            bellOn: true,
            subagentView: null,
            subagentChat: null,
            pendingSubagentFollowup: null,
            openSubagentView: async () => { },
            openSubagentChat: async () => { },
            sendToSubagent: () => { },
        },
    };
    // Kernel primitives live on the root as REAL properties; every other flat
    // member is an accessor pair forwarding into its slice (P0 — modules keep
    // reading/writing `app.xxx` unchanged).
    const app = {
        ctx,
        runtimeCtx,
        config,
        headless,
        watchdogMs,
        dumpPath,
        errorLogPath,
        svc,
        luaCall,
        lua: {
            ensureChat: (id) => luaCall('return require("dsh_tui").ensure_chat(...)', [id]),
            ensureReasoning: (id) => luaCall('return require("dsh_tui").ensure_reasoning(...)', [id]),
            setActive: (id) => luaCall('require("dsh_tui").set_active(...)', [id]),
        },
        requestExit: () => { },
        notice: () => { },
        openPicker: async () => null,
        guard: (label, fn) => async (...args) => {
            try {
                await fn(...args);
            }
            catch (err) {
                const e = err;
                try {
                    appendFileSync(errorLogPath, `${new Date().toISOString()} ${label}: ${e?.stack ?? String(err)}\n`);
                }
                catch { }
                app.notice(`⚠ ${label}失败: ${e?.message ?? String(err)}`);
            }
        },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        exitDiag: () => { },
        quit: async () => { },
        teardown: async () => { },
        closeNvimWindow: async () => { },
        slices,
    };
    // -- process exit plumbing ---------------------------------------------------
    const appExitService = svc('appExit');
    app.requestExit = (code = 0) => {
        if (typeof appExitService === 'function')
            appExitService(code);
        else
            process.exit(code);
    };
    if (headless)
        appendFileSync(`${dumpPath}.applies`, `apply ${new Date().toISOString()}\n`);
    app.slices.ui.activeFeed = () => {
        const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
        return rec?.feed;
    };
    app.notice = (text) => { app.slices.ui.activeFeed()?.appendNotice(text); };
    app.openPicker = (title, items) => new Promise((resolve) => {
        app.slices.agent.pickerSettle = resolve;
        void luaCall('require("dsh_tui").show_picker(...)', [title, items])
            .catch(() => { app.slices.agent.pickerSettle = null; resolve(null); });
    });
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
        const persistence = svc('sessionPersistence');
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
            const projections = svc('sessionProjectionCache') ?? svc('sessionProjections');
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
            app.slices.sessions.historyHeaders = all
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
    /** Read a file as a diff snapshot (null when absent/unreadable/binary/
     *  oversized — those cases render no diff block). */
    app.slices.ui.readFileSnapshot = async (p) => {
        try {
            const abs = resolve(p);
            const st = await stat(abs);
            if (!st.isFile() || st.size > 256 * 1024)
                return null;
            const text = await readFile(abs, 'utf8');
            return text.includes('\0') ? null : text;
        }
        catch {
            return null;
        }
    };
    /** tool/result: render ✎ diff blocks into the feed that rendered the
     *  tool line. Primary source = the tool's official presentationMeta
     *  (`meta.diffs = [{ path, oldText, newText }]` — exact, cwd-immune);
     *  falls back to the pre-call file snapshot for flows the meta misses
     *  (creates, deletes). Also runs during history REPLAYS: the persisted
     *  events carry the same meta, so diff blocks survive restarts. */
    app.slices.ui.maybePushFileDiff = (feed, event, labelPrefix = '') => {
        if (event.type !== 'tool/result')
            return;
        const callId = event.data?.message?.source?.callId;
        // One diff render per tool call per feed: replay loops and live event
        // re-emission must never stack the same ✎ block twice.
        const seenCalls = app.slices.ui.renderedDiffCalls.get(feed) ?? new Set();
        const callKey = typeof callId === 'string' ? callId : '';
        if (callKey !== '' && seenCalls.has(callKey))
            return;
        if (callKey !== '')
            seenCalls.add(callKey);
        app.slices.ui.renderedDiffCalls.set(feed, seenCalls);
        const metaDiffs = fileDiffsFromMeta(event.data?.meta);
        if (metaDiffs !== null) {
            if (callKey !== '')
                app.slices.ui.pendingFileSnaps.delete(callKey);
            for (const d of metaDiffs.slice(0, 4)) {
                const block = diffTexts(d.oldText ?? null, d.newText ?? null);
                if (block.stats.added === 0 && block.stats.removed === 0)
                    continue;
                const action = d.oldText === undefined
                    ? t('新增')
                    : d.newText === undefined
                        ? t('删除')
                        : t('修改');
                feed.pushDiff(`✎ ${labelPrefix}${action} ${d.path} (+${block.stats.added} −${block.stats.removed})`, block.lines);
            }
            return;
        }
        if (typeof callId !== 'string' || callId === '')
            return;
        const snap = app.slices.ui.pendingFileSnaps.get(callId);
        if (snap === undefined)
            return;
        app.slices.ui.pendingFileSnaps.delete(callId);
        void app.slices.ui.readFileSnapshot(snap.display).then((after) => {
            if (app.slices.runtime.disposed)
                return;
            const block = diffTexts(snap.before, after);
            if (block.stats.added === 0 && block.stats.removed === 0)
                return;
            const action = snap.before === null ? t('新增') : after === null ? t('删除') : t('修改');
            feed.pushDiff(`✎ ${labelPrefix}${action} ${snap.display} (+${block.stats.added} −${block.stats.removed})`, block.lines);
        });
    };
    /** Route a subagent lifecycle event to its PARENT session's feed. */
    app.slices.ui.feedForSubagent = (info) => {
        if (!info?.id)
            return undefined;
        const child = runtimeCtx.sessions.get(info.id);
        const parentId = child?.header?.parentSession;
        const rec = parentId !== undefined ? app.slices.sessions.live.get(parentId) : undefined;
        if (rec)
            return rec;
        // Fallback: subagents usually spawn while their parent is the active session.
        return app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
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
        app.slices.sessions.sessionEntries = entries;
    };
    /** Refresh the `/` completion catalog: built-in commands plus skill
     *  entries (the official client's slash trigger merges command and skill
     *  sources; `/skills:<name>` shows the skill detail float). */
    app.slices.agent.refreshCommandCatalog = async () => {
        const entries = app.slices.agent.commandSpecs.map(({ name, desc }) => ({ name, desc }));
        const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
        const skills = svc('skills');
        if (rec !== undefined && skills !== undefined) {
            try {
                const list = await skills.list({ scope: rec.handle.agent });
                for (const sk of list) {
                    entries.push({ name: `/skills:${sk.name}`, desc: String(sk.description ?? '').slice(0, 40) });
                }
            }
            catch { }
        }
        await luaCall('require("dsh_tui").set_commands(...)', [entries]).catch(() => { });
    };
    // -- exit path ----------------------------------------------------------------
    /** Exit-path diagnostics: WHY the UI closed (signal / nvim exit / fatal /
     *  explicit quit) — appended to the errors log, since a spontaneous host
     *  shutdown otherwise leaves no trace at all. */
    app.exitDiag = (kind, ...detail) => {
        try {
            appendFileSync(errorLogPath, `${new Date().toISOString()} 退出诊断: ${kind} ${detail.map((d) => String(d)).join(' ')}\n`);
        }
        catch { }
    };
    /** Close the nvim window gracefully (`:qa!` over RPC) so it never prints
     *  "Nvim: Caught deadly signal 'SIGTERM'". kill(2) stays as the fallback
     *  for a wedged RPC or an nvim that already went away. The exit listener
     *  is registered BEFORE the qa! — nvim can exit before the RPC roundtrip
     *  ends and the event would otherwise be missed. */
    app.closeNvimWindow = async () => {
        const exited = app.slices.runtime.child === null || app.slices.runtime.child.exitCode !== null || app.slices.runtime.child.signalCode !== null
            ? Promise.resolve()
            : new Promise((resolve) => app.slices.runtime.child.once('exit', resolve));
        try {
            if (app.slices.runtime.nvim !== null) {
                await Promise.race([
                    app.slices.runtime.nvim.command('qa!').catch(() => { }),
                    app.sleep(250),
                ]);
            }
        }
        catch { }
        // Give the graceful exit a moment, then force-kill whatever remains.
        await Promise.race([exited, app.sleep(400)]);
        try {
            if (app.slices.runtime.child !== null && app.slices.runtime.child.exitCode === null && app.slices.runtime.child.signalCode === null) {
                app.slices.runtime.child.kill();
            }
        }
        catch { }
    };
    /** UI teardown only — must NOT exit the process: the runner row can be
     *  reloaded (hmr) while dsh keeps running; the next apply spawns a fresh nvim. */
    app.teardown = async () => {
        if (app.slices.runtime.disposed)
            return;
        app.slices.runtime.disposed = true;
        try {
            app.slices.runtime.feedDisposer?.();
        }
        catch { }
        for (const dispose of app.slices.runtime.hostDisposers) {
            try {
                dispose();
            }
            catch { }
        }
        app.slices.runtime.hostDisposers.length = 0;
        if (app.slices.runtime.spinnerTimer !== null) {
            clearInterval(app.slices.runtime.spinnerTimer);
            app.slices.runtime.spinnerTimer = null;
        }
        if (app.slices.runtime.idleRefreshTimer !== null) {
            clearInterval(app.slices.runtime.idleRefreshTimer);
            app.slices.runtime.idleRefreshTimer = null;
        }
        // Unblock pending interactions so the host can drain.
        app.slices.agent.approvalSettle?.('cancelled');
        app.slices.agent.approvalSettle = null;
        if (app.slices.agent.questionsResolve) {
            const r = app.slices.agent.questionsResolve;
            app.slices.agent.questionsResolve = null;
            r.reject(new Error('UI torn down'));
        }
        app.slices.agent.pickerSettle?.(null);
        app.slices.agent.pickerSettle = null;
        if (app.slices.sessions.activeId !== null)
            app.slices.sessions.recordState(app.slices.sessions.activeId);
        // Persist every live session before disposing its agent. Bounded: an
        // active turn holds the session's append boundary open, and the flush /
        // handle disposal would wait for LLM retries (minutes). The QUIT path
        // races this; the effect-disposer path lets it drain.
        try {
            for (const session of runtimeCtx.sessions.list()) {
                try {
                    await runtimeCtx.sessions.flush(session);
                }
                catch { }
            }
        }
        catch { }
        for (const rec of app.slices.sessions.live.values()) {
            try {
                await rec.handle.dispose();
            }
            catch (err) {
                console.error('[dsh-nvim-tui] dispose failed:', err);
            }
        }
        app.slices.sessions.live.clear();
        app.slices.sessions.childParent.clear();
        // Extension surface: broadcast teardown (Node subscribers + nvim-side
        // User DshTuiShutdown autocmd) so extensions release windows/handles
        // BEFORE the nvim window closes. The QUIT path already fired both
        // pre-close (the window is gone by the time teardown runs) — skip there.
        try {
            if (!app.slices.runtime.quitting) {
                await app.slices.ext.extNodeCleanup?.();
                app.slices.ext.extFire('tui:teardown', {});
                void app.luaCall('require("dsh_tui.api").emit(...)', ['Shutdown', {}]).catch(() => { });
            }
        }
        catch { }
        app.slices.ext.extLuaSubs.clear();
        await app.closeNvimWindow();
    };
    /** Explicit quit (user action, nvim exit, fatal error, signals): close the
     *  UI immediately, give graceful persistence a bounded window, then exit —
     *  with a hard fallback in case the launcher's graceful shutdown stalls. */
    app.quit = async (code = 0) => {
        if (app.slices.runtime.quitting)
            return;
        app.slices.runtime.quitting = true;
        app.exitDiag('quit', `code=${code}`, `disposed=${app.slices.runtime.disposed}`);
        try {
            // Tell nvim-side extensions BEFORE the window closes — the teardown
            // path below runs after ':qa!' and can no longer reach them. Node-side
            // panel/region slots release first (they hold Lua registry entries).
            try {
                await app.slices.ext.extNodeCleanup?.();
                app.slices.ext.extFire('tui:teardown', {});
                void app.luaCall('require("dsh_tui.api").emit(...)', ['Shutdown', {}]).catch(() => { });
            }
            catch { }
            await app.closeNvimWindow(); // the window closes right away, no waiting on the agent
            await Promise.race([app.teardown(), app.sleep(2500)]);
            app.requestExit(code);
        }
        catch (err) {
            app.exitDiag('quit-error', err instanceof Error ? (err.stack ?? err.message) : String(err));
        }
        // Last resort: whatever hangs (in-flight turn, pending flush, loader
        // shutdown) must not survive this timer.
        setTimeout(() => process.exit(code), 2000);
    };
    // -- process-level error/signal hooks ------------------------------------------
    // alpha.4 host fail-loud: ANY unhandled rejection/uncaught exception in
    // the process disposes the whole tree and hard-exits (proc.exit(1)) —
    // silently as far as our own logs go. Log it FIRST (sync) so the culprit
    // survives even when the host's fail-loud exit races our teardown.
    const logProcessError = (kind, err) => {
        try {
            appendFileSync(errorLogPath, `${new Date().toISOString()} 进程诊断: ${kind}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
        }
        catch { }
    };
    const onUnhandledRejection = (err) => logProcessError('unhandledRejection', err);
    const onUncaughtException = (err) => logProcessError('uncaughtException', err);
    const onSignal = (sig) => {
        app.exitDiag('signal', sig);
        void app.quit(0);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    process.on('uncaughtException', onUncaughtException);
    ctx.effect(() => {
        process.on('SIGTERM', () => onSignal('SIGTERM'));
        process.on('SIGINT', () => onSignal('SIGINT'));
        process.on('SIGHUP', () => onSignal('SIGHUP'));
        return () => {
            process.off('SIGTERM', () => onSignal('SIGTERM'));
            process.off('SIGINT', () => onSignal('SIGINT'));
            process.off('SIGHUP', () => onSignal('SIGHUP'));
            process.off('unhandledRejection', onUnhandledRejection);
            process.off('uncaughtException', onUncaughtException);
            void app.teardown();
        };
    });
    return app;
}
