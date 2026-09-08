/** dsh_tui command: /goal — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'


/** /goal [show|new <objective>|pause|resume|complete|clear] — the active
 *  goal (compare-and-set on the GoalRef). */
export const goalCommand = (app: App, a: string | undefined) => {
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  const goals = app.svc('goals')
  if (goals === undefined) {
    app.notice(t('goal 服务未装配（profile 加入 dsh-goal 后可用）'))
    return
  }
  const agent = rec.handle.agent
  const goal = goals.get(agent)
  const [op, ...rest] = (a ?? '').trim().split(/\s+/)
  if (op === '' || op === 'show' || op === 'status') {
    if (goal === undefined) {
      app.notice(t('（无进行中的目标）用法: /goal new <objective>'))
      return
    }
    app.notice(`🎯 ${goal.objective}`)
    app.notice(`${goal.phase}${goal.blockedReason ? ` · 阻塞: ${goal.blockedReason.message}` : ''} · ${goal.roundsStarted} 轮 / 上限 ${goal.maxGoalRounds > 0 ? goal.maxGoalRounds : '∞'} · ${goal.activation === 'armed' ? 'armed' : 'disarmed'}`)
    return
  }
  const ref = goal === undefined ? undefined : { id: goal.id, revision: goal.revision }
  try {
    if (op === 'new' || op === 'create') {
      const objective = rest.join(' ').trim()
      if (objective === '') {
        app.notice(t('用法: /goal new <objective>'))
        return
      }
      goals.create(agent, { objective })
      app.notice(t('目标已创建'))
    } else if (op === 'pause') {
      goals.pause(agent, ref)
      app.notice(t('目标已暂停'))
    } else if (op === 'resume') {
      goals.resume(agent, ref)
      app.notice(t('目标已恢复'))
    } else if (op === 'complete') {
      goals.complete(agent, ref)
      app.notice(t('目标已标记完成'))
    } else if (op === 'clear') {
      goals.clear(agent, ref)
      app.notice(t('目标已清空'))
    } else {
      app.notice(t('用法: /goal [show|new <objective>|pause|resume|complete|clear]'))
    }
  } catch (err) {
    app.notice(`goal 操作失败: ${(err as Error).message}`)
  }
}

export function installGoalCommand(app: App): void {
  app.registerCommands([{ name: '/goal', desc: t('查看/管理目标'), usage: t('[new <目标>|pause|resume|complete|clear]'), group: t('会话'), fn: (a) => goalCommand(app, a) }])
}
