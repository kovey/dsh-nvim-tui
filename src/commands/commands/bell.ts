/** dsh_tui command: /bell — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js'
import type { AppSlices, WritableSlice } from '../../kernel/app.js'
import type { App } from '../../kernel/app.js'

const W = (d: AppSlices['agent']) => d as WritableSlice<AppSlices['agent']>

/** /bell [on|off] — terminal bell on turn end (approvals always ring). */
export const bellCommand = (app: App, a: string | undefined) => {
  const arg = (a ?? '').trim()
  if (arg !== '' && arg !== 'on' && arg !== 'off') {
    app.notice('用法: /bell [on|off]')
    return
  }
  if (arg !== '') W(app.slices.agent).bellOn = arg === 'on'
  else W(app.slices.agent).bellOn = !app.slices.agent.bellOn
  app.notice(`回合结束响铃: ${app.slices.agent.bellOn ? '开' : '关'}`)
}

export function installBellCommand(app: App): void {
  app.registerCommands([{ name: '/bell', desc: t('回合结束响铃开关'), usage: t('[on|off]'), group: t('系统'), fn: (a) => bellCommand(app, a) }])
}
