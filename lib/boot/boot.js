/**
 * dsh_tui boot module — the RUN-PHASE composition root.
 *
 * boot does ONLY four things:
 *   1. install the lifecycle + headless services (synchronously, before any await);
 *   2. spawn nvim, connect the socket, handshake, hand over the command
 *      catalog and theme overrides;
 *   3. run the thin wiring loops: nvim request → ext bus (ext-api),
 *      nvim notification → the rpc table (owner modules registered at
 *      install time), host events → the host-events table, session/event
 *      → the session-events pipeline;
 *   4. run the boot sequence (history resume, watchdog arm, ready announce,
 *      headless kick).
 *
 * Every behavior lives in its owner module (commands / sessions / subagents
 * / transcript / ext-api / statusline) and reaches boot only as a table
 * entry — boot never grows a branch.
 *
 * @module dsh-nvim-tui/boot
 */
import { spawnNvim, connectNvim } from '../kernel/bridge.js';
import { themeMapFor } from '../kernel/theme-presets.js';
import { join } from 'node:path';
import { EXT_API_VERSION, announceReady, handleDshExtRequest } from '../ext-api/index.js';
import { installLifecycle } from '../kernel/lifecycle.js';
import { installHeadless } from '../kernel/headless.js';
import { flushTtyInput, resetTerminalModes } from '../kernel/term.js';
import { dispatchNvimNotification, registerNvimNotification } from '../kernel/rpc.js';
import { wireHostEvents } from '../kernel/host-events.js';
import { makeSessionEventHandler } from './session-events.js';
import { resumeOrCreate } from '../sessions/index.js';
import { drainPendingInput } from '../commands/index.js';
import { restoreGlance } from '../statusline/commands/glance.js';
import { maybeOnboard } from './onboarding.js';
import { tf, t } from '../kernel/i18n.js';
const W = (d) => d;
/** Synchronous runtime-domain defaults — MUST run before every other
 *  install: install bodies push disposers into runtime.hostDisposers
 *  (statusline/commands/…), so the domain needs its shape from t=0.
 *  Also registers the runtime-owned notifications (quit / reasoning). */
export function installRuntime(app) {
    const R = app.slices.runtime;
    R.setChatWin = (id) => { R.chatWinId = id; };
    R.setReasoning = (open, win) => { R.reasoningOpen = open; R.reasoningWinId = win; };
    R.spinnerSet = (timer) => { R.spinnerTimer = timer; };
    R.spinnerStep = (mod) => { R.spinnerIndex = (R.spinnerIndex + 1) % mod; };
    R.setRestartPending = (v) => { R.restartPending = v; };
    Object.assign(app.slices.runtime, {
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
        childExitDuringBoot: null,
        idleRefreshTimer: null,
        restartPending: false,
        boot: async () => { },
    });
    registerNvimNotification('dsh-quit', t('退出'), (app) => app.quit(0));
    registerNvimNotification('dsh-reasoning-toggled', t('思考面板'), async (app, args) => {
        W(app.slices.runtime).reasoningOpen = args?.[0] === true;
        if (app.slices.runtime.reasoningOpen) {
            const ids = await app.luaCall('return require("dsh_tui").ids()', []).catch(() => null);
            W(app.slices.runtime).reasoningWinId = ids?.reasoningWin ?? null;
        }
    });
}
export async function boot(app) {
    // 1) Lifecycle services (moved out of createApp, I1) — injected
    //    SYNCHRONOUSLY before any await: quit/teardown/exitDiag must be
    //    live for host disposers and signals even during startup.
    installLifecycle(app);
    // Headless e2e plumbing: installed up-front so the session/event wiring
    // below can reference dumpAndQuit before any event lands (the old order
    // declared it after the wiring — a TDZ landmine). The watchdog is armed
    // BEFORE the first await: a hung boot (nvim connect / resume replay)
    // must still dump-and-quit in e2e instead of waiting forever.
    const headlessCtl = installHeadless(app);
    headlessCtl.startWatchdog();
    try {
        // Terminal hygiene BEFORE the child claims the tty: a crashed/force-killed
        // previous instance may have left kitty keyboard protocol / alt screen /
        // mouse modes enabled AND its unconsumed query responses queued in the
        // tty input — the next nvim reads those bytes as keystrokes (garbage in
        // the input box, or a wedged startup). Flush the queue, then reset modes.
        flushTtyInput();
        resetTerminalModes();
        // Flipped once connect + attach + listener wiring have all succeeded.
        let wired = false;
        const spawned = await spawnNvim({
            extraArgs: app.headless ? ['--headless'] : [],
            isolateXdg: app.headless, // sandbox/CI: private XDG dirs for the child
            loadUserConfig: app.config.loadUserConfig !== false &&
                process.env.DSH_NVIM_TUI_LOAD_USER_CONFIG !== '0',
            onExit: (code, signal) => {
                // A child exit we initiated (teardown/:qa!) must not re-trigger
                // quit(); only a spontaneous nvim death closes the UI.
                app.exitDiag('nvim-exit', `code=${code}`, `signal=${signal}`, `disposed=${app.slices.runtime.disposed}`);
                if (!app.slices.runtime.disposed) {
                    // BOOT IS NOT DONE YET (connect / preload wait / attach / wiring):
                    // record the exit and let boot's catch exit NON-ZERO. The old test
                    // was `nvim === null`, which stopped being true the moment the
                    // socket connected — an nvim dying during attach then took the
                    // quit(0) path, set `quitting`, and made the catch's quit(1) a
                    // no-op: every such startup failure exited 0 with no message.
                    if (!wired) {
                        W(app.slices.runtime).childExitDuringBoot = { code, signal };
                        return;
                    }
                    void app.quit(0);
                }
            },
        });
        if (app.slices.runtime.disposed)
            return;
        W(app.slices.runtime).child = spawned.child;
        // nvim now owns the terminal; keep our own process silent so DSH
        // logging cannot corrupt the TUI.
        const silent = () => { };
        const originals = { log: console.log, warn: console.warn, error: console.error };
        console.log = silent;
        console.warn = silent;
        console.error = silent;
        // Restore on teardown: the hijack is process-wide and used to outlive the
        // TUI (a runner-row reload left every later host log silently dropped).
        app.slices.runtime.hostDisposers.push(() => {
            console.log = originals.log;
            console.warn = originals.warn;
            console.error = originals.error;
        });
        const nvim = await connectNvim(spawned.sockPath, {
            child: spawned.child,
            stderrLog: join(spawned.dir, 'nvim-stderr.log'),
        });
        if (app.slices.runtime.disposed)
            return;
        W(app.slices.runtime).nvim = nvim;
        // INBOUND WIRING FIRST — before anything can reach back into the runner.
        // `attach` assigns the Lua-side channel and synchronously emits the
        // User DshTuiAttach autocmd; extensions subscribing there call
        // vim.rpcrequest(channel, 'dsh-ext', …) and rpcnotify(...) immediately.
        // With the listeners installed only AFTER attach, those requests had no
        // responder (the Lua side blocked inside attach → deadlock, bounded-reply
        // guarantees never ran) and every early notification was dropped.
        nvim.on('disconnect', () => {
            // A teardown-initiated socket EOF must not re-trigger quit: the runner
            // row can be reloaded (hmr) while dsh keeps running.
            if (!app.slices.runtime.disposed)
                void app.quit(0);
        });
        nvim.on('request', (method, args, resp) => {
            handleDshExtRequest(app, method, args, resp);
        });
        nvim.on('notification', (method, args) => {
            if (app.slices.runtime.disposed)
                return;
            void dispatchNvimNotification(app, method, args);
        });
        const channelId = await nvim.channelId;
        if (app.slices.runtime.disposed)
            return;
        W(app.slices.runtime).channelIdValue = channelId;
        // The --cmd preload (package.preload['dsh_tui'] = …) runs during nvim
        // STARTUP, but the --listen socket accepts and answers RPC BEFORE
        // startup finishes — a fast connect+attach races it and fails with
        // "module 'dsh_tui' not found" (a bare nvim with no chat box; the
        // /restart successor lost this race reliably because its handshake
        // runs warm). Wait, bounded, until the preload is installed.
        for (let i = 0; i < 50; i++) {
            const ready = await app.luaCall('return package.preload["dsh_tui"] ~= nil or package.loaded["dsh_tui"] ~= nil', [])
                .catch(() => false);
            if (ready === true)
                break;
            if (app.slices.runtime.disposed)
                return;
            await app.sleep(100);
        }
        await app.luaCall('require("dsh_tui").attach(...)', [channelId]);
        if (app.slices.runtime.disposed)
            return;
        // Extension handshake: agree on the API major version (a mismatch
        // surfaces as a boot notice).
        void app.luaCall('require("dsh_tui.api").handshake(...)', [EXT_API_VERSION])
            .then((res) => {
            const r = res;
            if (r !== null && r !== undefined && typeof r === 'object' && r.ok === false) {
                app.notice(`⚠ ${String(r.error ?? t('扩展接口握手失败'))}`);
            }
        })
            .catch((err) => app.notice(tf('⚠ 扩展接口握手失败: {0}', [err.message])));
        // /glance visibility set persists across restarts via vim.g.
        void app.luaCall('return vim.g.dsh_tui_glance', [])
            .then((saved) => restoreGlance(saved))
            .catch(() => { });
        // Slash-command catalog for the completion menu (name + description);
        // nvim shows it as soon as the input starts with '/'.
        await app.luaCall('require("dsh_tui").set_commands(...)', [app.commandCatalog()]).catch(() => { });
        void app.refreshCommandCatalog();
        // Theme overrides from the runner config (profile cordis.patch.yml), or
        // the /theme preset chosen in an earlier run (persisted UI preference).
        if (app.config.theme !== undefined && app.config.theme !== null && typeof app.config.theme === 'object') {
            await app.luaCall('require("dsh_tui").apply_theme(...)', [app.config.theme]).catch(() => { });
        }
        else {
            // Restore the /theme preset chosen in an earlier run.
            const saved = app.slices.sessions.uiPref('theme');
            const map = typeof saved === 'string' && saved !== '' ? themeMapFor(saved) : null;
            if (map !== null)
                await app.luaCall('require("dsh_tui").apply_theme(...)', [map]).catch(() => { });
        }
        // 2) wiring — three thin loops, all behavior lives in owner modules.
        // (disconnect / request / notification listeners were installed right
        //  after connect — see the INBOUND WIRING block above.)
        // Host events (agent/status, subagent/*, workflow/*, approval/questions):
        // one loop over the registry (host-events.ts).
        wireHostEvents(app);
        wired = true; // connect + attach + listeners are live: a later nvim death is an ordinary close
        // Session elapsed / stats tick slowly while idle (the spinner interval
        // already covers the running state at 180ms).
        W(app.slices.runtime).idleRefreshTimer = setInterval(() => {
            if (!app.slices.runtime.disposed) {
                app.slices.ui.refreshBgJobs();
                app.slices.ui.ensureSpinner();
                app.slices.ui.updateStatusline();
            }
        }, 30000);
        // Event dispatch: each session's transcript goes to its own feed —
        // the whole pipeline lives in session-events.ts.
        W(app.slices.runtime).feedDisposer = app.runtimeCtx.on('session/event', makeSessionEventHandler(app, headlessCtl.dumpAndQuit));
        // 3) boot sequence.
        await resumeOrCreate(app);
        if (app.slices.runtime.disposed)
            return;
        // First-launch onboarding: missing API key → one-shot guide block.
        await maybeOnboard(app);
        drainPendingInput(app);
        app.exitDiag('boot-complete', `active=${app.slices.sessions.activeId}`);
        announceReady(app);
        headlessCtl.kick();
    }
    catch (err) {
        // After teardown started, in-flight RPC writes can fail with EPIPE —
        // that is the shutdown race, not a product failure.
        if (app.slices.runtime.disposed)
            return;
        const bootExit = app.slices.runtime.childExitDuringBoot;
        app.exitDiag('fatal', err instanceof Error ? (err.stack ?? err.message) : String(err), bootExit !== null ? `nvim exited during boot: code=${bootExit.code} signal=${bootExit.signal}` : '');
        // console.error is hijacked to silent after spawn (the child owns the
        // terminal) — a boot fatal MUST still reach the user/CI: stderr direct.
        process.stderr.write(`[dsh-nvim-tui] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
        if (app.slices.runtime.quitting) {
            // quit(0) already claimed the exit (nvim died mid-boot): quit(1) would
            // be a no-op and CI/wrappers would read the startup failure as success.
            try {
                const child = app.slices.runtime.child;
                if (child !== null && child.exitCode === null && child.signalCode === null)
                    child.kill('SIGKILL');
            }
            catch { }
            process.exit(1);
        }
        void app.quit(1);
    }
}
