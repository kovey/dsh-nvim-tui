/** dsh_tui command: /difficulty — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js'
import { applyDifficultyCommand, difficultyStatusLines } from '../../kernel/difficulty.js'
import type { App } from '../../kernel/app.js'


/** /difficulty [easy|medium|hard|auto|off] — 按任务难度自动选择模型。 */
export const difficultyCommand = async (app: App, a: string | undefined) => {
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (rec === undefined || rec.difficulty === undefined) {
    app.notice(t('无活跃会话'))
    return
  }
  const arg = (a ?? '').trim()
  if (arg === '' || arg === 'status') {
    await app.luaCall('require("dsh_tui").show_lines_float(...)', ['难度路由', difficultyStatusLines(app, rec)]).catch(() => {})
    return
  }
  if (arg !== 'auto' && arg !== 'off' && arg !== 'easy' && arg !== 'medium' && arg !== 'hard') {
    app.notice(t('用法: /difficulty [easy|medium|hard|auto|off]'))
    return
  }
  const lines = await applyDifficultyCommand(app, rec, arg as 'auto' | 'off' | 'easy' | 'medium' | 'hard')
  for (const l of lines) app.notice(l)
  app.slices.ui.updateStatusline()
}

export function installDifficultyCommand(app: App): void {
  app.registerCommands([{ name: '/difficulty', desc: t('按难度自动选模型'), usage: t('easy|medium|hard|auto|off'), group: t('模型'), fn: (a) => difficultyCommand(app, a) }])
}
