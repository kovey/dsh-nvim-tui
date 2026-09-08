/** dsh_tui command: /branch (/fork alias) — one command per file. */
import { t } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'
import { forkSession } from '../services.js'

export function installBranchCommand(app: App): void {
  app.registerCommands([{ name: '/branch', desc: t('分叉（/fork 别名）'), usage: t(''), group: t('会话'), fn: (a) => forkSession(app, a) }])
}
