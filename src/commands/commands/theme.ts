/** dsh_tui command: /theme — one command per file (self-registering,
 *  wired by the commands module index). */
import { t, tf } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'
import { THEME_NAMES, themeMapFor } from '../../kernel/theme-presets.js'


/** /theme [name] — built-in presets over the colorscheme. */
export const themeCommand = (app: App, a: string | undefined) => {
  const name = a || 'default'
  const map = themeMapFor(name)
  if (map === null) {
    app.notice(tf('未知主题 {0}（可用: {1})', [name, THEME_NAMES.join(' ')]))
    return
  }
  // Every group ANY preset can touch is included in the same call; groups the
  // target preset does not style get an EMPTY spec, which the Lua side treats
  // as "reset to default". Presets only ADD attributes, so switching
  // (dim → default) used to keep the previous styling.
  void app.luaCall('require("dsh_tui").apply_theme(...)', [map])
    .catch((err: unknown) => app.notice(tf('⚠ 主题应用失败: {0}', [(err as Error).message])))
  app.slices.sessions.saveUiPref('theme', name)
  app.notice(tf('主题: {0}', [name]))
}

export function installThemeCommand(app: App): void {
  app.registerCommands([{ name: '/theme', desc: t('内置主题预设'), usage: t('default|dim|vivid|contrast|mono'), group: t('显示'), fn: (a) => themeCommand(app, a) }])
}
