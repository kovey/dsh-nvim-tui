/** Extension API version (semver, independent of the bundle version). */
export const EXT_API_VERSION = '0.1.0';
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
    const listeners = new Map();
    const sessionSubs = [];
    /** Node-side floats opened via ui.float: key → win id. */
    const nodeFloats = new Map();
    let floatSeq = 0;
    /** Last payload per fired event — late subscribers of one-shot lifecycle
     *  events (tui:ready / tui:active-session) get an immediate replay. */
    const lastFired = new Map();
    /** Nested-call deadlock guard: inside a dsh-ext handler nvim is blocked
     *  in vim.rpcrequest — any nvim round-trip from here can never be
     *  answered. Reject loudly instead of wedging both sides. */
    const assertNotInExtHandler = (what) => {
        if (app.extBusInHandler) {
            throw new Error(`${what}: dsh-ext 处理器内禁止调用 nvim（nvim 正阻塞等待本应答，会死锁）`);
        }
    };
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
            assertNotInExtHandler('nvim.request');
            if (app.nvim === null)
                return Promise.reject(new Error('nvim not connected'));
            const p = app.nvim.request(method, args);
            if (opts?.timeoutMs === undefined)
                return p;
            return Promise.race([
                p,
                new Promise((_, reject) => setTimeout(() => reject(new Error(`nvim.request ${method} 超时`)), opts.timeoutMs)),
            ]);
        },
        call: (fn, args = []) => {
            assertNotInExtHandler('nvim.call');
            if (app.nvim === null)
                return Promise.reject(new Error('nvim not connected'));
            return app.nvim.call(fn, args);
        },
        lua: (code, args = []) => {
            assertNotInExtHandler('nvim.lua');
            return app.luaCall(code, args);
        },
        ex: async (cmd) => {
            assertNotInExtHandler('nvim.ex');
            if (app.nvim === null)
                throw new Error('nvim not connected');
            await app.nvim.command(cmd);
        },
    };
    const api = {
        version: EXT_API_VERSION,
        ready: new Promise((resolve) => {
            app.extReadyResolve = resolve;
        }),
        capabilities: () => ({
            headless: app.headless,
            // cards/floats/pickers render fine in headless too (useful for e2e
            // dumps); the panel slot is the one primitive gated off.
            card: true,
            float: true,
            picker: true,
            panel: !app.headless,
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
            // Late-subscribe replay: one-shot lifecycle events already fired are
            // re-delivered immediately so consumers never miss boot.
            const last = lastFired.get(event);
            if (last !== undefined) {
                try {
                    cb(last.payload);
                }
                catch (err) {
                    app.notice(`⚠ 扩展事件 ${event} 处理失败: ${err.message}`);
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
        getActiveSessionId: () => app.activeId,
        submit: (text) => app.send(text),
        insertInput: (text) => {
            void app.luaCall('require("dsh_tui").fill_input(...)', [text]).catch(() => { });
        },
        ui: {
            card: (opts) => {
                const feed = (opts.sessionId !== undefined
                    ? app.sessions.get(opts.sessionId)?.feed
                    : undefined) ?? app.activeFeed();
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
                });
                if (opts.ttlMs !== undefined && opts.ttlMs > 0) {
                    setTimeout(() => handle.dismiss(), opts.ttlMs);
                }
                return handle;
            },
            float: async (opts) => {
                assertNotInExtHandler('ui.float');
                if (app.nvim === null)
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
                assertNotInExtHandler('ui.floatClose');
                const win = nodeFloats.get(id);
                nodeFloats.delete(id);
                if (win === undefined)
                    return;
                await app.luaCall('require("dsh_tui.api").float_close(...)', ['__node__', win]).catch(() => { });
            },
            picker: (opts) => {
                assertNotInExtHandler('ui.picker');
                return app.openPicker(opts.title, opts.items);
            },
            notice: (text) => app.notice(text),
            statuslineSegment: (id, text, priority = 100) => {
                const clean = String(text);
                if (clean === '')
                    app.extStatusSegments.delete(id);
                else
                    app.extStatusSegments.set(id, { text: clean, priority });
                app.updateStatusline();
            },
            panel: async (opts) => {
                assertNotInExtHandler('ui.panel');
                if (app.nvim === null || app.headless)
                    return null;
                const res = await app.luaCall('return require("dsh_tui.api").panel_claim(...)', [
                    '__node__', { width: opts.width, title: opts.title, footer: opts.footer, lines: opts.lines ?? [] },
                ]);
                if (res === null || res === undefined || typeof res.err === 'string') {
                    app.notice(`⚠ ui.panel: ${String(res?.err ?? '不可用')}`);
                    return null;
                }
                if (typeof res.win !== 'number' || typeof res.buf !== 'number')
                    return null;
                return { win: res.win, buf: res.buf };
            },
            panelRelease: async () => {
                assertNotInExtHandler('ui.panelRelease');
                if (app.nvim === null)
                    return;
                await app.luaCall('require("dsh_tui.api").panel_release(...)', ['__node__']).catch(() => { });
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
            call: async (extId, method, args = []) => {
                const res = await app.luaCall('return require("dsh_tui.api").rpc_dispatch(...)', [
                    extId, method, args,
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
            on: (extId, handler) => {
                app.extNodeHandlers.set(extId, handler);
                return () => {
                    app.extNodeHandlers.delete(extId);
                };
            },
        },
    };
    app.extApi = api;
    app.extFire = fire;
    app.extSessionSubs = sessionSubs;
    /** session/event mirror dispatch: Node-side subscribers (filtered here)
     *  plus the Lua-side routing (extLuaSubs, fed by dsh-ext-register).
     *  Called by boot.ts's session/event handler AFTER the TUI's own routing. */
    app.extDispatchSessionEvent = (sessionId, event) => {
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
        if (app.extLuaSubs.size > 0) {
            const targets = [];
            for (const [id, kinds] of app.extLuaSubs) {
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
