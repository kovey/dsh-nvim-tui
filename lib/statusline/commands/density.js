/** dsh_tui command: /density — one command per file. */
import { t } from '../../kernel/i18n.js';
export const densityCommand = (app) => {
    const feed = app.slices.ui.activeFeed();
    if (!feed)
        return;
    feed.dense = !feed.dense;
    // The toggle used to affect only tool cards rendered AFTER it; repaint the
    // current view and persist the preference so new sessions keep it.
    void feed.flush();
    app.slices.sessions.saveUiPref('dense', feed.dense);
    app.notice(`紧凑模式: ${feed.dense ? t('开') : t('关')}`);
};
/** /glance [segment…] — toggle statusline segments. */
export function installDensityCommand(app) {
    app.registerCommands([{ name: '/density', desc: t('紧凑卡片模式'), usage: t('紧凑卡片'), group: t('显示'), fn: () => densityCommand(app) }]);
}
