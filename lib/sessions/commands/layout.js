/** dsh_tui command: /layout — one command per file. */
import { t } from '../../kernel/i18n.js';
/** /layout [default|panel] — window layout presets (bare cycles). */
let layoutIdx = -1;
export const layoutCommand = (app, a) => {
    const order = ['default', 'panel'];
    let name = (a ?? '').trim();
    if (name === '') {
        layoutIdx = (layoutIdx + 1) % order.length;
        name = order[layoutIdx];
    }
    else if (!order.includes(name)) {
        app.notice(`未知布局 ${name}（可用: ${order.join(' ')})`);
        return;
    }
    else {
        layoutIdx = order.indexOf(name);
    }
    void app.luaCall('require("dsh_tui").apply_layout(...)', [name]).catch(() => { });
    app.notice(`布局: ${name}`);
};
export function installLayoutCommand(app) {
    app.registerCommands([{ name: '/layout', desc: t('布局预设'), usage: t('default|panel'), group: t('显示'), fn: (a) => layoutCommand(app, a) }]);
}
