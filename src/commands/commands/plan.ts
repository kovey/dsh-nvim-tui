/** dsh_tui command: /plan — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'


/** /plan [on|off|status] — plan mode state. */
export const planCommand = (app: App, a: string | undefined) => {
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  const planMode = app.svc('planMode')
  if (planMode === undefined) {
    app.notice(t('plan-mode 服务未装配'))
    return
  }
  const arg = (a ?? '').trim()
  const state = planMode.get(rec.handle.agent)
  if (arg === '' || arg === 'status') {
    app.notice(`计划模式: ${state.active ? '开启' : '关闭'}${state.pending ? '（变更待生效）' : ''}`)
    return
  }
  if (arg !== 'on' && arg !== 'off') {
    app.notice(t('用法: /plan [on|off|status]'))
    return
  }
  const r = planMode.set(rec.handle.agent, arg === 'on')
  app.notice(`计划模式: ${arg === 'on' ? '开启' : '关闭'}（${r}）`)
}

export function installPlanCommand(app: App): void {
  app.registerCommands([{ name: '/plan', desc: t('计划模式开关'), usage: t('[on|off|status]'), group: t('会话'), fn: (a) => planCommand(app, a) }])
}
