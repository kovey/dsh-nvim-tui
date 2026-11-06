/** dsh_tui command: /steps — show or hide tool/subagent/workflow cards.
 *  `final` keeps the user prompts, assistant text and notices; the complete
 *  event log is untouched, so /steps all can rebuild the view. */
import { t, tf } from '../../kernel/i18n.js';
export const stepsCommand = (app, a) => {
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    const feed = app.slices.ui.activeFeed();
    if (!rec || !feed) {
        app.notice(t('无活跃会话'));
        return;
    }
    const arg = (a ?? '').trim();
    if (arg !== '' && arg !== 'all' && arg !== 'final') {
        app.notice(t('用法: /steps [all|final]'));
        return;
    }
    const mode = arg === 'all' || arg === 'final'
        ? arg
        : feed.stepsMode === 'final' ? 'all' : 'final';
    feed.setStepsMode(mode, app.slices.trans.sessionEvents(rec.handle.agent.session));
    app.slices.sessions.saveUiPref('stepsMode', mode);
    app.notice(tf('步骤显示: {0}', [mode === 'final' ? t('仅最终回答（隐藏工具/子代理）') : t('全部步骤')]));
};
export function installStepsCommand(app) {
    app.registerCommands([{
            name: '/steps',
            desc: t('工具/子代理步骤显示：all 或 final'),
            usage: t('[all|final]'),
            group: t('显示'),
            args: [{ kind: 'oneof', values: ['all', 'final'], hint: t('不填则切换') }],
            fn: (a) => stepsCommand(app, a),
        }]);
}
