/** dsh_tui command: /upload — durably attach a local file to the next prompt.
 *
 * Unlike `@` references (a path the model may read with a tool, subject to
 * sandbox/read policy), this commits the bytes through the host attachment
 * store and sends a real `file` content block. The TUI is local, so "upload"
 * is a local file read; the durable ref is what makes the prompt portable.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'
import { t, tf } from '../../kernel/i18n.js'
import { activeSessionCwd } from '../../kernel/app.js'
import type { AppSlices, WritableSlice } from '../../kernel/app.js'
import type { App } from '../../kernel/app.js'
const W = (d: AppSlices['agent']) => d as WritableSlice<AppSlices['agent']>

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

const expandHome = (p: string): string => p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p

export const uploadCommand = async (app: App, a: string | undefined) => {
  const raw = (a ?? '').trim()
  if (raw === 'clear') {
    const n = app.slices.agent.pendingFiles.length
    W(app.slices.agent).pendingFiles = []
    app.notice(tf('已清空 {0} 个待发送文件', [String(n)]))
    return
  }
  if (raw === '') {
    const n = app.slices.agent.pendingFiles.length
    app.notice(tf('待发送文件 {0} 个；用法: /upload <路径> | /upload clear', [String(n)]))
    return
  }
  const path = isAbsolute(expandHome(raw)) ? expandHome(raw) : resolve(activeSessionCwd(app), expandHome(raw))
  if (!existsSync(path)) { app.notice(tf('文件不存在: {0}', [path])); return }
  let size = 0
  try { size = statSync(path).size } catch (err) { app.notice(tf('读取失败: {0}', [(err as Error).message])); return }
  if (size > MAX_UPLOAD_BYTES) {
    app.notice(tf('文件过大（{0} MB，上限 20 MB）；请用 @ 引用路径', [(size / 1024 / 1024).toFixed(1)]))
    return
  }
  const attachments = app.svc('attachments')
  if (attachments?.saveFile === undefined) {
    app.notice(t('附件服务不支持文件上传（缺少 saveFile）；请用 @ 引用路径'))
    return
  }
  try {
    const data = readFileSync(path)
    const ref = await attachments.saveFile({ data, name: basename(path) })
    app.slices.agent.pendingFiles.push(ref)
    app.notice(tf('📎 已附加文件 {0}（{1} 个待发送；回车随消息发送）', [
      ref.name,
      String(app.slices.agent.pendingFiles.length),
    ]))
  } catch (err) {
    app.notice(tf('文件上传失败: {0}', [(err as Error).message]))
  }
}

export function installUploadCommand(app: App): void {
  app.registerCommands([{
    name: '/upload',
    desc: t('把本地文件作为 durable 附件随消息发送'),
    usage: t('<路径> | clear'),
    group: t('会话'),
    args: [{ kind: 'free', label: '<路径> | clear', hint: t('clear 清空待发送文件') }],
    fn: (a?: string) => uploadCommand(app, a),
  }])
}
