/** dsh_tui command: /compact — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js'
import { formatTokens } from '../../feed/stats.js'
import type { App } from '../../kernel/app.js'


/** /compact — manually compact the session context via the compaction
 *  engine; null result means there was nothing worth compacting. */
export const compactCommand = async (app: App) => {
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  const compaction = app.svc('compaction')
  if (compaction === undefined) {
    app.notice(t('compaction 服务未装配（profile 加入 dsh-compaction 后可用）'))
    return
  }
  app.notice(t('正在压缩上下文…'))
  try {
    const result = await compaction.compactNow(rec.handle.agent, new AbortController().signal)
    if (result === null) {
      app.notice(t('没有可压缩的历史'))
    } else {
      app.notice(`已压缩 ${result.shadowedSeqs.length} 条历史 · 约 ${formatTokens(result.shadowedTokenCount)} tokens`)
    }
  } catch (err) {
    app.notice(`压缩失败: ${(err as Error).message}`)
  }
}

export function installCompactCommand(app: App): void {
  app.registerCommands([{ name: '/compact', desc: t('压缩上下文'), usage: t(''), group: t('会话'), fn: () => compactCommand(app) }])
}
