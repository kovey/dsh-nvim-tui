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

/** TUI lifecycle / user-intent events. */
export type ExtEventName =
  | 'tui:ready'          // boot complete, first session attached
  | 'tui:active-session' // the active session switched (payload: { id })
  | 'tui:input'          // user submitted chat input (payload: { text })
  | 'tui:teardown'       // the TUI is shutting down (payload: {})

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
}

/** Install the extension API onto the App (runs before boot; index.ts then
 *  publishes the built surface through the cordis registry). */
export function installExtApi(app: App): void {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const sessionSubs: Array<{
    filter: ExtSessionEventFilter
    cb: (sid: string, ev: SessionEvent) => void
  }> = []

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
  }

  app.extApi = api
  app.extFire = fire
  app.extSessionSubs = sessionSubs

  /** session/event mirror dispatch (P3 fills the Lua-side routing; the
   *  Node-side subscribers work from P0 on). Called by boot.ts's
   *  session/event handler AFTER the TUI's own routing. */
  app.extDispatchSessionEvent = (sessionId, event) => {
    if (sessionSubs.length === 0) return
    const matches = (f: ExtSessionEventFilter): boolean => {
      if (f.sessionId !== undefined && f.sessionId !== sessionId) return false
      if (f.type === undefined) return true
      const kinds = Array.isArray(f.type) ? f.type : [f.type]
      return kinds.includes(event.type)
    }
    for (const { filter, cb } of sessionSubs) {
      if (!matches(filter)) continue
      try {
        cb(sessionId, event)
      } catch (err) {
        app.notice(`⚠ 扩展会话事件 ${event.type} 处理失败: ${(err as Error).message}`)
      }
    }
  }
}
