/** dsh_tui command: /compact — one command per file (self-registering,
 *  wired by the commands module index). */
import { t, tf } from '../../kernel/i18n.js';
import { formatTokens } from '../../feed/stats.js';
/** /compact — manually compact the session context via the compaction
 *  engine; null result means there was nothing worth compacting. */
export const compactCommand = async (app) => {
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec) {
        app.notice(t('无活跃会话'));
        return;
    }
    const compaction = app.svc('compaction');
    if (compaction === undefined) {
        app.notice(t('compaction 服务未装配（profile 加入 dsh-compaction 后可用）'));
        return;
    }
    app.notice(t('正在压缩上下文…'));
    try {
        // Bounded: compaction runs an LLM summarization pass, and a wedged
        // provider used to leave /compact awaiting forever with no way out.
        const result = await compaction.compactNow(rec.handle.agent, AbortSignal.timeout(180000));
        if (result === null) {
            app.notice(t('没有可压缩的历史'));
        }
        else {
            app.notice(tf('已压缩 {0} 条历史 · 约 {1} tokens', [result.shadowedSeqs.length, formatTokens(result.shadowedTokenCount)]));
        }
    }
    catch (err) {
        app.notice(tf('压缩失败: {0}', [err.message]));
    }
};
export function installCompactCommand(app) {
    app.registerCommands([{ name: '/compact', desc: t('压缩上下文'), usage: t(''), group: t('会话'), fn: () => compactCommand(app) }]);
}
