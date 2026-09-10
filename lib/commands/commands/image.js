/** dsh_tui command: /image — one command per file (self-registering,
 *  wired by the commands module index). */
import { t, tf } from '../../kernel/i18n.js';
import { isAbsolute, join } from 'node:path';
import { readImageFile, expandHome } from '../../feed/images.js';
import { readClipboardImage } from '../../feed/images.js';
import { followup } from '../core.js';
import { activeSessionCwd } from '../../kernel/app.js';
const W = (d) => d;
/** /image [<path>] [prompt] — attach an image and send. No path on macOS
 *  reads the clipboard image via pbpaste (PNG bytes). `/image clear`
 *  drops the <C-v> pending queue. */
export const imageCommand = (app, a) => {
    if ((a ?? '').trim() === 'clear') {
        const n = app.slices.agent.pendingImages.length;
        W(app.slices.agent).pendingImages = [];
        app.notice(n > 0 ? tf('已清空 {0} 张待发送图片', [n]) : t('（没有待发送图片）'));
        return;
    }
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec) {
        app.notice(t('无活跃会话'));
        return;
    }
    const m = (a ?? '').match(/^(\S+)(?:\s+([\s\S]*))?$/);
    const prompt = (m?.[2] ?? '').trim();
    let image;
    if (m !== null && m[1] !== undefined) {
        try {
            // Relative paths resolve against the ACTIVE SESSION's cwd, not
            // process.cwd() (pre-review: /image ignored the kernel contract that
            // every local-file command joins activeSessionCwd).
            const expanded = expandHome(m[1]);
            const abs = isAbsolute(expanded) ? expanded : join(activeSessionCwd(app), expanded);
            image = readImageFile(abs);
        }
        catch (err) {
            app.notice(tf('读取图片失败: {0}', [err.message]));
            return;
        }
    }
    else if (process.platform === 'darwin') {
        image = readClipboardImage();
        if (image === null) {
            app.notice(t('剪贴板里没有图片（用法: /image <路径> [提示]；或先复制图片）'));
            return;
        }
    }
    else {
        app.notice(t('用法: /image <路径> [提示]'));
        return;
    }
    void followup(app, rec, prompt || '📎 图片消息', [image]);
};
export function installImageCommand(app) {
    app.registerCommands([{ name: '/image', desc: t('发送图片附件（识图）'), usage: t('<路径> [提示]'), group: t('会话'), fn: (a) => imageCommand(app, a) }]);
}
