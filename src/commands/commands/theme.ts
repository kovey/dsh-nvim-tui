/** dsh_tui command: /theme — one command per file (self-registering,
 *  wired by the commands module index). */
import { t, tf } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'


/** /theme [name] — built-in presets over the colorscheme. */
export const themeCommand = (app: App, a: string | undefined) => {
  const presets: Record<string, Record<string, unknown>> = {
    default: {},
    dim: { DshTuiReasoning: { italic: true }, DshTuiNotice: { italic: true } },
    vivid: { DshTuiUser: { bold: true }, DshTuiTool: { italic: true } },
    contrast: { DshTuiUser: { bold: true }, DshTuiTool: { bold: true }, DshTuiError: { bold: true } },
    mono: { DshTuiUser: { underline: true }, DshTuiTool: { underline: true }, DshTuiReasoning: { underline: true } },
  }
  const name = a || 'default'
  const theme = presets[name]
  if (!theme) {
    app.notice(tf('未知主题 {0}（可用: {1})', [name, Object.keys(presets).join(' ')]))
    return
  }
  void app.luaCall('require("dsh_tui").apply_theme(...)', [theme]).catch(() => {})
  app.notice(tf('主题: {0}', [name]))
}

export function installThemeCommand(app: App): void {
  app.registerCommands([{ name: '/theme', desc: t('内置主题预设'), usage: t('default|dim|vivid|contrast|mono'), group: t('显示'), fn: (a) => themeCommand(app, a) }])
}
