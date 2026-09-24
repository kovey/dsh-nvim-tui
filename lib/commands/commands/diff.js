/** dsh_tui command: /diff — one command per file (self-registering,
 *  wired by the commands module index). */
import { t, tf } from '../../kernel/i18n.js';
/** `/diff` — review the turn's file changes side by side.
 *
 * The feed already renders a UNIFIED diff inline, which is the right thing for
 * reading a turn top to bottom. It is the wrong thing for REVIEWING a change:
 * you cannot see the two versions against each other. This opens the same data
 * as two bound `diff` windows in a new nvim tab, where line matching,
 * intra-line highlighting and scroll sync are nvim's own.
 *
 * The two sides come from the render-intent metadata captured when the tool
 * result arrived — NOT from re-reading the files, which may have changed since
 * (and then the review would silently show something other than what changed).
 */
export const diffCommand = async (app, a) => {
    const diffs = app.slices.ui.recentDiffs;
    if (diffs.size === 0) {
        app.notice(t('本会话还没有可审阅的文件改动'));
        return;
    }
    // Newest first: the change just made is the one being reviewed.
    const entries = [...diffs.entries()].sort((x, y) => y[1].at - x[1].at);
    const wanted = (a ?? '').trim();
    let path;
    if (wanted !== '') {
        const hit = entries.find(([p]) => p === wanted || p.endsWith('/' + wanted));
        if (hit === undefined) {
            app.notice(tf('没有该文件的改动记录: {0}', [wanted]));
            return;
        }
        path = hit[0];
    }
    else {
        const sel = await app.openPicker(t('文件改动（Enter 左右对照审阅）'), entries.map(([p, d]) => ({
            label: `${p}${d.oldText === null ? '  ' + t('（新增）') : d.newText === null ? '  ' + t('（删除）') : ''}`,
            value: p,
        })));
        if (sel === null)
            return;
        path = sel;
    }
    const d = diffs.get(path);
    if (d === undefined)
        return;
    await app.luaCall('require("dsh_tui").show_diff_split(...)', [
        t('改动对照'),
        path,
        d.oldText,
        d.newText,
    ]).catch(() => { });
};
export function installDiffCommand(app) {
    app.registerCommands([
        {
            name: '/diff',
            desc: t('左右对照审阅文件改动'),
            usage: t('[路径]'),
            group: t('信息'),
            args: [{ kind: 'free', label: '[路径]', hint: t('不填则从改动列表选择') }],
            fn: (a) => diffCommand(app, a),
        },
    ]);
}
