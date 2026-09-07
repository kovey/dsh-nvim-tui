/** Extension API version (semver, independent of the bundle version). */
export const EXT_API_VERSION = '0.1.0';
/** Default upper bound for one dsh-ext handler execution (both directions).
 *  vim.rpcrequest blocks nvim uninterruptibly and cannot be cancelled from
 *  Lua — the bounded answer is the ONLY freeze protection, so the runner
 *  always answers within this window (timeout → structured error; late
 *  results are discarded). */
export const EXT_HANDLER_TIMEOUT_MS = 30_000;
/** Pure filter match (exported for unit tests). */
export function matchSessionEventFilter(filter, sessionId, eventType) {
    if (filter.sessionId !== undefined && filter.sessionId !== sessionId)
        return false;
    if (filter.type === undefined)
        return true;
    const kinds = Array.isArray(filter.type) ? filter.type : [filter.type];
    return kinds.includes(eventType);
}
/** Install the extension API onto the App (runs before boot; index.ts then
 *  publishes the built surface through the cordis registry). */
export function installExtApi(app) {
    // -- ext domain defaults (I2: the ext slice lives here) --
    Object.assign(app.slices.ext, {
        extApi: null,
        extReadyResolve: null,
        extFire: () => { },
        extSessionSubs: [],
        extDispatchSessionEvent: () => { },
        extLuaSubs: new Map(),
        extNodeCleanup: null,
        pendingCardInput: null,
        extNodeHandlers: new Map(),
        extStatusSegments: new Map(),
    });
    const listeners = new Map();
    const sessionSubs = [];
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
                app.notice(`⚠ 扩展事件 ${event} 处理失败: ${err.message}`);
            }
        }
    };
    const nvimLayer = {
        request: (method, args = [], opts) => {
            if (app.slices.runtime.nvim === null)
                return Promise.reject(new Error('nvim not connected'));
            const p = app.slices.runtime.nvim.request(method, args);
            if (opts?.timeoutMs === undefined)
                return p;
            return Promise.race([
                p,
                new Promise((_, reject) => setTimeout(() => reject(new Error(`nvim.request ${method} 超时`)), opts.timeoutMs)),
            ]);
        },
        call: (fn, args = []) => {
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
            app.slices.ext.extReadyResolve = resolve;
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
                        app.notice(`⚠ 扩展事件 ${event} 处理失败: ${err.message}`);
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
                    app.notice(`⚠ ui.panel: ${String(res?.err ?? '不可用')}`);
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
                    app.notice(`⚠ ui.region: ${String(res?.err ?? '不可用')}`);
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
            const specs = cmds.map((c) => ({
                name: `/${c.name.replace(/^\//, '')}`,
                desc: c.desc,
                usage: c.usage ?? '',
                group: c.group ?? '扩展',
                fn: c.fn,
            }));
            app.registerCommands(specs);
            void app.refreshCommandCatalog().catch(() => { });
            return () => {
                const names = new Set(specs.map((s) => s.name));
                app.commandSpecs = app.commandSpecs.filter((s) => !names.has(s.name));
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
                const res = await Promise.race([
                    p,
                    new Promise((_, reject) => setTimeout(() => reject(new Error(`lua ext ${extId}.${method} timeout (${timeoutMs}ms)`)), timeoutMs)),
                ]);
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
                app.slices.ext.extNodeHandlers.set(extId, {
                    handler,
                    timeoutMs: opts?.timeoutMs ?? EXT_HANDLER_TIMEOUT_MS,
                });
                return () => {
                    app.slices.ext.extNodeHandlers.delete(extId);
                };
            },
        },
    };
    app.slices.ext.extApi = api;
    app.slices.ext.extFire = fire;
    app.slices.ext.extSessionSubs = sessionSubs;
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
                    app.notice(`⚠ 扩展会话事件 ${event.type} 处理失败: ${err.message}`);
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
}
