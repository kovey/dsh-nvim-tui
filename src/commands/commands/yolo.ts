/** dsh_tui command: /yolo — one command per file (self-registering,
 *  wired by the commands module index). */
import { t, tf } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'


/** /yolo [on|off] — approval policy ask/never. */
export const yoloCommand = (app: App, a: string | undefined) => {
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (!rec) return
  const arg = (a ?? '').trim()
  if (arg !== '' && arg !== 'on' && arg !== 'off') {
    // Invalid args used to silently TOGGLE — surface the usage instead.
    app.notice(t('用法: /yolo [on|off]'))
    return
  }
  const policy = arg === 'on' ? 'never' : arg === 'off' ? 'ask' : rec.policy === 'never' ? 'ask' : 'never'
  try {
    rec.handle.agent.session.append('approval/policy', { policy })
    rec.policy = policy
    app.slices.ui.updateStatusline()
    app.notice(`审批策略: ${policy === 'never' ? t('never（不再询问 · 需要审批的操作自动拒绝）') : t('ask（逐项询问）')}`)
  } catch (err) {
    app.notice(tf('yolo 失败: {0}', [(err as Error).message]))
  }
}

export function installYoloCommand(app: App): void {
  app.registerCommands([{ name: '/yolo', desc: t('审批策略开关'), usage: t('on|off'), group: t('审批'), fn: (a) => yoloCommand(app, a) }])
}
