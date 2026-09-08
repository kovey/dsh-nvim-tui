/** dsh_tui command: /lines — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js'
import { isAbsolute, join } from 'node:path'
import { openDirPicker } from '../core.js'
import type { App } from '../../kernel/app.js'
import { activeSessionCwd } from '../../kernel/app.js'


/** /lines [路径] — lightweight file viewer: read-only float with the file's
 *  lines, `i` opens it for editing in a fresh tab. No argument → the
 *  directory picker selects the target. */
export const linesCommand = async (app: App, a: string | undefined) => {
  const arg = (a ?? '').trim()
  let path: string | null = arg
  if (path === '') {
    path = await openDirPicker(app, activeSessionCwd(app))
    if (path === null) return
  }
  const abs = isAbsolute(path) ? path : join(activeSessionCwd(app), path)
  const content = await app.slices.ui.readFileSnapshot(abs)
  if (content === null) {
    app.notice(`无法读取 ${abs}（不存在 / 目录 / 二进制 / 超过 256KB）`)
    return
  }
  await app.luaCall('require("dsh_tui").show_lines_float(...)', [abs, content.split('\n'), abs]).catch(() => {})
}

export function installLinesCommand(app: App): void {
  app.registerCommands([{ name: '/lines', desc: t('文件行视图（i 打开编辑）'), usage: t('[路径]'), group: t('信息'), fn: (a) => linesCommand(app, a) }])
}
