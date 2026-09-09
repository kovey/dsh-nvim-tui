/** dsh_tui command: /quit — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'




export function installQuitCommand(app: App): void {
  app.registerCommands([{
    name: '/quit',
    desc: t('退出（/exit 别名）'),
    usage: t(''),
    group: t('系统'),
    fn: async () => {
      const ok = await app.openPicker(t('确认退出'), [
        { label: t('退出 dsh'), value: 'yes' },
        { label: t('取消'), value: 'no' },
      ])
      if (ok === 'yes') app.quit(0)
    },
  }])
}
