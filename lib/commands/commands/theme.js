/** dsh_tui command: /theme — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js';
/** /theme [name] — built-in presets over the colorscheme. */
export const themeCommand = (app, a) => {
    const presets = {
        default: {},
        dim: { DshTuiReasoning: { italic: true }, DshTuiNotice: { italic: true } },
        vivid: { DshTuiUser: { bold: true }, DshTuiTool: { italic: true } },
        contrast: { DshTuiUser: { bold: true }, DshTuiTool: { bold: true }, DshTuiError: { bold: true } },
        mono: { DshTuiUser: { underline: true }, DshTuiTool: { underline: true }, DshTuiReasoning: { underline: true } },
    };
    const name = a || 'default';
    const theme = presets[name];
    if (!theme) {
        app.notice(`未知主题 ${name}（可用: ${Object.keys(presets).join(' ')})`);
        return;
    }
    void app.luaCall('require("dsh_tui").apply_theme(...)', [theme]).catch(() => { });
    app.notice(`主题: ${name}`);
};
export function installThemeCommand(app) {
    app.registerCommands([{ name: '/theme', desc: t('内置主题预设'), usage: t('default|dim|vivid|contrast|mono'), group: t('显示'), fn: (a) => themeCommand(app, a) }]);
}
