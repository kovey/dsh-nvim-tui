/** dsh_tui command: /history — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'


/** /history — input history browser: newest first, Enter fills the input
 *  box with the selected entry (multi-line entries round-trip intact). */
export const historyCommand = (app: App) => {
  void app.luaCall('require("dsh_tui").show_input_history()', []).catch(() => {})
}

export function installHistoryCommand(app: App): void {
  app.registerCommands([{ name: '/history', desc: t('输入历史浏览（回车回填）'), usage: t(''), group: t('会话'), fn: () => historyCommand(app) }])
}
