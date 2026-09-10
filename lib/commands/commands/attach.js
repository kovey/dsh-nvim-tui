/** dsh_tui command: /attach — one command per file (self-registering,
 *  wired by the commands module index). */
import { t, tf } from '../../kernel/i18n.js';
import { isAbsolute, join } from 'node:path';
import { readImageFile, expandHome } from '../../feed/images.js';
import { imageLabel } from '../../feed/images.js';
import { openDirPicker } from '../core.js';
import { formatMention } from '../core.js';
import { activeSessionCwd } from '../../kernel/app.js';
/** /attach [path] — image → durable attachment; file/dir → @-mention.
 *  Without an argument a directory picker selects the target. */
export const attachCommand = async (app, a) => {
    let path = (a ?? '').trim();
    if (path === '') {
        path = await openDirPicker(app, activeSessionCwd(app));
        if (path === null)
            return;
    }
    const expanded = expandHome(path);
    const abs = isAbsolute(expanded) ? expanded : join(activeSessionCwd(app), expanded);
    // Detect on the BYTES: readImageFile reads the file and sniffs the
    // format (extension fallback); it throws for non-images, which is how
    // we tell "image attachment" from "@ path mention" below.
    let img = null;
    try {
        img = await readImageFile(abs);
    }
    catch { /* not a readable image → fall through to @-mention */ }
    if (img !== null) {
        const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
        const attachments = app.svc('attachments');
        if (!rec) {
            app.notice(t('无活跃会话'));
            return;
        }
        if (typeof attachments?.saveImage !== 'function') {
            app.notice(t('附件服务未装配（attachments.saveImage 缺失）'));
            return;
        }
        try {
            const ref = await attachments.saveImage(img);
            app.slices.agent.pendingImages.push({ type: 'image', attachment: ref });
            app.notice(tf('📎 图片已附加: {0}（随下一条消息发送）', [imageLabel(ref)]));
        }
        catch (err) {
            app.notice(tf('附件失败: {0}', [err.message]));
        }
        return;
    }
    // Non-image: a path-only @-mention (the official file-reference way —
    // the model reads the file through its tools when needed).
    const rel = path;
    await app.luaCall('require("dsh_tui").append_input(...)', [formatMention(rel) + ' ']).catch(() => { });
    app.notice(tf('已引用: {0}（@ 路径会随消息发送，模型按需读取）', [rel]));
};
export function installAttachCommand(app) {
    app.registerCommands([{ name: '/attach', desc: t('附加文件/目录（图片为附件，其余为 @ 引用）'), usage: t('[路径]'), group: t('会话'), fn: (a) => attachCommand(app, a) }]);
}
