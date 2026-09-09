/** dsh_tui command: /rewind — one command per file. */
import { t } from '../../kernel/i18n.js'
import type { ChatMessage, MessageContent } from '../../kernel/types.js'
import type { App } from '../../kernel/app.js'

export const rewindCommand = async (app: App, a: string | undefined) => {
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  const session = app.runtimeCtx.sessions.get(rec.id)
  if (session === undefined || typeof session.truncate !== 'function') {
    app.notice(t('会话截断不可用：宿主 dsh-session 不支持 truncate（可用 /fork 派生替代）'))
    return
  }
  const arg = (a ?? '').trim()
  const boundaries = []
  for (const e of app.slices.trans.sessionEvents(session)) {
    if (e.type === 'user/message') {
      const um = (e.data as { message?: ChatMessage } | ChatMessage | undefined)
      const umsg = (um as { message?: ChatMessage } | undefined)?.message ?? (um as ChatMessage | undefined)
      const text = Array.isArray(umsg?.content)
        ? umsg.content.filter((b): b is Extract<MessageContent, { type: 'text' }> => b?.type === 'text' && typeof (b as { text?: unknown }).text === 'string').map((b) => b.text).join(' ')
        : (umsg?.text ?? '')
      boundaries.push({ seq: e.seq, text: String(text).replace(/\s+/g, ' ').slice(0, 48) })
    }
  }
  if (boundaries.length === 0) {
    app.notice(t('（没有可回退的用户消息）'))
    return
  }
  const recent = boundaries.slice(-8)
  const numeric = arg !== '' && /^\d+$/.test(arg)
  let target
  if (numeric) {
    // 1-based FROM THE START: /rewind N keeps the first N user messages and
    // truncates everything after the Nth. (Counting from the END — /rewind 2
    // deleting all but the last two messages — was the pre-review behavior.)
    const n = Math.max(1, Math.min(Number(arg), boundaries.length))
    target = boundaries[n - 1]
  } else {
    const sel = await app.openPicker(t('回退到哪条消息之后（截断其后内容）'),
      recent.map((b) => ({ label: `#${b.seq} ${b.text}`, value: String(b.seq) })))
    if (sel === null) return
    target = boundaries.find((b) => String(b.seq) === sel)
  }
  if (target === undefined) {
    app.notice(t('未找到目标边界'))
    return
  }
  if (numeric) {
    // The numeric shortcut had no preview and truncates in place: confirm.
    const ok = await app.openPicker(t('确认回退'), [
      { label: `截断 #${target.seq}「${target.text}」之后的全部内容（不可恢复）`, value: 'yes' },
      { label: t('取消'), value: 'no' },
    ])
    if (ok !== 'yes') return
  }
  try {
    session.truncate(target.seq)
    // Rebuild the chat from the truncated events (the harness truncates
    // in place and emits no events).
    rec.feed.clear()
    // Rebuilding replays the SAME tool/result events into the SAME feed:
    // drop the ✎ dedupe cache or every diff block rendered before the
    // rewind stays suppressed forever.
    app.slices.ui.renderedDiffCalls.delete(rec.feed)
    for (const e of app.slices.trans.sessionEvents(session)) {
      app.slices.ui.foldEvent(rec, e)
      rec.feed.applyEvent(e, { history: true })
      app.slices.ui.maybePushFileDiff(rec.feed, e)
    }
    void rec.feed.flush()
    app.notice(`已回退到 #${target.seq}（其后内容已截断）`)
  } catch (err) {
    app.notice(`回退失败: ${(err as Error).message}`)
  }
}

/** /queue — pending-message queue (official QueueDock counterpart):
 *  view queued turns and next-step input, edit / remove rows, clear all. */

export function installRewindCommand(app: App): void {
  app.registerCommands([{ name: '/rewind', desc: t('回退到某条消息'), usage: t('[第N条]'), group: t('会话'), fn: (a) => rewindCommand(app, a) }])
}
