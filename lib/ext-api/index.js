import { registerNvimNotification } from '../kernel/rpc.js';
/** Extension API version (semver, independent of the bundle version). */
export const EXT_API_VERSION = '0.1.0';
/** Default upper bound for one dsh-ext handler execution (both directions).
 *  vim.rpcrequest blocks nvim uninterruptibly and cannot be cancelled from
 *  Lua — the bounded answer is the ONLY freeze protection, so the runner
 *  always answers within this window (timeout → structured error; late
 *  results are discarded). */
export const EXT_HANDLER_TIMEOUT_MS = 30_000;
import { t, tf } from '../kernel/i18n.js';
/** Pure filter match (exported for unit tests). */
export function matchSessionEventFilter(filter, sessionId, eventType) {
    if (filter.sessionId !== undefined && filter.sessionId !== sessionId)
        return false;
    if (filter.type === undefined)
        return true;
    const kinds = Array.isArray(filter.type) ? filter.type : [filter.type];
    return kinds.includes(eventType);
}
// -- hmr-surviving module state (see installExtApi) -------------------------
let readyAnnounced = false;
/** Promise.race with a timeout whose timer is ALWAYS cleared (the naive
 *  race leaked one pending timer per bounded call). */
const withTimeout = (p, ms, message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});
const readyWaiters = [];
const moduleListeners = new Map();
const moduleSessionSubs = [];
const readyListeners = () => moduleListeners;
const readySessionSubs = () => moduleSessionSubs;
/** Install the extension API onto the App (runs before boot; index.ts then
 *  publishes the built surface through the cordis registry). */
export function installExtApi(app) {
    const WE = app.slices.ext;
    // -- ext domain defaults (I2: the ext slice lives here) --
    Object.assign(app.slices.ext, {
        extApi: null,
        extReadyResolve: null,
        setPendingCardInput: (v) => { WE.pendingCardInput = v; },
        fireExtReady: () => {
            // Ready waiters survive runner-row reloads (module scope): a SECOND
            // apply's api.ready resolves together with the first one — nobody
            // hangs, and tui:ready fires exactly once.
            const first = !readyAnnounced;
            readyAnnounced = true;
            const ws = [...readyWaiters];
            readyWaiters.length = 0;
            for (const w of ws)
                w();
            WE.extReadyResolve = null;
            return first;
        },
        extFire: () => { },
        extSessionSubs: [],
        extDispatchSessionEvent: () => { },
        extLuaSubs: new Map(),
        extNodeCleanup: null,
        pendingCardInput: null,
        extNodeHandlers: new Map(),
        extStatusSegments: new Map(),
    });
    // Subscription state lives at MODULE scope: a runner-row reload (hmr)
    //  re-runs apply() in the same process — `on`/`onSessionEvent` listeners
    //  must survive the reload, not silently vanish.
    //  CAVEAT (audit 2026-09): status segments, `luaExt.on` handlers and Lua
    //  subscriptions live in the APP domain (the arch gate pins those fields
    //  there), so a runner-row reload DROPS them. A consumer that registers
    //  once inside `tui.ready.then(...)` must re-register after a reload —
    //  see the note in docs/EXT-API.md.
    const listeners = readyListeners();
    const sessionSubs = readySessionSubs();
    /** Node-side floats opened via ui.float: key → win id. */
    const nodeFloats = new Map();
    let floatSeq = 0;
    /**
     * Node-side panel/region slot machinery (MULTI-BLOCK): every claim slot
     * maps to its own pseudo-extId in the Lua registry — the Lua side allows
     * ONE block per ext per side, so distinct slots stack concurrently.
     *   slot ('default' = back-compat) → { luaId, claims: side → { win, buf } }
     * Slot names are Node-side free-form; the LUA id must match the
     * `^[%w_%.-]+$` pattern — the `__node*` prefix is RESERVED for this map.
     */
    const nodeSlots = new Map();
    let slotSeq = 0;
    const slotLuaId = (slot) => {
        if (slot === 'default')
            return '__node__';
        const existing = nodeSlots.get(slot);
        if (existing !== undefined)
            return existing.luaId;
        return `__node_${++slotSeq}`;
    };
    const slotEntry = (slot) => {
        const entry = nodeSlots.get(slot);
        if (entry !== undefined)
            return entry;
        const fresh = { luaId: slotLuaId(slot), claims: new Map() };
        nodeSlots.set(slot, fresh);
        return fresh;
    };
    /** Release every claim of one slot (all sides); drops the mapping. */
    const releaseSlot = async (slot) => {
        const entry = nodeSlots.get(slot);
        if (entry === undefined)
            return;
        for (const side of [...entry.claims.keys()]) {
            await app.luaCall('require("dsh_tui.api").region_release(...)', [entry.luaId, side]).catch(() => { });
        }
        nodeSlots.delete(slot);
    };
    /** Replace semantics: a re-claim of the same slot+side releases the old
     *  block first (width/title may differ). */
    const releaseClaim = async (slot, side) => {
        const entry = nodeSlots.get(slot);
        if (entry === undefined)
            return;
        const claim = entry.claims.get(side);
        if (claim === undefined)
            return;
        entry.claims.delete(side);
        await app.luaCall('require("dsh_tui.api").region_release(...)', [entry.luaId, side]).catch(() => { });
        if (entry.claims.size === 0)
            nodeSlots.delete(slot);
    };
    /** Teardown hook (app.ts calls it before the window closes). */
    app.slices.ext.extNodeCleanup = async () => {
        for (const slot of [...nodeSlots.keys()]) {
            await releaseSlot(slot);
        }
    };
    /** Last payload per fired event — late subscribers of the ONE-SHOT
     *  lifecycle events (tui:ready / tui:active-session) get an immediate
     *  replay. Stream events (tui:input) and terminal events (tui:teardown)
     *  must NEVER replay — a late subscriber getting the last user input
     *  would be wrong. */
    const lastFired = new Map();
    const REPLAYABLE_EVENTS = new Set(['tui:ready', 'tui:active-session']);
    /** Fire a tui:* event; subscriber throws are contained (feed notice). */
    const fire = (event, payload) => {
        lastFired.set(event, { payload });
        const set = listeners.get(event);
        if (set === undefined || set.size === 0)
            return;
        for (const cb of [...set]) {
            try {
                cb(payload);
            }
            catch (err) {
                app.notice(tf('⚠ 扩展事件 {0} 处理失败: {1}', [event, err.message]));
            }
        }
    };
    // The execution layer is full-trust by DESIGN (documented in
    //  kernel/ext-types.ts), but the two cheapest guardrails still apply:
    //  requests must be real nvim_* API methods, and vim.fn calls are limited
    //  to a read-only-ish whitelist (lua/ex remain the documented escape
    //  hatches with NO sandbox).
    const SAFE_VIM_FN = new Set([
        'fnameescape', 'expand', 'fnamemodify', 'getcwd', 'stdpath', 'glob', 'globpath',
        'has', 'exists', 'getenv', 'executable', 'filereadable', 'isdirectory',
        'getftime', 'getfsize', 'tempname', 'bufname', 'bufnr', 'line', 'col',
        'winwidth', 'winheight', 'winnr', 'tabpagenr', 'trim',
        'strwidth', 'strdisplaywidth', 'keys', 'values', 'len', 'string', 'type',
        // NOT whitelisted: systemlist — it executes an arbitrary command and
        // contradicted the read-only contract (arbitrary exec lives behind
        // nvim.lua / nvim.ex, declared by capabilities.unrestrictedExec).
    ]);
    const nvimLayer = {
        request: (method, args = [], opts) => {
            if (typeof method !== 'string' || !method.startsWith('nvim_'))
                return Promise.reject(new Error(`nvim.request 仅接受 nvim_* API 方法（收到: ${String(method)}）`));
            if (app.slices.runtime.nvim === null)
                return Promise.reject(new Error('nvim not connected'));
            const p = app.slices.runtime.nvim.request(method, args);
            if (opts?.timeoutMs === undefined)
                return p;
            // Clear the timer on the SUCCESS path too: every bounded request used
            // to leave a pending timer alive for up to timeoutMs (30s), keeping the
            // event loop busy and the process from draining.
            return withTimeout(p, opts.timeoutMs, `nvim.request ${method} 超时`);
        },
        call: (fn, args = []) => {
            if (!SAFE_VIM_FN.has(fn))
                return Promise.reject(new Error(`nvim.call 不在只读白名单内（收到: ${fn}；需要任意执行请用 nvim.lua/nvim.ex）`));
            if (app.slices.runtime.nvim === null)
                return Promise.reject(new Error('nvim not connected'));
            return app.slices.runtime.nvim.call(fn, args);
        },
        lua: (code, args = []) => {
            return app.luaCall(code, args);
        },
        ex: async (cmd) => {
            if (app.slices.runtime.nvim === null)
                throw new Error('nvim not connected');
            await app.slices.runtime.nvim.command(cmd);
        },
    };
    const api = {
        version: EXT_API_VERSION,
        ready: new Promise((resolve) => {
            // BOUNDED: boot has six `disposed` early-returns and can stall in the
            // credentials seam before announceReady — an unbounded `ready` left
            // every consumer's `void tui.ready.then(init)` silently pending
            // forever. Resolve (never reject: the documented pattern has no catch,
            // and the host's fail-loud would turn an unhandled rejection into a
            // hard process exit) and leave a diagnostic behind.
            const timer = setTimeout(() => {
                if (WE.extReadyResolve !== settle)
                    return;
                WE.extReadyResolve = null;
                const at = readyWaiters.indexOf(settle);
                if (at >= 0)
                    readyWaiters.splice(at, 1);
                app.exitDiag('ext-ready-timeout', 'boot did not announce ready within 30s');
                settle();
            }, 30000);
            const settle = () => {
                clearTimeout(timer);
                resolve();
            };
            WE.extReadyResolve = settle;
            // Survive runner-row reloads: fireExtReady drains the module-scope
            // waiter list, so a SECOND apply's promise resolves together with the
            // first one. (Previously nothing pushed here — every await tui.ready
            // hung forever.)
            readyWaiters.push(settle);
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
            // NO sandbox on lua/ex (nvim has none): the surface is a full-trust
            // execution layer — declared so installers can warn, never implied.
            unrestrictedExec: true,
        }),
        nvim: nvimLayer,
        on: (event, cb) => {
            let set = listeners.get(event);
            if (set === undefined) {
                set = new Set();
                listeners.set(event, set);
            }
            set.add(cb);
            // Late-subscribe replay: ONE-SHOT lifecycle events already fired are
            // re-delivered immediately so consumers never miss boot; stream
            // events stay live-only.
            if (REPLAYABLE_EVENTS.has(event)) {
                const last = lastFired.get(event);
                if (last !== undefined) {
                    try {
                        cb(last.payload);
                    }
                    catch (err) {
                        app.notice(tf('⚠ 扩展事件 {0} 处理失败: {1}', [event, err.message]));
                    }
                }
            }
            return () => {
                set.delete(cb);
            };
        },
        onSessionEvent: (filter, cb) => {
            const entry = { filter, cb };
            sessionSubs.push(entry);
            return () => {
                const i = sessionSubs.indexOf(entry);
                if (i >= 0)
                    sessionSubs.splice(i, 1);
            };
        },
        getActiveSessionId: () => app.slices.sessions.activeId,
        submit: (text) => app.slices.agent.send(text),
        insertInput: (text) => {
            void app.luaCall('require("dsh_tui").fill_input(...)', [text]).catch(() => { });
        },
        ui: {
            card: (opts) => {
                const feed = (opts.sessionId !== undefined
                    ? app.slices.sessions.live.get(opts.sessionId)?.feed
                    : undefined) ?? app.slices.ui.activeFeed();
                if (feed === undefined) {
                    // No feed yet (pre-boot) / headless without a session: an inert
                    // handle so callers never null-check.
                    const inert = {
                        id: `ext-${opts.plugin}-dropped`,
                        update: () => { },
                        dismiss: () => { },
                    };
                    return inert;
                }
                const handle = feed.pushExtCard({
                    plugin: opts.plugin,
                    title: opts.title,
                    body: opts.body,
                    actions: opts.actions,
                    onAction: opts.onAction,
                });
                if (opts.ttlMs !== undefined && opts.ttlMs > 0) {
                    setTimeout(() => handle.dismiss(), opts.ttlMs);
                }
                return handle;
            },
            float: async (opts) => {
                if (app.slices.runtime.nvim === null)
                    throw new Error('nvim not connected');
                // The float layer is ownership-registered: make sure the __node__
                // entry exists (panel/region create it lazily — a fresh session must
                // be able to open a float BEFORE any claim, else float_open rejects
                // with 'not registered').
                await app.luaCall('require("dsh_tui.api").ensure_registry(...)', ['__node__']).catch(() => { });
                const id = `f${++floatSeq}`;
                const res = await app.luaCall('return require("dsh_tui.api").float_open(...)', [
                    '__node__', { lines: opts.lines, title: opts.title, relative: opts.relative,
                        width: opts.width, height: opts.height, row: opts.row, col: opts.col },
                ]);
                if (res === null || res === undefined || typeof res.win !== 'number' || typeof res.buf !== 'number') {
                    throw new Error(`ui.float: ${String(res?.err ?? 'nvim float_open failed')}`);
                }
                nodeFloats.set(id, res.win);
                return { id, win: res.win, buf: res.buf };
            },
            floatClose: async (id) => {
                const win = nodeFloats.get(id);
                nodeFloats.delete(id);
                if (win === undefined)
                    return;
                await app.luaCall('require("dsh_tui.api").float_close(...)', ['__node__', win]).catch(() => { });
            },
            picker: (opts) => {
                return app.openPicker(opts.title, opts.items);
            },
            notice: (text) => app.notice(text),
            statuslineSegment: (id, text, priority = 100) => {
                const clean = String(text);
                if (clean === '')
                    app.slices.ext.extStatusSegments.delete(id);
                else
                    app.slices.ext.extStatusSegments.set(id, { text: clean, priority });
                app.slices.ui.updateStatusline();
            },
            panel: async (opts) => {
                if (app.slices.runtime.nvim === null || app.headless)
                    return null;
                const slot = opts.slot ?? 'default';
                const side = opts.side ?? 'right';
                const entry = slotEntry(slot);
                await app.luaCall('require("dsh_tui.api").ensure_registry(...)', [entry.luaId]).catch(() => { });
                // Replace semantics: same slot + side re-claim frees the old block.
                await releaseClaim(slot, side);
                const res = await app.luaCall('return require("dsh_tui.api").region_claim(...)', [
                    entry.luaId, { side, width: opts.width, height: opts.height,
                        title: opts.title, footer: opts.footer, lines: opts.lines ?? [] },
                ]);
                if (res === null || res === undefined || typeof res.err === 'string') {
                    app.notice(`⚠ ui.panel: ${String(res?.err ?? t('不可用'))}`);
                    return null;
                }
                if (typeof res.win !== 'number' || typeof res.buf !== 'number')
                    return null;
                entry.claims.set(side, { win: res.win, buf: res.buf });
                return {
                    win: res.win, buf: res.buf, slot,
                    release: () => releaseClaim(slot, side),
                };
            },
            panelRelease: async (slot = 'default') => {
                if (app.slices.runtime.nvim === null)
                    return;
                await releaseSlot(slot);
            },
            panels: () => {
                const out = [];
                for (const [slot, entry] of nodeSlots) {
                    for (const [side, claim] of entry.claims) {
                        out.push({ slot, side, win: claim.win, buf: claim.buf });
                    }
                }
                return out;
            },
            region: async (opts) => {
                if (app.slices.runtime.nvim === null || app.headless)
                    return null;
                const slot = opts.slot ?? 'default';
                const side = opts.side ?? 'right';
                const entry = slotEntry(slot);
                await app.luaCall('require("dsh_tui.api").ensure_registry(...)', [entry.luaId]).catch(() => { });
                await releaseClaim(slot, side);
                const res = await app.luaCall('return require("dsh_tui.api").region_claim(...)', [
                    entry.luaId, { side, width: opts.width, height: opts.height, size: opts.size,
                        title: opts.title, footer: opts.footer, lines: opts.lines ?? [] },
                ]);
                if (res === null || res === undefined || typeof res.err === 'string') {
                    app.notice(`⚠ ui.region: ${String(res?.err ?? t('不可用'))}`);
                    return null;
                }
                if (typeof res.win !== 'number' || typeof res.buf !== 'number')
                    return null;
                entry.claims.set(side, { win: res.win, buf: res.buf });
                return {
                    win: res.win, buf: res.buf, slot,
                    release: () => releaseClaim(slot, side),
                };
            },
            regionRelease: async (slot = 'default') => {
                if (app.slices.runtime.nvim === null)
                    return;
                await releaseSlot(slot);
            },
        },
        registerCommands: (cmds) => {
            // Never let a malformed external entry (missing name/fn) blow up the
            // caller synchronously — skip it like the duplicate-name path does.
            const valid = (cmds ?? []).filter((c) => c != null && typeof c.name === 'string' && c.name.trim() !== '' && typeof c.fn === 'function');
            const specs = valid.map((c) => ({
                name: `/${c.name.replace(/^\//, '')}`,
                desc: c.desc,
                usage: c.usage ?? '',
                group: c.group ?? '扩展',
                fn: c.fn,
            }));
            const mine = app.registerCommands(specs);
            void app.refreshCommandCatalog().catch(() => { });
            return () => {
                // Ownership-checked disposal: only the specs THIS registration
                // actually added may be removed (a rejected duplicate must never
                // delete the pre-existing command it collided with).
                app.commandSpecs = app.commandSpecs.filter((s) => !mine.includes(s));
                void app.refreshCommandCatalog().catch(() => { });
            };
        },
        luaExt: {
            call: async (extId, method, args = [], opts) => {
                const timeoutMs = opts?.timeoutMs ?? EXT_HANDLER_TIMEOUT_MS;
                // Bound the Node→Lua round trip: a wedged Lua handler blocks nvim's
                // main loop, so the caller must not hang forever either. The
                // underlying request continues — its late response is dropped.
                const p = app.luaCall('return require("dsh_tui.api").rpc_dispatch(...)', [
                    extId, method, args,
                ]);
                const res = await withTimeout(p, timeoutMs, `lua ext ${extId}.${method} timeout (${timeoutMs}ms)`);
                if (res !== null && res !== undefined && typeof res === 'object' && res.ok === false) {
                    throw new Error(String(res.error ?? `lua ext ${extId}.${method} failed`));
                }
                if (res !== null && res !== undefined && typeof res === 'object' && res.ok === true) {
                    return res.value;
                }
                return res;
            },
            emit: (extId, event, payload) => {
                void app.luaCall('require("dsh_tui.api").rpc_event(...)', [extId, event, payload ?? null]).catch(() => { });
            },
            on: (extId, handler, opts) => {
                // Token-guarded disposer: a second on() for the same extId REPLACES
                // the entry — the first disposer must not delete the newcomer.
                const token = Symbol(`luaExt:${extId}`);
                app.slices.ext.extNodeHandlers.set(extId, {
                    handler,
                    timeoutMs: opts?.timeoutMs ?? EXT_HANDLER_TIMEOUT_MS,
                    token,
                });
                return () => {
                    // Token-guarded disposal: a second on() for the same extId
                    // REPLACES the entry — the first disposer must not delete the
                    // newcomer (the token identity check makes that real).
                    if (app.slices.ext.extNodeHandlers.get(extId)?.token === token) {
                        app.slices.ext.extNodeHandlers.delete(extId);
                    }
                };
            },
        },
    };
    app.slices.ext.extApi = api;
    app.slices.ext.extFire = fire;
    WE.extSessionSubs = sessionSubs;
    /** session/event mirror dispatch: Node-side subscribers (filtered here)
     *  plus the Lua-side routing (extLuaSubs, fed by dsh-ext-register).
     *  Called by boot.ts's session/event handler AFTER the TUI's own routing. */
    app.slices.ext.extDispatchSessionEvent = (sessionId, event) => {
        if (sessionSubs.length > 0) {
            for (const { filter, cb } of sessionSubs) {
                if (!matchSessionEventFilter(filter, sessionId, event.type))
                    continue;
                try {
                    cb(sessionId, event);
                }
                catch (err) {
                    app.notice(tf('⚠ 扩展会话事件 {0} 处理失败: {1}', [event.type, err.message]));
                }
            }
        }
        // Lua-side mirror: registered extensions with matching event kinds.
        if (app.slices.ext.extLuaSubs.size > 0) {
            const targets = [];
            for (const [id, kinds] of app.slices.ext.extLuaSubs) {
                if (kinds === 'all' || kinds.has(event.type))
                    targets.push(id);
            }
            if (targets.length > 0) {
                // msgpack-safe copy: SessionEvent payloads carry undefined fields
                // (optional turn/step), which the RPC encoder cannot represent.
                let clean;
                try {
                    clean = JSON.parse(JSON.stringify(event));
                }
                catch {
                    clean = event;
                }
                void app.luaCall('require("dsh_tui.api").session_event(...)', [targets, clean]).catch(() => { });
            }
        }
    };
    // -- nvim notifications this module owns (dispatched by boot via rpc.ts) --
    registerNvimNotification('dsh-ext-register', t('扩展注册'), (app, args) => {
        // A Lua-side extension registered (api.register): mirror its
        // session-event subscription so the Node side knows what to route.
        const spec = (args?.[0] ?? {});
        const id = typeof spec.id === 'string' ? spec.id : '';
        if (id === '')
            return;
        const raw = Array.isArray(spec.events) ? spec.events.filter((e) => typeof e === 'string') : undefined;
        const wantsAll = raw === undefined || raw.length === 0 || raw.includes('all');
        app.slices.ext.extLuaSubs.set(id, wantsAll ? 'all' : new Set(raw));
    });
    registerNvimNotification('dsh-ext-unregister', t('扩展注销'), (app, args) => {
        const id = typeof args?.[0] === 'string' ? args[0] : '';
        if (id !== '')
            app.slices.ext.extLuaSubs.delete(id);
    });
    registerNvimNotification('dsh-ext-notice', t('扩展通知'), (app, args) => {
        // Lua-side extensions surface transient notices through the runner.
        const text = String(args?.[0]?.text ?? args?.[0] ?? '');
        if (text !== '')
            app.notice(text);
    });
    registerNvimNotification('dsh-ext-card-activate', t('卡片操作'), (app, args) => {
        // Interactive ext card: the chat keymap resolved the card mark under
        // the cursor (active session feed). action null → open the action
        // picker; a number → dispatch that action (plain fires immediately,
        // confirm gates behind a picker, input claims the next dsh-input).
        const payload = (args?.[0] ?? {});
        const mark = Number(payload.mark);
        if (!Number.isInteger(mark))
            return;
        const feed = app.slices.ui.activeFeed();
        if (feed === undefined)
            return;
        const dispatch = (feed2, idx) => {
            // Any new card activation supersedes a pending input-mode prompt
            // (the input branch below re-arms it when needed).
            app.slices.ext.setPendingCardInput(null);
            const r = feed2.resolveCardAction(mark, idx);
            if (r === null || r.action === undefined) {
                app.notice(t('⚠ 卡片已失效'));
                return;
            }
            const act = r.action;
            const kind = act.kind ?? 'plain';
            try {
                if (kind === 'confirm') {
                    // headless degrades to plain (no TTY to confirm on).
                    if (app.headless) {
                        feed2.fireCardAction(r.cardId, act.value);
                        return;
                    }
                    void app.openPicker(String(act.confirmText ?? tf('确认执行「{0}」？', [act.label])), [
                        { label: t('确认'), value: 'yes' },
                        { label: t('取消'), value: 'no' },
                    ]).then((sel) => {
                        if (sel === 'yes') {
                            try {
                                feed2.fireCardAction(r.cardId, act.value);
                            }
                            catch (err) {
                                app.notice(tf('⚠ 卡片操作失败: {0}', [err.message]));
                            }
                        }
                    });
                    return;
                }
                if (kind === 'input') {
                    // headless degrades to plain (no input box to type into).
                    if (app.headless) {
                        feed2.fireCardAction(r.cardId, act.value);
                        return;
                    }
                    const prompt = String(act.inputPrompt ?? `输入「${act.label}」的参数`);
                    app.slices.ext.setPendingCardInput({ mark, actionIdx: idx, prompt });
                    if (typeof act.inputDefault === 'string' && act.inputDefault !== '') {
                        void app.luaCall('require("dsh_tui").fill_input(...)', [act.inputDefault]).catch(() => { });
                    }
                    app.notice(tf('✎ {0}（Enter 提交 · 空输入取消）', [prompt]));
                    return;
                }
                feed2.fireCardAction(r.cardId, act.value);
            }
            catch (err) {
                app.notice(tf('⚠ 卡片操作失败: {0}', [err.message]));
            }
        };
        try {
            const action = typeof payload.action === 'number' ? payload.action : null;
            const res = feed.activateCard(mark, action);
            if (res === null)
                return;
            if (Array.isArray(res)) {
                if (res.length === 0)
                    return;
                // Kind badges: confirm ⚠ / input ✎ — the picker shows what
                // happens BEFORE anything fires.
                const items = res.map((a) => ({
                    label: (a.kind === 'confirm' ? '⚠ ' : a.kind === 'input' ? '✎ ' : '') + a.label,
                    value: a.value,
                }));
                void app.openPicker(t('卡片操作'), items).then((value) => {
                    if (value === null)
                        return;
                    const idx = res.findIndex((i) => i.value === value) + 1;
                    if (idx > 0)
                        dispatch(feed, idx);
                });
                return;
            }
            // Direct 1-9: the dispatcher handles the kind.
            dispatch(feed, action);
        }
        catch (err) {
            app.notice(tf('⚠ 卡片操作失败: {0}', [err.message]));
        }
    });
}
/** nvim `request` side of the dsh-ext bus (moved out of boot): every
 *  vim.rpcrequest(channel, 'dsh-ext', …) gets a BOUNDED response —
 *  vim.rpcrequest blocks nvim uninterruptibly (and cannot be cancelled from
 *  Lua), so a hung handler freezes the UI forever. The runner races the
 *  handler against its timeout and answers an error when it overruns; late
 *  handler results are discarded (answered flag guards the single-send
 *  channel). NOTE: nvim DOES process events while blocked in rpcrequest, so
 *  handlers may safely make nested nvim calls (verified empirically). */
export function handleDshExtRequest(app, method, args, resp) {
    void (async () => {
        let answered = false;
        const reply = (r) => {
            if (answered)
                return;
            answered = true;
            // msgpack-safe payload: undefined/functions/BigInt would make
            // resp.send throw AFTER `answered` was set — the peer would block in
            // vim.rpcrequest forever. Clean first, then send.
            let payload = r;
            try {
                payload = JSON.parse(JSON.stringify(r));
            }
            catch {
                payload = { ok: false, error: 'ext handler returned a non-serializable value' };
            }
            try {
                resp.send(payload);
            }
            catch { /* peer went away mid-handler: nothing to answer */ }
        };
        if (method !== 'dsh-ext') {
            reply({ ok: false, error: `unsupported request: ${method}` });
            return;
        }
        const payload = (args?.[0] ?? {});
        const extId = typeof payload.id === 'string' ? payload.id : '';
        const m = typeof payload.method === 'string' ? payload.method : '';
        const entry = extId === '' ? undefined : app.slices.ext.extNodeHandlers.get(extId);
        if (entry === undefined) {
            reply({ ok: false, error: `no ext handler: ${extId}.${m || '?'}` });
            return;
        }
        const deadline = setTimeout(() => {
            reply({ ok: false, error: `ext handler timeout: ${extId}.${m} (${entry.timeoutMs}ms)` });
        }, entry.timeoutMs);
        try {
            const value = await entry.handler(m, Array.isArray(payload.args) ? payload.args : []);
            clearTimeout(deadline);
            reply({ ok: true, value });
        }
        catch (err) {
            clearTimeout(deadline);
            reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
    })();
}
/** Extension readiness announce (moved out of boot): resolve the ready
 *  promise, notify Node subscribers, and fire the nvim-side User DshTuiReady
 *  autocmd. */
export function announceReady(app) {
    const first = app.slices.ext.fireExtReady();
    app.slices.ext.setPendingCardInput(null);
    // Node-side tui:ready is one-shot per process (hmr reloads must not
    // double-announce); the nvim-side Ready autocmd fires per boot — the new
    // nvim instance's plugins need it every time.
    if (first)
        app.slices.ext.extFire('tui:ready', { active: app.slices.sessions.activeId });
    void app.luaCall('require("dsh_tui.api").emit(...)', ['Ready', { active: app.slices.sessions.activeId }]).catch(() => { });
}
