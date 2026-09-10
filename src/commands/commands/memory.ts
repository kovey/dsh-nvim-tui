/** dsh_tui command: /memory — one command per file (self-registering,
 *  wired by the commands module index). */
import { t, tf } from '../../kernel/i18n.js'
import { existsSync } from 'node:fs'
import { unlinkSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { App } from '../../kernel/app.js'
import { activeSessionCwd } from '../../kernel/app.js'


/** /memory [delete <id>] — list / delete project memory files. */
export const memoryCommand = async (app: App, a: string | undefined) => {
  const dir = join(activeSessionCwd(app), '.dsh', 'memory')
  const a0 = a ?? ''
  try {
    if (a0.startsWith('delete ')) {
      const target = a0.slice(7).trim()
      const name = target.endsWith('.md') ? target : `${target}.md`
      const base = resolve(dir)
      const file = resolve(dir, name)
      if (!file.startsWith(base + sep)) {
        app.notice(tf('非法路径: {0}（仅允许删除 .dsh/memory 内的文件）', [target]))
        return
      }
      if (!existsSync(file)) {
        app.notice(tf('不存在: {0}', [target]))
        return
      }
      // Deleting a memory file is irreversible and had NO confirmation —
      // confirm before the unlink.
      const ok = await app.openPicker(t('确认删除记忆'), [
        { label: `确认删除 .dsh/memory/${name}`, value: 'yes' },
        { label: t('取消'), value: 'no' },
      ])
      if (ok !== 'yes') return
      unlinkSync(file)
      app.notice(tf('已删除 {0}', [target]))
      return
    }
    if (!existsSync(dir)) {
      app.notice(t('（无项目记忆）用法: /remember <text> 写入'))
      return
    }
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      app.notice(`- ${f}`)
    }
  } catch (err) {
    app.notice(tf('memory 失败: {0}', [(err as Error).message]))
  }
}

export function installMemoryCommand(app: App): void {
  app.registerCommands([{ name: '/memory', desc: t('浏览/删除项目记忆'), usage: t('[delete <id>]'), group: t('记忆'), fn: (a) => memoryCommand(app, a) }])
}
