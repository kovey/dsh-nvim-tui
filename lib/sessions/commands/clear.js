/** dsh_tui command: /clear — one command per file. */
import { t } from '../../kernel/i18n.js';
export function installClearCommand(app) {
    app.registerCommands([{ name: '/clear', desc: t('清空当前会话屏幕'), usage: t(''), group: t('会话'), fn: () => app.slices.ui.activeFeed()?.clear() }]);
}
