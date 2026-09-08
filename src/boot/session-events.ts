/**
 * Session-event pipeline: every harness `session/event` routes through here —
 * extension mirror → subagent chat/view feeds → child→parent diff sync →
 * the owning session's transcript with its per-type side effects.
 *
 * boot only subscribes this ONE handler; the routing steps and the per-type
 * hook table below keep event-type branches out of boot.
 *
 * @module dsh-nvim-tui/session-events
 */
import { FeedRenderer } from '../feed/feed.js'
import { t } from '../kernel/i18n.js'
import type { ChatMessage, GoalState, MessageContent, SessionEvent } from '../kernel/types.js'
import type { App, SessionRec } from '../kernel/app.js'

/** Produced-file heuristic for /deliverables: mutation tools whose args
 *  carry a follow-along path (official render intents: diff / edit). */
const producedPathFromCall = (name: string, argsText: string | undefined): string | null => {
  if (!['fs', 'write', 'edit', 'replace', 'append', 'str_replace_editor', 'patch'].includes(name)) return null
  let args: Record<string, unknown> | undefined
  try { args = JSON.parse(argsText ?? '{}') as Record<string, unknown> } catch { return null }
  if (name === 'str_replace_editor' && args?.command !== 'insert') return null
  const p = args?.file_path ?? args?.path
  return typeof p === 'string' && p !== '' ? p : null
}

/** Per-event-type side effect on the OWNING session's transcript. Returns
 *  true when the event is fully consumed (no folding into the feed). */
type MainEventHook = (rec: SessionRec, owner: { id: string }, event: SessionEvent) => boolean

export function makeSessionEventHandler(
  app: App,
  headlessDump: () => Promise<void>,
): (owner: { id: string }, event: SessionEvent) => void {
  /** tool/call → pre-edit snapshot of the mutation target (shared by all
   *  four routing paths — the ✓ result line renders an accurate +/− block). */
  const snapshotToolTarget = (event: SessionEvent): void => {
    if (event.type !== 'tool/call' || typeof event.data?.name !== 'string') return
    const p = producedPathFromCall(event.data.name, event.data.arguments)
    if (p === null) return
    if (typeof event.data.callId === 'string' && event.data.callId !== '') {
      const cid = event.data.callId
      void app.slices.ui.readFileSnapshot(p).then((before) => {
        app.slices.ui.pendingFileSnaps.set(cid, { display: p, before })
      })
    }
  }

  /** Open subagent CHAT/VIEW window: route the child's live events into its
   *  feed (reasoning/text/tools keep streaming in place). The chat window
   *  dedupes the harness's replay of our own optimistic user echo (FIFO). */
  const routeToChildFeed = (owner: { id: string }, event: SessionEvent, feed: SessionRec['feed'], dedupeEchoes: boolean): void => {
    snapshotToolTarget(event)
    if (dedupeEchoes && event.type === 'user/message') {
      const q = app.slices.ui.pendingEchoes.get(owner.id)
      if (q !== undefined && q.length > 0) {
        const data = event.data as { message?: ChatMessage } | ChatMessage | undefined
        const msg = (data as { message?: ChatMessage } | undefined)?.message ??
          (data as ChatMessage | undefined)
        if (FeedRenderer.messageText(msg) === q[0]) {
          q.shift()
          app.slices.ui.pendingEchoes.set(owner.id, q)
          return // already rendered optimistically — no double bubble
        }
      }
    }
    feed.applyEvent(event)
    app.slices.ui.maybePushFileDiff(feed, event)
  }

  /** Main-session side effects, one hook per event type. A hook that needs
   *  several steps (e.g. tool/call: deliverables + snapshot + orphan
   *  tracking) runs them in the exact order the old inline chain did. */
  const MAIN_EVENT_HOOKS: Record<string, MainEventHook> = {
    'turn/start': (rec, _owner, event) => {
      const data = event.data as { turn?: number } | undefined
      rec.deliverables = { turn: data?.turn, paths: [] }
      rec.pendingToolCalls.clear()
      rec.lastTurnStartAt = Date.now()
      return false
    },
    'tool/call': (rec, _owner, event) => {
      // Deliverables: files the current turn produced, derived from
      // mutation tools' follow-along args (official client uses the tools'
      // render-intent locations; the tool/result payload does not carry
      // them, so this is a name+args heuristic over the same set).
      const data = event.data as { name?: string; arguments?: string; callId?: string; turn?: unknown; step?: unknown } | undefined
      if (data?.name !== undefined) {
        const p = producedPathFromCall(data.name, data.arguments)
        if (p !== null) {
          if (!(rec.deliverables?.paths ?? []).includes(p)) {
            rec.deliverables = rec.deliverables ?? { turn: undefined, paths: [] }
            rec.deliverables.paths.push(p)
          }
          if (typeof data.callId === 'string' && data.callId !== '') {
            const cid = data.callId
            void app.slices.ui.readFileSnapshot(p).then((before) => {
              app.slices.ui.pendingFileSnaps.set(cid, { display: p, before })
            })
          }
        }
      }
      // Live orphan tracking for the duplicate-dsh-tools scheduler crash:
      // every tool/call parks here until its tool/result arrives; any call
      // still parked when turn/end lands has been orphaned by the crash.
      if (typeof data?.callId === 'string') {
        rec.pendingToolCalls.set(data.callId, {
          seq: event.seq ?? -1,
          turn: data?.turn,
          step: data?.step,
        })
      }
      return false
    },
    'tool/result': (rec, _owner, event) => {
      const data = event.data as { message?: { source?: { callId?: string } } } | undefined
      if (typeof data?.message?.source?.callId === 'string') {
        rec.pendingToolCalls.delete(data.message.source.callId)
      }
      return false
    },
    'turn/end': (rec, owner, event) => {
      // Turn finished on the ACTIVE session → terminal bell (toggle /bell).
      app.slices.ui.pendingFileSnaps.clear()
      if (rec.pendingToolCalls.size > 0) {
        // The turn ended while tool calls were still pending: the tool
        // scheduler crashed after committing tool/call events and no
        // result will ever arrive. Synthesize error results so the next
        // request is not rejected by "insufficient tool messages".
        // Deferred: session.append cannot reenter while the turn/end
        // event's own publication boundary is still open.
        const orphaned = [...rec.pendingToolCalls.entries()]
        rec.pendingToolCalls.clear()
        const reason = (event.data as {
          reason?: { error?: { message?: string } }
        } | undefined)?.reason
        const prepareCrash = typeof reason?.error?.message === 'string' &&
          reason.error.message.includes("reading 'prepare'")
        setTimeout(() => {
          if (app.slices.runtime.disposed || !app.slices.sessions.live.has(rec.id)) return
          let healed = 0
          for (const [callId, call] of orphaned) {
            try {
              app.slices.trans.synthesizeToolResult(rec, callId, call.seq >= 0 ? call.seq : undefined, call.turn, call.step)
              healed++
            } catch {}
          }
          if (healed > 0 && owner.id === app.slices.sessions.activeId) {
            app.notice(prepareCrash
              ? t(`⚠ 工具调度器崩溃（profile 里存在第二份 @deepseek-ai/dsh-tools 拷贝）——已补写 ${healed} 个悬空工具结果，本会话可继续使用；根治：在 profile 目录执行 pnpm why @deepseek-ai/dsh-tools 后 pnpm dedupe（或将 dsh-nvim-tui 升级到 0.2.8+）`)
              : t(`⚠ 回合结束时仍有 ${healed} 个工具调用未产生结果——已补写错误结果，会话历史已修复`))
          }
        }, 0)
      }
      if (owner.id === app.slices.sessions.activeId && app.slices.agent.bellOn) {
        void app.luaCall('require("dsh_tui").bell()', []).catch(() => {})
      }
      // 识图临时切换恢复：图片回合（在切换之后启动的回合）结束 → 切回
      // 原模型。排在图片回合之后入队的普通回合不受影响（switchAt 判定）。
      if (rec.visionTmp !== null && (rec.lastTurnStartAt ?? 0) > rec.visionTmp.switchAt) {
        const prev = rec.visionTmp.prev
        rec.visionTmp = null
        rec.modelRef.current = prev
        rec.model = prev.model
        if (owner.id === app.slices.sessions.activeId) {
          app.notice(`已切回模型 ${prev.provider}/${prev.model}`)
          app.slices.ui.updateStatusline()
        }
      }
      return false
    },
    'session/title': (rec, owner, event) => {
      const data = event.data as { title?: string } | undefined
      if (typeof data?.title !== 'string') return false
      rec.title = data.title
      app.slices.sessions.refreshList()
      if (owner.id === app.slices.sessions.activeId) {
        app.slices.ui.updateStatusline()
        app.slices.sessions.updateTitle()
      }
      return true
    },
    'user/message': (rec, owner, event) => {
      // A user message that still carries an image block predates the
      // official vision-model routing (or the catalog had no vision model):
      // every later turn re-sends it, and a text-only model rejects the
      // whole request. Warn once and point at /rewind.
      const data = event.data as { message?: { content?: MessageContent[] } } | undefined
      if (Array.isArray(data?.message?.content) &&
        data.message.content.some((b: MessageContent) => b?.type === 'image')) {
        if (!rec.imagePoisonWarned) {
          rec.imagePoisonWarned = true
          if (owner.id === app.slices.sessions.activeId) {
            app.notice(t('⚠ 检测到历史带图消息（text-only 模型回放会失败）。用 /rewind 回退到该消息之前，或确认目录中已声明官方识图模型即可修复'))
          }
        }
      }
      return false
    },
    'assistant/message': (rec, _owner, event) => {
      // Track the last assistant message id (message feedback target).
      const data = event.data as { message?: { id?: string } } | undefined
      if (typeof data?.message?.id === 'string') {
        rec.lastAssistantMessageId = data.message.id
      }
      return false
    },
    'plan/mode': (rec, owner, event) => {
      const data = event.data as { active?: boolean } | undefined
      rec.planActive = data?.active === true
      if (owner.id === app.slices.sessions.activeId) {
        app.slices.ui.updateStatusline()
        app.notice(`计划模式已${rec.planActive ? '开启' : '关闭'}`)
      }
      return false
    },
    'goal/change': (rec, owner, event) => {
      // `data.goal` is the durable GoalSnapshot; `roundsStarted` rides as
      // a sibling of the snapshot, so fold it back in for the statusline.
      const data = event.data as { goal?: GoalState | null; roundsStarted?: number } | undefined
      const goal = data?.goal ?? null
      if (goal === null) {
        rec.goal = null
      } else {
        const roundsStarted = data?.roundsStarted
        rec.goal = roundsStarted === undefined ? goal : { ...goal, roundsStarted }
      }
      if (owner.id === app.slices.sessions.activeId) app.slices.ui.updateStatusline()
      return false
    },
  }

  return (owner, event) => {
    if (app.slices.runtime.disposed) return
    // Extension mirror: opt-in session-event subscribers (Node-side
    // onSessionEvent; the Lua-side routing lands with P3).
    app.slices.ext.extDispatchSessionEvent(owner.id, event)

    // -- special feed routing ------------------------------------------------
    // Open subagent CHAT window (dedupe our optimistic echo).
    const chat = app.slices.agent.subagentChat
    if (chat !== null && owner.id === chat.childId) {
      routeToChildFeed(owner, event, chat.feed, true)
      return
    }
    // Open subagent transcript view: read-only feed, no echo dedupe.
    const view = app.slices.agent.subagentView
    if (view !== null && owner.id === view.childId) {
      routeToChildFeed(owner, event, view.feed, false)
      return
    }
    // Child→parent modification sync (alpha.4): the child's file-change
    // diffs render LIVE into the parent's chat as subagent-labeled ✎
    // cards — the parent shares the workspace, so the child's edits are
    // the parent's edits (the harness forwards no child transcript, but
    // this runner sees every child session event).
    const childLink = app.slices.sessions.childParent.get(owner.id)
    if (childLink !== undefined) {
      snapshotToolTarget(event)
      if (event.type === 'tool/result') {
        const prec = app.slices.sessions.live.get(childLink.parentId)
        if (prec !== undefined) {
          app.slices.ui.maybePushFileDiff(prec.feed, event, `${t('子代理')} ${childLink.label} `)
        }
      }
      return
    }

    // -- owning session transcript -------------------------------------------
    const rec = app.slices.sessions.live.get(owner.id)
    if (!rec) return
    // Skip the host's user/message when this exact text was already
    // rendered optimistically at submit time (no double bubble).
    let echoed = false
    if (event.type === 'user/message') {
      const q = app.slices.ui.pendingEchoes.get(owner.id)
      if (q !== undefined && q.length > 0) {
        const data = event.data as { message?: ChatMessage } | ChatMessage | undefined
        const msg = (data as { message?: ChatMessage } | undefined)?.message ??
          (data as ChatMessage | undefined)
        // SELF-HEALING dedupe: search the WHOLE queue instead of q[0]
        // only — one desync (a non-echoed submit, a text mismatch, a
        // queue-cap eviction, a reload) used to poison EVERY later input
        // into double-rendering forever; matching anywhere re-aligns at
        // the very next message.
        const text = FeedRenderer.messageText(msg)
        const at = q.indexOf(text)
        if (at >= 0) {
          q.splice(0, at + 1)
          app.slices.ui.pendingEchoes.set(owner.id, q)
          echoed = true
        }
      }
    }
    const hook = MAIN_EVENT_HOOKS[event.type]
    if (hook !== undefined && hook(rec, owner, event)) return
    if (!echoed) {
      app.slices.ui.foldEvent(rec, event)
      rec.feed.applyEvent(event)
      app.slices.ui.maybePushFileDiff(rec.feed, event)
    }
    // Headless e2e: first completed turn of the initial session ends the test.
    if (app.headless && event.type === 'turn/end' && owner.id === app.slices.sessions.activeId) {
      rec.feed.commitTail()
      void rec.feed.flush().then(headlessDump)
    }
  }
}
