/** dsh_tui command: /copy — put the session history, last answer, or raw JSONL
 *  on the system clipboard. The Markdown header carries the session id, title
 *  and the original log path, so a pasted transcript remains supportable. */
import { t, tf } from '../../kernel/i18n.js'
import { writeClipboardText } from '../../kernel/clipboard.js'
import { FeedRenderer } from '../../feed/feed.js'
import { historyMarkdown, serializeSessionLog, sessionEventsOf } from '../../kernel/session-log.js'
import { activeSessionCwd } from '../../kernel/app.js'
import type { App } from '../../kernel/app.js'
import type { SessionEvent } from '../../kernel/types.js'

export type CopyMode = 'history' | 'last' | 'raw'

export const parseCopyMode = (arg: string | undefined): CopyMode | undefined => {
  const mode = (arg ?? '').trim()
  if (mode === '' || mode === 'history' || mode === 'md') return 'history'
  if (mode === 'last' || mode === 'answer') return 'last'
  if (mode === 'raw' || mode === 'log') return 'raw'
  return undefined
}

/** Last assistant text in the committed event log. */
export const lastAssistantText = (events: readonly SessionEvent[]): string => {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'assistant/message') continue
    const text = FeedRenderer.messageText((event.data as { message?: Parameters<typeof FeedRenderer.messageText>[0] } | undefined)?.message)
    if (text.trim() !== '') return text.trim()
  }
  return ''
}

export const copyCommand = async (app: App, a?: string): Promise<void> => {
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (!rec) { app.notice(t('无活跃会话')); return }
  const mode = parseCopyMode(a)
  if (mode === undefined) {
    app.notice(t('用法: /copy [history|last|raw]'))
    return
  }
  const session = rec.handle.agent.session
  const events = sessionEventsOf(session)
  const persisted = app.svc('sessionPersistence')
  let logPath: string | undefined
  try { logPath = persisted?.locate?.(session.header)?.path } catch { logPath = undefined }
  let text: string
  try {
    if (mode === 'last') {
      text = lastAssistantText(events)
      if (text === '') { app.notice(t('最近没有助手文本可复制')); return }
    } else if (mode === 'raw') {
      text = serializeSessionLog(session.header as Parameters<typeof serializeSessionLog>[0], events, {
        id: rec.id,
        createdAt: rec.createdAt,
      })
    } else {
      const lines = await app.slices.runtime.nvim!.request('nvim_buf_get_lines', [rec.feed.bufId, 0, -1, false]) as string[]
      text = historyMarkdown(lines, { id: rec.id, title: rec.title, logPath, cwd: activeSessionCwd(app) })
    }
  } catch (err) {
    app.notice(tf('复制内容生成失败: {0}', [(err as Error).message]))
    return
  }
  const result = writeClipboardText(text)
  if (!result.ok) {
    app.notice(tf('剪贴板不可用: {0}', [result.error ?? 'no clipboard command']))
    return
  }
  const label = mode === 'history' ? t('完整历史 Markdown') : mode === 'last' ? t('最后一条助手文本') : t('原始 JSONL')
  app.notice(tf('已复制{0}（{1} 字符，{2}）', [label, String(text.length), result.command ?? '']))
}

export function installCopyCommand(app: App): void {
  app.registerCommands([{
    name: '/copy',
    desc: t('复制完整历史 Markdown、最后回答或原始 JSONL 到剪贴板'),
    usage: t('[history|last|raw]'),
    group: t('信息'),
    args: [{ kind: 'oneof', values: ['history', 'last', 'raw'], hint: t('history=完整记录；last=最后回答；raw=原始 JSONL') }],
    fn: (a?: string) => copyCommand(app, a),
  }])
}
