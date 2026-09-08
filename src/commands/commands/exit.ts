/** dsh_tui command: /exit — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'




export function installExitCommand(app: App): void {
  app.registerCommands([{ name: '/exit', desc: t('退出 dsh'), usage: t('退出'), group: t('系统'), fn: () => app.quit(0) }])
}
