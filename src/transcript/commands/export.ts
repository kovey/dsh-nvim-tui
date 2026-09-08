/** dsh_tui command: /export — one command per file. */
import { t } from '../../kernel/i18n.js'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { App } from '../../kernel/app.js'

export const exportCommand = async (app: App) => {
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (!rec) return
  try {
    const lines = await app.slices.runtime.nvim!.request('nvim_buf_get_lines', [rec.feed.bufId, 0, -1, false])
    const path = join(process.cwd(), `dsh-export-${new Date().toISOString().replace(/[:.]/g, '-')}.md`)
    writeFileSync(path, `# ${rec.title ?? rec.id}\n\n` + lines.join('\n') + '\n')
    app.notice(`已导出: ${path}`)
  } catch (err) {
    app.notice(`导出失败: ${(err as Error).message}`)
  }
}

/** /rewind — pick a user-message boundary, truncate the session after
 *  it, and rebuild the chat from the remaining events. */

export function installExportCommand(app: App): void {
  app.registerCommands([{ name: '/export', desc: t('导出转录 md'), usage: t('导出转录'), group: t('信息'), fn: () => exportCommand(app) }])
}
