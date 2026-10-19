/** dsh_tui command: /cwd — read or change the SESSION working directory.
 *
 *  dsh 0.2.1 introduced `working_directory` (tool + SDK seam): `set()` changes
 *  one Session's directory WITHOUT touching existing processes or permissions,
 *  which is exactly what a TUI user wants — "keep this chat, work somewhere
 *  else now". Before this the directory was fixed at session creation, so the
 *  only way to move was to start another session.
 *
 *  Freshness matters here: the directory is durable state owned by the host, so
 *  the value is re-read from the service rather than cached from
 *  `session.header.cwd` (that header is the ORIGINAL directory and goes stale
 *  after a `set`). */
import { t, tf } from '../../kernel/i18n.js'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { App } from '../../kernel/app.js'

/** The host's committed directory for the active session, or undefined when
 *  the service is missing (pre-0.2.1 hosts) or nothing is active. */
export const sessionWorkingDir = (app: App): string | undefined => {
  const rec = app.slices.sessions.activeId === null
    ? undefined
    : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (rec === undefined) return undefined
  const wd = app.svc('workingDirectory')
  if (typeof wd?.get !== 'function') return undefined
  try {
    const dir = wd.get(rec.handle.agent.session)
    return typeof dir === 'string' && dir !== '' ? dir : undefined
  } catch {
    return undefined
  }
}

/** /cwd [路径] — show the session working directory, or move it.
 *  A relative path resolves against the CURRENT directory, which is what a
 *  person expects from `cd`. */
export const cwdCommand = async (app: App, a: string | undefined): Promise<void> => {
  const rec = app.slices.sessions.activeId === null
    ? undefined
    : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (rec === undefined) {
    app.notice(t('当前没有活跃会话'))
    return
  }
  const wd = app.svc('workingDirectory')
  if (typeof wd?.set !== 'function') {
    // Distinguish "old host" from "something else went wrong": claiming a
    // failure here would send the user looking for a bug that is not there.
    app.notice(t('该宿主没有 working_directory 服务（需 dsh 0.2.1+），无法切换工作目录'))
    return
  }
  const want = (a ?? '').trim()
  const cur = sessionWorkingDir(app)
  if (want === '') {
    app.notice(cur === undefined
      ? t('（无法读取当前工作目录）')
      : tf('会话工作目录: {0}（/cwd <路径> 切换）', [cur]))
    return
  }
  const target = isAbsolute(want) ? want : resolvePath(cur ?? process.cwd(), want)
  try {
    const dir = await wd.set(rec.handle.agent, target)
    app.notice(tf('工作目录已切换到 {0}', [dir]))
    app.slices.ui.updateStatusline()
  } catch (err) {
    // The host rejects non-existent directories; surface ITS reason rather than
    // inventing one (ENOENT vs ENOTDIR vs permission are different fixes).
    app.notice(tf('切换失败: {0}', [(err as Error).message]))
  }
}

export function installCwdCommand(app: App): void {
  app.registerCommands([{
    name: '/cwd',
    desc: t('会话工作目录（查看/切换）'),
    usage: t('[路径]'),
    group: t('信息'),
    fn: (a) => cwdCommand(app, a),
  }])
}
