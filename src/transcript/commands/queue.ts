/** dsh_tui command: /queue — one command per file. */
import { t } from '../../kernel/i18n.js'
import { FeedRenderer } from '../../feed/feed.js'
import type { ChatMessage, InboxLike } from '../../kernel/types.js'
import type { App } from '../../kernel/app.js'

export const queueCommand = async (app: App): Promise<void> => {
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  const inbox = rec.handle.agent.inbox as InboxLike | undefined
  const nextTurn = (inbox?.nextTurn ?? []) as unknown[]
  const nextStep = (inbox?.nextStep ?? []) as unknown[]
  if (nextTurn.length === 0 && nextStep.length === 0) {
    app.notice(t('（没有排队中的消息）'))
    return
  }
  interface QueueRow { label: string; value: string }
  const rows: QueueRow[] = []
  const add = (list: 'nextTurn' | 'nextStep', msgs: unknown[], prefix: string) => {
    for (const m of msgs) {
      const id = (m as { id?: string }).id
      const text = FeedRenderer.messageText(m as ChatMessage)
      rows.push({
        label: `${prefix}${FeedRenderer.truncate(text.replace(/\s+/g, ' '), 60)}`,
        value: JSON.stringify({ list, id: String(id ?? '') }),
      })
    }
  }
  if (nextTurn.length > 0) rows.push({ label: `── 排队回合 ${nextTurn.length} 条`, value: 'none' })
  add('nextTurn', nextTurn, '  ')
  if (nextStep.length > 0) rows.push({ label: `── 下一步输入 ${nextStep.length} 条`, value: 'none' })
  add('nextStep', nextStep, '  ')
  rows.push({ label: '🗑 清空全部排队', value: 'clear' })
  const sel = await app.openPicker(t('消息队列'), rows)
  if (sel === null || sel === 'none') return
  if (sel === 'clear') {
    if (typeof inbox?.clear !== 'function') { app.notice(t('inbox 不可用')); return }
    try { inbox.clear(); app.notice(t('已清空排队消息')) } catch (err) { app.notice(`清空失败: ${(err as Error).message}`) }
    return
  }
  let picked: { list: 'nextTurn' | 'nextStep'; id: string } | undefined
  try { picked = JSON.parse(sel) as { list: 'nextTurn' | 'nextStep'; id: string } } catch {}
  if (picked === undefined) return
  const act = await app.openPicker(t('队列操作'), [
    { label: '删除该条', value: 'del' },
    { label: '编辑该条（下一条输入作为新内容）', value: 'edit' },
  ])
  if (act === 'del') {
    if (typeof inbox?.remove !== 'function') { app.notice(t('inbox 不可用')); return }
    try {
      const ok = inbox.remove(picked.id)
      app.notice(ok === true ? '已从队列移除' : '该消息已被处理')
    } catch (err) { app.notice(`移除失败: ${(err as Error).message}`) }
  } else if (act === 'edit') {
    app.slices.agent.setPendingQueueEdit({ list: picked.list, messageId: picked.id })
    app.notice(t('下一条输入将替换该排队消息'))
  }
}


export function installQueueCommand(app: App): void {
  app.registerCommands([{ name: '/queue', desc: t('消息队列（编辑/删除/清空）'), usage: t('消息队列'), group: t('会话'), fn: () => queueCommand(app) }])
}
