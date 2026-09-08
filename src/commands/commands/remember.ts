/** dsh_tui command: /remember — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js'
import { appendFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { App } from '../../kernel/app.js'


/** /remember <text> — append to .dsh/memory/global.md. */
export const rememberCommand = (app: App, a: string | undefined) => {
  if (!a) {
    app.notice(t('用法: /remember <text>'))
    return
  }
  try {
    const dir = join(process.cwd(), '.dsh', 'memory')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'global.md'), `- ${a}\n`)
    app.notice(t('已写入 .dsh/memory/global.md'))
  } catch (err) {
    app.notice(`写入失败: ${(err as Error).message}`)
  }
}

export function installRememberCommand(app: App): void {
  app.registerCommands([{ name: '/remember', desc: t('写入项目记忆'), usage: t('<text>'), group: t('记忆'), fn: (a) => rememberCommand(app, a) }])
}
