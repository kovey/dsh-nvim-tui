/** dsh_tui command: /plugins — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js';
/** /plugins — read-only host loader inventory (official Plugins
 *  settings tab counterpart), rendered in a scrollable float like
 *  /sessions and the other listing commands. */
export const pluginsCommand = async (app) => {
    const inv = app.svc('pluginInventory');
    if (typeof inv?.list !== 'function') {
        app.notice(t('plugin-inventory 服务未装配（dsh-host-plugin-inventory）'));
        return;
    }
    // dsh 0.1.2-alpha.2: list() 改为 async，返回 Promise<PluginInventorySnapshot>。
    const snapshot = await inv.list();
    const entries = snapshot.entries ?? [];
    const lines = [''];
    if (entries.length === 0) {
        lines.push(t('（loader 没有插件条目）'));
    }
    else {
        for (const e of entries) {
            lines.push(`${e.enabled ? '●' : '○'} ${e.entryId} · ${e.moduleName} · ${e.fiberPhase}`);
        }
    }
    void app.luaCall('require("dsh_tui").show_lines_float(...)', [t('插件清单（只读）'), lines]).catch(() => { });
};
export function installPluginsCommand(app) {
    app.registerCommands([{ name: '/plugins', desc: t('宿主插件清单（只读）'), usage: t('插件清单'), group: t('信息'), fn: () => pluginsCommand(app) }]);
}
