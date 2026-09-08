/** dsh_tui command: /cost — one command per file. */
import { t } from '../../kernel/i18n.js';
import { billedInput } from '../../feed/stats.js';
import { estimateCost } from '../../feed/stats.js';
import { formatTokens } from '../../feed/stats.js';
export const costCommand = (app) => {
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec?.usage) {
        app.notice(t('本会话暂无用量数据'));
        return;
    }
    const u = rec.usage;
    const billed = billedInput(u);
    const cost = rec.model ? estimateCost(rec.model, u) : undefined;
    app.notice(`输入 ${formatTokens(u.input)} · 缓存读 ${formatTokens(u.cacheRead)} · 输出 ${formatTokens(u.output)}`);
    app.notice(`billed 输入 ${formatTokens(billed)} · 总计 ${formatTokens(billed + u.output)}` +
        (cost !== undefined ? ` · 预估 $${cost.toFixed(2)}` : ''));
};
export function installCostCommand(app) {
    app.registerCommands([{ name: '/cost', desc: t('用量与成本'), usage: t('用量成本'), group: t('信息'), fn: () => costCommand(app) }]);
}
