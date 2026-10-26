/** dsh_tui command: /outline — session turn outline. Shows every turn with its
 *  first user prompt, step/tool counts and end reason; Enter opens that turn's
 *  step trajectory. `/trajectory` remains the single-turn detail view. */
import { t, tf } from '../../kernel/i18n.js'
import { FeedRenderer } from '../../feed/feed.js'
import type { App } from '../../kernel/app.js'
import type { ChatMessage, SessionEvent } from '../../kernel/types.js'

export interface TurnOutlineRow {
  turn: number
  user: string
  steps: number
  tools: number
  reason: string
  at: number
}

/** Pure fold: turns in log order. Exported so the outline shape is asserted
 *  without a live session. */
export const turnOutlineRows = (events: readonly SessionEvent[]): TurnOutlineRow[] => {
  const rows = new Map<number, TurnOutlineRow>()
  let currentTurn: number | undefined
  for (const event of events) {
    const data = event.data as { turn?: number; step?: number; message?: ChatMessage; name?: string } | undefined
    if (event.type === 'turn/start') {
      const turn = data?.turn
      if (typeof turn === 'number') {
        currentTurn = turn
        rows.set(turn, { turn, user: '', steps: 0, tools: 0, reason: '', at: event.time ?? 0 })
      }
      continue
    }
    // user/message carries no turn field; it belongs to the most recently
    // opened turn (step/tool/end events carry their own).
    const turn = data?.turn ?? (event.type === 'user/message' ? currentTurn : undefined)
    if (typeof turn !== 'number') continue
    const row = rows.get(turn)
    if (row === undefined) continue
    if (event.type === 'user/message') {
      if (row.user === '') {
        const msg = (data as { message?: ChatMessage } | undefined)?.message ?? data as ChatMessage
        const src = msg?.source as { kind?: string } | undefined
        if (src?.kind === undefined || src.kind === 'user') row.user = FeedRenderer.messageText(msg).replace(/\s+/g, ' ').slice(0, 60)
      }
    } else if (event.type === 'step/start') {
      row.steps += 1
    } else if (event.type === 'tool/call') {
      row.tools += 1
    } else if (event.type === 'turn/end') {
      row.reason = String((event.data as { reason?: unknown } | undefined)?.reason ?? '')
    }
  }
  return [...rows.values()]
}

export const outlineCommand = async (app: App) => {
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (!rec) { app.notice(t('无活跃会话')); return }
  const rows = turnOutlineRows(app.slices.trans.sessionEvents(rec.handle.agent.session))
  if (rows.length === 0) { app.notice(t('本会话还没有回合')); return }
  const chosen = await app.openPicker(t('回合大纲（Enter 查看步骤轨迹）'), rows.map((r) => ({
    label: `#${String(r.turn)} · ${r.user || t('（无用户文本）')} · ${tf('{0} 步 / {1} 工具', [String(r.steps), String(r.tools)])}${r.reason !== '' ? ` · ${r.reason}` : ''}`,
    value: String(r.turn),
  })))
  if (chosen === null) return
  const spec = app.commandSpecs.find((s) => s.name === '/trajectory')
  if (spec !== undefined) await spec.fn(chosen)
}

export function installOutlineCommand(app: App): void {
  app.registerCommands([{
    name: '/outline',
    desc: t('回合大纲（跳到某一回合的步骤轨迹）'),
    usage: t(''),
    group: t('信息'),
    fn: () => outlineCommand(app),
  }])
}
