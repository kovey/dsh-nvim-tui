/** dsh_tui command: /fb — one command per file (self-registering,
 *  wired by the commands module index). */
import { t, tf } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'


/** /fb up|down [note] — feedback on the last assistant message. */
export const feedbackCommand = async (app: App, a: string | undefined) => {
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  const feedback = app.svc('messageFeedback')
  if (feedback === undefined) {
    app.notice(t('message-feedback 服务未装配'))
    return
  }
  const [op, ...rest] = (a ?? '').trim().split(/\s+/)
  if (op !== 'up' && op !== 'down' && op !== 'clear') {
    app.notice(t('用法: /fb up|down [备注] | /fb clear'))
    return
  }
  if (rec.lastAssistantMessageId === null || rec.lastAssistantMessageId === undefined) {
    app.notice(t('本会话还没有助手消息可反馈'))
    return
  }
  try {
    if (op === 'clear') {
      const list = await feedback.list({ sessionId: rec.id })
      const item = list.ok ? list.value.items.find((i) => i.messageId === rec.lastAssistantMessageId) : undefined
      if (item !== undefined) {
        await feedback.delete({ sessionId: rec.id, messageId: rec.lastAssistantMessageId, ifVersion: item.version })
        app.notice(t('已清除反馈'))
      } else {
        app.notice(t('该回答没有反馈记录'))
      }
      return
    }
    const list = await feedback.list({ sessionId: rec.id })
    const item = list.ok ? list.value.items.find((i) => i.messageId === rec.lastAssistantMessageId) : undefined
    const note = rest.join(' ').trim() || undefined
    const r = await feedback.put({
      sessionId: rec.id,
      messageId: rec.lastAssistantMessageId,
      rating: op === 'up' ? 'positive' : 'negative',
      ...(note !== undefined ? { note } : {}),
      ifVersion: item?.version ?? null,
    })
    if (r.ok) app.notice(op === 'up' ? t('👍 已反馈') : t('👎 已反馈'))
    else app.notice(tf('反馈失败: {0}', [r.error?.code ?? 'unknown']))
  } catch (err) {
    app.notice(tf('反馈失败: {0}', [(err as Error).message]))
  }
}

export function installFbCommand(app: App): void {
  app.registerCommands([{ name: '/fb', desc: t('反馈最后一条回答'), usage: t('up|down [备注]'), group: t('会话'), fn: (a) => feedbackCommand(app, a) }])
}
