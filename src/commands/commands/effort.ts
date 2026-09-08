/** dsh_tui command: /effort — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js'
import { applyModelSelection } from '../core.js'
import type { App } from '../../kernel/app.js'


/** /effort [off|high|max|auto] */
export const effortCommand = async (app: App, a: string | undefined) => {
  if (!a) {
    app.notice(`当前推理等级: ${app.slices.agent.currentSelection().reasoningEffort ?? 'auto（模型默认）'}`)
    return
  }
  if (!['off', 'high', 'max', 'auto'].includes(a)) {
    app.notice(t('用法: /effort [off|high|max|auto]'))
    return
  }
  const next = { ...app.slices.agent.currentSelection(), reasoningEffort: a === 'auto' ? undefined : a }
  try {
    await applyModelSelection(app, next)
  } catch (err) {
    app.notice(`切换失败: ${(err as Error).message}`)
  }
}

export function installEffortCommand(app: App): void {
  app.registerCommands([{ name: '/effort', desc: t('推理等级'), usage: t('off|high|max|auto'), group: t('模型'), fn: (a) => effortCommand(app, a) }])
}
