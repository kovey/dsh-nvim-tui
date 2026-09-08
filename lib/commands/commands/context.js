/** dsh_tui command: /context — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js';
import { formatTokens } from '../../feed/stats.js';
import { billedInput } from '../../feed/stats.js';
/** /context — context composition breakdown (official client's
 *  occupancy ring panel counterpart): ~used/capacity, heuristic
 *  composition rows, claim window. */
export const contextCommand = async (app) => {
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec) {
        app.notice(t('无活跃会话'));
        return;
    }
    const projections = app.svc('sessionProjections');
    if (typeof projections?.stateOf === 'function') {
        try {
            const b = projections.stateOf(rec.handle.agent.session, 'contextBreakdown');
            if (b !== undefined) {
                const used = (b.systemTokens ?? 0) + (b.toolsTokens ?? 0) + (b.messageTokens ?? 0);
                const cap = rec.contextWindow;
                app.notice(`上下文占用 ≈${formatTokens(used)}${cap !== undefined ? `) / ${formatTokens(cap)} · ${Math.round((used / cap) * 100)}%` : ''}`);
                app.notice(`  system ${formatTokens(b.systemTokens ?? 0)} · tools ${formatTokens(b.toolsTokens ?? 0)} · messages ${formatTokens(b.messageTokens ?? 0)}`);
                if (b.claim !== undefined) {
                    app.notice(`  claim ${formatTokens(b.claim.tokens ?? 0)} tokens（seq ${b.claim.start ?? '?'}–${b.claim.end ?? '?'}）`);
                }
                return;
            }
        }
        catch { }
    }
    const usage = rec.lastUsage ?? rec.usage;
    app.notice(`上下文占用（按事件折叠）: ${usage !== undefined ? `)◧ ${formatTokens(billedInput(usage))}${rec.contextWindow !== undefined ? `/${formatTokens(rec.contextWindow)}` : ''}` : '暂无数据'}`);
};
export function installContextCommand(app) {
    app.registerCommands([{ name: '/context', desc: t('上下文组成分解'), usage: t('上下文组成'), group: t('信息'), fn: () => contextCommand(app) }]);
}
