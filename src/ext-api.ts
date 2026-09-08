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
import type { SessionEvent } from './kernel/types.js'
import type { App, AppSlices, WritableSlice } from './kernel/app.js'
import { registerNvimNotification } from './kernel/rpc.js'

/** Extension API version (semver, independent of the bundle version). */
export const EXT_API_VERSION = '0.1.0'

/** Default upper bound for one dsh-ext handler execution (both directions).
 *  vim.rpcrequest blocks nvim uninterruptibly and cannot be cancelled from
 *  Lua — the bounded answer is the ONLY freeze protection, so the runner
 *  always answers within this window (timeout → structured error; late
 *  results are discarded). */
export const EXT_HANDLER_TIMEOUT_MS = 30_000

import type { ExtNvimLayer, ExtSessionEventFilter, ExtEventName, ExtCardHandle, TuiExtApi } from './kernel/ext-types.js'

// Public contract re-exports: the type definitions moved to kernel/ext-types.ts
export type { ExtNvimLayer, ExtSessionEventFilter, ExtEventName, ExtCardOpts, ExtCardHandle, ExtFloatOpts, ExtFloatResult, ExtPickerOpts, ExtPanelOpts, ExtPanelHandles, ExtRegionOpts, ExtRegionHandles, ExtCommandSpec, ExtLuaLayer, ExtUiLayer, TuiExtApi } from './kernel/ext-types.js'

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

/** Install the extension API onto the App (runs before boot; index.ts then
 *  publishes the built surface through the cordis registry). */
export function installExtApi(app: App): void {
  const WE = app.slices.ext as WritableSlice<AppSlices['ext']>
  // -- ext domain defaults (I2: the ext slice lives here) --
  Object.assign(app.slices.ext, {
    extApi: null as unknown as TuiExtApi,
    extReadyResolve: null,
    setPendingCardInput: (v: { mark: number; actionIdx: number; prompt: string } | null) => { WE.pendingCardInput = v },
    fireExtReady: () => { const fn = WE.extReadyResolve; WE.extReadyResolve = null; fn?.() },
    extFire: () => {},
    extSessionSubs: [],
    extDispatchSessionEvent: () => {},
    extLuaSubs: new Map(),
    extNodeCleanup: null,
    pendingCardInput: null,
    extNodeHandlers: new Map(),
    extStatusSegments: new Map(),
  })

  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const sessionSubs: Array<{
    filter: ExtSessionEventFilter
    cb: (sid: string, ev: SessionEvent) => void
  }> = []
  /** Node-side floats opened via ui.float: key → win id. */
  const nodeFloats = new Map<string, number>()
  let floatSeq = 0
  /**
   * Node-side panel/region slot machinery (MULTI-BLOCK): every claim slot
   * maps to its own pseudo-extId in the Lua registry — the Lua side allows
   * ONE block per ext per side, so distinct slots stack concurrently.
   *   slot ('default' = back-compat) → { luaId, claims: side → { win, buf } }
   * Slot names are Node-side free-form; the LUA id must match the
   * `^[%w_%.-]+$` pattern — the `__node*` prefix is RESERVED for this map.
   */
  const nodeSlots = new Map<string, { luaId: string; claims: Map<string, { win: number; buf: number }> }>()
  let slotSeq = 0
  const slotLuaId = (slot: string): string => {
    if (slot === 'default') return '__node__'
    const existing = nodeSlots.get(slot)
    if (existing !== undefined) return existing.luaId
    return `__node_${++slotSeq}`
  }
  const slotEntry = (slot: string): { luaId: string; claims: Map<string, { win: number; buf: number }> } => {
    const entry = nodeSlots.get(slot)
    if (entry !== undefined) return entry
    const fresh = { luaId: slotLuaId(slot), claims: new Map() }
    nodeSlots.set(slot, fresh)
    return fresh
  }
  /** Release every claim of one slot (all sides); drops the mapping. */
  const releaseSlot = async (slot: string): Promise<void> => {
    const entry = nodeSlots.get(slot)
    if (entry === undefined) return
    for (const side of [...entry.claims.keys()]) {
      await app.luaCall('require("dsh_tui.api").region_release(...)', [entry.luaId, side]).catch(() => {})
    }
    nodeSlots.delete(slot)
  }
  /** Replace semantics: a re-claim of the same slot+side releases the old
   *  block first (width/title may differ). */
  const releaseClaim = async (slot: string, side: string): Promise<void> => {
    const entry = nodeSlots.get(slot)
    if (entry === undefined) return
    const claim = entry.claims.get(side)
    if (claim === undefined) return
    entry.claims.delete(side)
    await app.luaCall('require("dsh_tui.api").region_release(...)', [entry.luaId, side]).catch(() => {})
    if (entry.claims.size === 0) nodeSlots.delete(slot)
  }
  /** Teardown hook (app.ts calls it before the window closes). */
  app.slices.ext.extNodeCleanup = async () => {
    for (const slot of [...nodeSlots.keys()]) {
      await releaseSlot(slot)
    }
  }

  /** Last payload per fired event — late subscribers of the ONE-SHOT
   *  lifecycle events (tui:ready / tui:active-session) get an immediate
   *  replay. Stream events (tui:input) and terminal events (tui:teardown)
   *  must NEVER replay — a late subscriber getting the last user input
   *  would be wrong. */
  const lastFired = new Map<string, { payload: unknown }>()
  const REPLAYABLE_EVENTS = new Set<ExtEventName>(['tui:ready', 'tui:active-session'])

  /** Fire a tui:* event; subscriber throws are contained (feed notice). */
  const fire = (event: ExtEventName, payload: unknown): void => {
    lastFired.set(event, { payload })
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
      if (app.slices.runtime.nvim === null) return Promise.reject(new Error('nvim not connected'))
      const p = app.slices.runtime.nvim.request(method, args as never[]) as Promise<unknown>
      if (opts?.timeoutMs === undefined) return p
      return Promise.race([
        p,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`nvim.request ${method} 超时`)), opts.timeoutMs)),
      ])
    },
    call: (fn, args = []) => {
      if (app.slices.runtime.nvim === null) return Promise.reject(new Error('nvim not connected'))
      return app.slices.runtime.nvim.call(fn, args as never[]) as Promise<unknown>
    },
    lua: (code, args = []) => {
      return app.luaCall(code, args)
    },
    ex: async (cmd) => {
      if (app.slices.runtime.nvim === null) throw new Error('nvim not connected')
      await app.slices.runtime.nvim.command(cmd)
    },
  }

  const api: TuiExtApi = {
    version: EXT_API_VERSION,
    ready: new Promise<void>((resolve) => {
      WE.extReadyResolve = resolve
    }),
    capabilities: () => ({
      headless: app.headless,
      // cards/floats/pickers render fine in headless too (useful for e2e
      // dumps); the panel slot is the one primitive gated off.
      card: true,
      float: true,
      picker: true,
      panel: !app.headless,
      region: !app.headless,
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
      // Late-subscribe replay: ONE-SHOT lifecycle events already fired are
      // re-delivered immediately so consumers never miss boot; stream
      // events stay live-only.
      if (REPLAYABLE_EVENTS.has(event)) {
        const last = lastFired.get(event)
        if (last !== undefined) {
          try {
            cb(last.payload)
          } catch (err) {
            app.notice(`⚠ 扩展事件 ${event} 处理失败: ${(err as Error).message}`)
          }
        }
      }
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
    getActiveSessionId: () => app.slices.sessions.activeId,
    submit: (text) => app.slices.agent.send(text),
    insertInput: (text) => {
      void app.luaCall('require("dsh_tui").fill_input(...)', [text]).catch(() => {})
    },

    ui: {
      card: (opts) => {
        const feed = (opts.sessionId !== undefined
          ? app.slices.sessions.live.get(opts.sessionId)?.feed
          : undefined) ?? app.slices.ui.activeFeed()
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
          onAction: opts.onAction,
        })
        if (opts.ttlMs !== undefined && opts.ttlMs > 0) {
          setTimeout(() => handle.dismiss(), opts.ttlMs)
        }
        return handle
      },
      float: async (opts) => {
        if (app.slices.runtime.nvim === null) throw new Error('nvim not connected')
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
      picker: (opts) => {
        return app.openPicker(opts.title, opts.items)
      },
      notice: (text) => app.notice(text),
      statuslineSegment: (id, text, priority = 100) => {
        const clean = String(text)
        if (clean === '') app.slices.ext.extStatusSegments.delete(id)
        else app.slices.ext.extStatusSegments.set(id, { text: clean, priority })
        app.slices.ui.updateStatusline()
      },
      panel: async (opts) => {
        if (app.slices.runtime.nvim === null || app.headless) return null
        const slot = opts.slot ?? 'default'
        const side = opts.side ?? 'right'
        const entry = slotEntry(slot)
        await app.luaCall('require("dsh_tui.api").ensure_registry(...)', [entry.luaId]).catch(() => {})
        // Replace semantics: same slot + side re-claim frees the old block.
        await releaseClaim(slot, side)
        const res = await app.luaCall('return require("dsh_tui.api").region_claim(...)', [
          entry.luaId, { side, width: opts.width, height: opts.height,
            title: opts.title, footer: opts.footer, lines: opts.lines ?? [] },
        ]) as { win?: unknown; buf?: unknown; err?: unknown } | null | undefined
        if (res === null || res === undefined || typeof res.err === 'string') {
          app.notice(`⚠ ui.panel: ${String(res?.err ?? '不可用')}`)
          return null
        }
        if (typeof res.win !== 'number' || typeof res.buf !== 'number') return null
        entry.claims.set(side, { win: res.win, buf: res.buf })
        return {
          win: res.win, buf: res.buf, slot,
          release: () => releaseClaim(slot, side),
        }
      },
      panelRelease: async (slot = 'default') => {
        if (app.slices.runtime.nvim === null) return
        await releaseSlot(slot)
      },
      panels: () => {
        const out: Array<{ slot: string; side: string; win: number; buf: number }> = []
        for (const [slot, entry] of nodeSlots) {
          for (const [side, claim] of entry.claims) {
            out.push({ slot, side, win: claim.win, buf: claim.buf })
          }
        }
        return out
      },
      region: async (opts) => {
        if (app.slices.runtime.nvim === null || app.headless) return null
        const slot = opts.slot ?? 'default'
        const side = opts.side ?? 'right'
        const entry = slotEntry(slot)
        await app.luaCall('require("dsh_tui.api").ensure_registry(...)', [entry.luaId]).catch(() => {})
        await releaseClaim(slot, side)
        const res = await app.luaCall('return require("dsh_tui.api").region_claim(...)', [
          entry.luaId, { side, width: opts.width, height: opts.height, size: opts.size,
            title: opts.title, footer: opts.footer, lines: opts.lines ?? [] },
        ]) as { win?: unknown; buf?: unknown; err?: unknown } | null | undefined
        if (res === null || res === undefined || typeof res.err === 'string') {
          app.notice(`⚠ ui.region: ${String(res?.err ?? '不可用')}`)
          return null
        }
        if (typeof res.win !== 'number' || typeof res.buf !== 'number') return null
        entry.claims.set(side, { win: res.win, buf: res.buf })
        return {
          win: res.win, buf: res.buf, slot,
          release: () => releaseClaim(slot, side),
        }
      },
      regionRelease: async (slot = 'default') => {
        if (app.slices.runtime.nvim === null) return
        await releaseSlot(slot)
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
      call: async (extId, method, args = [], opts) => {
        const timeoutMs = opts?.timeoutMs ?? EXT_HANDLER_TIMEOUT_MS
        // Bound the Node→Lua round trip: a wedged Lua handler blocks nvim's
        // main loop, so the caller must not hang forever either. The
        // underlying request continues — its late response is dropped.
        const p = app.luaCall('return require("dsh_tui.api").rpc_dispatch(...)', [
          extId, method, args,
        ])
        const res = await Promise.race([
          p,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`lua ext ${extId}.${method} timeout (${timeoutMs}ms)`)), timeoutMs)),
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
      on: (extId, handler, opts) => {
        app.slices.ext.extNodeHandlers.set(extId, {
          handler,
          timeoutMs: opts?.timeoutMs ?? EXT_HANDLER_TIMEOUT_MS,
        })
        return () => {
          app.slices.ext.extNodeHandlers.delete(extId)
        }
      },
    },
  }

  app.slices.ext.extApi = api
  app.slices.ext.extFire = fire
  WE.extSessionSubs = sessionSubs

  /** session/event mirror dispatch: Node-side subscribers (filtered here)
   *  plus the Lua-side routing (extLuaSubs, fed by dsh-ext-register).
   *  Called by boot.ts's session/event handler AFTER the TUI's own routing. */
  app.slices.ext.extDispatchSessionEvent = (sessionId, event) => {
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
    if (app.slices.ext.extLuaSubs.size > 0) {
      const targets: string[] = []
      for (const [id, kinds] of app.slices.ext.extLuaSubs) {
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

  // -- nvim notifications this module owns (dispatched by boot via rpc.ts) --
  registerNvimNotification('dsh-ext-register', '扩展注册', (app, args) => {
    // A Lua-side extension registered (api.register): mirror its
    // session-event subscription so the Node side knows what to route.
    const spec = (args?.[0] ?? {}) as { id?: unknown; events?: unknown }
    const id = typeof spec.id === 'string' ? spec.id : ''
    if (id === '') return
    const raw = Array.isArray(spec.events) ? spec.events.filter((e): e is string => typeof e === 'string') : undefined
    const wantsAll = raw === undefined || raw.length === 0 || raw.includes('all')
    app.slices.ext.extLuaSubs.set(id, wantsAll ? 'all' : new Set(raw))
  })
  registerNvimNotification('dsh-ext-unregister', '扩展注销', (app, args) => {
    const id = typeof args?.[0] === 'string' ? args[0] : ''
    if (id !== '') app.slices.ext.extLuaSubs.delete(id)
  })
  registerNvimNotification('dsh-ext-notice', '扩展通知', (app, args) => {
    // Lua-side extensions surface transient notices through the runner.
    const text = String((args?.[0] as { text?: unknown } | undefined)?.text ?? args?.[0] ?? '')
    if (text !== '') app.notice(text)
  })
  registerNvimNotification('dsh-ext-card-activate', '卡片操作', (app, args) => {
    // Interactive ext card: the chat keymap resolved the card mark under
    // the cursor (active session feed). action null → open the action
    // picker; a number → dispatch that action (plain fires immediately,
    // confirm gates behind a picker, input claims the next dsh-input).
    const payload = (args?.[0] ?? {}) as { mark?: unknown; action?: unknown }
    const mark = Number(payload.mark)
    if (!Number.isInteger(mark)) return
    const feed = app.slices.ui.activeFeed()
    if (feed === undefined) return
    const dispatch = (feed2: typeof feed, idx: number): void => {
      // Any new card activation supersedes a pending input-mode prompt
      // (the input branch below re-arms it when needed).
      app.slices.ext.setPendingCardInput(null)
      const r = feed2.resolveCardAction(mark, idx)
      if (r === null || r.action === undefined) {
        app.notice('⚠ 卡片已失效')
        return
      }
      const act = r.action
      const kind = act.kind ?? 'plain'
      try {
        if (kind === 'confirm') {
          // headless degrades to plain (no TTY to confirm on).
          if (app.headless) {
            feed2.fireCardAction(r.cardId, act.value)
            return
          }
          void app.openPicker(String(act.confirmText ?? `确认执行「${act.label}」？`), [
            { label: '确认', value: 'yes' },
            { label: '取消', value: 'no' },
          ]).then((sel) => {
            if (sel === 'yes') {
              try { feed2.fireCardAction(r.cardId, act.value) }
              catch (err) { app.notice(`⚠ 卡片操作失败: ${(err as Error).message}`) }
            }
          })
          return
        }
        if (kind === 'input') {
          // headless degrades to plain (no input box to type into).
          if (app.headless) {
            feed2.fireCardAction(r.cardId, act.value)
            return
          }
          const prompt = String(act.inputPrompt ?? `输入「${act.label}」的参数`)
          app.slices.ext.setPendingCardInput({ mark, actionIdx: idx, prompt })
          if (typeof act.inputDefault === 'string' && act.inputDefault !== '') {
            void app.luaCall('require("dsh_tui").fill_input(...)', [act.inputDefault]).catch(() => {})
          }
          app.notice(`✎ ${prompt}（Enter 提交 · 空输入取消）`)
          return
        }
        feed2.fireCardAction(r.cardId, act.value)
      } catch (err) {
        app.notice(`⚠ 卡片操作失败: ${(err as Error).message}`)
      }
    }
    try {
      const action = typeof payload.action === 'number' ? payload.action : null
      const res = feed.activateCard(mark, action)
      if (res === null) return
      if (Array.isArray(res)) {
        if (res.length === 0) return
        // Kind badges: confirm ⚠ / input ✎ — the picker shows what
        // happens BEFORE anything fires.
        const items = res.map((a) => ({
          label: (a.kind === 'confirm' ? '⚠ ' : a.kind === 'input' ? '✎ ' : '') + a.label,
          value: a.value,
        }))
        void app.openPicker('卡片操作', items).then((value) => {
          if (value === null) return
          const idx = res.findIndex((i) => i.value === value) + 1
          if (idx > 0) dispatch(feed, idx)
        })
        return
      }
      // Direct 1-9: the dispatcher handles the kind.
      dispatch(feed, action as number)
    } catch (err) {
      app.notice(`⚠ 卡片操作失败: ${(err as Error).message}`)
    }
  })
}

/** nvim `request` side of the dsh-ext bus (moved out of boot): every
 *  vim.rpcrequest(channel, 'dsh-ext', …) gets a BOUNDED response —
 *  vim.rpcrequest blocks nvim uninterruptibly (and cannot be cancelled from
 *  Lua), so a hung handler freezes the UI forever. The runner races the
 *  handler against its timeout and answers an error when it overruns; late
 *  handler results are discarded (answered flag guards the single-send
 *  channel). NOTE: nvim DOES process events while blocked in rpcrequest, so
 *  handlers may safely make nested nvim calls (verified empirically). */
export function handleDshExtRequest(app: App, method: string, args: unknown[], resp: { send: (r: unknown) => void }): void {
  void (async () => {
    let answered = false
    const reply = (r: unknown): void => {
      if (answered) return
      answered = true
      try {
        resp.send(r)
      } catch { /* peer went away mid-handler: nothing to answer */ }
    }
    if (method !== 'dsh-ext') {
      reply({ ok: false, error: `unsupported request: ${method}` })
      return
    }
    const payload = (args?.[0] ?? {}) as { id?: unknown; method?: unknown; args?: unknown }
    const extId = typeof payload.id === 'string' ? payload.id : ''
    const m = typeof payload.method === 'string' ? payload.method : ''
    const entry = extId === '' ? undefined : app.slices.ext.extNodeHandlers.get(extId)
    if (entry === undefined) {
      reply({ ok: false, error: `no ext handler: ${extId}.${m || '?'}` })
      return
    }
    const deadline = setTimeout(() => {
      reply({ ok: false, error: `ext handler timeout: ${extId}.${m} (${entry.timeoutMs}ms)` })
    }, entry.timeoutMs)
    try {
      const value = await entry.handler(m, Array.isArray(payload.args) ? payload.args : [])
      clearTimeout(deadline)
      reply({ ok: true, value })
    } catch (err) {
      clearTimeout(deadline)
      reply({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })()
}

/** Extension readiness announce (moved out of boot): resolve the ready
 *  promise, notify Node subscribers, and fire the nvim-side User DshTuiReady
 *  autocmd. */
export function announceReady(app: App): void {
  app.slices.ext.fireExtReady()
  app.slices.ext.setPendingCardInput(null)
  app.slices.ext.extFire('tui:ready', { active: app.slices.sessions.activeId })
  void app.luaCall('require("dsh_tui.api").emit(...)', ['Ready', { active: app.slices.sessions.activeId }]).catch(() => {})
}
