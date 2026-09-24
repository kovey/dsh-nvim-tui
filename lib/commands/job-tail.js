/**
 * Live tail of one background job's output (`/tasks log <id>`).
 *
 * WHY: a long command or workflow can be handed to the background, and the job
 * registry only exposes status/progress — so the user had no way to watch what
 * it is actually doing. `JobView.output.spillPaths` names the complete stream on
 * disk while the producer keeps one, which is enough to tail it.
 *
 * The display reuses the EXISTING live-progress float (`show_progress` +
 * `progress_update`, the same one plugin installs use): it already keeps a
 * window open and tails the newest lines, which is exactly this shape. A second
 * float implementation would be a second set of close/teardown bugs.
 *
 * @module dsh-nvim-tui/commands/job-tail
 */
import { readFileSync, statSync } from 'node:fs';
import { t, tf } from '../kernel/i18n.js';
/** Lines kept for the tail. Enough to read context, small enough to push often. */
const MAX_LINES = 200;
/** Poll cadence. Matches the statusline's idle refresh — no tighter, or a busy
 *  job's tail competes with the streaming path for RPC bandwidth. */
const POLL_MS = 700;
/** One live tail per app instance (a second `/tasks log` replaces the first). */
const tails = new WeakMap();
const stopTail = (app) => {
    const prev = tails.get(app);
    if (prev !== undefined)
        clearInterval(prev.timer);
    tails.delete(app);
};
/** Append `text` to the ring, keeping at most MAX_LINES. */
const pushLines = (lines, text) => {
    for (const line of text.split('\n'))
        lines.push(line);
    const excess = lines.length - MAX_LINES;
    if (excess > 0)
        lines.splice(0, excess);
};
/**
 * Tail one job's output into the live float until it settles or the float is
 * closed. Returns immediately: the caller does not wait for the job.
 */
export const jobTailCommand = async (app, jobId) => {
    const jobs = app.svc('jobs');
    if (jobs === undefined) {
        app.notice(t('jobs 服务未装配'));
        return;
    }
    const rec = app.slices.sessions.activeId === null
        ? undefined
        : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec) {
        app.notice(t('无活跃会话'));
        return;
    }
    stopTail(app);
    const find = () => {
        let list;
        try {
            list = jobs.list(rec.handle.agent);
        }
        catch {
            return undefined;
        }
        const j = list.find((x) => x['id'] === jobId);
        if (j === undefined)
            return undefined;
        const output = j['output'];
        const spill = output?.spillPaths?.[0];
        // `exactOptionalPropertyTypes`: build only the keys we actually have.
        const snap = {};
        const put = (k, v) => {
            if (typeof v === 'string')
                snap[k] = v;
        };
        put('label', j['label']);
        put('status', j['status']);
        put('progress', j['progress']);
        put('detail', j['detail']);
        put('spill', spill);
        return snap;
    };
    const first = find();
    if (first === undefined) {
        app.notice(tf('找不到任务 {0}', [jobId]));
        return;
    }
    const lines = [];
    const head = `${jobId} · ${first.label ?? ''}`;
    lines.push(head);
    await app.luaCall('require("dsh_tui").show_progress(...)', [tf('任务 {0}', [jobId]), [...lines]]).catch(() => { });
    const state = { timer: setInterval(() => { }, POLL_MS), offset: 0, lines };
    tails.set(app, state);
    clearInterval(state.timer);
    const tick = async () => {
        const now = find();
        if (now === undefined) {
            await app.luaCall('require("dsh_tui").progress_update(...)', [[...lines], t('任务已从注册表消失')]).catch(() => { });
            stopTail(app);
            return;
        }
        // Read whatever the producer appended since the last tick. A spill file can
        // rotate away (the producer stops keeping it) — then just stop growing and
        // say so, rather than showing a stale tail as if it were live.
        if (now.spill !== undefined) {
            try {
                const size = statSync(now.spill).size;
                if (size > state.offset) {
                    const text = readFileSync(now.spill).subarray(state.offset).toString('utf8');
                    state.offset = size;
                    pushLines(lines, text);
                }
            }
            catch {
                /* file gone or unreadable: keep what we have */
            }
        }
        const bar = [
            now.status ?? '',
            now.progress ?? '',
            now.detail ?? '',
            now.spill === undefined ? t('（无输出文件）') : '',
        ].filter((x) => x !== '').join(' · ');
        await app.luaCall('require("dsh_tui").progress_update(...)', [[...lines], bar]).catch(() => { });
        if (now.status !== 'running' && now.status !== 'stopping') {
            stopTail(app);
        }
    };
    state.timer = setInterval(() => { void tick(); }, POLL_MS);
    await tick();
};
/** Test seam: is a tail currently polling for this app? */
export const jobTailActive = (app) => tails.has(app);
