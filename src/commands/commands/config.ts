/** dsh_tui command: /config — one command per file (self-registering,
 *  wired by the commands module index). */
import { t, tf } from '../../kernel/i18n.js'
import { modeLabel } from '../../feed/stats.js'
import type { App } from '../../kernel/app.js'


/** /config — current runtime summary. */
export const configCommand = (app: App) => {
  const sel = app.slices.agent.currentSelection()
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  app.notice(tf('模型 {0}/{1} · effort {2}', [sel.provider, sel.model, sel.reasoningEffort ?? 'auto']))
  app.notice(`权限 ${modeLabel(rec?.mode)} · 审批 ${rec?.policy ?? 'ask'} · 用户配置 ${app.config.loadUserConfig !== false ? '已加载' : '关闭'}`)
  app.notice(`主题覆盖 ${app.config.theme ? Object.keys(app.config.theme).length + ' 组' : '无（跟随 colorscheme）'}`)
}

export function installConfigCommand(app: App): void {
  app.registerCommands([{ name: '/config', desc: t('配置摘要'), usage: t('配置'), group: t('信息'), fn: () => configCommand(app) }])
}
