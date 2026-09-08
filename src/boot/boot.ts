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
import { spawnNvim, connectNvim } from '../kernel/bridge.js'
import { EXT_API_VERSION, announceReady, handleDshExtRequest } from '../ext-api/index.js'
import { installLifecycle } from '../kernel/lifecycle.js'
import { installHeadless } from '../kernel/headless.js'
import { dispatchNvimNotification, registerNvimNotification } from '../kernel/rpc.js'
import { wireHostEvents } from '../kernel/host-events.js'
import { makeSessionEventHandler } from './session-events.js'
import { resumeOrCreate } from '../sessions/index.js'
import { drainPendingInput } from '../commands/index.js'
import { restoreGlance } from '../statusline/commands/glance.js'
import type { AppSlices, WritableSlice } from '../kernel/app.js'
import type { App } from '../kernel/app.js'
const W = (d: AppSlices['runtime']) => d as WritableSlice<AppSlices['runtime']>

/** Synchronous runtime-domain defaults — MUST run before every other
 *  install: install bodies push disposers into runtime.hostDisposers
 *  (statusline/commands/…), so the domain needs its shape from t=0.
 *  Also registers the runtime-owned notifications (quit / reasoning). */
export function installRuntime(app: App): void {
  const R = app.slices.runtime as WritableSlice<AppSlices['runtime']>
  R.setChatWin = (id) => { R.chatWinId = id }
  R.setReasoning = (open, win) => { R.reasoningOpen = open; R.reasoningWinId = win }
  R.spinnerSet = (timer) => { R.spinnerTimer = timer }
  R.spinnerStep = (mod) => { R.spinnerIndex = (R.spinnerIndex + 1) % mod }
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
    idleRefreshTimer: null,
    boot: async () => {},
  })
  registerNvimNotification('dsh-quit', '退出', (app) => app.quit(0))
  registerNvimNotification('dsh-reasoning-toggled', '思考面板', async (app, args) => {
    W(app.slices.runtime).reasoningOpen = args?.[0] === true
    if (app.slices.runtime.reasoningOpen) {
      const ids = await app.luaCall('return require("dsh_tui").ids()', []).catch(() => null)
      W(app.slices.runtime).reasoningWinId = ids?.reasoningWin ?? null
    }
  })
}

export async function boot(app: App): Promise<void> {
  // 1) Lifecycle services (moved out of createApp, I1) — injected
  //    SYNCHRONOUSLY before any await: quit/teardown/exitDiag must be
  //    live for host disposers and signals even during startup.
  installLifecycle(app)
  // Headless e2e plumbing: installed up-front so the session/event wiring
  // below can reference dumpAndQuit before any event lands (the old order
  // declared it after the wiring — a TDZ landmine).
  const headlessCtl = installHeadless(app)

  try {
    const spawned = await spawnNvim({
      extraArgs: app.headless ? ['--headless'] : [],
      isolateXdg: app.headless, // sandbox/CI: private XDG dirs for the child
      loadUserConfig: app.config.loadUserConfig !== false &&
        process.env.DSH_NVIM_TUI_LOAD_USER_CONFIG !== '0',
      onExit: (code, signal) => {
        // A child exit we initiated (teardown/:qa!) must not re-trigger
        // quit(); only a spontaneous nvim death closes the UI.
        app.exitDiag('nvim-exit', `code=${code}`, `signal=${signal}`, `disposed=${app.slices.runtime.disposed}`)
        if (!app.slices.runtime.disposed) void app.quit(0)
      },
    })
    W(app.slices.runtime).child = spawned.child

    // nvim now owns the terminal; keep our own process silent so DSH
    // logging cannot corrupt the TUI.
    const silent = () => {}
    console.log = silent
    console.warn = silent
    console.error = silent

    const nvim = await connectNvim(spawned.sockPath)
    W(app.slices.runtime).nvim = nvim
    const channelId = await nvim.channelId
    W(app.slices.runtime).channelIdValue = channelId
    await app.luaCall('require("dsh_tui").attach(...)', [channelId])
    // Extension handshake: agree on the API major version (a mismatch
    // surfaces as a boot notice).
    void app.luaCall('require("dsh_tui.api").handshake(...)', [EXT_API_VERSION])
      .then((res: unknown) => {
        const r = res as { ok?: unknown; error?: unknown } | null | undefined
        if (r !== null && r !== undefined && typeof r === 'object' && r.ok === false) {
          app.notice(`⚠ ${String(r.error ?? '扩展接口握手失败')}`)
        }
      })
      .catch((err: unknown) => app.notice(`⚠ 扩展接口握手失败: ${(err as Error).message}`))
    // /glance visibility set persists across restarts via vim.g.
    void app.luaCall('return vim.g.dsh_tui_glance', [])
      .then((saved: unknown) => restoreGlance(saved))
      .catch(() => {})

    // Slash-command catalog for the completion menu (name + description);
    // nvim shows it as soon as the input starts with '/'.
    await app.luaCall('require("dsh_tui").set_commands(...)', [app.commandCatalog()]).catch(() => {})
    void app.refreshCommandCatalog()
    // Theme overrides from the runner config (profile cordis.patch.yml).
    if (app.config.theme !== undefined && app.config.theme !== null && typeof app.config.theme === 'object') {
      await app.luaCall('require("dsh_tui").apply_theme(...)', [app.config.theme]).catch(() => {})
    }

    // 2) wiring — three thin loops, all behavior lives in owner modules.
    app.slices.runtime.nvim!.on('disconnect', () => {
      // A teardown-initiated socket EOF must not re-trigger quit: the runner
      // row can be reloaded (hmr) while dsh keeps running.
      if (!app.slices.runtime.disposed) void app.quit(0)
    })
    // dsh-ext bus: nvim plugins issue vim.rpcrequest(channel, 'dsh-ext', …)
    // and the runner answers from the extId dispatch table (luaExt.on).
    // Handler + bounded-response semantics live in ext-api.ts.
    app.slices.runtime.nvim!.on('request', (method: string, args: unknown[], resp: { send: (r: unknown) => void }) => {
      handleDshExtRequest(app, method, args, resp)
    })
    // nvim notifications: one guarded table lookup — the old 22-branch
    // if-else chain is gone; each `dsh-*` method is registered by its
    // owner module at install time (rpc.ts).
    app.slices.runtime.nvim!.on('notification', (method: string, args: unknown[]) => {
      if (app.slices.runtime.disposed) return
      void dispatchNvimNotification(app, method, args)
    })
    // Host events (agent/status, subagent/*, workflow/*, approval/questions):
    // one loop over the registry (host-events.ts).
    wireHostEvents(app)

    // Session elapsed / stats tick slowly while idle (the spinner interval
    // already covers the running state at 180ms).
    W(app.slices.runtime).idleRefreshTimer = setInterval(() => {
      if (!app.slices.runtime.disposed) {
        app.slices.ui.refreshBgJobs()
        app.slices.ui.ensureSpinner()
        app.slices.ui.updateStatusline()
      }
    }, 30000)

    // Event dispatch: each session's transcript goes to its own feed —
    // the whole pipeline lives in session-events.ts.
    W(app.slices.runtime).feedDisposer = app.runtimeCtx.on('session/event',
      makeSessionEventHandler(app, headlessCtl.dumpAndQuit))

    // 3) boot sequence.
    await resumeOrCreate(app)
    headlessCtl.startWatchdog()
    drainPendingInput(app)
    app.exitDiag('boot-complete', `active=${app.slices.sessions.activeId}`)
    announceReady(app)
    headlessCtl.kick()
  } catch (err: unknown) {
    // After teardown started, in-flight RPC writes can fail with EPIPE —
    // that is the shutdown race, not a product failure.
    if (app.slices.runtime.disposed) return
    app.exitDiag('fatal', err instanceof Error ? (err.stack ?? err.message) : String(err))
    console.error('[dsh-nvim-tui] fatal:', err)
    void app.quit(1)
  }
}
