/** dsh_tui command: /terminal — host-owned persistent PTYs (dsh-terminal).
 *
 * The host API is line-oriented (`startSend({text, submit})`), so the view is a
 * console, not a raw key stream: `<CR>` prompts for one line, `<C-c>` sends
 * SIGINT, `K` kills the session, `q` closes the view while the PTY keeps
 * running. `/terminal shell` opens nvim's native terminal for a local-only
 * full interactive shell (that PTY is intentionally invisible to the model).
 */
import { t, tf } from '../../kernel/i18n.js'
import { promptLine } from '../../kernel/prompt.js'
import { registerNvimNotification } from '../../kernel/rpc.js'
import { activeSessionCwd } from '../../kernel/app.js'
import type { App } from '../../kernel/app.js'
import type { TerminalSessionSnapshotLike } from '../../kernel/types.js'

interface ViewState {
  recId: string
  timer: ReturnType<typeof setInterval>
}

const views = new Map<string, ViewState>()

const recOf = (app: App, id: string) => {
  for (const rec of app.slices.sessions.live.values()) {
    if (rec.id === id) return rec
  }
  return undefined
}

const statusLabel = (snap: TerminalSessionSnapshotLike | undefined): string => {
  if (snap?.status?.kind === 'exited') {
    const code = snap.status.exitCode
    return code === null || code === undefined ? t('已退出') : tf('已退出 ({0})', [String(code)])
  }
  return t('运行中')
}

const stopView = (app: App, id: string, closeLua: boolean): void => {
  const view = views.get(id)
  if (view !== undefined) clearInterval(view.timer)
  views.delete(id)
  if (closeLua) void app.luaCall('require("dsh_tui").terminal_close(...)', [id]).catch(() => {})
}

/** Poll scrollback + status into the nvim console buffer. */
const startPolling = (app: App, recId: string, id: string): void => {
  const svc = app.svc('terminals')
  const rec = recOf(app, recId)
  if (svc?.read === undefined || rec === undefined) return
  const tick = async (): Promise<void> => {
    const current = recOf(app, recId)
    if (current === undefined) { stopView(app, id, true); return }
    try {
      const page = svc.read?.(current.handle.agent, id, { count: 400 })
      if (page === undefined) return
      const snap = svc.list?.(current.handle.agent).find((s) => s.sessionId === id)
      await app.luaCall('require("dsh_tui").terminal_update(...)', [id, page.text, statusLabel(snap)]).catch(() => {
        stopView(app, id, false)
      })
    } catch {
      // The host disposed the session/owner; stop polling rather than logging
      // every 600ms. The view stays readable until the user closes it.
      stopView(app, id, false)
    }
  }
  // Re-attaching must not leave the old poller alive: two timers would fight
  // over the same buffer and leak one per attach.
  const previous = views.get(id)
  if (previous !== undefined) clearInterval(previous.timer)
  const timer = setInterval(() => { void tick() }, 600)
  timer.unref?.()
  views.set(id, { recId, timer })
  void tick()
}

const openConsole = async (
  app: App,
  recId: string,
  snap: TerminalSessionSnapshotLike,
  motd?: string,
): Promise<void> => {
  const label = snap.name !== undefined && snap.name !== '' ? snap.name : snap.type
  const opened = await app.luaCall('require("dsh_tui").terminal_open(...)', [snap.sessionId, label]).catch(() => false)
  if (opened === false) {
    app.notice(t('终端视图打开失败（无法创建 split）'))
    return
  }
  if (typeof motd === 'string' && motd !== '') {
    await app.luaCall('require("dsh_tui").terminal_update(...)', [snap.sessionId, motd, statusLabel(snap)]).catch(() => {})
  }
  startPolling(app, recId, snap.sessionId)
}

const spawnTerminal = async (app: App, recId: string, nameArg: string): Promise<void> => {
  const svc = app.svc('terminals')
  if (svc?.spawn === undefined) {
    app.notice(t('terminal 服务未装配（/deps install 可装配 dsh-terminal + terminal-bash）'))
    return
  }
  const rec = recOf(app, recId)
  if (rec === undefined) { app.notice(t('无活跃会话')); return }
  const backends = svc.listBackends?.() ?? []
  if (backends.length === 0) {
    app.notice(t('没有已注册的终端后端（需要 dsh-terminal-bash；/deps install）'))
    return
  }
  const type = backends.includes('bash') ? 'bash' : backends[0] as string
  const name = nameArg.trim() !== '' ? nameArg.trim() : undefined
  try {
    const snap = await svc.spawn(rec.handle.agent, {
      type,
      ...(name !== undefined ? { name } : {}),
      cwd: activeSessionCwd(app),
    })
    await openConsole(app, rec.id, snap, snap.motd)
    app.notice(tf('已打开终端 {0}（{1}）', [snap.sessionId.slice(-8), type]))
  } catch (err) {
    app.notice(tf('打开终端失败: {0}', [(err as Error).message]))
  }
}

const killTerminal = async (app: App, recId: string, id: string): Promise<void> => {
  const svc = app.svc('terminals')
  const rec = recOf(app, recId)
  if (svc?.kill === undefined || rec === undefined) return
  try {
    await svc.kill(rec.handle.agent, id, 'user /terminal kill')
    stopView(app, id, true)
    app.notice(tf('已关闭终端 {0}', [id.slice(-8)]))
  } catch (err) {
    app.notice(tf('关闭终端失败: {0}', [(err as Error).message]))
  }
}

const chooseSession = async (app: App, recId: string): Promise<TerminalSessionSnapshotLike | undefined> => {
  const svc = app.svc('terminals')
  const rec = recOf(app, recId)
  if (svc?.list === undefined || rec === undefined) return undefined
  const sessions = svc.list(rec.handle.agent)
  if (sessions.length === 0) {
    app.notice(t('本会话没有终端（/terminal new 创建）'))
    return undefined
  }
  const picked = await app.openPicker(t('终端会话'), [
    { label: t('＋ 新建终端'), value: 'new' },
    ...sessions.map((s) => ({
      label: `${s.name ?? s.type} · ${statusLabel(s)} · ${s.sessionId.slice(-8)}`,
      value: s.sessionId,
    })),
  ])
  if (picked === null) return undefined
  if (picked === 'new') { await spawnTerminal(app, recId, ''); return undefined }
  return sessions.find((s) => s.sessionId === picked)
}

export const terminalCommand = async (app: App, a: string | undefined) => {
  const arg = (a ?? '').trim()
  const [sub, ...rest] = arg === '' ? [] : arg.split(/\s+/)
  if (sub === 'shell') {
    await app.luaCall('require("dsh_tui").terminal_native(...)').catch((err: unknown) => {
      app.notice(tf('打开 nvim 终端失败: {0}', [(err as Error).message]))
    })
    return
  }
  const svc = app.svc('terminals')
  if (svc === undefined) {
    app.notice(t('terminal 服务未装配（/deps install 可装配 dsh-terminal + terminal-bash）'))
    return
  }
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (!rec) { app.notice(t('无活跃会话')); return }
  if (sub === 'new') { await spawnTerminal(app, rec.id, rest.join(' ')); return }
  if (sub === 'kill' && rest[0] !== undefined) {
    const sessions = svc.list?.(rec.handle.agent) ?? []
    const hit = sessions.find((s) => s.sessionId === rest[0] || s.sessionId.endsWith(rest[0] as string))
    if (hit === undefined) { app.notice(t('找不到该终端')); return }
    await killTerminal(app, rec.id, hit.sessionId)
    return
  }
  if (sub === 'attach' || sub === '') {
    const snap = await chooseSession(app, rec.id)
    if (snap !== undefined) await openConsole(app, rec.id, snap)
    return
  }
  app.notice(t('用法: /terminal [new [name] | attach | kill <id> | shell]'))
}

export function installTerminalCommand(app: App): void {
  registerNvimNotification('dsh-terminal-input', t('终端输入'), (app, args) => {
    const id = typeof args?.[0] === 'string' ? args[0] : ''
    const view = id === '' ? undefined : views.get(id)
    if (id === '' || view === undefined) return
    const rec = app.slices.sessions.live.get(view.recId)
    if (rec === undefined) return
    void (async () => {
      const text = await promptLine(app, t('终端输入（回车发送）'))
      if (text === null) return
      try {
        const op = app.svc('terminals')?.startSend?.(rec.handle.agent, id, { text, submit: true })
        if (op === undefined) { app.notice(t('该终端不支持发送')); return }
        const result = await op.done
        await app.luaCall('require("dsh_tui").terminal_update(...)', [id, result.viewport, result.waitReason]).catch(() => {})
      } catch (err) {
        app.notice(tf('终端发送失败: {0}', [(err as Error).message]))
      }
    })()
  })
  registerNvimNotification('dsh-terminal-signal', t('终端信号'), (app, args) => {
    const id = typeof args?.[0] === 'string' ? args[0] : ''
    const recId = views.get(id)?.recId
    const rec = recId === undefined ? undefined : app.slices.sessions.live.get(recId)
    if (rec === undefined) return
    void app.svc('terminals')?.signal?.(rec.handle.agent, id, 'SIGINT').catch((err: unknown) => {
      app.notice(tf('发送 SIGINT 失败: {0}', [(err as Error).message]))
    })
  })
  registerNvimNotification('dsh-terminal-kill', t('终端关闭'), (app, args) => {
    const id = typeof args?.[0] === 'string' ? args[0] : ''
    const recId = views.get(id)?.recId
    if (recId !== undefined) void killTerminal(app, recId, id)
  })
  registerNvimNotification('dsh-terminal-close', t('终端视图'), (app, args) => {
    const id = typeof args?.[0] === 'string' ? args[0] : ''
    if (id !== '') stopView(app, id, true)
  })
  app.registerCommands([{
    name: '/terminal',
    desc: t('宿主持久终端（PTY）/ nvim 原生 shell'),
    usage: t('[new [name] | attach | kill <id> | shell]'),
    group: t('会话'),
    args: [{ kind: 'oneof', values: ['new', 'attach', 'kill', 'shell'], hint: t('shell=本地 nvim :terminal') }],
    fn: (a?: string) => terminalCommand(app, a),
  }])
}
