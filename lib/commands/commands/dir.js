/** dsh_tui command: /dir — one command per file (self-registering,
 *  wired by the commands module index). */
import { t, tf } from '../../kernel/i18n.js';
import { isAbsolute, join } from 'node:path';
import { openDirPicker } from '../core.js';
import { activeSessionCwd } from '../../kernel/app.js';
/** /dir [路径] — navigable directory browser: Enter on a file opens it in a
 *  fresh nvim tab (directories descend inside the float). */
export const dirCommand = async (app, a) => {
    const start = (a ?? '').trim();
    const base = start === '' ? activeSessionCwd(app) : (isAbsolute(start) ? start : join(activeSessionCwd(app), start));
    const picked = await openDirPicker(app, base);
    if (picked === null)
        return;
    const ok = await app.luaCall('return require("dsh_tui").open_file_tab(...)', [picked]).catch(() => false);
    if (ok === true)
        app.notice(tf('已打开 {0}（新标签页，gt/gT 切换）', [picked]));
};
export function installDirCommand(app) {
    app.registerCommands([{ name: '/dir', desc: t('目录浏览（文件回车在新标签页打开）'), usage: t('[路径]'), group: t('信息'), fn: (a) => dirCommand(app, a) }]);
}
