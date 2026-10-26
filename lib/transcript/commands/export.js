/** dsh_tui command: /export — one command per file. */
import { t, tf } from '../../kernel/i18n.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeSessionCwd } from '../../kernel/app.js';
import { serializeSessionLog, sessionEventsOf } from '../../kernel/session-log.js';
/** `/export [md|log] [path]` — rendered Markdown (default) or the canonical
 *  JSONL session log (header + every committed event). The raw log preserves
 *  tool arguments/results, image references and log-only events that the chat
 *  buffer never renders — the file support/replay actually needs. */
export const exportCommand = async (app, a) => {
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec)
        return;
    const raw = (a ?? '').trim();
    const parts = raw === '' ? [] : raw.split(/\s+/);
    const mode = parts[0] === 'log' || parts[0] === 'md' ? parts.shift() : 'md';
    const pathArg = parts.join(' ');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
        if (mode === 'log') {
            const session = rec.handle.agent.session;
            const text = serializeSessionLog(session.header, sessionEventsOf(session), { id: rec.id, createdAt: rec.createdAt });
            const safe = rec.id.replace(/[^A-Za-z0-9._-]/g, '_');
            const path = pathArg !== '' ? pathArg : join(activeSessionCwd(app), `dsh-session-${safe}.jsonl`);
            writeFileSync(path, text);
            app.notice(tf('已导出原始日志: {0}（{1} 行）', [path, String(text.split('\n').length - 1)]));
            return;
        }
        const lines = await app.slices.runtime.nvim.request('nvim_buf_get_lines', [rec.feed.bufId, 0, -1, false]);
        const path = pathArg !== '' ? pathArg : join(activeSessionCwd(app), `dsh-export-${stamp}.md`);
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
    app.registerCommands([{
            name: '/export',
            desc: t('导出转录 md 或原始 JSONL 日志'),
            usage: t('[md|log] [路径]'),
            group: t('信息'),
            args: [
                { kind: 'oneof', values: ['md', 'log'], hint: t('md=渲染转录；log=原始会话日志（JSONL）') },
                { kind: 'free', label: '[路径]', hint: t('不填则写到会话 cwd') },
            ],
            fn: (a) => exportCommand(app, a),
        }]);
}
