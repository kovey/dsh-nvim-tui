/** dsh_tui command: /steer — one command per file (self-registering,
 *  wired by the commands module index). */
import { t, tf } from '../../kernel/i18n.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
/** /steer <directive> — inject steering for the nearest step. */
export const steerCommand = (app, a) => {
    const text = (a ?? '').trim();
    if (!text) {
        app.notice(t('用法: /steer <directive>（注入到最近一步的引导指令）'));
        return;
    }
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec) {
        app.notice(t('无活跃会话'));
        return;
    }
    try {
        rec.handle.agent.steer(createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
        }));
        rec.feed.pushBlock('steer', text);
        app.notice(t('已注入引导指令'));
    }
    catch (err) {
        app.notice(tf('steer 失败: {0}', [err.message]));
    }
};
export function installSteerCommand(app) {
    app.registerCommands([{ name: '/steer', desc: t('注入引导指令'), usage: t('<directive>'), group: t('会话'), fn: (a) => steerCommand(app, a) }]);
}
