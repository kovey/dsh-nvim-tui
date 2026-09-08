/** dsh_tui command: /deliverables — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'


/** /deliverables — files this session's current turn produced (mutation
 *  tools' follow-along paths, derived from tool/call arguments). */
export const deliverablesCommand = async (app: App) => {
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  const paths = rec.deliverables?.paths ?? []
  if (paths.length === 0) {
    app.notice(t('本回合还没有产出文件（写/改文件的工具运行后会出现在这里）'))
    return
  }
  const sel = await app.openPicker(t('交付物（Enter 在 nvim 新标签页打开）'),
    paths.map((p) => ({ label: p, value: p })))
  if (sel === null) return
  await app.luaCall('require("dsh_tui").open_file_tab(...)', [sel]).catch(() => {})
}

export function installDeliverablesCommand(app: App): void {
  app.registerCommands([{ name: '/deliverables', desc: t('本回合交付物（打开产物文件）'), usage: t(''), group: t('信息'), fn: () => deliverablesCommand(app) }])
}
