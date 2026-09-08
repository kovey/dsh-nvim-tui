/** dsh_tui command: /help — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js'
import type { CommandSpec } from '../../kernel/app.js'
import type { App } from '../../kernel/app.js'


/** /help — every command in a sessions-style popup, grouped like the
 *  old chat listing and sorted alphabetically within each group; Enter
 *  fills the picked command into the input box (the command completion
 *  menu's Enter logic: type args, a second Enter executes). */
export const helpCommand = async (app: App) => {
  const groups = new Map<string, CommandSpec[]>()
  for (const s of app.commandSpecs) {
    const group = s.group ?? t('其他')
    const list = groups.get(group) ?? []
    list.push(s)
    groups.set(group, list)
  }
  const rows: Array<{ label: string; value: string }> = []
  for (const [group, list] of groups) {
    rows.push({ label: `── ${group} ──`, value: `grp:${group}` })
    for (const s of [...list].sort((a, b) => a.name.localeCompare(b.name))) {
      rows.push({ label: `  ${s.name}${s.usage ? ` ${s.usage}` : ''} · ${s.desc}`, value: s.name })
    }
  }
  const sel = await app.openPicker(t('全部命令（Enter 填入输入框）'), rows)
  if (sel === null || sel.startsWith('grp:')) return
  await app.luaCall('require("dsh_tui").fill_input(...)', [`${sel} `]).catch(() => {})
}

export function installHelpCommand(app: App): void {
  app.registerCommands([{ name: '/help', desc: t('弹出全部命令（Enter 填入输入框）'), usage: t(''), group: t('系统'), fn: () => helpCommand(app) }])
}
