/** dsh_tui command: /rename — one command per file. */
import { t } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'

/** /rename <title> — pin the active session's title. */
export const renameCommand = (app: App, a: string | undefined) => {
  const title = (a ?? '').trim()
  if (title === '') {
    app.notice(t('用法: /rename <新标题>'))
    return
  }
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  const sessionTitle = app.svc('sessionTitle')
  if (sessionTitle === undefined) {
    app.notice(t('session-title 服务未装配'))
    return
  }
  try {
    sessionTitle.rename(app.liveSessions.get(rec.id), title)
    app.notice(t('标题已更新'))
  } catch (err) {
    app.notice(`重命名失败: ${(err as Error).message}`)
  }
}

export function installRenameCommand(app: App): void {
  app.registerCommands([{ name: '/rename', desc: t('重命名会话'), usage: t('<新标题>'), group: t('会话'), fn: (a) => renameCommand(app, a) }])
}
