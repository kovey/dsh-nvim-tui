/** dsh_tui command: /panel — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'




export function installPanelCommand(app: App): void {
  app.registerCommands([{ name: '/panel', desc: t('展开/收起活动面板'), usage: t('活动面板'), group: t('系统'), fn: () => app.luaCall('require("dsh_tui").toggle_reasoning()', []).catch(() => {}) }])
}
