/**
 * dsh_tui subagents module: child-agent directory (/subagents), the
 * read-only thinking-chain replay float, and the continuable child chat
 * window (send user messages to a child like chatting with the main agent).
 *
 * @module dsh-nvim-tui/subagents
 */
import { FeedRenderer } from '../feed/feed.js'
import { t, tf } from '../kernel/i18n.js'
import { queueSubagentPromptKey } from '../kernel/types.js'
import type { SessionEvent, SubagentInfo } from '../kernel/types.js'
import type { App, AppSlices, WritableSlice } from '../kernel/app.js'
import { registerHostHandler } from '../kernel/host-events.js'
import { registerNvimNotification } from '../kernel/rpc.js'
import { installSubagentsCommand } from './commands/subagents.js'
const W = (d: AppSlices['agent']) => d as WritableSlice<AppSlices['agent']>

/** Enumerate the active session's subagent children (live + persisted).
 *  Preferred path: the official `subagents.listChildren` directory.
 *  Fallback: scan the live session store + sessionPersistence.list() for
 *  headers with parentSession === parentId and origin 'subagent'. */
/** Open a read-only replay of one subagent's session log in a float. */
const openSubagentView = async (app: App, childId: string, label: string) => {
  // One float family at a time: the chat window closes (its close handler
  // drops the routing state).
  if (app.slices.agent.subagentChat !== null) {
    await app.luaCall('require("dsh_tui").close_subagent_chat()', []).catch(() => {})
    W(app.slices.agent).subagentChat = null
  }
  // Gather the event log: live children stream from the in-memory store
  // (new events keep arriving via session/event routing); settled children
  // are read from persistence without resuming or publishing an agent.
  const live = app.liveSessions.get(childId)
  let events: SessionEvent[] = []
  if (live) {
    events = [...app.slices.trans.sessionEvents(live)]
  } else {
    try {
      const persistence = app.svc('sessionPersistence')
      if (typeof persistence?.open === 'function') {
        // 0.1.5: open a read handle, read the validated log, close the handle.
        const handle = await persistence.open(childId, 'read')
        // try/finally: a THROWING read used to skip close() and leak the
        // session handle (both the view and the chat path had this shape).
        try {
          const result = handle === undefined ? undefined : await handle.read?.()
          events = (result?.events ?? []) as SessionEvent[]
        } finally {
          if (handle !== undefined) {
            try { await handle.close?.() } catch {}
          }
        }
      } else {
        // pre-0.1.5 hosts: read-only inspection.
        const inspection = await persistence?.inspect?.(childId)
        events = (inspection?.events ?? []) as SessionEvent[]
      }
    } catch (err) {
      app.notice(tf('读取子代理会话失败: {err}', { err: (err as Error).message }))
      return
    }
  }
  if (events.length === 0) {
    // A just-started child streams its first events moments after spawn —
    // open the empty view anyway; the session/event routing fills it live.
    app.notice(t('子代理会话暂无事件（空视图，事件到达后实时显示）'))
  }
  const ids = await app.luaCall('return require("dsh_tui").open_subagent_view(...)', [label])
  if (!ids || !Number.isInteger(ids.buf) || !Number.isInteger(ids.win)) {
    app.notice(t('子代理视图打开失败（nvim 浮窗未创建）'))
    return
  }
  const feed = new FeedRenderer(app.slices.runtime.nvim!, ids.buf, ids.win, {
    idsProvider: () => app.luaCall('return require("dsh_tui").subagent_view_ids()', []),
    activeChecker: () => true,
    // No separate reasoning panel: reasoning blocks render inline, dim.
    reasoningBuf: null,
    reasoningView: () => null,
    inlineReasoning: true,
  })
  W(app.slices.agent).subagentView = { childId, feed }
  for (const e of events) {
    feed.applyEvent(e, { history: true })
    app.slices.ui.maybePushFileDiff(feed, e)
  }
  // Close the snapshot/live gap: events appended while the view opened.
  if (live) {
    const liveEvents = app.slices.trans.sessionEvents(live)
    for (let i = events.length; i < liveEvents.length; i++) {
      feed.applyEvent(liveEvents[i], { history: true })
      app.slices.ui.maybePushFileDiff(feed, liveEvents[i])
    }
  }
  await feed.flush()
  if (!live) {
    // Settled replay: land on the FIRST thinking block — the window
    // otherwise opens scrolled to the transcript tail (the final answer),
    // which makes the thinking details look missing. Live views keep
    // tail-following the running stream.
    await app.luaCall('require("dsh_tui").subagent_view_goto_thinking()', []).catch(() => {})
  }
  app.notice(tf('子代理视图: {label}（{n} 事件 · q/Esc 关闭{live}）', { label, n: events.length, live: live ? t(' · 实时跟随') : '' }))
}

/**
 * Open the subagent CHAT window for one continuable child: the child's
 * live transcript streams into the upper feed (inline reasoning + answer
 * + tool cards), and the lower input row sends user messages to the child
 * through the official `subagents.followup` queue (human prompt → the
 * child's next turn; a settled child cold-resumes, a running child admits
 * it after the current turn converges).
 */
const openSubagentChat = async (app: App, childId: string, label: string) => {
  if (app.slices.sessions.activeId === null) {
    app.notice(t('无活跃会话'))
    return
  }
  // One float family at a time: the read-only view closes (its close
  // handler drops the routing state).
  if (app.slices.agent.subagentView !== null) {
    await app.luaCall('require("dsh_tui").close_subagent_view()', []).catch(() => {})
    W(app.slices.agent).subagentView = null
  }
  const live = app.liveSessions.get(childId)
  let events: SessionEvent[] = []
  if (live) {
    events = [...app.slices.trans.sessionEvents(live)]
  } else {
    try {
      const persistence = app.svc('sessionPersistence')
      if (typeof persistence?.open === 'function') {
        // 0.1.5: open a read handle, read the validated log, close the handle.
        const handle = await persistence.open(childId, 'read')
        try {
          const result = handle === undefined ? undefined : await handle.read?.()
          events = (result?.events ?? []) as SessionEvent[]
        } finally {
          if (handle !== undefined) {
            try { await handle.close?.() } catch {}
          }
        }
      } else {
        // pre-0.1.5 hosts: read-only inspection.
        const inspection = await persistence?.inspect?.(childId)
        events = (inspection?.events ?? []) as SessionEvent[]
      }
    } catch (err) {
      app.notice(tf('读取子代理会话失败: {0}', [(err as Error).message]))
      return
    }
  }
  if (events.length === 0) {
    app.notice(t('子代理会话无事件（可能尚未开始）'))
    return
  }
  const ids = await app.luaCall('return require("dsh_tui").open_subagent_chat(...)', [label])
  if (!ids || !Number.isInteger(ids.buf) || !Number.isInteger(ids.win) ||
    !Number.isInteger(ids.inputBuf) || !Number.isInteger(ids.inputWin)) {
    app.notice(t('子代理对话窗打开失败（nvim 浮窗未创建）'))
    return
  }
  // The window takes over the "next input goes to the child" quick path.
  W(app.slices.agent).pendingSubagentFollowup = null
  const feed = new FeedRenderer(app.slices.runtime.nvim!, ids.buf, ids.win, {
    idsProvider: () => app.luaCall('return require("dsh_tui").subagent_chat_ids()', []),
    activeChecker: () => true,
    // No separate reasoning panel: reasoning blocks render inline, dim.
    reasoningBuf: null,
    reasoningView: () => null,
    inlineReasoning: true,
  })
  W(app.slices.agent).subagentChat = { childId, parentId: app.slices.sessions.activeId, label, feed }
  for (const e of events) {
    feed.applyEvent(e, { history: true })
    app.slices.ui.maybePushFileDiff(feed, e)
  }
  // Close the snapshot/live gap: events appended while the window opened.
  if (live) {
    const liveEvents = app.slices.trans.sessionEvents(live)
    for (let i = events.length; i < liveEvents.length; i++) {
      feed.applyEvent(liveEvents[i], { history: true })
      app.slices.ui.maybePushFileDiff(feed, liveEvents[i])
    }
  }
  await feed.flush()
  if (!live) {
    // Settled replay: land on the FIRST thinking block, like the view.
    await app.luaCall('require("dsh_tui").subagent_chat_goto_thinking()', []).catch(() => {})
  }
  app.notice(tf('子代理对话窗: {label}（Enter 发送 · Esc 关闭{live}）', { label, live: live ? t(' · 实时') : '' }))
}

/**
 * Send one user message from the subagent chat window to its child.
 * Optimistic echo (deduped against the harness's user/message replay),
 * queued through `subagents.followup` with user provenance.
 */
const sendToSubagent = (app: App, text: string) => {
  const chat = app.slices.agent.subagentChat
  if (chat === null || app.slices.runtime.disposed) return
  const clean = text.trim()
  if (clean === '') return
  const parentRec = app.slices.sessions.live.get(chat.parentId)
  if (parentRec === undefined) {
    chat.feed.pushError(t('父会话已不存在，无法发送'))
    return
  }
  // Validate the service BEFORE the optimistic echo: a failed send must
  // not leave a pending-echo entry that poisons the next message's dedupe.
  const subagentsSvc = app.svc('subagents')
  if (typeof subagentsSvc?.prompt !== 'function' && typeof subagentsSvc?.[queueSubagentPromptKey] !== 'function') {
    chat.feed.pushError(t('子代理续聊不可用（subagents 服务未装配）'))
    return
  }
  // Optimistic echo: render the bubble now; the matching user/message
  // replay is skipped in the session/event routing (FIFO per session).
  chat.feed.pushUser(clean, [])
  const q = app.slices.ui.pendingEchoes.get(chat.childId) ?? []
  q.push(clean)
  if (q.length > 4) q.shift()
  app.slices.ui.pendingEchoes.set(chat.childId, q)
  if (app.slices.sessions.runningSubagents.has(chat.childId)) {
    chat.feed.appendNotice(t('⏳ 已排队：子代理当前回合结束后处理'))
  }
  void (async () => {
    try {
      await app.slices.agent.queueSubagentPrompt(parentRec.handle.agent, chat.childId, clean)
      parentRec.feed?.appendNotice(tf('➤ 已发给子代理 {label}: {text}', { label: chat.label, text: FeedRenderer.truncate(clean, 60) }))
    } catch (err) {
      chat.feed.pushError(`${t('发送失败')}: ${(err as Error).message}`)
    }
  })()
}

/** /subagents — child-agent directory; pick one to view its thinking. */
/** Fill the subagents module's App slots and register its commands. */
export function installSubagents(app: App): void {
  // -- agent sub-part ops (this module owns subagentView/subagentChat) --
  const W = (d: AppSlices['agent']) => d as WritableSlice<AppSlices['agent']>
  const A = W(app.slices.agent)
  A.setSubagentView = (v) => { A.subagentView = v }
  A.setSubagentChat = (v) => { A.subagentChat = v }

  // -- ui.feedForSubagent + agent subagent-chat domain defaults (I2) --
  app.slices.ui.feedForSubagent = () => undefined
  Object.assign(app.slices.agent, {
    subagentView: null,
    subagentChat: null,
    pendingSubagentFollowup: null,
    openSubagentView: async () => {},
    openSubagentChat: async () => {},
    sendToSubagent: () => {},
  })

  // -- core services this module owns (moved out of createApp, I1) --
  /** Route a subagent lifecycle event to its PARENT session's feed. */
  app.slices.ui.feedForSubagent = (info: SubagentInfo) => {
    if (!info?.id) return undefined
    const child = app.liveSessions.get(info.id)
    const parentId = child?.header?.parentSession
    const rec = parentId !== undefined ? app.slices.sessions.live.get(parentId) : undefined
    if (rec) return rec
    // Fallback: subagents usually spawn while their parent is the active session.
    return app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  }


  app.slices.agent.openSubagentView = (childId, label) => openSubagentView(app, childId, label)
  app.slices.agent.openSubagentChat = (childId, label) => openSubagentChat(app, childId, label)
  app.slices.agent.sendToSubagent = (text) => sendToSubagent(app, text)
  installSubagentsCommand(app)


  // -- nvim notifications this module owns (dispatched by boot via rpc.ts) --
  registerNvimNotification('dsh-subagent-view-closed', t('子代理视图'), (app) => {
    app.slices.agent.setSubagentView(null)
  })
  registerNvimNotification('dsh-subagent-chat-closed', t('子代理对话'), (app) => {
    app.slices.agent.setSubagentChat(null)
    // Closing the chat window cancels the "next input goes to this child"
    // addressing too (the notice promises /subagents can cancel it).
    const A = W(app.slices.agent)
    if (A.pendingSubagentFollowup !== null) A.pendingSubagentFollowup = null
  })
  registerNvimNotification('dsh-subagent-send', t('子代理发送'), (app, args) => {
    try {
      app.slices.agent.sendToSubagent(String(args?.[0] ?? ''))
    } catch (err) {
      app.notice(tf('⚠ 子代理发送失败: {err}', { err: (err as Error).message }))
    }
  })

  // -- host events this module owns (wired by boot via host-events.ts) ----
  registerHostHandler('subagent/start', (app, info) => {
    const payload = info as SubagentInfo
    if (app.slices.runtime.disposed) return
    const parent = app.slices.ui.feedForSubagent(payload)
    parent?.feed.subagentStart(payload)
    const key = payload?.id ?? payload?.runId
    if (parent && key) {
      const label = `${payload?.provider ?? 'subagent'} ${FeedRenderer.truncate(String(payload?.id ?? ''), 8)}`
      app.slices.sessions.runningSubagents.set(String(key), {
        parentId: parent.id,
        label,
        startedAt: Date.now(),
      })
      // Durable routing for the child's own session events (tool diffs,
      // late messages) — kept after subagent/end, pruned with the parent.
      app.slices.sessions.childParent.set(String(key), { parentId: parent.id, label })
      // Bounded memory: long-running hosts spawn unbounded children;
      // evict the oldest routing entry past the cap.
      if (app.slices.sessions.childParent.size > 400) {
        // Evict the oldest entry whose child is NOT running — a live
        // child's routing entry must survive for its tool diffs.
        for (const [k] of app.slices.sessions.childParent) {
          if (app.slices.sessions.runningSubagents.has(k)) continue
          app.slices.sessions.childParent.delete(k)
          break
        }
      }
      app.slices.ui.ensureSpinner()
      app.slices.ui.updateStatusline()
    }
  })
  registerHostHandler('subagent/end', (app, info) => {
    const payload = info as SubagentInfo
    if (app.slices.runtime.disposed) return
    app.slices.ui.feedForSubagent(payload)?.feed.subagentEnd(payload)
    const key = payload?.id ?? payload?.runId
    if (key && app.slices.sessions.runningSubagents.delete(String(key))) {
      app.slices.ui.ensureSpinner()
      app.slices.ui.updateStatusline()
    }
  })
}
