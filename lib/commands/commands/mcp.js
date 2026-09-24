/** dsh_tui command: /mcp — one command per file (self-registering,
 *  wired by the commands module index). */
import { t, tf } from '../../kernel/i18n.js';
/** /mcp — MCP tools grouped by server (prefix mcp__<server>__<tool>). */
export const mcpCommand = (app) => {
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec) {
        app.notice(t('无活跃会话'));
        return;
    }
    const tools = app.svc('tools');
    if (tools === undefined) {
        app.notice(t('tools 服务未装配'));
        return;
    }
    const byServer = new Map();
    const names = new Set();
    for (const s of tools.schemas(rec.handle.agent)) {
        names.add(s.name);
        if (!s.name.startsWith('mcp__'))
            continue;
        const server = s.name.slice(5).split('__')[0];
        byServer.set(server, (byServer.get(server) ?? 0) + 1);
    }
    if (byServer.size === 0) {
        app.notice(t('（没有已连接的 MCP server）'));
        return;
    }
    for (const [server, count] of byServer)
        app.notice(tf('🔌 {0}: {1} 个工具', [server, count]));
    // dsh 0.1.7 added MCP resource support as three SHARED tools (registered by
    // `mcpResources` for the agent to call), not as a service the UI can query —
    // measured: `McpResourceRuntime` exposes only `register(server, provider)` to
    // connection plugins, so a `/mcp resources` listing is not implementable from
    // here. Report them when they are actually present, so the user knows the
    // capability exists and that the AGENT is the one that drives it.
    const shared = [
        'list_mcp_resources',
        'list_mcp_resource_templates',
        'read_mcp_resource',
    ].filter((n) => names.has(n));
    if (shared.length > 0) {
        app.notice(tf('📄 资源类工具已启用（{0}）—— 让 agent 调用，TUI 无法直接列出资源', [shared.join(' · ')]));
    }
};
export function installMcpCommand(app) {
    app.registerCommands([{ name: '/mcp', desc: t('MCP server 工具统计'), usage: t(''), group: t('信息'), fn: () => mcpCommand(app) }]);
}
