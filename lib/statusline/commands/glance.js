/** dsh_tui command: /glance — one command per file. */
import { t } from '../../kernel/i18n.js';
const GLANCE_SEGMENTS = ['cache', 'context', 'tokens', 'cost', 'elapsed', 'total'];
const hiddenGlance = new Set();
export const glanceCommand = (app, a) => {
    if (!a) {
        const shown = GLANCE_SEGMENTS.filter((s) => !hiddenGlance.has(s));
        app.notice(`glance 段: ${shown.join(' ') || '（全部隐藏）'} · 用法: /glance <segment>`);
        return;
    }
    const seg = GLANCE_SEGMENTS.find((s) => a.startsWith(s));
    if (!seg) {
        app.notice(`未知段 ${a}（可选: ${GLANCE_SEGMENTS.join(' ')})`);
        return;
    }
    if (hiddenGlance.has(seg))
        hiddenGlance.delete(seg);
    else
        hiddenGlance.add(seg);
    app.slices.ui.updateStatusline();
    app.notice(`glance ${seg}: ${hiddenGlance.has(seg) ? '隐藏' : '显示'}`);
};
/** /cost — accumulated usage + cost for the active session. */
export function installGlanceCommand(app) {
    app.registerCommands([{ name: '/glance', desc: t('状态栏段显隐'), usage: t('<cache|context|tokens|cost|elapsed|total>'), group: t('显示'), fn: (a) => glanceCommand(app, a) }]);
}
