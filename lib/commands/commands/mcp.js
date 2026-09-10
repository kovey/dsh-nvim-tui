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
    for (const s of tools.schemas(rec.handle.agent)) {
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
};
export function installMcpCommand(app) {
    app.registerCommands([{ name: '/mcp', desc: t('MCP server 工具统计'), usage: t(''), group: t('信息'), fn: () => mcpCommand(app) }]);
}
