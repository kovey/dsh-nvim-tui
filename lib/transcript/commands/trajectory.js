/** dsh_tui command: /trajectory — one command per file. */
import { t } from '../../kernel/i18n.js';
import { FeedRenderer } from '../../feed/feed.js';
export const trajectoryCommand = (app) => {
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec) {
        app.notice(t('无活跃会话'));
        return;
    }
    const events = app.slices.trans.sessionEvents(rec.handle.agent.session);
    const turnStart = [...events].reverse().find((e) => e.type === 'turn/start');
    if (turnStart === undefined) {
        app.notice(t('本会话还没有回合'));
        return;
    }
    const turn = turnStart.data?.turn;
    const lines = [`回合 #${turn ?? '?'} 步骤轨迹`, ''];
    let step = 0;
    let toolCount = 0;
    for (const e of events) {
        const data = e.data;
        if (e.type === 'turn/start') {
            step = data?.turn === turn ? (data?.step ?? 0) : step;
            continue;
        }
        if (data === undefined || data.turn !== turn)
            continue;
        if (e.type === 'assistant/message') {
            const text = FeedRenderer.messageText(data.message).replace(/\s+/g, ' ').slice(0, 90);
            lines.push(`步骤 ${data.step ?? '?'} · ${text || '（无文本）'}`);
        }
        else if (e.type === 'tool/call') {
            lines.push(`  🔧 ${data.name}(${FeedRenderer.argsPreview(data.arguments)})`);
            toolCount++;
        }
        else if (e.type === 'tool/result') {
            const err = data.error !== undefined && data.error !== null ? ' ✗' : ' ✓';
            lines.push(`    ${err}`);
        }
    }
    lines.push('', `工具调用 ${toolCount} 次`);
    void app.luaCall('require("dsh_tui").show_lines_float(...)', ['步骤轨迹', lines]).catch(() => { });
};
/** /export — write the rendered transcript to a markdown file. */
export function installTrajectoryCommand(app) {
    app.registerCommands([{ name: '/trajectory', desc: t('回合步骤轨迹'), usage: t(''), group: t('信息'), fn: () => trajectoryCommand(app) }]);
}
