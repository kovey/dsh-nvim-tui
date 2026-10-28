import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { t, tf } from './i18n.js';
import { COMMAND_ARGS } from './command-args.js';
/** Version + build stamp shown in the boot banner (proof of which code runs). */
/** The active session's working directory (falls back to the process cwd
 *  when no session is attached) — local-file commands must resolve against
 *  THIS, not process.cwd(): /search can resume a session from another
 *  project directory while the shell cwd stays put. */
export const activeSessionCwd = (app) => {
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    // `/cwd` writes the host workingDirectory service; `session.header.cwd` is
    // the ORIGINAL directory and goes stale after a switch. Prefer the service,
    // then fall back to the header (pre-0.2.1 hosts), then the process cwd.
    const wd = app.svc('workingDirectory');
    if (rec !== undefined && typeof wd?.get === 'function') {
        try {
            const current = wd.get(rec.handle.agent.session);
            if (typeof current === 'string' && current !== '')
                return current;
        }
        catch { /* fall through to the header */ }
    }
    const cwd = rec?.handle?.agent?.session?.header?.cwd;
    return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
};
/** dsh 0.1.5 persistence.list() returns snapshots ({header, revision, …});
 *  pre-0.1.5 hosts returned the header directly. Normalize either shape. */
export const persistedHeader = (item) => {
    if (item === null || item === undefined)
        return null;
    const h = item.header;
    if (h !== null && h !== undefined && typeof h === 'object')
        return h;
    return item;
};
export const BUILD_VERSION = '0.5.1';
export const BUILD_STAMP = new Date().toISOString().slice(0, 16).replace('T', ' ');
/** Build the App object. All state and core services live here; module-owned
 *  functions start as no-ops and are installed afterwards. `ctx` is the
 *  cordis plugin context (inject/effect); `runtimeCtx` is the injected
 *  runtime with the agent/session services. */
/**
 * Merge OFFICIAL registry descriptors into the completion catalog, in place.
 *
 * WHY MERGING (and not a separate list): the input box completes from ONE
 * catalog. Offering official commands through a separate `/commands` command
 * meant you could LIST `/kb` and still not complete it on a leading `/`.
 *
 * Three rules, each asserted:
 *   · a name WE already own is never overwritten — a plugin must not be able to
 *     take over `/sessions` in the menu;
 *   · a descriptor with no `input.hint` contributes NO argument — inventing one
 *     would put a placeholder on screen that nobody declared;
 *   · the official side advertises free-form input as a HINT only, so it maps to
 *     a `free` argument (hinted, never completed) rather than a fabricated
 *     choice list.
 */
export const mergeOfficial = (entries, listed) => {
    const own = new Set(entries.map((e) => e.name));
    let added = 0;
    for (const d of listed) {
        const name = '/' + d.name.replace(/^\//, '');
        if (own.has(name))
            continue;
        const hint = d.input?.hint;
        entries.push({
            name,
            desc: String(d.description ?? '').slice(0, 60),
            ...(hint === undefined || hint === ''
                ? {}
                : { args: [{ kind: 'free', label: hint }] }),
        });
        own.add(name);
        added += 1;
    }
    return added;
};
export function createApp(ctx, runtimeCtx, config) {
    const svc = (name) => runtimeCtx.get(name);
    // dsh 0.1.5 removed the `sessions` service: the live-session store is the
    // agents registry itself (`ctx.agents.get/list` return Agents whose
    // `.session` is the live session). Build the store-shaped adapter HERE —
    // assigning a property onto the cordis context is service-registration
    // semantics and deadlocks inside the inject callback.
    const agentsReg = runtimeCtx.get('agents');
    const liveSessions = {
        get: (id) => {
            const s = agentsReg?.get?.(id)?.session;
            return (s === null || s === undefined ? undefined : s);
        },
        list: () => (agentsReg?.list?.() ?? [])
            .map((a) => a.session)
            .filter((s) => s !== null && s !== undefined),
    };
    /** msgpack-RPC boundary: nvim.lua results are structurally unknown. */
    const luaCall = (code, args = []) => {
        return app.slices.runtime.nvim === null ? Promise.reject(new Error('nvim not connected')) :
            app.slices.runtime.nvim.lua(code, args);
    };
    const headless = config.headless === true || process.env['DSH_NVIM_TUI_HEADLESS'] === '1';
    const watchdogMsRaw = Number(config.watchdogMs ?? process.env['DSH_NVIM_TUI_WATCHDOG_MS'] ?? 120000);
    const watchdogMs = Number.isFinite(watchdogMsRaw) && watchdogMsRaw > 0 ? watchdogMsRaw : 120000;
    const dumpPath = config.dumpPath ?? process.env['DSH_NVIM_TUI_DUMP'] ??
        `/tmp/dsh-nvim-tui-e2e-${process.pid}.txt`;
    const errorLogPath = join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'nvim-tui-errors.log');
    // Domain shells: owners inject their defaults + implementations at
    // install time (I2) — createApp only guarantees the SHAPE, never the
    // state. Installs all run before boot, and kernel code only reads slices
    // lazily at call time.
    const slices = { runtime: {}, sessions: {}, ui: {}, ext: {}, trans: {}, agent: {} };
    // Kernel primitives live on the root as REAL properties; everything else
    // is domain state in `slices`.
    /** The completion catalog shape pushed to Lua. ONE definition: the boot push
     *  and refreshCommandCatalog() used to map this separately, and the refresh
     *  path silently dropped `args` — which killed argument completion right after
     *  boot, because the refresh overwrote the good catalog. */
    const catalogEntries = () => app.commandSpecs.map(({ name, desc, args }) => {
        // A command may declare its grammar inline (it is the author's own
        // contract) OR leave it to the central table, where the whole input
        // language of the TUI is reviewable in one read. Inline wins.
        const grammar = args ?? COMMAND_ARGS[name];
        return {
            name,
            desc: t(desc),
            ...(grammar === undefined ? {} : { args: grammar }),
        };
    });
    const app = {
        ctx,
        runtimeCtx,
        config,
        liveSessions,
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
                app.notice(tf('⚠ {0}失败: {1}', [label, e?.message ?? String(err)]));
            }
        },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        exitDiag: () => { },
        quit: async () => { },
        teardown: async () => { },
        closeNvimWindow: async () => true,
        commandSpecs: [],
        officialCatalogPending: false,
        // Command registry (kernel bootstrap facility: EVERY module registers
        // its specs at install time, so the mechanism must exist from t=0 —
        // the owner-module pattern does not apply to cross-module facilities).
        registerCommands: (specs) => {
            // Duplicate-name protection (internal modules register first, ext
            // commands land later at runtime): the second registrant is skipped
            // with a notice instead of shadowing the first handler. Returns the
            // specs ACTUALLY registered — disposers must only remove their own.
            const accepted = [];
            for (const s of specs) {
                if (app.commandSpecs.some((e) => e.name === s.name)) {
                    app.notice(tf('⚠ 命令 {0} 已注册，忽略重复', [s.name]));
                    continue;
                }
                app.commandSpecs.push(s);
                accepted.push(s);
            }
            return accepted;
        },
        commandCatalog: () => catalogEntries(),
        refreshCommandCatalog: async () => {
            // t() at PUSH time (not at registration): /locale re-pushes the catalog
            // and the descriptions must follow the new locale both ways.
            const entries = catalogEntries();
            const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
            // OFFICIAL registry commands join the SAME catalog (see mergeOfficial).
            const official = svc('commands');
            // Diagnostic: this merge has three ways to contribute NOTHING (service
            // absent, no active agent, empty registry) and all three look identical
            // from the outside — the completion menu simply lacks the commands. Record
            // WHICH one it was, so "why is /kb missing?" is answerable from the log
            // instead of guesswork.
            if (official === undefined || typeof official.list !== 'function') {
                app.exitDiag('catalog-official', 'service=absent');
            }
            else if (rec === undefined) {
                // MEASURED: the boot-time push runs BEFORE the session exists, so this
                // branch is the normal first pass — and skipping it silently meant the
                // official commands never reached the menu at all. Remember that the
                // merge is still owed, and `retryOfficialCatalog` pays it once a session
                // is active.
                app.officialCatalogPending = true;
                app.exitDiag('catalog-official', 'service=ok agent=none (pending)');
            }
            else {
                try {
                    const listed = official.list(rec.handle.agent);
                    const added = mergeOfficial(entries, listed);
                    app.officialCatalogPending = false;
                    app.exitDiag('catalog-official', `service=ok listed=${listed.length} added=${added}`);
                }
                catch (err) {
                    app.exitDiag('catalog-official', `service=ok error=${err.message}`);
                    app.notice(tf('读取官方命令失败: {0}', [err.message]));
                }
            }
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
        },
        retryOfficialCatalog: () => {
            // Only when a previous push actually owed the merge — otherwise every
            // session switch would re-push an unchanged catalog.
            if (!app.officialCatalogPending)
                return;
            void app.refreshCommandCatalog().catch(() => { });
        },
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
    app.slices.ui.activeFeed = () => {
        const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
        return rec?.feed;
    };
    app.notice = (text) => {
        // Startup window: before the first session attaches there is NO feed to
        // render into, and every real failure notice (session-history load,
        // onboarding, profile warnings…) was silently dropped. Buffer them and
        // flush into the first ACTIVE session's feed.
        const feed = app.slices.ui.activeFeed();
        if (feed === undefined) {
            const q = app.slices.ui.pendingNotices;
            q.push(text);
            if (q.length > 20)
                q.shift();
            return;
        }
        feed.appendNotice(text);
    };
    /** Flush notices buffered before any session was active (owner: sessions). */
    app.flushPendingNotices = (feed) => {
        const q = app.slices.ui.pendingNotices;
        if (q.length === 0)
            return;
        for (const t of q.splice(0, q.length))
            feed.appendNotice(t);
    };
    app.openPicker = (title, items) => new Promise((resolve) => {
        // Single-slot semantics: a second picker supersedes the first — settle
        // the previous one as cancelled so its awaiter can never hang forever
        // (the tui_command tool can open two pickers back-to-back).
        if (app.slices.agent.pickerSettle !== null)
            app.slices.agent.settlePicker(null);
        app.slices.agent.setPickerSettle(resolve);
        void luaCall('require("dsh_tui").show_picker(...)', [title, items])
            .catch(() => {
            // Identity-checked failure settle: a STALE picker's failed open
            // must not cancel its successor (pre-review: the unconditional
            // settlePicker(null) settled picker #2 when picker #1's luaCall
            // rejected late — the user's #2 choice was silently discarded).
            if (app.slices.agent.pickerSettle === resolve)
                app.slices.agent.settlePicker(null);
        });
    });
    app.openLivePicker = (title, items) => ({
        pick: app.openPicker(title, items),
        update: (next) => {
            void luaCall('require("dsh_tui").update_picker(...)', [next]).catch(() => { });
        },
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
    // Named handlers: the cleanup below must remove the SAME function identity
    // (an inline arrow would never match → one leaked listener per re-apply).
    const onSigterm = () => onSignal('SIGTERM');
    const onSigint = () => onSignal('SIGINT');
    const onSighup = () => onSignal('SIGHUP');
    ctx.effect(() => {
        process.on('SIGTERM', onSigterm);
        process.on('SIGINT', onSigint);
        process.on('SIGHUP', onSighup);
        return () => {
            process.off('SIGTERM', onSigterm);
            process.off('SIGINT', onSigint);
            process.off('SIGHUP', onSighup);
            process.off('unhandledRejection', onUnhandledRejection);
            process.off('uncaughtException', onUncaughtException);
            void app.teardown();
        };
    });
    return app;
}
