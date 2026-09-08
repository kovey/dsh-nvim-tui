/** dsh_tui command: /search — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'


/** /search <query> — cross-session full-text search → picker → resume. */
export const searchCommand = async (app: App, a: string | undefined) => {
  const query = (a ?? '').trim()
  if (query === '') {
    app.notice(t('用法: /search <关键词>（跨会话全文搜索）'))
    return
  }
  const sessionQuery = app.svc('sessionQuery')
  if (sessionQuery === undefined) {
    app.notice(t('session-query 服务未装配（profile 加入 dsh-session-query-sqlite 后可用）'))
    return
  }
  app.notice(`搜索中: ${query}…`)
  try {
    const page = await sessionQuery.searchSessions({
      query,
      eventFilters: [{ kind: 'type', values: ['user/message', 'assistant/message'] }],
      limit: 20,
    })
    const hits = page.items ?? []
    if (hits.length === 0) {
      app.notice(t('没有匹配的会话'))
      return
    }
    const sel = await app.openPicker(`搜索结果（${hits.length}）`,
      hits.map((h) => ({
        label: `${String(h.header?.id ?? '?')} · ${String(h.bestMatch?.snippet ?? '').slice(0, 48)}`,
        value: String(h.header?.id),
      })))
    if (sel !== null) await app.slices.sessions.selectSession(sel)
  } catch (err) {
    app.notice(`搜索失败: ${(err as Error).message}`)
  }
}

export function installSearchCommand(app: App): void {
  app.registerCommands([{ name: '/search', desc: t('跨会话全文搜索'), usage: t('<关键词>'), group: t('会话'), fn: (a) => searchCommand(app, a) }])
}
