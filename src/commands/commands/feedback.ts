/** dsh_tui command: /feedback — session-level feedback (categories + text),
 *  the TUI counterpart of the Web feedback dialog. Message-level thumbs stay
 *  on `/fb`; this one records `feedback/record` for the whole session, which
 *  is what authorizes the host's feedback-only telemetry delivery. */
import { t, tf } from '../../kernel/i18n.js'
import { promptLine } from '../../kernel/prompt.js'
import { FEEDBACK_CATEGORIES, type FeedbackCategory } from '../../kernel/types.js'
import type { App } from '../../kernel/app.js'

/** Parse `/feedback [category] [text…]`. Exported for a pure assertion: a
 *  category token wins only when it is EXACTLY one of the durable ids. */
export const parseFeedbackArgs = (a: string | undefined): { category?: FeedbackCategory; text: string } => {
  const raw = (a ?? '').trim()
  if (raw === '') return { text: '' }
  const [first, ...rest] = raw.split(/\s+/)
  if (first !== undefined && (FEEDBACK_CATEGORIES as readonly string[]).includes(first)) {
    return { category: first as FeedbackCategory, text: rest.join(' ').trim() }
  }
  return { text: raw }
}

const categoryLabel = (c: FeedbackCategory): string => {
  switch (c) {
    case 'task-result': return t('任务结果')
    case 'instruction-following': return t('指令遵循')
    case 'product-interaction': return t('产品交互')
    case 'service-stability': return t('服务稳定性')
    case 'resource-cost': return t('资源/成本')
    case 'security-privacy-permission': return t('安全/隐私/权限')
    case 'other': return t('其他')
  }
}

export const feedbackCommand = async (app: App, a: string | undefined) => {
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  const svc = app.svc('sessionFeedback')
  if (svc === undefined || typeof svc.record !== 'function') {
    app.notice(t('session-feedback 服务未装配（在 profile 加入 dsh-command-feedback）'))
    return
  }
  let { category, text } = parseFeedbackArgs(a)
  if (a === undefined || (a ?? '').trim() === '') {
    const picked = await app.openPicker(t('反馈分类'), [
      { label: t('不分类'), value: 'none' },
      ...FEEDBACK_CATEGORIES.map((c) => ({ label: categoryLabel(c), value: c })),
    ])
    if (picked === null) return
    if (picked !== 'none') category = picked as FeedbackCategory
    const input = await promptLine(app, t('反馈内容（可留空）'))
    if (input === null) return
    text = input.trim()
  }
  if ((text ?? '') === '' && category === undefined) {
    app.notice(t('用法: /feedback [分类] <反馈内容>'))
    return
  }
  try {
    const result = await svc.record({
      sessionId: rec.id,
      ...(text !== undefined && text !== '' ? { text } : {}),
      ...(category !== undefined ? { category } : {}),
    })
    if (result.ok) {
      app.notice(tf('已记录会话反馈{0}', [category !== undefined ? `（${categoryLabel(category)}）` : '']))
    } else {
      app.notice(tf('反馈失败: {0}', [result.error.code]))
    }
  } catch (err) {
    app.notice(tf('反馈失败: {0}', [(err as Error).message]))
  }
}

export function installFeedbackCommand(app: App): void {
  app.registerCommands([{
    name: '/feedback',
    desc: t('会话级反馈（分类 + 文本，授权反馈日志投递）'),
    usage: t('[分类] <反馈内容>'),
    group: t('会话'),
    args: [{ kind: 'free', label: '[分类] <反馈内容>', hint: t('分类可选；不填分类会弹出选择器') }],
    fn: (a?: string) => feedbackCommand(app, a),
  }])
}
