/** dsh_tui command: /new — one command per file. */
import { t } from '../../kernel/i18n.js'
import { activeSessionCwd } from '../../kernel/app.js'
import type { App } from '../../kernel/app.js'

export function installNewCommand(app: App): void {
  app.registerCommands([{
    name: '/new',
    desc: t('新建会话（可带目录）'),
    usage: t('[目录]'),
    group: t('会话'),
    fn: async (a) => {
      let dir = (a ?? '').trim()
      if (dir === '') {
        // README promises a directory-picker for bare /new (pre-review it
        // silently fell back to process.cwd()).
        dir = await app.slices.agent.openDirPicker(activeSessionCwd(app)) ?? ''
        if (dir === '') return
      }
      await app.slices.sessions.createSession(dir)
    },
  }])
}
