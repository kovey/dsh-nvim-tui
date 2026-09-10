/** dsh_tui command: /export — one command per file. */
import { t, tf } from '../../kernel/i18n.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const exportCommand = async (app) => {
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec)
        return;
    try {
        const lines = await app.slices.runtime.nvim.request('nvim_buf_get_lines', [rec.feed.bufId, 0, -1, false]);
        const path = join(process.cwd(), `dsh-export-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
        writeFileSync(path, `# ${rec.title ?? rec.id}\n\n` + lines.join('\n') + '\n');
        app.notice(tf('已导出: {0}', [path]));
    }
    catch (err) {
        app.notice(tf('导出失败: {0}', [err.message]));
    }
};
/** /rewind — pick a user-message boundary, truncate the session after
 *  it, and rebuild the chat from the remaining events. */
export function installExportCommand(app) {
    app.registerCommands([{ name: '/export', desc: t('导出转录 md'), usage: t('导出转录'), group: t('信息'), fn: () => exportCommand(app) }]);
}
