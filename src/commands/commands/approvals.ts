/** dsh_tui command: /approvals — one command per file.
 *
 *  The approval float and its transcript notice are both transient, so after a
 *  few turns there is no way to answer "why did I allow that?" — the decision
 *  log behind this command is the only record.
 */
import { t, tf } from '../../kernel/i18n.js'
import { APPROVAL_HISTORY_MAX, ensureApprovalHistory } from '../../kernel/approval-log.js'
import type { ApprovalRecord } from '../../kernel/app.js'
import type { App } from '../../kernel/app.js'

/** Seconds-resolution clock time; the log is for humans, not for ordering. */
const hhmmss = (at: number): string => {
  try {
    return new Date(at).toTimeString().slice(0, 8)
  } catch {
    return '--:--:--'
  }
}

/** Outcome → a stable glyph the user can scan for. */
const mark = (outcome: string): string => {
  if (outcome.startsWith('allow')) return '✓'
  if (outcome.includes('reject') || outcome.includes('deny')) return '✗'
  return '·'
}

/**
 * Render the history as float lines. Pure so the smoke suite can pin the
 * format (newest first, stable glyphs) without an App.
 */
export const approvalHistoryLines = (all: readonly ApprovalRecord[], max: number): string[] => {
  const lines: string[] = ['']
  // Newest first: the recent decisions are what you are usually checking.
  for (const r of [...all].reverse()) {
    const reason = r.reason === '' ? '' : ` — ${r.reason}`
    lines.push(`${mark(r.outcome)} ${hhmmss(r.at)}  ${r.toolName}${reason}`)
    lines.push(`    ${r.outcome}`)
  }
  lines.push('', tf('共 {0} 条（最多保留 {1} 条）', [all.length, max]))
  return lines
}

export const approvalsCommand = async (app: App): Promise<void> => {
  // Read path of the lazy reload: if the active session changed since the last
  // call, pull ITS decisions from disk before showing anything.
  const all = ensureApprovalHistory(app.slices.agent, app.slices.sessions.activeId)
  if (all.length === 0) {
    app.notice(t('还没有审批记录（本会话尚未出现需要审批的操作）'))
    return
  }
  const lines = approvalHistoryLines(all, APPROVAL_HISTORY_MAX)
  await app.luaCall('require("dsh_tui").show_lines_float(...)', [t('审批历史'), lines]).catch(() => {})
}

export function installApprovalsCommand(app: App): void {
  app.registerCommands([{
    name: '/approvals',
    desc: t('审批历史（当前会话的批准/拒绝记录，重启后仍在）'),
    usage: t('审批历史'),
    group: t('信息'),
    fn: () => approvalsCommand(app),
  }])
}
