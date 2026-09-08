/** dsh_tui command: /workflow — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js'
import { formatElapsed } from '../../feed/stats.js'
import type { App } from '../../kernel/app.js'


/** /workflow — live registry view of workflow runs (phases, agents). */
export const workflowCommand = (app: App) => {
  if (app.slices.trans.workflowRuns.size === 0) {
    app.notice(t('没有工作流记录（workflow 工具运行后此处显示阶段树）'))
    return
  }
  const lines = []
  for (const run of app.slices.trans.workflowRuns.values()) {
    const elapsed = run.startedAt ? formatElapsed(Date.now() - run.startedAt) : '?'
    lines.push(`◈ ${run.name ?? run.id} · ${run.running ? `运行中 ${elapsed}` : `完成 ${run.stopReason ?? ''}`}`)
    for (const ph of run.phases) {
      lines.push(`  ─ ${ph.title}${ph.startedAt ? ` · ${formatElapsed(Date.now() - ph.startedAt)}` : ''}`)
    }
    for (const ag of run.agents) {
      lines.push(`    ◇ #${ag.seq} ${ag.label}${ag.outcome ? ` · ${ag.outcome}` : ''}`)
    }
    for (const msg of run.logs.slice(-6)) {
      lines.push(`    · ${String(msg).slice(0, 100)}`)
    }
  }
  void app.luaCall('require("dsh_tui").show_lines_float(...)', ['工作流运行', lines]).catch(() => {})
}

export function installWorkflowCommand(app: App): void {
  app.registerCommands([{ name: '/workflow', desc: t('工作流运行视图（阶段树）'), usage: t(''), group: t('会话'), fn: () => workflowCommand(app) }])
}
