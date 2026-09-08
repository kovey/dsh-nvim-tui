/** dsh_tui command: /stop — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js'
import { stopCommand } from '../core.js'
import type { App } from '../../kernel/app.js'




export function installStopCommand(app: App): void {
  app.registerCommands([{ name: '/stop', desc: t('停止当前回合'), usage: t(''), group: t('会话'), fn: () => stopCommand(app) }])
}
