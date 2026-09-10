/**
 * dsh_tui kernel module: TODO-LIST DISCIPLINE GUARD.
 *
 * `todo_write` is a WHOLE-LIST replacement: the model decides when to write,
 * so a batched "mark everything done at the end" call is the model's cadence,
 * not a client rendering problem (the panel/statusline update on every
 * `todo/write` event the instant it lands). This guard turns per-item
 * maintenance into a CODE-LEVEL requirement instead of a hope:
 *
 *   1. a standing system-prompt SECTION states the hard rule (start an item →
 *      `in_progress`; finish it → `completed` immediately; never batch to the
 *      end; no stale `in_progress` when the turn stops);
 *   2. an `agent/pre-step` waterfall appends a BOUNDED reminder whenever a
 *      step ran tools but wrote no `todo/write` while items were still open —
 *      every further request then carries the concrete open-item list.
 *
 * Both registrations are agent-scoped (installed in the agent setup callback,
 * unwound with the agent) and share the same API on dsh 0.1.2 / 0.1.5.
 *
 * @module dsh-nvim-tui/kernel/todo-guard
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Stable section name (a duplicate registration would throw). */
export const TODO_GUARD_SECTION = 'nvim-tui-todo-discipline'
/** Section placement (ascending order in the assembled prompt). */
const SECTION_ORDER = 55
/** Reminder budget per turn — enough to steer, never a nag loop. */
export const MAX_NUDGES_PER_TURN = 3

export interface TodoItem { content: string; status: string }
interface SessionEventLike { type?: unknown; data?: { todos?: unknown } }

export function todoDisciplineSectionText(): string {
  return [
    'Task-list discipline (hard requirement for multi-step work):',
    '- 多步任务必须用 todo_write 维护任务清单；',
    '- 开始一项 → 立即把该项标成 in_progress；完成一项 → 立即调用 todo_write 标成 completed（逐项更新，禁止攒到最后一次性更新）；',
    '- 每完成一项就更新一次清单是硬性要求：客户端面板/状态栏按每次 todo_write 事件实时刷新，批量更新会让用户在整个回合里看不到进度；',
    '- 回合自然结束前，清单里不得留下与事实不符的 in_progress 项（做完了就标 completed；做不完就说明原因或改回 pending）。',
  ].join('\n')
}

/** Newest standing list from one session log (the last todo/write wins). */
export function latestTodos(events: readonly SessionEventLike[]): TodoItem[] | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e?.type !== 'todo/write') continue
    const todos = e.data?.todos
    if (!Array.isArray(todos)) continue
    return todos.map((t) => {
      const o = (t ?? {}) as { content?: unknown; status?: unknown }
      return { content: String(o.content ?? ''), status: String(o.status ?? '') }
    })
  }
  return null
}

export interface TodoGuardStep {
  /** The step being inspected called todo_write. */
  sawTodoWrite: boolean
  /** Number of tool calls the step made. */
  toolCalls: number
}

/** Reminder for the NEXT request; null when the step was clean. Pure. */
export function todoGuardReminder(
  step: TodoGuardStep,
  todos: TodoItem[] | null,
  nudgesUsed: number,
  maxNudges: number = MAX_NUDGES_PER_TURN,
): string | null {
  if (todos === null || todos.length === 0) return null
  const open = todos.filter((t) => t.status !== 'completed')
  if (open.length === 0) return null
  if (step.sawTodoWrite || step.toolCalls === 0) return null
  if (nudgesUsed >= maxNudges) return null
  const listing = open.slice(0, 8)
    .map((t) => `「${t.content}」(${t.status === 'in_progress' ? '进行中' : '待办'})`)
    .join('、')
  return `【任务清单纪律】上一步执行了 ${step.toolCalls} 个工具调用但未更新清单。未完成项：${listing}。`
    + '若其中某项已完成，请立即调用 todo_write 把它标成 completed（逐项更新，不要攒到最后一次性更新）；新开始/重排也请同步清单。'
}

/** Session log access (0.1.5 `snapshotEvents()`, pre-alpha.4 `events`). */
/** Session log access. Every supported host (0.1.2-rc.1 … 0.1.5-rc.1)
 *  exposes `snapshotEvents()`; the pre-alpha.4 `events` property is gone. */
function sessionEventsOf(session: unknown): SessionEventLike[] {
  const s = session as { snapshotEvents?: () => unknown } | undefined
  try {
    if (typeof s?.snapshotEvents === 'function') {
      const got = s.snapshotEvents()
      if (Array.isArray(got)) return got as SessionEventLike[]
    }
  } catch {}
  return []
}

/** Per-session guard bookkeeping (keyed by the session object). */
const guardState = new WeakMap<object, { lastSeq: number; nudges: number }>()

/** Install the guard on one agent scope. Never throws. */
export function installTodoGuard(agentCtx: unknown, opts?: { enabled?: boolean }): void {
  if (opts?.enabled === false) return
  const ctx = agentCtx as {
    systemPrompt?: { section?: (section: { name: string; order: number; text: string }) => unknown }
    get?: (name: string) => unknown
    on?: (name: string, handler: (...args: any[]) => any, options?: { prepend?: boolean }) => unknown
  } | undefined
  // ① standing system-prompt section (agent-scoped contribution)
  try {
    const prompt = (ctx?.systemPrompt ?? ctx?.get?.('systemPrompt')) as {
      section?: (section: { name: string; order: number; text: string }) => unknown
    } | undefined
    prompt?.section?.({ name: TODO_GUARD_SECTION, order: SECTION_ORDER, text: todoDisciplineSectionText() })
  } catch {}
  // ② per-step reminder (waterfall: appended to the NEXT request's messages)
  try {
    ctx?.on?.('agent/pre-step', async (payload: any, next: () => Promise<any>) => {
      const decision = await next()
      try {
        if (decision?.kind === 'reject' || payload?.signal?.aborted === true) return decision
        const session = payload?.agent?.session
        if (session === null || session === undefined || typeof session !== 'object') return decision
        const events = sessionEventsOf(session)
        let state = guardState.get(session)
        if (state === undefined) {
          state = { lastSeq: events.length, nudges: 0 }
          guardState.set(session, state)
        }
        const fresh = events.slice(state.lastSeq)
        state.lastSeq = events.length
        if (fresh.some((e) => e?.type === 'turn/start')) state.nudges = 0
        const reminder = todoGuardReminder(
          {
            sawTodoWrite: fresh.some((e) => e?.type === 'todo/write'),
            toolCalls: fresh.filter((e) => e?.type === 'tool/call').length,
          },
          latestTodos(events),
          state.nudges,
        )
        if (reminder === null) return decision
        state.nudges++
        return {
          ...decision,
          messages: [
            ...(Array.isArray(decision?.messages) ? decision.messages : []),
            createUserMessage({
              content: [{ type: 'text', text: reminder }],
              source: { kind: 'plugin', plugin: 'nvim-tui-todo-guard', form: 'notice', summary: '任务清单纪律提醒' },
            }),
          ],
        }
      } catch {
        return decision
      }
    }, { prepend: true })
  } catch {}
}
