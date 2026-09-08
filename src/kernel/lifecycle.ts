/**
 * dsh_tui lifecycle services: exit diagnostics + UI teardown + explicit quit.
 *
 * Injecting them is the FIRST thing boot does — synchronously before any
 * await — because host disposers and signal handlers can fire during
 * startup and must find a live implementation.
 *
 * @module dsh-nvim-tui/lifecycle
 */
import { appendFileSync } from 'node:fs'
import type { App, AppSlices, WritableSlice } from './app.js'

const W = (d: AppSlices['runtime']) => d as WritableSlice<AppSlices['runtime']>

export function installLifecycle(app: App): void {
  /** Exit-path diagnostics: WHY the UI closed (signal / nvim exit / fatal /
   *  explicit quit) — appended to the errors log, since a spontaneous host
   *  shutdown otherwise leaves no trace at all. */
  app.exitDiag = (kind: string, ...detail: unknown[]) => {
    try {
      appendFileSync(app.errorLogPath,
        `${new Date().toISOString()} 退出诊断: ${kind} ${detail.map((d) => String(d)).join(' ')}\n`)
    } catch {}
  }

  /** Close the nvim window gracefully (`:qa!` over RPC) so it never prints
   *  "Nvim: Caught deadly signal 'SIGTERM'". kill(2) stays as the fallback
   *  for a wedged RPC or an nvim that already went away. The exit listener
   *  is registered BEFORE the qa! — nvim can exit before the RPC roundtrip
   *  ends and the event would otherwise be missed. */
  app.closeNvimWindow = async () => {
    const exited = app.slices.runtime.child === null || app.slices.runtime.child.exitCode !== null || app.slices.runtime.child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => app.slices.runtime.child!.once('exit', resolve))
    try {
      if (app.slices.runtime.nvim !== null) {
        await Promise.race([
          app.slices.runtime.nvim!.command('qa!').catch(() => {}),
          app.sleep(250),
        ])
      }
    } catch {}
    // Give the graceful exit a moment, then force-kill whatever remains
    // (SIGTERM first, SIGKILL escalation for a wedged process).
    await Promise.race([exited, app.sleep(400)])
    try {
      if (app.slices.runtime.child !== null && app.slices.runtime.child.exitCode === null && app.slices.runtime.child.signalCode === null) {
        app.slices.runtime.child.kill()
        setTimeout(() => {
          if (app.slices.runtime.child !== null && app.slices.runtime.child.exitCode === null && app.slices.runtime.child.signalCode === null) {
            try { app.slices.runtime.child.kill('SIGKILL') } catch { /* gone */ }
          }
        }, 800)
      }
    } catch {}
  }

  /** UI teardown only — must NOT exit the process: the runner row can be
   *  reloaded (hmr) while dsh keeps running; the next apply spawns a fresh nvim. */
  app.teardown = async () => {
    if (app.slices.runtime.disposed) return
    W(app.slices.runtime).disposed = true
    try {
      app.slices.runtime.feedDisposer?.()
    } catch {}
    for (const dispose of app.slices.runtime.hostDisposers) {
      try {
        dispose()
      } catch {}
    }
    app.slices.runtime.hostDisposers.length = 0
    if (app.slices.runtime.spinnerTimer !== null) {
      clearInterval(app.slices.runtime.spinnerTimer)
      W(app.slices.runtime).spinnerTimer = null
    }
    if (app.slices.runtime.idleRefreshTimer !== null) {
      clearInterval(app.slices.runtime.idleRefreshTimer)
      W(app.slices.runtime).idleRefreshTimer = null
    }
    // Unblock pending interactions so the host can drain — the QUEUES too,
    // not just the heads (concurrent parent+subagent requests).
    app.slices.agent.drainApprovals('cancelled')
    app.slices.agent.drainQuestions()
    app.slices.agent.settlePicker(null)
    if (app.slices.sessions.activeId !== null) app.slices.sessions.recordState(app.slices.sessions.activeId)
    // Persist every live session before disposing its agent. Bounded: an
    // active turn holds the session's append boundary open, and the flush /
    // handle disposal would wait for LLM retries (minutes). The QUIT path
    // races this; the effect-disposer path lets it drain.
    try {
      for (const session of app.runtimeCtx.sessions.list()) {
        try {
          await app.runtimeCtx.sessions.flush(session)
        } catch {}
      }
    } catch {}
    for (const rec of app.slices.sessions.live.values()) {
      try {
        await rec.handle.dispose()
      } catch (err) {
        console.error('[dsh-nvim-tui] dispose failed:', err)
      }
    }
    app.slices.sessions.live.clear()
    app.slices.sessions.childParent.clear()
    // Extension surface: broadcast teardown (Node subscribers + nvim-side
    // User DshTuiShutdown autocmd) so extensions release windows/handles
    // BEFORE the nvim window closes. The QUIT path already fired both
    // pre-close (the window is gone by the time teardown runs) — skip there.
    try {
      if (!app.slices.runtime.quitting) {
        await app.slices.ext.extNodeCleanup?.()
        app.slices.ext.extFire('tui:teardown', {})
        void app.luaCall('require("dsh_tui.api").emit(...)', ['Shutdown', {}]).catch(() => {})
      }
    } catch {}
    app.slices.ext.extLuaSubs.clear()
    await app.closeNvimWindow()
  }

  /** Explicit quit (user action, nvim exit, fatal error, signals): close the
   *  UI immediately, give graceful persistence a bounded window, then exit —
   *  with a hard fallback in case the launcher's graceful shutdown stalls. */
  app.quit = async (code = 0) => {
    if (app.slices.runtime.quitting) return
    W(app.slices.runtime).quitting = true
    app.exitDiag('quit', `code=${code}`, `disposed=${app.slices.runtime.disposed}`)
    try {
      // Tell nvim-side extensions BEFORE the window closes — the teardown
      // path below runs after ':qa!' and can no longer reach them. Node-side
      // panel/region slots release first (they hold Lua registry entries).
      try {
        await app.slices.ext.extNodeCleanup?.()
        app.slices.ext.extFire('tui:teardown', {})
        void app.luaCall('require("dsh_tui.api").emit(...)', ['Shutdown', {}]).catch(() => {})
      } catch {}
      await app.closeNvimWindow() // the window closes right away, no waiting on the agent
      await Promise.race([app.teardown(), app.sleep(2500)])
      app.requestExit(code)
    } catch (err) {
      app.exitDiag('quit-error', err instanceof Error ? (err.stack ?? err.message) : String(err))
    }
    // Last resort: whatever hangs (in-flight turn, pending flush, loader
    // shutdown) must not survive this timer.
    setTimeout(() => process.exit(code), 2000)
  }
}
