/** dsh_tui command: /btw — one command per file. */
import { t } from '../../kernel/i18n.js';
import { forkSession } from '../services.js';
export function installBtwCommand(app) {
    app.registerCommands([{ name: '/btw', desc: t('侧问：分叉新会话并发送问题'), usage: t('<问题>'), group: t('会话'), fn: (a) => {
                if (!a) {
                    app.notice(t('用法: /btw <question>（分叉新会话并发送该问题）'));
                    return;
                }
                return forkSession(app, a);
            } }]);
}
