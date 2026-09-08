/** dsh_tui command: /attach — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js';
import { isAbsolute, join } from 'node:path';
import { readImageFile } from '../../feed/images.js';
import { imageLabel } from '../../feed/images.js';
import { openDirPicker } from '../core.js';
import { formatMention } from '../core.js';
/** /attach [path] — image → durable attachment; file/dir → @-mention.
 *  Without an argument a directory picker selects the target. */
export const attachCommand = async (app, a) => {
    let path = (a ?? '').trim();
    if (path === '') {
        path = await openDirPicker(app, process.cwd());
        if (path === null)
            return;
    }
    const abs = isAbsolute(path) ? path : join(process.cwd(), path);
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
        if (!rec || typeof attachments?.saveImage !== 'function') {
            app.notice(t('附件服务未装配'));
            return;
        }
        try {
            const ref = await attachments.saveImage(img);
            app.slices.agent.pendingImages.push({ type: 'image', attachment: ref });
            app.notice(`📎 图片已附加: ${imageLabel(ref)}（随下一条消息发送）`);
        }
        catch (err) {
            app.notice(`附件失败: ${err.message}`);
        }
        return;
    }
    // Non-image: a path-only @-mention (the official file-reference way —
    // the model reads the file through its tools when needed).
    const rel = path;
    await app.luaCall('require("dsh_tui").append_input(...)', [formatMention(rel) + ' ']).catch(() => { });
    app.notice(`已引用: ${rel}（@ 路径会随消息发送，模型按需读取）`);
};
export function installAttachCommand(app) {
    app.registerCommands([{ name: '/attach', desc: t('附加文件/目录（图片为附件，其余为 @ 引用）'), usage: t('[路径]'), group: t('会话'), fn: (a) => attachCommand(app, a) }]);
}
