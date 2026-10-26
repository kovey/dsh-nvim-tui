/** dsh_tui command: /deliverables — one command per file (self-registering,
 *  wired by the commands module index). */
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { t, tf } from '../../kernel/i18n.js'
import { activeSessionCwd, type App } from '../../kernel/app.js'
import { deliverablePaths, resolveDeliverablePath } from '../../kernel/deliverables.js'

/** Human-readable size. Produced files are often large binaries the model will
 *  never show inline, so the size is the first thing the user wants to know. */
const humanSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(1)} ${units[i]}`
}

/**
 * OS "open with the default application" argv, or undefined when this platform
 * has no known opener.
 *
 * WHY: a produced file has no business living only inside nvim — a PDF, an
 * image or a spreadsheet is meant to be handed to the system. macOS `open`
 * covers it; Linux falls back to `xdg-open`.
 *
 * Platform is a parameter (not read from `process` inline) so the mapping is
 * testable without pretending to run on another OS.
 */
export const systemOpenArgv = (path: string, platform: string = process.platform): string[] | undefined => {
  if (platform === 'darwin') return ['open', path]
  if (platform === 'linux') return ['xdg-open', path]
  return undefined
}

/** Same, but selecting the file in the platform's file manager. Only macOS has
 *  a portable spelling; elsewhere the action is simply not offered. */
export const systemRevealArgv = (path: string, platform: string = process.platform): string[] | undefined => {
  if (platform === 'darwin') return ['open', '-R', path]
  return undefined
}

/** Shorten a path for display: `$HOME` → `~`. */
const prettyPath = (p: string): string => {
  const home = homedir()
  return p.startsWith(home + '/') ? '~' + p.slice(home.length) : p
}

/** /deliverables — files this session's current turn produced.
 *
 *  Explicit `deliverables/presented` declarations come first (they can cover
 *  files made by bash or any tool without a path argument), then the mutation
 *  tool heuristic. Relative declared paths resolve against the session cwd —
 *  the cwd `/new <dir>` or `/cwd` set, not the shell's. */
export const deliverablesCommand = async (app: App) => {
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  const cwd = activeSessionCwd(app)
  const descriptions = new Map((rec.deliverables?.presented ?? []).map((f) => [f.path, f.description] as const))
  const rows: Array<{ label: string; value: string }> = []
  const seen = new Set<string>()
  for (const path of deliverablePaths(rec.deliverables)) {
    const abs = resolveDeliverablePath(cwd, path)
    if (seen.has(abs)) continue
    seen.add(abs)
    const description = descriptions.get(path)
    rows.push({
      label: `${prettyPath(abs)}${description !== undefined && description !== '' ? ` — ${description}` : ''}`,
      value: abs,
    })
  }
  if (rows.length === 0) {
    app.notice(t('本回合还没有产出文件（present / 写改文件的工具运行后会出现在这里）'))
    return
  }
  const sel = await app.openPicker(t('交付物（Enter 在 nvim 新标签页打开）'), rows)
  if (sel === null) return
  if (!existsSync(sel)) {
    app.notice(tf('文件已不存在: {0}', [prettyPath(sel)]))
    return
  }
  let size = 0
  try {
    size = statSync(sel).size
  } catch {
    /* unreadable: report 0 rather than failing the whole flow */
  }
  // Show the file's facts and let the user choose the destination: nvim (i/o)
  // or the system's own application. The argv is built here, where the platform
  // is known; the float just spawns it.
  const open = systemOpenArgv(sel)
  const reveal = systemRevealArgv(sel)
  const actions: Array<{ key: string; label: string; argv: string[] }> = []
  if (open !== undefined) actions.push({ key: 'O', label: t('用系统程序打开'), argv: open })
  if (reveal !== undefined) actions.push({ key: 'R', label: t('在文件管理器中显示'), argv: reveal })
  await app.luaCall('require("dsh_tui").show_lines_float(...)', [
    t('交付物'),
    [prettyPath(sel), humanSize(size)],
    sel,
    actions,
  ]).catch(() => {})
}

export function installDeliverablesCommand(app: App): void {
  app.registerCommands([{ name: '/deliverables', desc: t('本回合交付物（打开产物文件）'), usage: t(''), group: t('信息'), fn: () => deliverablesCommand(app) }])
}
