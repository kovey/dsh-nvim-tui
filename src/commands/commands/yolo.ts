/** dsh_tui command: /yolo — one command per file (self-registering,
 *  wired by the commands module index). */
import { t, tf } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'


/** /yolo [on|off] — TUI auto-allow for approval requests.
 *  The host policy stays `ask`; every request still reaches the waterfall and
 *  is audited, but while auto-allow is on it is answered allowed-once without
 *  a float. `off` restores per-item prompting. */
export const yoloCommand = (app: App, a: string | undefined) => {
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (!rec) return
  const arg = (a ?? '').trim()
  if (arg !== '' && arg !== 'on' && arg !== 'off') {
    app.notice(t('用法: /yolo [on|off]'))
    return
  }
  const enabled = arg === 'on' ? true : arg === 'off' ? false : rec.autoAllow !== true
  try {
    // The host only knows ask|never; auto-allow is a TUI decision, so ensure
    // the waterfall is dispatched (never would reject before it). This also
    // lets `/yolo off` recover a session left in never by an older build.
    if (rec.policy === 'never') {
      rec.handle.agent.session.append('approval/policy', { policy: 'ask' })
      rec.policy = 'ask'
    }
    rec.autoAllow = enabled
    app.slices.ui.updateStatusline()
    app.notice(enabled
      ? t('自动允许已开启：后续审批不再弹窗，直接按 allowed-once 记录（/yolo off 恢复逐项询问）')
      : t('自动允许已关闭：审批恢复逐项询问'))
  } catch (err) {
    app.notice(tf('yolo 失败: {0}', [(err as Error).message]))
  }
}

export function installYoloCommand(app: App): void {
  app.registerCommands([{ name: '/yolo', desc: t('自动允许审批开关'), usage: t('on|off'), group: t('审批'), fn: (a) => yoloCommand(app, a) }])
}
