/** dsh_tui command: /changes — one command per file (self-registering,
 *  wired by the commands module index). */
import { t, tf } from '../../kernel/i18n.js'
import { ledgerRows, ledgerTotals } from '../../kernel/change-ledger.js'
import type { App } from '../../kernel/app.js'

/**
 * Dispatch another slash command the same way the input dispatcher does.
 *
 * Commands are async and a rejection here MUST NOT escape: from alpha.4 the host
 * turns an unhandled rejection into a hard `process.exit`, which is exactly how
 * "选择会话 → dsh 整个退掉" behaved. So this mirrors core.ts's contract rather
 * than calling `spec.fn` bare.
 */
const runSlash = async (app: App, line: string): Promise<void> => {
  const m = /^(\S+)(?:\s+(.*))?$/.exec(line)
  const spec = app.commandSpecs.find((s) => s.name === (m?.[1] ?? ''))
  if (spec === undefined) return
  try {
    await spec.fn(m?.[2] ?? '')
  } catch (err) {
    app.notice(tf('命令失败: {0}', [(err as Error).message]))
  }
}

/** `/changes` — every file THIS SESSION has changed, newest first.
 *
 * The distinction from its neighbours is the whole point:
 *   · `/deliverables` — files produced in the CURRENT TURN (turn-scoped, and it
 *     tracks produced artefacts, not every diff);
 *   · `/diff [path]`  — side-by-side review of ONE file's latest shape;
 *   · `/changes`      — the session-wide ledger: which files, how many times,
 *     net line delta. This is the "what did this task actually touch?" view.
 *
 * A path argument narrows to one file and goes straight to the review, so the
 * command is a usable entry point even for a single file.
 */
export const changesCommand = async (app: App, a: string | undefined) => {
  const rec = app.slices.sessions.activeId === null
    ? undefined
    : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  const ledger = app.slices.ui.changeLedger.get(rec.feed)
  if (ledger === undefined || ledger.size === 0) {
    app.notice(t('本会话还没有文件改动'))
    return
  }
  const rows = ledgerRows(ledger)
  const totals = ledgerTotals(ledger)

  const wanted = (a ?? '').trim()
  if (wanted !== '') {
    const hit = rows.find((r) => r.path === wanted || r.path.endsWith('/' + wanted))
    if (hit === undefined) {
      app.notice(tf('本会话没有改过: {0}', [wanted]))
      return
    }
    // Hand off to /diff, which owns the side-by-side view (and its data).
    await runSlash(app, 'diff ' + hit.path)
    return
  }

  const icon = (s: string): string => s === 'added' ? '＋' : s === 'deleted' ? '－' : '✎'
  const lines = [
    tf('{0} 个文件 · +{1} −{2}', [String(totals.files), String(totals.added), String(totals.removed)]),
    '',
    ...rows.map((r) => {
      const times = r.edits > 1 ? tf(' · 改过 {0} 次', [String(r.edits)]) : ''
      return `${icon(r.status)} ${r.path} · +${r.added} −${r.removed}${times}`
    }),
  ]
  // The review is the next step a person wants after seeing the list, so it is
  // offered from here rather than left to a second command.
  const sel = await app.openPicker(t('本会话改动（Enter 左右对照审阅）'), [
    { label: t('↩ 关闭'), value: 'act:close' },
    ...rows.map((r) => ({
      label: `${icon(r.status)} ${r.path} · +${r.added} −${r.removed}${r.edits > 1 ? tf(' · 改过 {0} 次', [String(r.edits)]) : ''}`,
      value: `rev:${r.path}`,
    })),
  ])
  if (sel === null || sel === 'act:close') {
    await app.luaCall('require("dsh_tui").show_lines_float(...)', [t('本会话改动'), lines]).catch(() => {})
    return
  }
  if (sel.startsWith('rev:')) await runSlash(app, 'diff ' + sel.slice(4))
}

export function installChangesCommand(app: App): void {
  app.registerCommands([
    {
      name: '/changes',
      desc: t('本会话改动过的文件（汇总）'),
      usage: t('[路径]'),
      group: t('信息'),
      args: [{ kind: 'free', label: '[路径]', hint: t('不填则列出全部改动过的文件') }],
      fn: (a?: string) => changesCommand(app, a),
    },
  ])
}
