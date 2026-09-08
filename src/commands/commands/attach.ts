/** dsh_tui command: /attach — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js'
import { isAbsolute, join } from 'node:path'
import { readImageFile } from '../../feed/images.js'
import { sniffMediaType } from '../../feed/images.js'
import { imageLabel } from '../../feed/images.js'
import { openDirPicker } from '../core.js'
import { formatMention } from '../core.js'
import type { App } from '../../kernel/app.js'


/** /attach [path] — image → durable attachment; file/dir → @-mention.
 *  Without an argument a directory picker selects the target. */
export const attachCommand = async (app: App, a: string | undefined) => {
  let path: string | null = (a ?? '').trim()
  if (path === '') {
    path = await openDirPicker(app, process.cwd())
    if (path === null) return
  }
  const abs = isAbsolute(path) ? path : join(process.cwd(), path)
  const media = sniffMediaType(abs as unknown as Uint8Array)
  if (media !== null) {
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
    const attachments = app.svc('attachments')
    if (!rec || typeof attachments?.saveImage !== 'function') {
      app.notice(t('附件服务未装配'))
      return
    }
    try {
      const img = await readImageFile(abs, media)
      const ref = await attachments.saveImage(img)
      app.slices.agent.pendingImages.push({ type: 'image', attachment: ref })
      app.notice(`📎 图片已附加: ${imageLabel(ref)}（随下一条消息发送）`)
    } catch (err) {
      app.notice(`附件失败: ${(err as Error).message}`)
    }
    return
  }
  // Non-image: a path-only @-mention (the official file-reference way —
  // the model reads the file through its tools when needed).
  const rel = isAbsolute(path) ? path : path
  await app.luaCall('require("dsh_tui").append_input(...)', [formatMention(rel) + ' ']).catch(() => {})
  app.notice(`已引用: ${rel}（@ 路径会随消息发送，模型按需读取）`)
}

export function installAttachCommand(app: App): void {
  app.registerCommands([{ name: '/attach', desc: t('附加文件/目录（图片为附件，其余为 @ 引用）'), usage: t('[路径]'), group: t('会话'), fn: (a) => attachCommand(app, a) }])
}
