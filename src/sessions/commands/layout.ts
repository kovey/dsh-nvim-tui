/** dsh_tui command: /layout — one command per file. */
import { t, tf } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'

/** /layout [default|panel] — window layout presets (bare cycles). */
let layoutIdx = -1
export const layoutCommand = (app: App, a: string | undefined) => {
  const order = ['default', 'panel']
  let name = (a ?? '').trim()
  if (name === '') {
    layoutIdx = (layoutIdx + 1) % order.length
    name = order[layoutIdx]
  } else if (!order.includes(name)) {
    app.notice(tf('未知布局 {0}（可用: {1})', [name, order.join(' ')]))
    return
  } else {
    layoutIdx = order.indexOf(name)
  }
  void app.luaCall('require("dsh_tui").apply_layout(...)', [name]).catch(() => {})
  app.notice(tf('布局: {0}', [name]))
}

export function installLayoutCommand(app: App): void {
  app.registerCommands([{ name: '/layout', desc: t('布局预设'), usage: t('default|panel'), group: t('显示'), fn: (a) => layoutCommand(app, a) }])
}
