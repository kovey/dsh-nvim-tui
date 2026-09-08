/** dsh_tui command: /density — one command per file. */
import { t } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'

export const densityCommand = (app: App) => {
  const feed = app.slices.ui.activeFeed()
  if (!feed) return
  feed.dense = !feed.dense
  app.notice(`紧凑模式: ${feed.dense ? '开' : '关'}`)
}

/** /glance [segment…] — toggle statusline segments. */

export function installDensityCommand(app: App): void {
  app.registerCommands([{ name: '/density', desc: t('紧凑卡片模式'), usage: t('紧凑卡片'), group: t('显示'), fn: () => densityCommand(app) }])
}
