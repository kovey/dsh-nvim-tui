/** dsh_tui command: /deps — one command per file. */
import type { App, AppSlices } from '../../kernel/app.js'
import { checkAll, installCommand, findProfilePatchPath, dshHome } from '../services.js'
import type { DepReport } from '../services.js'
import { t, tf } from '../../kernel/i18n.js'

export const depsCommand = async (app: App, s: AppSlices['agent'], a: string | undefined): Promise<void> => {
  const arg = (a ?? '').trim()
  if (arg === 'install') {
    await installCommand(app, s)
    return
  }
  if (arg !== '') {
    app.notice(t('用法: /deps（体检报告）· /deps install（一键装配可修复项）'))
    return
  }
  const patchPath = findProfilePatchPath(app)
  const reports = await checkAll(app, s, patchPath)
  const lines = [
    `依赖体检 · ${reports.length} 项（profile patch: ${patchPath === null ? '未定位（仅报告模式）' : patchPath.replace(dshHome(), '~')}）`,
    '',
  ]
  const byGroup = new Map<string, DepReport[]>()
  for (const r of reports) {
    const g = byGroup.get(r.group) ?? []
    g.push(r)
    byGroup.set(r.group, g)
  }
  let fixable = 0
  for (const [group, items] of byGroup) {
    lines.push(`── ${group} ──`)
    for (const r of items) {
      const mark = r.status === 'ok' ? '✓' : r.status === 'missing' ? '✗' : '⚠'
      if (r.fixId !== undefined) fixable++
      lines.push(`${mark} ${r.label} — ${r.detail}`)
    }
    lines.push('')
  }
  const missing = reports.filter((r) => r.status === 'missing').length
  const warned = reports.filter((r) => r.status === 'warn').length
  lines.push(tf('小结: ✓ {0} · ✗ {1} · ⚠ {2}', [reports.length - missing - warned, missing, warned]))
  if (fixable > 0) {
    lines.push(tf('可一键装配 {0} 项: /deps install（写入 patch · 等待热重载 · 必要时自动重启）', [fixable]))
  }
  await app.luaCall('require("dsh_tui").show_lines_float(...)', [t('依赖体检'), lines]).catch(() => {})
}

export function installDepsCommand(app: App, s: AppSlices['agent']): void {
  app.registerCommands([{ name: '/deps', desc: t('依赖体检（缺什么/一键装配）'), usage: '[install]', group: t('系统'), fn: (a: string) => depsCommand(app, s, a) }])
}
