/**
 * dsh-nvim-tui extension API — the PUBLIC service surface this bundle
 * exports to other dsh plugins via `ctx.provide('nvim-tui', …)`.
 *
 * P0 scope: service mount + readiness lifecycle (ready/teardown), the
 * whitelisted nvim execution layer (request / call / lua / ex), TUI-scoped
 * event subscriptions, and the active-session / input plumbing. UI
 * primitives (card/float/picker/notice/statuslineSegment), the ext RPC bus
 * and Lua-side hooks land in later phases.
 *
 * Fault isolation: every consumer callback is guarded — a throwing
 * subscriber surfaces as a feed notice + error-log line and never breaks
 * the TUI event loop. All nvim calls funnel through the SINGLE shared
 * channel (serialized by design); consumers must not hold it with long
 * blocking work.
 *
 * @module dsh-nvim-tui/ext-api
 */
import type { SessionEvent } from './types.js'
import type { App } from './app.js'

/** Extension API version (semver, independent of the bundle version). */
export const EXT_API_VERSION = '0.1.0'

/** Nvim execution layer: the whitelisted raw editor surface. */
export interface ExtNvimLayer {
  /** nvim_* API request (msgpack-RPC). Optional timeout rejects instead of
   *  wedging the caller — nvim keeps executing, so calls must be
   *  idempotence-safe. */
  request(method: string, args?: unknown[], opts?: { timeoutMs?: number }): Promise<unknown>
  /** vim.fn call. */
  call(fn: string, args?: unknown[]): Promise<unknown>
  /** Arbitrary Lua evaluation (escape hatch; prefer the typed layers). */
  lua(code: string, args?: unknown[]): Promise<unknown>
  /** vim.cmd execution. */
  ex(cmd: string): Promise<void>
}

/** Subscription filter for onSessionEvent. */
export interface ExtSessionEventFilter {
  /** Event type(s) of interest; omitted = every type. */
  type?: string | string[]
  /** Restrict to one session; omitted = every session. */
  sessionId?: string
}

/** Pure filter match (exported for unit tests). */
export function matchSessionEventFilter(
  filter: ExtSessionEventFilter,
  sessionId: string,
  eventType: string,
): boolean {
  if (filter.sessionId !== undefined && filter.sessionId !== sessionId) return false
  if (filter.type === undefined) return true
  const kinds = Array.isArray(filter.type) ? filter.type : [filter.type]
  return kinds.includes(eventType)
}

/** TUI lifecycle / user-intent events. */
export type ExtEventName =
  | 'tui:ready'          // boot complete, first session attached
  | 'tui:active-session' // the active session switched (payload: { id })
  | 'tui:input'          // user submitted chat input (payload: { text })
  | 'tui:teardown'       // the TUI is shutting down (payload: {})

/** ui.card options. */
export interface ExtCardOpts {
  /** Render into this session's feed; omitted = the active session. */
  sessionId?: string
  /** Extension name shown in the card header. */
  plugin: string
  title: string
  body: string
  /** Action hints rendered as a footer row (informational in v1). */
  actions?: Array<{ label: string; value: string }>
  /** Auto-dismiss after this many milliseconds. */
  ttlMs?: number
}

/** Handle for a rendered card (update/dismiss in place). */
export interface ExtCardHandle {
  id: string
  update(next: { title?: string; body?: string; actions?: Array<{ label: string; value: string }> }): void
  dismiss(): void
}

/** ui.float options. */
export interface ExtFloatOpts {
  lines: string[]
  title?: string
  relative?: 'editor' | 'cursor'
  width?: number
  height?: number
  row?: number
  col?: number
}

/** Opened float: window/buffer handles (write content via api.nvim). */
export interface ExtFloatResult {
  id: string
  win: number
  buf: number
}

/** ui.picker options. */
export interface ExtPickerOpts {
  title: string
  items: Array<{ label: string; value: string; active?: boolean }>
}

/** ui.panel options (the right-edge panel slot). */
export interface ExtPanelOpts {
  side?: 'right'
  width?: number
  title?: string
  /** Hints embedded in the bottom border (nvim >= 0.10). */
  footer?: string
  /** Initial content lines. */
  lines?: string[]
}

/** Claimed panel: write content via api.nvim into `buf`. */
export interface ExtPanelHandles {
  win: number
  buf: number
}

/** Extension slash command (name WITHOUT the leading '/'). */
export interface ExtCommandSpec {
  name: string
  desc: string
  usage?: string
  group?: string
  fn: (arg: string) => unknown
}

/** The ext RPC bus face: drive / answer nvim-side extensions by extId. */
export interface ExtLuaLayer {
  /** Call a method registered by a Lua extension (api.rpc_register).
   *  Rejects with the remote error message when the handler fails. */
  call(extId: string, method: string, args?: unknown[]): Promise<unknown>
  /** Fire an event at a Lua extension (User DshTuiExtEvent +
   *  api.on_ext_event callbacks). */
  emit(extId: string, event: string, payload?: unknown): void
  /** Answer dsh-ext requests from a nvim extension (vim.rpcrequest).
   *  Returns a disposer. */
  on(extId: string, handler: (method: string, args: unknown[]) => unknown | Promise<unknown>): () => void
}

/** Managed UI primitives (headless degrades to no-ops where flagged). */
export interface ExtUiLayer {
  /** Render a plugin card into a session feed. */
  card(opts: ExtCardOpts): ExtCardHandle
  /** Open a managed floating window (ownership-registered). */
  float(opts: ExtFloatOpts): Promise<ExtFloatResult>
  /** Close a float opened via ui.float. */
  floatClose(id: string): Promise<void>
  /** Reuse the TUI picker float; resolves null on cancel. */
  picker(opts: ExtPickerOpts): Promise<string | null>
  /** Transient notice in the feed (one line). */
  notice(text: unknown): void
  /** Add/update a statusline segment ('' removes it). */
  statuslineSegment(id: string, text: string, priority?: number): void
  /** Claim the right-edge panel slot (null when unavailable/headless). */
  panel(opts: ExtPanelOpts): Promise<ExtPanelHandles | null>
  /** Release the panel slot claimed via ui.panel. */
  panelRelease(): Promise<void>
}

/** The stable public surface. Consume via `ctx.get('nvim-tui')`. */
export interface TuiExtApi {
  /** Extension API version (semver). */
  version: string
  /** Resolves when boot completes (nvim connected, first session attached).
   *  Queued calls before that are safe: nvim-layer calls reject until the
   *  channel exists. */
  ready: Promise<void>
  /** Feature flags (headless degrades UI primitives to no-ops). */
  capabilities(): Record<string, boolean>

  /** Raw nvim execution layer. */
  nvim: ExtNvimLayer

  /** TUI lifecycle / intent events. Returns a disposer. */
  on(event: ExtEventName, cb: (payload: unknown) => void): () => void
  /** Mirrored session/event subscription (live events + history replays).
   *  Returns a disposer. */
  onSessionEvent(filter: ExtSessionEventFilter, cb: (sessionId: string, ev: SessionEvent) => void): () => void

  /** The active session id (null before boot). */
  getActiveSessionId(): string | null
  /** Submit text as a chat message to the active session (input-box path). */
  submit(text: string): void
  /** Fill the input box without submitting. */
  insertInput(text: string): void

  /** Managed UI primitives. */
  ui: ExtUiLayer
  /** Register slash commands (name WITHOUT '/') into the completion
   *  catalog + /help. Duplicate names are rejected. Returns a disposer. */
  registerCommands(cmds: ExtCommandSpec[]): () => void
  /** The ext RPC bus: talk to nvim-side extensions by extId. */
  luaExt: ExtLuaLayer
}

/** Install the extension API onto the App (runs before boot; index.ts then
 *  publishes the built surface through the cordis registry). */
export function installExtApi(app: App): void {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const sessionSubs: Array<{
    filter: ExtSessionEventFilter
    cb: (sid: string, ev: SessionEvent) => void
  }> = []
  /** Node-side floats opened via ui.float: key → win id. */
  const nodeFloats = new Map<string, number>()
  let floatSeq = 0

  /** Fire a tui:* event; subscriber throws are contained (feed notice). */
  const fire = (event: ExtEventName, payload: unknown): void => {
    const set = listeners.get(event)
    if (set === undefined || set.size === 0) return
    for (const cb of [...set]) {
      try {
        cb(payload)
      } catch (err) {
        app.notice(`⚠ 扩展事件 ${event} 处理失败: ${(err as Error).message}`)
      }
    }
  }

  const nvimLayer: ExtNvimLayer = {
    request: (method, args = [], opts) => {
      if (app.nvim === null) return Promise.reject(new Error('nvim not connected'))
      const p = app.nvim.request(method, args as never[]) as Promise<unknown>
      if (opts?.timeoutMs === undefined) return p
      return Promise.race([
        p,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`nvim.request ${method} 超时`)), opts.timeoutMs)),
      ])
    },
    call: (fn, args = []) => {
      if (app.nvim === null) return Promise.reject(new Error('nvim not connected'))
      return app.nvim.call(fn, args as never[]) as Promise<unknown>
    },
    lua: (code, args = []) => app.luaCall(code, args),
    ex: async (cmd) => {
      if (app.nvim === null) throw new Error('nvim not connected')
      await app.nvim.command(cmd)
    },
  }

  const api: TuiExtApi = {
    version: EXT_API_VERSION,
    ready: new Promise<void>((resolve) => {
      app.extReadyResolve = resolve
    }),
    capabilities: () => ({
      headless: app.headless,
      card: !app.headless,
      float: !app.headless,
      picker: !app.headless,
      panel: !app.headless,
      rpc: true,
    }),
    nvim: nvimLayer,
    on: (event, cb) => {
      let set = listeners.get(event)
      if (set === undefined) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(cb)
      return () => {
        set.delete(cb)
      }
    },
    onSessionEvent: (filter, cb) => {
      const entry = { filter, cb }
      sessionSubs.push(entry)
      return () => {
        const i = sessionSubs.indexOf(entry)
        if (i >= 0) sessionSubs.splice(i, 1)
      }
    },
    getActiveSessionId: () => app.activeId,
    submit: (text) => app.send(text),
    insertInput: (text) => {
      void app.luaCall('require("dsh_tui").fill_input(...)', [text]).catch(() => {})
    },

    ui: {
      card: (opts) => {
        const feed = (opts.sessionId !== undefined
          ? app.sessions.get(opts.sessionId)?.feed
          : undefined) ?? app.activeFeed()
        if (feed === undefined) {
          // No feed yet (pre-boot) / headless without a session: an inert
          // handle so callers never null-check.
          const inert: ExtCardHandle = {
            id: `ext-${opts.plugin}-dropped`,
            update: () => {},
            dismiss: () => {},
          }
          return inert
        }
        const handle = feed.pushExtCard({
          plugin: opts.plugin,
          title: opts.title,
          body: opts.body,
          actions: opts.actions,
        })
        if (opts.ttlMs !== undefined && opts.ttlMs > 0) {
          setTimeout(() => handle.dismiss(), opts.ttlMs)
        }
        return handle
      },
      float: async (opts) => {
        if (app.nvim === null) throw new Error('nvim not connected')
        const id = `f${++floatSeq}`
        const res = await app.luaCall('return require("dsh_tui.api").float_open(...)', [
          '__node__', { lines: opts.lines, title: opts.title, relative: opts.relative,
            width: opts.width, height: opts.height, row: opts.row, col: opts.col },
        ]) as { win?: unknown; buf?: unknown; err?: unknown } | null | undefined
        if (res === null || res === undefined || typeof res.win !== 'number' || typeof res.buf !== 'number') {
          throw new Error(`ui.float: ${String((res as { err?: unknown } | null | undefined)?.err ?? 'nvim float_open failed')}`)
        }
        nodeFloats.set(id, res.win)
        return { id, win: res.win, buf: res.buf }
      },
      floatClose: async (id) => {
        const win = nodeFloats.get(id)
        nodeFloats.delete(id)
        if (win === undefined) return
        await app.luaCall('require("dsh_tui.api").float_close(...)', ['__node__', win]).catch(() => {})
      },
      picker: (opts) => app.openPicker(opts.title, opts.items),
      notice: (text) => app.notice(text),
      statuslineSegment: (id, text, priority = 100) => {
        const clean = String(text)
        if (clean === '') app.extStatusSegments.delete(id)
        else app.extStatusSegments.set(id, { text: clean, priority })
        app.updateStatusline()
      },
      panel: async (opts) => {
        if (app.nvim === null || app.headless) return null
        const res = await app.luaCall('return require("dsh_tui.api").panel_claim(...)', [
          '__node__', { width: opts.width, title: opts.title, footer: opts.footer, lines: opts.lines ?? [] },
        ]) as { win?: unknown; buf?: unknown; err?: unknown } | null | undefined
        if (res === null || res === undefined || typeof res.err === 'string') {
          app.notice(`⚠ ui.panel: ${String(res?.err ?? '不可用')}`)
          return null
        }
        if (typeof res.win !== 'number' || typeof res.buf !== 'number') return null
        return { win: res.win, buf: res.buf }
      },
      panelRelease: async () => {
        if (app.nvim === null) return
        await app.luaCall('require("dsh_tui.api").panel_release(...)', ['__node__']).catch(() => {})
      },
    },

    registerCommands: (cmds) => {
      const specs = cmds.map((c) => ({
        name: `/${c.name.replace(/^\//, '')}`,
        desc: c.desc,
        usage: c.usage ?? '',
        group: c.group ?? '扩展',
        fn: c.fn,
      }))
      app.registerCommands(specs)
      void app.refreshCommandCatalog().catch(() => {})
      return () => {
        const names = new Set(specs.map((s) => s.name))
        app.commandSpecs = app.commandSpecs.filter((s) => !names.has(s.name))
        void app.refreshCommandCatalog().catch(() => {})
      }
    },

    luaExt: {
      call: async (extId, method, args = []) => {
        const res = await app.luaCall('return require("dsh_tui.api").rpc_dispatch(...)', [
          extId, method, args,
        ]) as { ok?: unknown; value?: unknown; error?: unknown } | null | undefined
        if (res !== null && res !== undefined && typeof res === 'object' && res.ok === false) {
          throw new Error(String(res.error ?? `lua ext ${extId}.${method} failed`))
        }
        if (res !== null && res !== undefined && typeof res === 'object' && res.ok === true) {
          return res.value
        }
        return res
      },
      emit: (extId, event, payload) => {
        void app.luaCall('require("dsh_tui.api").rpc_event(...)', [extId, event, payload ?? null]).catch(() => {})
      },
      on: (extId, handler) => {
        app.extNodeHandlers.set(extId, handler)
        return () => {
          app.extNodeHandlers.delete(extId)
        }
      },
    },
  }

  app.extApi = api
  app.extFire = fire
  app.extSessionSubs = sessionSubs

  /** session/event mirror dispatch: Node-side subscribers (filtered here)
   *  plus the Lua-side routing (extLuaSubs, fed by dsh-ext-register).
   *  Called by boot.ts's session/event handler AFTER the TUI's own routing. */
  app.extDispatchSessionEvent = (sessionId, event) => {
    if (sessionSubs.length > 0) {
      for (const { filter, cb } of sessionSubs) {
        if (!matchSessionEventFilter(filter, sessionId, event.type)) continue
        try {
          cb(sessionId, event)
        } catch (err) {
          app.notice(`⚠ 扩展会话事件 ${event.type} 处理失败: ${(err as Error).message}`)
        }
      }
    }
    // Lua-side mirror: registered extensions with matching event kinds.
    if (app.extLuaSubs.size > 0) {
      const targets: string[] = []
      for (const [id, kinds] of app.extLuaSubs) {
        if (kinds === 'all' || kinds.has(event.type)) targets.push(id)
      }
      if (targets.length > 0) {
        // msgpack-safe copy: SessionEvent payloads carry undefined fields
        // (optional turn/step), which the RPC encoder cannot represent.
        let clean: SessionEvent
        try {
          clean = JSON.parse(JSON.stringify(event)) as SessionEvent
        } catch {
          clean = event
        }
        void app.luaCall('require("dsh_tui.api").session_event(...)', [targets, clean]).catch(() => {})
      }
    }
  }
}
