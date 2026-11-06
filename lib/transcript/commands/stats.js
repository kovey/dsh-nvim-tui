/** dsh_tui command: /stats — per-turn developer statistics derived from the
 *  committed session log. This is the TUI counterpart of 0.2.2's developer
 *  statistics: turns/steps/tools, token and cache usage, wall time. */
import { t, tf } from '../../kernel/i18n.js';
const n = (value) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
/** Fold session events into per-turn counters. Pure, so the arithmetic is
 *  testable without a live harness. */
export const collectTurnStats = (events) => {
    const byTurn = new Map();
    const currentTurn = () => {
        for (let i = events.length - 1; i >= 0; i--) {
            const event = events[i];
            if (event?.type !== 'turn/start')
                continue;
            const turn = event.data?.turn;
            return turn === undefined ? undefined : byTurn.get(turn);
        }
        return undefined;
    };
    let active;
    for (const event of events) {
        const data = event.data;
        if (event.type === 'turn/start') {
            const turn = data?.turn;
            if (turn === undefined)
                continue;
            active = { turn, steps: 0, tools: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, stepSet: new Set() };
            byTurn.set(turn, active);
            continue;
        }
        if (event.type === 'turn/end') {
            const turn = data?.turn ?? active?.turn;
            const row = turn === undefined ? undefined : byTurn.get(turn);
            const start = [...events].reverse().find((e) => e.type === 'turn/start' && e.data?.turn === turn);
            if (row !== undefined && start?.time !== undefined && event.time !== undefined)
                row.durationMs = Math.max(0, event.time - start.time);
            active = undefined;
            continue;
        }
        if (event.type === 'step/start' && data?.step !== undefined) {
            const row = data.turn === undefined ? currentTurn() : byTurn.get(data.turn);
            if (row !== undefined) {
                row.stepSet.add(data.step);
                row.steps = row.stepSet.size;
            }
            continue;
        }
        if (event.type === 'tool/call') {
            const row = data?.turn === undefined ? active : byTurn.get(data.turn);
            if (row !== undefined)
                row.tools++;
            continue;
        }
        if (event.type === 'assistant/message' && data?.usage !== undefined) {
            const row = data.turn === undefined ? active : byTurn.get(data.turn);
            if (row === undefined)
                continue;
            row.input += n(data.usage.inputTokens);
            row.output += n(data.usage.outputTokens);
            row.cacheRead += n(data.usage.cacheReadTokens);
            row.cacheWrite += n(data.usage.cacheWriteTokens);
        }
    }
    const turns = [...byTurn.values()].map(({ stepSet: _stepSet, ...row }) => row);
    const totals = turns.reduce((sum, row) => ({
        steps: sum.steps + row.steps,
        tools: sum.tools + row.tools,
        input: sum.input + row.input,
        output: sum.output + row.output,
        cacheRead: sum.cacheRead + row.cacheRead,
        cacheWrite: sum.cacheWrite + row.cacheWrite,
    }), { steps: 0, tools: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    return { turns, totals };
};
const fmt = (value) => value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
export const statsCommand = async (app, a) => {
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec) {
        app.notice(t('无活跃会话'));
        return;
    }
    const events = app.slices.trans.sessionEvents(rec.handle.agent.session);
    const all = collectTurnStats(events);
    if (all.turns.length === 0) {
        app.notice(t('本会话还没有回合'));
        return;
    }
    const wanted = (a ?? '').trim();
    const parsed = wanted === '' ? undefined : Number(wanted.replace(/^#/, ''));
    const rows = parsed !== undefined && Number.isInteger(parsed)
        ? all.turns.filter((row) => row.turn === parsed)
        : all.turns;
    if (rows.length === 0) {
        app.notice(tf('找不到回合 {0}', [wanted]));
        return;
    }
    const totals = parsed === undefined ? all.totals : rows[0];
    const lines = [
        `${t('会话统计')} · ${rec.title ?? rec.id}`,
        '',
        `${t('轮次')} ${all.turns.length} · ${t('步骤')} ${totals.steps} · ${t('工具')} ${totals.tools}`,
        `tokens: in ${fmt(totals.input)} · out ${fmt(totals.output)} · cache r ${fmt(totals.cacheRead)} / w ${fmt(totals.cacheWrite)}`,
        '',
    ];
    for (const row of rows) {
        const cache = row.input + row.cacheRead > 0 ? Math.round((row.cacheRead / (row.input + row.cacheRead)) * 100) : null;
        lines.push(`#${row.turn} · ${row.steps} ${t('步')} · ${row.tools} ${t('工具')} · in ${fmt(row.input)} → out ${fmt(row.output)}${cache === null ? '' : ` · cache ${cache}%`}${row.durationMs === undefined ? '' : ` · ${(row.durationMs / 1000).toFixed(1)}s`}`);
    }
    void app.luaCall('require("dsh_tui").show_lines_float(...)', [t('会话统计'), lines]).catch(() => { });
};
export function installStatsCommand(app) {
    app.registerCommands([{
            name: '/stats',
            desc: t('按轮次查看步骤、工具、token/缓存统计'),
            usage: t('[回合号]'),
            group: t('信息'),
            args: [{ kind: 'free', label: '[回合号]', hint: t('不填则显示全部回合') }],
            fn: (a) => statsCommand(app, a),
        }]);
}
