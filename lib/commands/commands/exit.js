/** dsh_tui command: /exit — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js';
export function installExitCommand(app) {
    app.registerCommands([{
            name: '/exit',
            desc: t('退出 dsh'),
            usage: t('退出'),
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
