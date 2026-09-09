/** dsh_tui command: /restart — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'


/** /restart — respawn the dsh command and exit this process. The successor
 *  spawn is NOT started here: quit() spawns it AFTER the old nvim fully
 *  released the terminal (alt screen + kitty keyboard protocol cleanup) and
 *  the session logs flushed — spawning it early used to interleave the two
 *  processes' terminal control sequences and the new instance read
 *  kitty-protocol-encoded keys as literal garbage text in the input box. */
export const restartCommand = async (app: App) => {
  const ok = await app.openPicker(t('确认重启'), [
    { label: t('重启 dsh 进程'), value: 'yes' },
    { label: t('取消'), value: 'no' },
  ])
  if (ok !== 'yes') return
  app.slices.runtime.setRestartPending(true)
  app.notice(t('正在重启…'))
  setTimeout(() => void app.quit(0), 300)
}

export function installRestartCommand(app: App): void {
  app.registerCommands([{ name: '/restart', desc: t('重启 dsh 进程'), usage: t('重启'), group: t('系统'), fn: () => restartCommand(app) }])
}
