/** dsh_tui command: /cordis — inspect the process-local dynamic Cordis plugins
 *  (dsh-cordis-host-runner). Read-only by design: defining/running a dynamic
 *  plugin is the model-facing tool's job; the TUI shows what exists and what
 *  an active run registered. */
import { t, tf } from '../../kernel/i18n.js';
const pretty = (value) => {
    try {
        return JSON.stringify(value, null, 2) ?? String(value);
    }
    catch {
        return String(value);
    }
};
const showJson = async (app, title, value) => {
    const lines = pretty(value).split('\n');
    if (lines.length > 400)
        lines.splice(400, lines.length - 400, tf('…（仅显示前 {0} 行）', ['400']));
    await app.luaCall('require("dsh_tui").show_lines_float(...)', [title, lines]).catch(() => { });
};
export const cordisCommand = async (app, a) => {
    const svc = app.svc('dynamicCordisRunner');
    if (svc === undefined) {
        app.notice(t('dynamicCordisRunner 未装配（/deps install 可装配 cordis-host-runner）'));
        return;
    }
    const arg = (a ?? '').trim();
    if (arg === 'inventory') {
        if (typeof svc.inventory !== 'function') {
            app.notice(t('该宿主没有 inventory'));
            return;
        }
        await showJson(app, t('Cordis 运行时库存'), svc.inventory());
        return;
    }
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec) {
        app.notice(t('无活跃会话'));
        return;
    }
    if (arg === 'snapshot' || arg === 'all') {
        if (typeof svc.snapshot !== 'function') {
            app.notice(t('该宿主没有 snapshot'));
            return;
        }
        await showJson(app, t('Cordis 动态插件快照'), svc.snapshot(rec.handle.agent));
        return;
    }
    let rows = [];
    try {
        rows = svc.snapshot?.(rec.handle.agent) ?? [];
    }
    catch (err) {
        app.notice(tf('读取 Cordis 快照失败: {0}', [err.message]));
        return;
    }
    if (rows.length === 0) {
        app.notice(t('本会话没有动态 Cordis 插件'));
        return;
    }
    const picked = await app.openPicker(t('动态 Cordis 插件（Enter 查看详情）'), rows.map((r) => ({
        label: `${r.pluginId ?? '?'} · ${(r.packages ?? []).map((p) => p.name ?? '?').join(' / ') || t('无 package')}${r.activeRun !== undefined ? ' · ▶' : ''}`,
        value: String(r.pluginId ?? ''),
    })));
    if (picked === null)
        return;
    if (typeof svc.inspectPlugin !== 'function') {
        app.notice(t('该宿主没有 inspectPlugin'));
        return;
    }
    try {
        await showJson(app, tf('Cordis 插件 {0}', [picked]), svc.inspectPlugin(rec.handle.agent, picked));
    }
    catch (err) {
        app.notice(tf('读取插件详情失败: {0}', [err.message]));
    }
};
export function installCordisCommand(app) {
    app.registerCommands([{
            name: '/cordis',
            desc: t('动态 Cordis 插件检查（snapshot/inspect/inventory）'),
            usage: t('[inventory|snapshot]'),
            group: t('信息'),
            args: [{ kind: 'oneof', values: ['inventory', 'snapshot'], hint: t('不填则列出本会话动态插件') }],
            fn: (a) => cordisCommand(app, a),
        }]);
}
