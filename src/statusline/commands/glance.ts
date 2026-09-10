/** dsh_tui command: /glance — one command per file. */
import { t, tf } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'

const GLANCE_SEGMENTS = ['cache', 'context', 'tokens', 'cost', 'elapsed', 'total']
export const hiddenGlance = new Set<string>()
/** Restore the persisted visibility set (boot reads vim.g.dsh_tui_glance). */
export const restoreGlance = (saved: unknown): void => {
  if (!Array.isArray(saved)) return
  for (const k of saved) {
    if (typeof k === 'string' && GLANCE_SEGMENTS.includes(k)) hiddenGlance.add(k)
  }
}

export const glanceCommand = (app: App, a: string | undefined) => {
  if (!a) {
    const shown = GLANCE_SEGMENTS.filter((s) => !hiddenGlance.has(s))
    app.notice(`glance 段: ${shown.join(' ') || '（全部隐藏）'} · 用法: /glance <segment>`)
    return
  }
  const seg = GLANCE_SEGMENTS.find((s) => a.startsWith(s))
  if (!seg) {
    app.notice(tf('未知段 {0}（可选: {1})', [a, GLANCE_SEGMENTS.join(' ')]))
    return
  }
  if (hiddenGlance.has(seg)) hiddenGlance.delete(seg)
  else hiddenGlance.add(seg)
  app.slices.ui.updateStatusline()
  void app.luaCall('vim.g.dsh_tui_glance = ...', [[...hiddenGlance]]).catch(() => {})
  app.notice(`glance ${seg}: ${hiddenGlance.has(seg) ? t('隐藏') : t('显示')}`)
}

/** /cost — accumulated usage + cost for the active session. */

export function installGlanceCommand(app: App): void {
  app.registerCommands([{ name: '/glance', desc: t('状态栏段显隐'), usage: t('<cache|context|tokens|cost|elapsed|total>'), group: t('显示'), fn: (a) => glanceCommand(app, a) }])
}
