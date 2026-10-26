/** dsh_tui command: /changes — one command per file (self-registering,
 *  wired by the commands module index). */
import { resolve } from 'node:path'
import { t, tf } from '../../kernel/i18n.js'
import { ledgerRows, ledgerTotals, type FileChange } from '../../kernel/change-ledger.js'
import type { App } from '../../kernel/app.js'
import type { WorkspaceChangesSummary } from '../../kernel/types.js'

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
  const raw = m?.[1] ?? ''
  // Specs are registered WITH the slash (`/diff`). Accepting a bare name here
  // cost a silent failure once: this function returned early for `'diff …'`,
  // so Enter in /changes did nothing at all. Normalise instead of trusting the
  // caller's spelling, and SAY SO when the target is missing — a silent return
  // is what made the bug invisible.
  const spec = app.commandSpecs.find((s) => s.name === (raw.startsWith('/') ? raw : '/' + raw))
  if (spec === undefined) {
    app.notice(tf('内部错误：找不到命令 {0}', [raw.startsWith('/') ? raw : '/' + raw]))
    return
  }
  try {
    await spec.fn(m?.[2] ?? '')
  } catch (err) {
    app.notice(tf('命令失败: {0}', [(err as Error).message]))
  }
}

/** Render the host's authoritative per-turn summary (git working-tree
 *  snapshots + whole-file captures). This is strictly better than the rendered
 *  diff ledger for files produced by bash or edited outside a tracked tool, so
 *  it is preferred whenever the service and a workspace/changes event exist. */
const showWorkspaceChanges = async (
  app: App,
  sessionId: string,
  seq: number,
  summary: WorkspaceChangesSummary,
  wanted: string,
  extra: readonly FileChange[],
): Promise<void> => {
  const icon = (f: { binary?: true; oversized?: true }): string =>
    f.binary === true || f.oversized === true ? '▧' : '✎'
  const openDiff = async (index: number): Promise<void> => {
    const svc = app.svc('workspaceChanges')
    if (svc === undefined || typeof svc.diff !== 'function') {
      app.notice(t('workspaceChanges 服务不可用'))
      return
    }
    const file = summary.files[index]
    if (file === undefined) return
    try {
      const diff = await svc.diff(sessionId, seq, index, AbortSignal.timeout(8000))
      if (diff === undefined) {
        app.notice(t('改动对比已不可用（宿主已释放该会话快照）'))
        return
      }
      if (diff.kind !== 'text') {
        app.notice(diff.kind === 'binary'
          ? tf('{0} 是二进制文件，无法显示行级对比', [file.display])
          : tf('{0} 超出对比大小上限', [file.display]))
        return
      }
      const lines: string[] = []
      for (const hunk of diff.hunks) {
        lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
        for (const line of hunk.lines) lines.push(line)
      }
      if (lines.length === 0) lines.push(t('（两侧内容相同）'))
      await app.luaCall('require("dsh_tui").show_lines_float(...)', [
        tf('改动对比 · {0}', [diff.display]),
        lines,
        resolve(summary.cwd, file.path),
      ]).catch(() => {})
    } catch (err) {
      app.notice(tf('读取改动对比失败: {0}', [(err as Error).message]))
    }
  }
  const hostHit = wanted === ''
    ? undefined
    : summary.files.findIndex((f) => f.path === wanted || f.display === wanted || f.display.endsWith('/' + wanted))
  if (wanted !== '') {
    if (hostHit !== undefined && hostHit >= 0) {
      await openDiff(hostHit)
      return
    }
    const extraHit = extra.find((r) => r.path === wanted || r.path.endsWith('/' + wanted))
    if (extraHit !== undefined) {
      await runSlash(app, '/diff ' + extraHit.path)
      return
    }
    app.notice(tf('本会话没有改过: {0}', [wanted]))
    return
  }
  const omitted = summary.total > summary.files.length
  const lines = [
    tf('本轮 {0} 个文件 · +{1} −{2}（宿主快照）', [String(summary.total), String(summary.added), String(summary.deleted)]),
    ...(omitted ? [tf('（仅列出前 {0} 个，共 {1} 个）', [String(summary.files.length), String(summary.total)])] : []),
    '',
    ...summary.files.map((f) => `${icon(f)} ${f.display} · +${f.added} −${f.deleted}`),
  ]
  if (extra.length > 0) {
    lines.push('', t('更早的改动（diff 账本）'), ...extra.map((r) => `✎ ${r.path} · +${r.added} −${r.removed}`))
  }
  const sel = await app.openPicker(t('改动（Enter 查看对比）'), [
    { label: t('↩ 关闭'), value: 'act:close' },
    ...summary.files.map((f, i) => ({
      label: `${icon(f)} ${f.display} · +${f.added} −${f.deleted}`,
      value: `ws:${String(i)}`,
    })),
    ...extra.map((r) => ({
      label: `✎ ${r.path} · +${r.added} −${r.removed}（diff 账本）`,
      value: `rev:${r.path}`,
    })),
  ])
  if (sel === null || sel === 'act:close') {
    await app.luaCall('require("dsh_tui").show_lines_float(...)', [t('改动'), lines]).catch(() => {})
    return
  }
  if (sel.startsWith('ws:')) await openDiff(Number(sel.slice(3)))
  else if (sel.startsWith('rev:')) await runSlash(app, '/diff ' + sel.slice(4))
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
  const wanted = (a ?? '').trim()
  const wsEvent = rec.workspaceChangesEvent
  const wsSeq = wsEvent === null ? undefined : wsEvent.seq
  const wsSvc = app.svc('workspaceChanges')
  let summary: WorkspaceChangesSummary | undefined
  if (wsSeq !== undefined && typeof wsSvc?.summary === 'function') {
    try { summary = wsSvc.summary(rec.id, wsSeq) } catch { summary = undefined }
  }
  const ledger = app.slices.ui.changeLedger.get(rec.feed)
  if (summary !== undefined && wsSeq !== undefined && summary.files.length > 0) {
    const hostPaths = new Set(summary.files.map((f) => f.path))
    const extra = ledger === undefined
      ? []
      : ledgerRows(ledger).filter((r) => !hostPaths.has(r.path) && !summary.files.some((f) => f.display === r.path))
    await showWorkspaceChanges(app, rec.id, wsSeq, summary, wanted, extra)
    return
  }
  if (ledger === undefined || ledger.size === 0) {
    app.notice(t('本会话还没有文件改动'))
    return
  }
  const rows = ledgerRows(ledger)
  const totals = ledgerTotals(ledger)

  if (wanted !== '') {
    const hit = rows.find((r) => r.path === wanted || r.path.endsWith('/' + wanted))
    if (hit === undefined) {
      app.notice(tf('本会话没有改过: {0}', [wanted]))
      return
    }
    // Hand off to /diff, which owns the side-by-side view (and its data).
    await runSlash(app, '/diff ' + hit.path)
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
  if (sel.startsWith('rev:')) await runSlash(app, '/diff ' + sel.slice(4))
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
