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
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { flushTtyInput, resetTerminalModes } from './term.js'
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
   *  ends and the event would otherwise be missed. RETURNS ONLY AFTER the
   *  child is actually dead: the /restart successor must never spawn while
   *  the old nvim still owns the terminal (a wedged nvim dies by SIGKILL
   *  with NO tui cleanup — the caller's reset sequences must be the LAST
   *  thing that touches the tty before the successor's nvim starts). */
  app.closeNvimWindow = async (): Promise<boolean> => {
    const child = app.slices.runtime.child
    const alive = (): boolean =>
      child !== null && child.exitCode === null && child.signalCode === null
    const exited = child === null || !alive()
      ? Promise.resolve()
      : new Promise((resolve) => child!.once('exit', resolve))
    try {
      if (app.slices.runtime.nvim !== null) {
        await Promise.race([
          app.slices.runtime.nvim!.command('qa!').catch(() => {}),
          app.sleep(250),
        ])
      }
    } catch {}
    // Graceful window, then escalating kills — each step AWAITS the exit
    // event (bounded) so callers never race a still-dying child.
    await Promise.race([exited, app.sleep(400)])
    if (!alive()) return true
    try { child!.kill() } catch { /* gone */ }
    await Promise.race([exited, app.sleep(800)])
    if (!alive()) return true
    try { child!.kill('SIGKILL') } catch { /* gone */ }
    await Promise.race([exited, app.sleep(500)])
    // TERMINAL assertion: SIGKILL can still be pending (uninterruptible D
    // state, load spikes). The /restart successor must never negotiate the
    // tty while a live nvim still owns it — report the failure to the caller
    // instead of silently pretending the child is gone.
    if (alive()) {
      app.exitDiag('close-timeout', `pid=${String(child?.pid ?? '?')} still alive after SIGKILL`)
      return false
    }
    return true
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
    // Persist every live session before disposing its agents. Bounded: an
    // active turn holds the session's append boundary open, and the flush /
    // handle disposal would wait for LLM retries (minutes). The QUIT path
    // races this; the effect-disposer path lets it drain.
    try {
      // pre-0.1.5: the `sessions` service carried a per-session flush;
      // 0.1.5: service-wide sessionPersistence.flush() (handle dispose
      // drains durably below). `get('sessions')` throws on 0.1.5 (service
      // removed) — the catch falls through to the service-level flush.
      // Every step is OBSERVABLE now: a swallowed failure used to look
      // exactly like success (the old code set `flushed = true` even when
      // every single flush rejected) and left no diagnostic at all.
      let allFlushed = true
      let anyFlushed = false
      try {
        const legacyStore = app.runtimeCtx.get('sessions') as unknown as { flush?: (s: unknown) => Promise<unknown> } | undefined
        if (typeof legacyStore?.flush === 'function') {
          anyFlushed = true
          for (const session of app.liveSessions.list()) {
            try {
              await legacyStore.flush.call(legacyStore, session)
            } catch (err) {
              allFlushed = false
              app.exitDiag('session-flush-failed', (err as Error).message)
            }
          }
        }
      } catch {}
      if (!anyFlushed || !allFlushed) {
        // Service-level fallback — called ON the service object (detaching
        // `flush` loses `this`, and dsh services are class instances).
        const persistence = app.svc('sessionPersistence') as unknown as { flush?: () => Promise<unknown> } | undefined
        if (typeof persistence?.flush === 'function') {
          try {
            await persistence.flush()
          } catch (err) {
            app.exitDiag('session-flush-service-failed', (err as Error).message)
          }
        } else if (!anyFlushed) {
          app.exitDiag('session-flush-unavailable')
        }
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
    // Last resort: whatever hangs (in-flight turn, pending flush, loader
    // shutdown) must not survive this timer. The budget must cover the FULL
    // cleanup it backstops — closeNvimWindow's worst case (~1950ms) PLUS the
    // 2500ms teardown race — otherwise the hard exit truncates the very
    // session flush it exists to protect (the old 2000ms fired first every
    // time on the non-restart path).
    const hardMs = app.slices.runtime.restartPending ? 9000 : 5000
    const hardExit = (): void => {
      const child = app.slices.runtime.child
      if (child !== null && child.exitCode === null && child.signalCode === null) {
        // Never leave an orphan nvim holding the tty.
        app.exitDiag('hard-exit-orphan', `pid=${String(child.pid ?? '?')}`)
        try { child.kill('SIGKILL') } catch {}
      }
      process.exit(code)
    }
    let hard = setTimeout(hardExit, hardMs)
    try {
      // Tell nvim-side extensions BEFORE the window closes — the teardown
      // path below runs after ':qa!' and can no longer reach them. Node-side
      // panel/region slots release first (they hold Lua registry entries).
      try {
        await app.slices.ext.extNodeCleanup?.()
        app.slices.ext.extFire('tui:teardown', {})
        void app.luaCall('require("dsh_tui.api").emit(...)', ['Shutdown', {}]).catch(() => {})
      } catch {}
      const closed = await app.closeNvimWindow() // window closes right away, no waiting on the agent
      await Promise.race([app.teardown(), app.sleep(2500)])
      // /restart: spawn the successor ONLY NOW — the old nvim has fully
      // exited (its tui restored the alternate screen and disabled the
      // kitty keyboard protocol) and teardown flushed the session logs.
      // Spawning earlier let the old instance's terminal cleanup clobber
      // the new instance's tui negotiation: the input box filled with
      // literal kitty-protocol sequences ("[108;1:3u" garbage) and the
      // frame/hint bar broke.
      if (app.slices.runtime.restartPending && closed !== true) {
        // The old nvim survived SIGKILL: spawning the successor now would put
        // two nvims on one tty (the exact kitty-protocol garbage regression
        // the spawn ordering exists to prevent). Cancel the restart loudly.
        W(app.slices.runtime).restartPending = false
        app.exitDiag('restart-cancelled-close-timeout')
        try {
          process.stderr.write('[dsh-nvim-tui] 重启已取消：旧 nvim 未能退出（SIGKILL 后仍在运行）— 请手动重新运行 dsh\n')
        } catch {}
      }
      if (app.slices.runtime.restartPending) {
        W(app.slices.runtime).restartPending = false
        clearTimeout(hard)
        try {
          // Flush leftover tty input + reset the terminal modes before the
          // successor's nvim negotiates (belt and braces over the boot-time
          // hygiene: the OLD nvim may have died by SIGKILL with unconsumed
          // query responses still queued and no tui shutdown sequences).
          flushTtyInput()
          resetTerminalModes()
          // The successor runs in its OWN session (setsid via python3):
          // immune to the shell's job-control signals (SIGHUP to the job
          // group when the old leader dies, orphaned-group handling). THIS
          // process does NOT exit — it stays alive as the shell's foreground
          // job holder, so the shell keeps waiting and never reclaims the
          // terminal (no prompt, no input race). It exits only when the
          // successor's whole tree has exited.
          // setsid keeps the successor out of the dying job group; it needs
          // python3. A host without python3 must NOT lose the restart — fall
          // back to a direct exec (no setsid) instead of `sh` exiting 127,
          // which used to be logged as a SUCCESSFUL restart with no successor.
          const hasPython3 = ((): boolean => {
            try {
              return spawnSync('python3', ['-c', 'pass'], { stdio: 'ignore', timeout: 3000 }).status === 0
            } catch { return false }
          })()
          const shCmd: string = hasPython3
            ? 'sleep 2; exec python3 -c "import os,sys; os.setsid(); os.execv(sys.argv[1], sys.argv[1:])" "$@"'
            : 'sleep 2; exec "$@"'
          if (!hasPython3) app.exitDiag('restart-no-python3', 'falling back to a direct exec (no setsid)')
          const argv0 = process.argv[0] ?? process.execPath
          const next: ChildProcess = spawn('/bin/sh',
            ['-c', shCmd, 'sh', argv0, ...process.argv.slice(1)],
            { stdio: 'inherit' })
          app.exitDiag('restart-spawned')
          await new Promise<void>((resolve) => {
            let done = false
            const fin = (): void => { if (!done) { done = true; resolve() } }
            next.once('exit', (code2: number | null, signal2: NodeJS.Signals | null) => {
              if (code2 !== 0 || signal2 !== null) {
                // The successor tree failed BEFORE taking over (127 = missing
                // interpreter, a config crash, a signal). Say so on the real
                // stderr — console.* is silenced from boot on.
                app.exitDiag('restart-successor-failed', `code=${code2}`, `signal=${signal2}`)
                try {
                  process.stderr.write(`[dsh-nvim-tui] 重启失败：后继进程退出 code=${code2}${signal2 ? ` signal=${signal2}` : ''} — 请手动重新运行 dsh\n`)
                } catch {}
              }
              fin()
            })
            next.once('error', (err: unknown) => {
              app.exitDiag('restart-spawn-error', String(err))
              try { process.stderr.write(`[dsh-nvim-tui] 重启失败：无法启动后继进程 (${String(err)})\n`) } catch {}
              fin()
            })
          })
          app.exitDiag('restart-successor-exited')
          app.requestExit(code)
          // Fallback if the host's own shutdown stalls: the successor tree
          // is already gone (we waited for its exit), so a hard exit here
          // is safe — the shell just gets its prompt back.
          hard = setTimeout(hardExit, 2000)
          return
        } catch (err) {
          app.exitDiag('restart-spawn-failed', err instanceof Error ? (err.stack ?? err.message) : String(err))
        }
        hard = setTimeout(hardExit, 2000)
      }
      app.requestExit(code)
    } catch (err) {
      app.exitDiag('quit-error', err instanceof Error ? (err.stack ?? err.message) : String(err))
    }
  }
}
