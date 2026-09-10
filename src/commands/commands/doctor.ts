/** dsh_tui command: /doctor — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'


/** /doctor — terminal capability report. */
export const doctorCommand = async (app: App) => {
  let size = null
  try {
    size = await app.luaCall('return { vim.o.columns, vim.o.lines }', [])
  } catch {}
  app.notice(`TERM=${process.env.TERM ?? '?'} · TTY=${process.stdout.isTTY} · Node ${process.version}`)
  app.notice(`终端尺寸 ${size ? `${size[0]}×${size[1]}` : '?'} · Unicode ✓ · truecolor ${process.env.COLORTERM === 'truecolor' ? '✓' : t('按 TERM')}`)
  app.notice(t('诊断建议: 真彩异常时检查 COLORTERM；宽度异常检查 locale/字体'))
}

export function installDoctorCommand(app: App): void {
  app.registerCommands([{ name: '/doctor', desc: t('终端诊断'), usage: t('终端诊断'), group: t('信息'), fn: () => doctorCommand(app) }])
}
