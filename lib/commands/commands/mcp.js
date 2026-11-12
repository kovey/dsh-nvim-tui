/** dsh_tui command: /mcp — MCP inventory and configuration surface.
 *
 * MCP servers are cordis rows (`dsh-mcp-client`), so this command can show the
 * live servers and their tools but must not invent an "add server" UI that
 * only edits a different file than the loader reads. Resource listing is a
 * host limitation too: McpResourceRuntime only exposes register() to servers,
 * not a query seam for the UI. */
import { t, tf } from '../../kernel/i18n.js';
const redact = (value) => {
    try {
        const text = JSON.stringify(value);
        return text === undefined ? '' : text.length > 160 ? text.slice(0, 160) + '…' : text;
    }
    catch {
        return String(value);
    }
};
const rowsOf = (app) => {
    const loader = app.svc('loader');
    return (loader?.entries?.() ?? [])
        .filter((e) => typeof e.options?.name === 'string' && e.options.name.includes('mcp-client'))
        .map((e) => ({
        ...(e.id !== undefined ? { id: e.id } : {}),
        ...(e.options?.name !== undefined ? { name: e.options.name } : {}),
        config: e.options?.config !== null && typeof e.options?.config === 'object'
            ? e.options.config
            : {},
    }));
};
export const mcpCommand = async (app, a) => {
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
    const arg = (a ?? '').trim();
    const manager = app.svc('mcpManager');
    if (arg === 'status') {
        if (manager === undefined) {
            app.notice(t('MCP manager 未装配（需要 rc.2 dsh-mcp-manager）'));
            return;
        }
        try {
            const rows = manager.list();
            if (rows.length === 0) {
                app.notice(t('没有 MCP server'));
                return;
            }
            const lines = [t('MCP server 状态'), '', ...rows.map((row) => {
                    const status = row.status ?? {};
                    const state = typeof status['state'] === 'string' ? status['state'] : 'unknown';
                    const reason = typeof status['reason'] === 'string' ? ` · ${status['reason']}` : '';
                    const error = typeof status['lastError'] === 'string' ? ` · ${status['lastError']}` : '';
                    return `▸ ${row.name}${row.configured === false ? t('（已移除，保留清理记录）') : ''} · ${state}${reason}${error}`;
                })];
            await app.luaCall('require("dsh_tui").show_lines_float(...)', [t('MCP server 状态'), lines]);
        }
        catch (err) {
            app.notice(tf('读取 MCP 状态失败: {0}', [err.message]));
        }
        return;
    }
    if (arg.startsWith('restart ')) {
        if (manager === undefined) {
            app.notice(t('MCP manager 未装配（需要 rc.2 dsh-mcp-manager）'));
            return;
        }
        const name = arg.slice('restart '.length).trim();
        if (name === '') {
            app.notice(t('用法: /mcp restart <server>'));
            return;
        }
        try {
            await manager.restart(name);
            app.notice(tf('MCP server 已重启: {0}', [name]));
        }
        catch (err) {
            app.notice(tf('MCP 重启失败: {0}', [err.message]));
        }
        return;
    }
    if (arg.startsWith('probe ')) {
        if (manager === undefined) {
            app.notice(t('MCP manager 未装配（需要 rc.2 dsh-mcp-manager）'));
            return;
        }
        const name = arg.slice('probe '.length).trim();
        if (name === '') {
            app.notice(t('用法: /mcp probe <server>'));
            return;
        }
        try {
            const result = await manager.probe(name, { signal: AbortSignal.timeout(30_000) });
            const text = JSON.stringify(result, null, 2);
            const lines = text === undefined ? [String(result)] : text.split('\n');
            await app.luaCall('require("dsh_tui").show_lines_float(...)', [tf('MCP probe: {0}', [name]), lines]);
        }
        catch (err) {
            app.notice(tf('MCP probe 失败: {0}', [err.message]));
        }
        return;
    }
    const names = new Set(tools.schemas(rec.handle.agent).map((s) => s.name));
    const byServer = new Map();
    for (const name of names) {
        if (!name.startsWith('mcp__'))
            continue;
        const rest = name.slice(5);
        const at = rest.indexOf('__');
        const server = at < 0 ? rest : rest.slice(0, at);
        const tool = at < 0 ? '' : rest.slice(at + 2);
        const list = byServer.get(server) ?? [];
        list.push(tool);
        byServer.set(server, list);
    }
    if (arg === 'config') {
        const rows = rowsOf(app);
        if (rows.length === 0) {
            app.notice(t('没有 mcp-client loader 行（MCP 未配置）'));
            return;
        }
        const lines = [t('MCP server 配置（来自 loader 行）'), ''];
        for (const row of rows) {
            const config = row.config ?? {};
            lines.push(`▸ ${row.id ?? '?'}`);
            lines.push(`  serverName: ${String(config['serverName'] ?? '?')} · transport: ${String(config['transport'] ?? '?')}`);
            if (config['url'] !== undefined)
                lines.push(`  url: ${String(config['url'])}`);
            if (config['command'] !== undefined)
                lines.push(`  command: ${String(config['command'])}`);
            if (config['headers'] !== undefined)
                lines.push(`  headers: ${redact(config['headers'])}`);
            if (config['env'] !== undefined)
                lines.push(`  env: ${redact(config['env'])}`);
        }
        lines.push('', t('新增/修改 server：编辑 profile 的 cordis.patch.yml 插入 dsh-mcp-client 行'));
        void app.luaCall('require("dsh_tui").show_lines_float(...)', [t('MCP 配置'), lines]).catch(() => { });
        return;
    }
    if (arg === 'tools') {
        const lines = [t('MCP 工具'), ''];
        for (const [server, list] of byServer) {
            lines.push(`🔌 ${server}: ${String(list.length)} 个`);
            for (const tool of list.sort())
                lines.push(`  · ${tool}`);
        }
        if (byServer.size === 0)
            lines.push(t('（没有已连接的 MCP server）'));
        void app.luaCall('require("dsh_tui").show_lines_float(...)', [t('MCP 工具'), lines]).catch(() => { });
        return;
    }
    if (arg === 'resources') {
        const shared = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].filter((n) => names.has(n));
        const lines = [
            t('MCP 资源'),
            '',
            shared.length > 0
                ? tf('资源类工具已启用（{0}）—— 让 agent 调用，TUI 侧无法直接枚举资源', [shared.join(' · ')])
                : t('资源类工具未注册（需要 dsh-mcp-resources 行）'),
            '',
            t('宿主 McpResourceRuntime 只向 server 暴露 register()，没有供 UI 查询的枚举接口；这不是漏做。'),
            t('用 /mcp tools 查看工具，/mcp config 查看 server 行配置。'),
        ];
        void app.luaCall('require("dsh_tui").show_lines_float(...)', [t('MCP 资源'), lines]).catch(() => { });
        return;
    }
    if (byServer.size === 0) {
        app.notice(t('（没有已连接的 MCP server；/mcp config 查看配置）'));
        return;
    }
    for (const [server, list] of byServer)
        app.notice(tf('🔌 {0}: {1} 个工具', [server, String(list.length)]));
    const sharedResources = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].filter((n) => names.has(n));
    if (sharedResources.length > 0) {
        app.notice(tf('📄 资源工具: {0}（agent 驱动；/mcp resources 查看说明）', [sharedResources.join(' · ')]));
    }
    app.notice(t('更多: /mcp tools · /mcp config · /mcp resources'));
};
export function installMcpCommand(app) {
    app.registerCommands([{
            name: '/mcp',
            desc: t('MCP server 工具/配置/状态/重启/探测'),
            usage: t('[tools|config|resources|status|restart <server>|probe <server>]'),
            group: t('信息'),
            args: [{ kind: 'oneof', values: ['tools', 'config', 'resources', 'status'], hint: t('restart/probe 后接 server 名') }],
            fn: (a) => mcpCommand(app, a),
        }]);
}
