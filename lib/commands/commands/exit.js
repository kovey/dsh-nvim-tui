/** dsh_tui command: /exit — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js';
export function installExitCommand(app) {
    app.registerCommands([{ name: '/exit', desc: t('退出 dsh'), usage: t('退出'), group: t('系统'), fn: () => app.quit(0) }]);
}
