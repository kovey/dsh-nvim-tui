/** dsh_tui command: /locale — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js';
import { locale, setLocale } from '../../kernel/i18n.js';
/** /locale [zh|en] — switch runner UI language (official client's
 *  locale preference; Lua-side hints stay Chinese for now). */
export const localeCommand = (app, a) => {
    const want = (a ?? '').trim();
    if (want === '') {
        app.notice(`语言: ${locale() === 'en' ? 'en' : 'zh'}（/locale zh|en 切换）`);
        return;
    }
    if (want !== 'zh' && want !== 'en') {
        app.notice('用法: /locale zh|en');
        return;
    }
    setLocale(want);
    app.slices.sessions.refreshList();
    void app.refreshCommandCatalog();
    app.slices.ui.updateStatusline();
    app.notice(`语言已切换: ${want}`);
};
export function installLocaleCommand(app) {
    app.registerCommands([{ name: '/locale', desc: t('语言 (zh/en)'), usage: t('[zh|en]'), group: t('系统'), fn: (a) => localeCommand(app, a) }]);
}
