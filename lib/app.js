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
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
            registerCommands: () => { }, // real impl injected by installCommands (I1)
            commandCatalog: () => [],
            refreshCommandCatalog: async () => { },
        },
    };
    // Kernel primitives live on the root as REAL properties; everything else
    // is domain state in `slices`.
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
