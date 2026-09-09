/** dsh_tui command: /restart — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js';
import { spawn } from 'node:child_process';
/** /restart — respawn the dsh command and exit this process. */
export const restartCommand = async (app) => {
    const ok = await app.openPicker(t('确认重启'), [
        { label: t('重启 dsh 进程'), value: 'yes' },
        { label: t('取消'), value: 'no' },
    ]);
    if (ok !== 'yes')
        return;
    try {
        const next = spawn(process.argv[0], process.argv.slice(1), { stdio: 'inherit', detached: true });
        next.unref();
        app.notice(t('正在重启…'));
        setTimeout(() => void app.quit(0), 300);
    }
    catch (err) {
        app.notice(`重启失败: ${err.message}`);
    }
};
export function installRestartCommand(app) {
    app.registerCommands([{ name: '/restart', desc: t('重启 dsh 进程'), usage: t('重启'), group: t('系统'), fn: () => restartCommand(app) }]);
}
