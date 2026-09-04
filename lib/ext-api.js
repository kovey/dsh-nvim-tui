/** Extension API version (semver, independent of the bundle version). */
export const EXT_API_VERSION = '0.1.0';
/** Install the extension API onto the App (runs before boot; index.ts then
 *  publishes the built surface through the cordis registry). */
export function installExtApi(app) {
    const listeners = new Map();
    const sessionSubs = [];
    /** Fire a tui:* event; subscriber throws are contained (feed notice). */
    const fire = (event, payload) => {
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
            if (app.nvim === null)
                return Promise.reject(new Error('nvim not connected'));
            return app.nvim.call(fn, args);
        },
        lua: (code, args = []) => app.luaCall(code, args),
        ex: async (cmd) => {
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
            card: !app.headless,
            float: !app.headless,
            picker: !app.headless,
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
    };
    app.extApi = api;
    app.extFire = fire;
    app.extSessionSubs = sessionSubs;
    /** session/event mirror dispatch (P3 fills the Lua-side routing; the
     *  Node-side subscribers work from P0 on). Called by boot.ts's
     *  session/event handler AFTER the TUI's own routing. */
    app.extDispatchSessionEvent = (sessionId, event) => {
        if (sessionSubs.length === 0)
            return;
        const matches = (f) => {
            if (f.sessionId !== undefined && f.sessionId !== sessionId)
                return false;
            if (f.type === undefined)
                return true;
            const kinds = Array.isArray(f.type) ? f.type : [f.type];
            return kinds.includes(event.type);
        };
        for (const { filter, cb } of sessionSubs) {
            if (!matches(filter))
                continue;
            try {
                cb(sessionId, event);
            }
            catch (err) {
                app.notice(`⚠ 扩展会话事件 ${event.type} 处理失败: ${err.message}`);
            }
        }
    };
}
