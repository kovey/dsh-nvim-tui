/** dsh_tui command: /new — one command per file. */
import { t } from '../../kernel/i18n.js';
export function installNewCommand(app) {
    app.registerCommands([{ name: '/new', desc: t('新建会话（可带目录）'), usage: t('[目录]'), group: t('会话'), fn: (a) => app.slices.sessions.createSession((a ?? '').trim() || undefined) }]);
}
