/**
 * One-line text prompt bridged to nvim's `vim.ui.input`.
 *
 * The TUI has a full input buffer, but a command that asks for one field
 * (feedback category text, a schedule title, a settings value) needs a small
 * modal prompt, not a new input mode. One promise-keyed request per prompt;
 * cancellation and a failed Lua call both settle `null` so a command can never
 * hang forever on a closed float.
 *
 * @module dsh-nvim-tui/prompt
 */
import { randomUUID } from 'node:crypto';
const pending = new WeakMap();
/** Ask for one line. Resolves null on cancel / UI failure. */
export const promptLine = (app, title, defaultValue = '') => {
    const id = randomUUID();
    return new Promise((resolve) => {
        const map = pending.get(app) ?? new Map();
        pending.set(app, map);
        map.set(id, { resolve });
        void app.luaCall('require("dsh_tui").prompt_line(...)', [id, title, defaultValue]).catch(() => {
            map.delete(id);
            resolve(null);
        });
    });
};
/** Settle one prompt from the nvim notification. */
export const settlePrompt = (app, id, value) => {
    const map = pending.get(app);
    const entry = map?.get(id);
    if (map === undefined || entry === undefined)
        return;
    map.delete(id);
    if (map.size === 0)
        pending.delete(app);
    entry.resolve(value);
};
/** Settle every outstanding prompt (UI teardown / session switch). */
export const drainPrompts = (app) => {
    const map = pending.get(app);
    if (map === undefined)
        return;
    pending.delete(app);
    for (const entry of map.values())
        entry.resolve(null);
};
