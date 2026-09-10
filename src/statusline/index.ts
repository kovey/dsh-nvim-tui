/**
 * dsh_tui statusline module: fold transcript events into the session's
 * statusline stats, render the statusline (permission mode + hints on the
 * left, model/effort/cache/context/tokens/elapsed/cost/route on the right),
 * drive the whale spinner while the active agent runs, and own the /glance
 * /density /whale /cost display commands.
 *
 * @module dsh-nvim-tui/statusline
 */
import { WHALE_EMOJI_FRAMES } from '../feed/whale.js'
import {
  EMPTY_USAGE, foldUsage, billedInput, cacheHitRate, estimateCost,
  formatTokens, formatElapsed, modeLabel, escapeStatusline,
} from '../feed/stats.js'
import { t, tf } from '../kernel/i18n.js'
import { TIER_ICONS } from '../kernel/difficulty.js'
import type { InboxLike, SessionEvent } from '../kernel/types.js'
import type { App, SessionRec } from '../kernel/app.js'
import { registerHostHandler } from '../kernel/host-events.js'
import { hiddenGlance } from './commands/glance.js'
import { installWhaleCommand } from './commands/whale.js'
import { installDensityCommand } from './commands/density.js'
import { installGlanceCommand } from './commands/glance.js'
import { installCostCommand } from './commands/cost.js'

/** Fold one transcript event into the session's statusline stats. */
const foldEvent = (app: App, rec: SessionRec, event: SessionEvent) => {
  if (event.type === 'assistant/message' && event.data?.usage) {
    rec.usage = foldUsage(rec.usage ?? EMPTY_USAGE, event.data.usage)
    // The CURRENT context proxy: only the latest step's billed input is
    // comparable against the context window (the session total is not).
    rec.lastUsage = foldUsage(EMPTY_USAGE, event.data.usage)
    rec.cacheReported = rec.cacheReported ||
      event.data.usage.cacheReadTokens !== undefined ||
      event.data.usage.cacheWriteTokens !== undefined
  } else if (event.type === 'request/context') {
    if (typeof event.data?.contextWindow === 'number') {
      rec.contextWindow = event.data.contextWindow
    }
    if (typeof event.data?.provider === 'string') rec.provider = event.data.provider
  } else if (event.type === 'sandbox/mode') {
    rec.mode = event.data?.mode ?? rec.mode
  } else if (event.type === 'approval/policy') {
    rec.policy = event.data?.policy ?? rec.policy
  } else if (event.type === 'todo/write') {
    // Flushed view (same as the feed's pinned panel): completed items that
    // already landed in a committed board stay out of the counts — the host
    // re-sends the whole standing list, so this is the only bounded view.
    // Defensive: foldEvent may run on a rec whose feed is not attached yet.
    const all = event.data?.todos ?? []
    const visible = rec.feed?.todoVisibleItems !== undefined
      ? rec.feed.todoVisibleItems(all)
      : all
    const count = (st: string) => visible.filter((t) => t.status === st).length
    rec.todos = { completed: count('completed'), inProgress: count('in_progress'), pending: count('pending') }
    rec.todosItems = visible
    if (rec.id === app.slices.sessions.activeId) app.slices.ui.updateStatusline()
    // LIVE todo popup: re-render the open /todo float in place.
    const pop = app.slices.agent.livePopup
    if (pop != null && pop.kind === 'todo') {
      const marks: Record<string, string> = { pending: '○', in_progress: '◐', completed: '✓' }
      pop.update(visible.map((it) => ({ label: `  ${marks[it.status] ?? '·'} ${it.content}`, value: it.content })))
    }
  }
}

// The running-subagents BADGE lives in the feed's activity line (same
// slot and transient logic as the thinking line) — the registry here
// only drives the statusline running state + spinner.
const ensureSpinner = (app: App) => {
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  const running = rec?.status === '● running' ||
    app.slices.sessions.runningSubagentsOf(app.slices.sessions.activeId).length > 0 ||
    (rec?.bgJobs ?? 0) > 0
  if (running && app.slices.runtime.spinnerTimer === null) {
    app.slices.runtime.spinnerSet(setInterval(() => {
      app.slices.runtime.spinnerStep(WHALE_EMOJI_FRAMES.length)
      app.slices.ui.updateStatusline()
    }, 450))
  } else if (!running && app.slices.runtime.spinnerTimer !== null) {
    clearInterval(app.slices.runtime.spinnerTimer)
    app.slices.runtime.spinnerSet(null)
  }
}

/**
 * The right-side running badge (pure): main turn → '● running'; live
 * subagents → '● running ◇N'; otherwise background jobs keep the whale
 * spinning with '🔧 后台 N'; nothing running → null (statusline shows idle).
 */
export function runningBadge(mainRunning: boolean, subRunning: number, bgJobs: number): string | null {
  if (mainRunning) return '● running'
  if (subRunning > 0) return `● running ◇${subRunning}`
  if (bgJobs > 0) return tf('🔧 后台 {n}', { n: bgJobs })
  return null
}

/** Re-read the ACTIVE session's live background jobs (running + stopping). */
const refreshBgJobs = (app: App) => {
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (rec === undefined) return
  const jobs = app.svc('jobs')
  let count = 0
  let listed: Array<{ id: string; label?: string; status: string; startedAt?: number }> = []
  let listedOk = true
  if (jobs !== undefined) {
    try {
      listed = jobs.list(rec.handle.agent)
    } catch {
      // A transient jobs.list failure must NOT mark every cached running
      // job as killed (the vanished-from-list branch below) — skip the
      // merge this round and keep the previous board.
      listedOk = false
    }
  }
  const cache = rec.jobsCache ?? new Map<string, { label?: string; status: string; startedAt?: number }>()
  rec.jobsCache = cache
  // Merge the live list into the cache; a cached running/stopping job that
  // VANISHED from the list (finished without a callback) turns terminal.
  if (listedOk) {
    const liveIds = new Set(listed.map((j) => j.id))
    const committed = rec.committedJobKeys ?? new Set<string>()
    for (const j of listed) {
      // Already committed terminal jobs stay OUT of the cache: jobs.list
      // keeps returning them and re-adding would resurrect the old board
      // into the next batch's commit.
      if (committed.has(`${j.id}:${j.status}`)) continue
      const prev = cache.get(j.id)
      cache.set(j.id, { label: j.label ?? prev?.label, status: j.status, startedAt: j.startedAt ?? prev?.startedAt })
    }
    for (const [id, c] of cache) {
      if (!liveIds.has(id) && (c.status === 'running' || c.status === 'stopping')) {
        cache.set(id, { ...c, status: 'killed' })
      }
    }
  }
  count = [...cache.values()].filter((c) => c.status === 'running' || c.status === 'stopping').length
  rec.bgJobs = count
  // Board rows from the CACHE (final states survive the live-list drop).
  const icon = (st: string): string => st === 'running' ? '⏳' : st === 'completed' ? '✓' : st === 'killed' ? '✗' : st === 'failed' ? '⚠' : '·'
  const entries = [...cache.entries()]
  const rows: string[] = []
  if (entries.length > 0) {
    rows.push('', `${t('⚙ 任务')} ${entries.length} ${t('项')} · ${count} ${t('运行中')}`)
    for (const [, c] of entries) {
      const elapsed = c.startedAt !== undefined ? ` · ${((Date.now() - c.startedAt) / 1000).toFixed(0)}s` : ''
      rows.push(`  ${icon(c.status)} ${c.label ?? '?'}${elapsed}`)
    }
  }
  const pop = app.slices.agent.livePopup
  if (pop != null && pop.kind === 'jobs') {
    pop.update(entries.map(([id, c]) => {
      const elapsed = c.startedAt !== undefined ? ` · ${((Date.now() - c.startedAt) / 1000).toFixed(0)}s` : ''
      return { label: `${icon(c.status)} ${c.label ?? '?'} · ${id}${elapsed}`, value: `kill:${id}` }
    }))
  }
  if (entries.length > 0 && count === 0) {
    // EVERY job is terminal: the final board commits into the chat flow
    // and the pinned slot clears. The harness's jobs.list KEEPS returning
    // terminal jobs, so the 30s idle heartbeat would re-populate the cache
    // and re-commit the same batch forever — the committed-batch key
    // (ids+statuses, NO elapsed) makes the commit one-shot.
    const key = entries.map(([id, c]) => `${id}:${c.status}`).sort().join('|')
    if (key !== rec.committedJobsKey) {
      rec.feed.commitJobsBoard(rows, key)
      rec.committedJobsKey = key
      // The committed batch is terminal forever: remember each id:status
      // (the merge above skips them) and drop the cache rows.
      rec.committedJobKeys ??= new Set<string>()
      for (const [id, c] of entries) rec.committedJobKeys.add(`${id}:${c.status}`)
      for (const [id] of entries) cache.delete(id)
    }
  } else {
    rec.feed.setJobsBoard(rows)
  }
}

/** Statusline: left = permission mode + hints; right = model/effort,
 *  cache, context, tokens, elapsed, cost, route (+ spinner while running). */
const updateStatusline = (app: App) => {
  if (app.slices.runtime.chatWinId === null) return
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  const subRunning = app.slices.sessions.runningSubagentsOf(app.slices.sessions.activeId)
  const mainRunning = rec?.status === '● running'
  const bgJobs = rec?.bgJobs ?? 0
  const badge = runningBadge(mainRunning, subRunning.length, bgJobs)
  const running = badge !== null

  // -- left: dynamic permission mode + key hints (literal % escaped:
  //    statusline treats % as the item prefix → E539 otherwise)
  const mode = modeLabel(rec?.mode)
  const policy = rec?.policy ?? 'ask'
  const left = escapeStatusline(`${mode} · ${policy} · / ${t('命令')} · ctrl+o ${t('面板')} · ctrl+p ${t('历史')}`)
  // Extension-contributed segments (P1 ext API): sorted by priority,
  // appended after the built-in left block.
  const extSegs = [...app.slices.ext.extStatusSegments.values()]
    .sort((a, b) => a.priority - b.priority)
    .map((s) => escapeStatusline(s.text))
  const leftFull = extSegs.length > 0 ? `${left}  ${extSegs.join('  ')}` : left

  // -- right: live statistics
  const right = []
  // The fat whale emoji + bubble cycle replaces the braille spinner.
  if (running) {
    right.push(`${WHALE_EMOJI_FRAMES[app.slices.runtime.spinnerIndex]} ${escapeStatusline(badge!)}`)
  } else right.push(escapeStatusline(rec?.status ?? '○ idle'))
  if (mainRunning && rec?.runningSince) {
    right.push(escapeStatusline(`${((Date.now() - rec.runningSince) / 1000).toFixed(1)}s`))
  }
  if (rec?.model) {
    const effort = app.slices.agent.currentSelection().reasoningEffort
    const tier = rec.difficulty?.tmp?.tier
    const tierIcon = tier !== undefined && tier !== null ? `${TIER_ICONS[tier]} ` : ''
    right.push(escapeStatusline(tierIcon + rec.model + (effort ? ` ◎${effort}` : '')))
  }
  const usage = rec?.usage
  const cacheRate = usage ? cacheHitRate(usage, rec?.cacheReported === true) : null
  if (!hiddenGlance.has('cache') && cacheRate !== null) right.push(escapeStatusline(tf('缓存 {n}%', { n: Math.round(cacheRate * 100) })))
  // Context = the LATEST step's billed input vs the context window
  // (the session total is a different number — shown as Σ).
  const last = rec?.lastUsage
  const lastBilled = last ? billedInput(last) : 0
  if (!hiddenGlance.has('context') && rec?.contextWindow && lastBilled > 0) {
    const ratio = Math.min(1, lastBilled / rec.contextWindow)
    right.push(escapeStatusline(tf('上下文 {n}%', { n: Math.round(ratio * 100) })))
  }
  if (!hiddenGlance.has('tokens') && lastBilled > 0) {
    right.push(escapeStatusline(rec?.contextWindow
      ? `◧ ${formatTokens(lastBilled)}/${formatTokens(rec.contextWindow)}`
      : `◧ ${formatTokens(lastBilled)}`))
  }
  if (!hiddenGlance.has('total') && usage) {
    const total = billedInput(usage) + usage.output
    if (total > 0) right.push(escapeStatusline(`Σ ${formatTokens(total)}`))
  }
  // Whole-log performance projection (official client's TTFT/throughput
  // stats): sessionStats unit, read live from the projection registry.
  const projections = app.svc('sessionProjections')
  if (rec !== undefined && typeof projections?.stateOf === 'function') {
    try {
      const stats = projections.stateOf(rec.handle.agent.session, 'sessionStats') as {
        ttftMs?: number; ttftSteps?: number; decodeMs?: number; decodeTokens?: number
      } | undefined
      if (stats !== undefined && (stats.ttftSteps ?? 0) > 0) {
        right.push(escapeStatusline(`TTFT ${((stats.ttftMs ?? 0) / (stats.ttftSteps ?? 1) / 1000).toFixed(1)}s`))
      }
      if (stats !== undefined && (stats.decodeMs ?? 0) > 0 && (stats.decodeTokens ?? 0) > 0) {
        right.push(escapeStatusline(`${Math.round((stats.decodeTokens ?? 0) / ((stats.decodeMs ?? 1) / 1000))} tok/s`))
      }
    } catch {}
  }
  // Goal / plan mode indicators (folded from session events, cached).
  if (rec?.planActive) right.push('📋 plan')
  // Background jobs badge (official client's session-header jobs entry).
  const jobs = app.svc('jobs')
  if (rec !== undefined && jobs !== undefined) {
    try {
      const running = (jobs.list(rec.handle.agent) ?? []).filter((j) => j.status === 'running').length
      if (running > 0) right.push(escapeStatusline(`⚙ ${running}`))
    } catch {}
  }
  // Addressed child session (continuable followup): lineage indicator.
  if (app.slices.agent.pendingSubagentFollowup !== null) {
    right.push(escapeStatusline(`⇢ ${app.slices.agent.pendingSubagentFollowup.label}`))
  }
  // Queued messages (inbox projection): the QueueDock counterpart.
  if (rec !== undefined) {
    try {
      const inbox = rec.handle.agent.inbox as InboxLike | undefined
      const queued = ((inbox?.nextTurn?.length ?? 0) + (inbox?.nextStep?.length ?? 0))
      if (queued > 0) right.push(escapeStatusline(`⏳ ${queued}`))
    } catch {}
  }
  // Standing todos (todo/write fold): the TodoDock counterpart.
  if (rec?.todos) {
    const t = rec.todos
    if (t.completed + t.inProgress + t.pending > 0) {
      right.push(`📋 ${t.completed}✓ ${t.inProgress}… ${t.pending}·`)
    }
  }
  if (rec?.goal) {
    const g = rec.goal
    right.push(escapeStatusline(`🎯 ${g.phase === 'active' ? '' : g.phase + ' '}${g.maxGoalRounds > 0 ? `${Math.min(g.roundsStarted ?? 0, g.maxGoalRounds)}/${g.maxGoalRounds}` : (g.roundsStarted ?? 0)}`))
  }
  if (!hiddenGlance.has('elapsed') && rec?.createdAt) right.push(escapeStatusline(formatElapsed(Date.now() - rec.createdAt)))
  if (!hiddenGlance.has('cost') && rec?.model && usage) {
    const cost = estimateCost(rec.model, usage)
    if (cost !== undefined) right.push(escapeStatusline(`$${cost.toFixed(2)}`))
  }
  right.push(escapeStatusline(rec?.provider ?? app.slices.agent.currentSelection().provider))

  const text = `%#DshTuiStatus# ${leftFull} %= ${right.join(' · ')} `
  // Owned by the Lua side: window events re-apply it so statusline
  // plugins cannot clobber it on window switches.
  void app.luaCall('require("dsh_tui").set_statusline(...)', [text]).catch(() => {})
}

// -- glance segments (statusline visibility toggles) ---------------------

/** /density — compact tool cards (title line only). */
/** /whale [on|off] — blue whale wallpaper/watermark toggle. */
/** Fill the statusline module's App slots and register its commands. */
export function installStatusline(app: App): void {
  // -- ui surface domain defaults (I2; transcript owns the diff part) --
  Object.assign(app.slices.ui, {
    welcomeLines: () => ({ above: [], below: [] }),
    ensureSpinner: () => {},
    updateStatusline: () => {},
    refreshBgJobs: () => {},
    foldEvent: () => {},
    pendingNotices: [],
  })

  app.slices.ui.foldEvent = (rec, event) => foldEvent(app, rec, event)
  app.slices.ui.updateStatusline = () => updateStatusline(app)
  app.slices.ui.ensureSpinner = () => ensureSpinner(app)
  app.slices.ui.refreshBgJobs = () => refreshBgJobs(app)
  // Background jobs keep the statusline honest while the agent is idle:
  // every visible-set change re-reads the active session's live jobs and
  // re-arms the spinner; a settled job notices its label when it belongs
  // to the active session.
  const jobs = app.svc('jobs')
  if (typeof jobs?.onJobsChanged === 'function') {
    app.slices.runtime.hostDisposers.push(jobs.onJobsChanged(() => {
      app.slices.ui.refreshBgJobs()
      app.slices.ui.ensureSpinner()
      app.slices.ui.updateStatusline()
    }))
  }
  if (typeof jobs?.onJobDone === 'function') {
    app.slices.runtime.hostDisposers.push(jobs.onJobDone((snap, owner) => {
      // Merge the terminal state BEFORE the board refreshes (the live list
      // may already have dropped the job).
      const sid = (owner as { session?: { id?: string } } | undefined)?.session?.id
      const snapId = (snap as { id?: string } | undefined)?.id
      if (sid !== undefined) {
        const rec2 = app.slices.sessions.live.get(sid)
        if (rec2 !== undefined && snapId !== undefined) {
          const cache2 = rec2.jobsCache ?? new Map<string, { label?: string; status: string; startedAt?: number }>()
          rec2.jobsCache = cache2
          const prev = cache2.get(snapId)
          cache2.set(snapId, { label: snap.label ?? prev?.label, status: snap.status ?? 'completed', startedAt: prev?.startedAt })
        }
      }
      app.slices.ui.refreshBgJobs()
      app.slices.ui.ensureSpinner()
      app.slices.ui.updateStatusline()
      if (sid !== undefined && sid === app.slices.sessions.activeId) {
        app.notice(tf('✓ 后台任务 {label} · {status}', { label: snap?.label ?? '?', status: snap?.status ?? t('结束') }))
      }
    }))
  }
  // -- the slash commands, one file each (self-registering) --
  installWhaleCommand(app)
  installDensityCommand(app)
  installGlanceCommand(app)
  installCostCommand(app)


  // -- host events this module owns (wired by boot via host-events.ts) ----
  // Agent lifecycle status → statusline.
  registerHostHandler('agent/status', (app, payload) => {
    if (app.slices.runtime.disposed) return
    const { agent, status } = (payload ?? {}) as { agent?: { session?: { id?: string } }; status?: string }
    const sid = agent?.session?.id
    const rec = sid === undefined ? undefined : app.slices.sessions.live.get(sid)
    if (!rec) return
    if (status === 'running') {
      rec.status = '● running'
      rec.runningSince = Date.now()
    } else {
      rec.status = '○ idle'
      rec.runningSince = null
    }
    if (rec.id === app.slices.sessions.activeId) {
      app.slices.ui.ensureSpinner()
      app.slices.ui.updateStatusline()
    }
  })
}
