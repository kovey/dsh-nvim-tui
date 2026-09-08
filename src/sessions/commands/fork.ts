/** dsh_tui command: /fork — one command per file. */
import { t } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'
import { forkSession } from '../services.js'

export function installForkCommand(app: App): void {
  app.registerCommands([{ name: '/fork', desc: t('分叉当前会话'), usage: t('[directive]'), group: t('会话'), fn: (a) => forkSession(app, a) }])
}
