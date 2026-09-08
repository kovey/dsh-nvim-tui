/** dsh_tui command: /clear — one command per file. */
import { t } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'

export function installClearCommand(app: App): void {
  app.registerCommands([{ name: '/clear', desc: t('清空当前会话屏幕'), usage: t(''), group: t('会话'), fn: () => app.slices.ui.activeFeed()?.clear() }])
}
