/** dsh_tui command: /quit — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js';
export function installQuitCommand(app) {
    app.registerCommands([{
            name: '/quit',
            desc: t('退出（/exit 别名）'),
            usage: t(''),
            group: t('系统'),
            fn: async () => {
                const ok = await app.openPicker(t('确认退出'), [
                    { label: t('退出 dsh'), value: 'yes' },
                    { label: t('取消'), value: 'no' },
                ]);
                if (ok === 'yes')
                    app.quit(0);
            },
        }]);
}
