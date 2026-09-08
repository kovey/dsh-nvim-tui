/** dsh_tui command: /bell — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js';
const W = (d) => d;
/** /bell [on|off] — terminal bell on turn end (approvals always ring). */
export const bellCommand = (app, a) => {
    if ((a ?? '').trim() !== '')
        W(app.slices.agent).bellOn = String(a).trim() === 'on';
    else
        W(app.slices.agent).bellOn = !app.slices.agent.bellOn;
    app.notice(`回合结束响铃: ${app.slices.agent.bellOn ? '开' : '关'}`);
};
export function installBellCommand(app) {
    app.registerCommands([{ name: '/bell', desc: t('回合结束响铃开关'), usage: t('[on|off]'), group: t('系统'), fn: (a) => bellCommand(app, a) }]);
}
