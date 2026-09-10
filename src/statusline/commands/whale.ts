/** dsh_tui command: /whale — one command per file. */
import { t } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'

export const whaleCommand = (app: App, a: string | undefined) => {
  const feed = app.slices.ui.activeFeed()
  if (!feed) return
  const on = a === 'on' ? true : a === 'off' ? false : !feed.whale
  feed.setWhale(on)
  app.notice(on ? t('蓝鲸背景已开启（空态居中壁纸 + 有内容时底部水印）') : t('蓝鲸背景已关闭'))
}


export function installWhaleCommand(app: App): void {
  app.registerCommands([{ name: '/whale', desc: t('蓝鲸背景开关'), usage: t('on|off'), group: t('显示'), fn: (a) => whaleCommand(app, a) }])
}
