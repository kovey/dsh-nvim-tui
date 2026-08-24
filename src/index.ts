import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync, readFileSync, mkdirSync, readdirSync, unlinkSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { NeovimClient } from 'neovim'
import { spawnNvim, connectNvim } from './bridge.js'
import { FeedRenderer } from './feed.js'
import { t, setLocale, locale } from './i18n.js'
import { readImageFile, readClipboardImage, splitImageDataUrls, imageLabel, sniffMediaType } from './images.js'
import {
  EMPTY_USAGE, foldUsage, billedInput, cacheHitRate, estimateCost,
  formatTokens, formatElapsed, modeLabel, escapeStatusline,
} from './stats.js'
import type {
  AgentHandle, AgentPresetsService, AgentStatusPayload, AgentsService, ApprovalRequest,
  AttachmentsService, ChatMessage, CompactionService, FileReferencesService,
  GoalsService, GoalState, HarnessSession, InboxLike, JobsService, LlmService, MessageContent,
  MessageFeedbackService, ModelSelection, PermissionPresetsService,
  PlanModeService, RuntimeCtx, SaveImageAttachment, SessionEvent,
  PluginInventoryService, SessionPersistenceService, SessionProjectionsService, SessionQueryService, SessionReferenceService, SessionStore,
  SessionTitleService, SettingsService, SkillsService, SubagentInfo,
  SubagentsService, TokenUsage, ToolsService, Usage, UserQuestion,
  UserQuestionsService, WorkflowInfo, WorkflowResult, WorkspacesService,
} from './types.js'

/** Version + build stamp shown in the boot banner (proof of which code runs). */
export const BUILD_VERSION = '0.2.0'
export const BUILD_STAMP = new Date().toISOString().slice(0, 16).replace('T', ' ')

export const name = 'dsh-nvim-tui'

/**
 * Mount the Neovim TUI runner over dsh-base.
 *
 * Flow: spawn nvim (built-in TUI renders the terminal) → connect the socket →
 * hand nvim its channel id → create the initial session+agent → stream
 * `session/event` per session into its chat buffer → forward nvim keystrokes
 * (rpcnotify) to the active session's agent.
 *
 * Sessions: one live record per owned agent ({handle, feed, title}). The
 * session list shows live sessions + persisted history; selecting a history
 * entry resumes it via `agents.resume` and replays its events into the chat.
 *
 * Test mode (`config.headless: true` or `DSH_NVIM_TUI_HEADLESS=1`): nvim runs
 * with `--headless` (no TTY needed) and the runner dumps the active chat
 * buffer to `DSH_NVIM_TUI_DUMP` after the first completed turn (or the
 * watchdog), then exits.
 */
export interface RunnerConfig {
  headless?: boolean
  watchdogMs?: number
  dumpPath?: string
  theme?: Record<string, unknown> | null
  loadUserConfig?: boolean
  resumeSessionId?: string
  resumeLatest?: boolean
  prompt?: string
  [key: string]: unknown
}

export function apply(ctx: Context, config: RunnerConfig = {}): void {
  ctx.inject(['agents', 'agentDefaultModel', 'sessions'], (rt) => {
    const runtimeCtx = rt as unknown as RuntimeCtx
    const localeInit = String(config.locale ?? process.env.DSH_NVIM_TUI_LOCALE ?? 'zh')
    setLocale(localeInit === 'en' ? 'en' : 'zh')
    /** Typed service registry: each harness service this bundle consumes,
     *  keyed by its runtime name. `get` returns undefined when unmounted. */
    interface ServiceMap {
      appExit: (code?: number) => void
      attachments: AttachmentsService
      visionBridge: unknown
      subagents: SubagentsService
      compaction: CompactionService
      goals: GoalsService
      planMode: PlanModeService
      jobs: JobsService
      skills: SkillsService
      permissionPresets: PermissionPresetsService
      fileReferences: FileReferencesService
      settings: SettingsService
      tools: ToolsService
      sessionQuery: SessionQueryService
      sessionProjections: SessionProjectionsService
      pluginInventory: PluginInventoryService
      sessionReferenceResolver: SessionReferenceService
      sessionTitle: SessionTitleService
      messageFeedback: MessageFeedbackService
      sessionPersistence: SessionPersistenceService
      agentPresets: AgentPresetsService
      userQuestions: UserQuestionsService
      workspaces: WorkspacesService
    }
    const svc = <K extends keyof ServiceMap>(name: K): ServiceMap[K] | undefined =>
      runtimeCtx.get(name) as ServiceMap[K] | undefined
    /** msgpack-RPC boundary: nvim.lua results are structurally unknown. */
    const luaCall = (code: string, args: unknown[] = []): Promise<any> => {
      if (nvim === null) return Promise.reject(new Error('nvim not connected'))
      return nvim.lua(code, args as never[])
    }
    const headless = config.headless === true || process.env.DSH_NVIM_TUI_HEADLESS === '1'
    const watchdogMs = Number(config.watchdogMs ?? process.env.DSH_NVIM_TUI_WATCHDOG_MS ?? 120000)
    const dumpPath = config.dumpPath ?? process.env.DSH_NVIM_TUI_DUMP ??
      `/tmp/dsh-nvim-tui-e2e-${process.pid}.txt`

    const appExitService = svc('appExit')
    const requestExit = (code = 0) => {
      if (typeof appExitService === 'function') appExitService(code)
      else process.exit(code)
    }

    let disposed = false
    let child: ReturnType<typeof spawn> | null = null
    let nvim: NeovimClient | null = null
    let channelIdValue: number | null = null
    let feedDisposer: (() => void) | null = null
    let chatWinId: number | null = null
    let reasoningOpen = false
    let reasoningWinId: number | null = null
    let approvalSettle: ((outcome: string) => void) | null = null // resolve({outcome}) of the pending approval
    let questionsResolve: { resolve: (v: { answers: unknown[] }) => void; reject: (e: Error) => void } | null = null
    let pickerSettle: ((value: string | null) => void) | null = null // resolve(value|null) of the pending picker
    const hostDisposers: Array<() => void> = []
    const pendingInput: string[] = []
    /** Clipboard images queued via <C-v>; sent with the next submitted text. */
    let pendingImages: Array<SaveImageAttachment | Extract<MessageContent, { type: 'image' }>> = []
    /** Open subagent transcript view: { childId, feed } (read-only replay). */
    let subagentView: { childId: string; feed: FeedRenderer } | null = null
    /** /sessions float data: [{ id, title, active, kind }] (full ids). */
    let sessionEntries: Array<{ id: string; title: string; active: boolean; kind: string }> = []
    /** Pending directory-picker selection (Lua float → 'dsh-dir-selected'). */
    let dirSettle: ((picked: string | null) => void) | null = null
    /** Next input line goes to a continuable subagent (set by /subagents). */
    let pendingSubagentFollowup: { childId: string; label: string } | null = null
    /** Next input line is a free-text rename (workspace/session row action). */
    let pendingRename: { kind: 'workspace'; id: string } | { kind: 'session'; id: string } | null = null
    /** Next input line replaces a queued message (queue edit action). */
    let pendingQueueEdit: { list: 'nextTurn' | 'nextStep'; messageId: string } | null = null
    /** Workflow run registry (live): runId → { name, startedAt, phases, agents, logs, running, stopReason }. */
    const workflowRuns = new Map<string, {
      id: string
      name: string
      startedAt: number
      phases: Array<{ title: string; startedAt: number }>
      agents: Array<{ seq: number; label: string; outcome?: string }>
      logs: string[]
      running: boolean
      stopReason: string | undefined
    }>()
    /** Turn-end terminal bell (default on; approvals always ring). */
    let bellOn = true

    // session id -> { id, handle, feed, title, status }
    interface ModelRef {
      current: ReturnType<ModelSelection['currentSelection']>
      assembled?: unknown
    }
    interface SessionRec {
      id: string
      handle: AgentHandle
      feed: FeedRenderer
      title: string | undefined
      status: string | undefined
      modelRef: ModelRef
      model: string | undefined
      createdAt: number
      usage: Usage | undefined
      contextWindow: number | undefined
      mode: string | undefined
      policy: string | undefined
      provider: string | undefined
      cacheReported: boolean
      lastUsage?: Usage
      lastAssistantMessageId: string | null
      goal: GoalState | null
      planActive: boolean
      imagePoisonWarned: boolean
      deliverables: { turn: number | undefined; paths: string[] }
      todos: { completed: number; inProgress: number; pending: number } | null
      runningSince?: number | null
      [key: string]: unknown
    }
    const sessions = new Map<string, SessionRec>()
    let activeId: string | null = null
    let historyHeaders: Array<{ id: string; cwd?: string; createdAt?: number; title?: string }> = []

    // Last-active-session state (claude --continue behaviour): recorded on
    // every switch; read at boot to auto-resume. Lives under DSH_HOME.
    const statePath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-nvim-tui-state.json')
    const readState = () => {
      try {
        return JSON.parse(readFileSync(statePath, 'utf8'))
      } catch {
        return null
      }
    }
    const recordState = (id: string) => {
      try {
        writeFileSync(statePath, JSON.stringify({ sessionId: id, cwd: process.cwd(), at: Date.now() }))
      } catch {}
    }

    if (headless) appendFileSync(`${dumpPath}.applies`, `apply ${new Date().toISOString()}\n`)

    const lua = {
      ensureChat: (id: string): Promise<any> => luaCall('return require("dsh_tui").ensure_chat(...)', [id]),
      ensureReasoning: (id: string): Promise<any> => luaCall('return require("dsh_tui").ensure_reasoning(...)', [id]),
      setActive: (id: string): Promise<any> => luaCall('require("dsh_tui").set_active(...)', [id]),
    }

    const currentSelection = () => runtimeCtx.agentDefaultModel.currentSelection()

    const activeFeed = () => {
      const rec = activeId === null ? undefined : sessions.get(activeId)
      return rec?.feed
    }

    const notice = (text: unknown): void => { activeFeed()?.appendNotice(text) }

    /** Fold one transcript event into the session's statusline stats. */
    const foldEvent = (rec: SessionRec, event: SessionEvent) => {
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
        const todos = event.data?.todos ?? []
        const count = (st: string) => todos.filter((t) => t.status === st).length
        rec.todos = { completed: count('completed'), inProgress: count('in_progress'), pending: count('pending') }
        if (rec.id === activeId) updateStatusline()
      }
    }

    /** Show the generic floating picker; resolves to the value or null. */
    const openPicker = (title: string, items: Array<{ label: string; value: string; active?: boolean }>) => new Promise<string | null>((resolve) => {
      pickerSettle = resolve
      void luaCall('require("dsh_tui").show_picker(...)', [title, items])
        .catch(() => { pickerSettle = null; resolve(null) })
    })

    // Spinner animation for the statusline while the active agent is running.
    const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    let spinnerTimer: ReturnType<typeof setInterval> | null = null
    let spinnerIndex = 0
    let idleRefreshTimer: ReturnType<typeof setInterval> | null = null
    const ensureSpinner = () => {
      const rec = activeId === null ? undefined : sessions.get(activeId)
      const running = rec?.status === '● running'
      if (running && spinnerTimer === null) {
        spinnerTimer = setInterval(() => {
          spinnerIndex = (spinnerIndex + 1) % SPINNER.length
          updateStatusline()
        }, 180)
      } else if (!running && spinnerTimer !== null) {
        clearInterval(spinnerTimer)
        spinnerTimer = null
      }
    }

    /** Statusline: left = permission mode + hints; right = model/effort,
     *  cache, context, tokens, elapsed, cost, route (+ spinner while running). */
    const updateStatusline = () => {
      if (chatWinId === null) return
      const rec = activeId === null ? undefined : sessions.get(activeId)
      const running = rec?.status === '● running'

      // -- left: dynamic permission mode + key hints (literal % escaped:
      //    statusline treats % as the item prefix → E539 otherwise)
      const mode = modeLabel(rec?.mode)
      const policy = rec?.policy ?? 'ask'
      const left = escapeStatusline(`${mode} · ${policy} · / ${t('命令')} · ctrl+o ${t('面板')} · ctrl+p ${t('历史')}`)

      // -- right: live statistics
      const right = []
      if (running) right.push(escapeStatusline(`${SPINNER[spinnerIndex]} ${rec.status}`))
      else right.push(escapeStatusline(rec?.status ?? '○ idle'))
      if (running && rec?.runningSince) {
        right.push(escapeStatusline(`${((Date.now() - rec.runningSince) / 1000).toFixed(1)}s`))
      }
      if (rec?.model) {
        const effort = currentSelection().reasoningEffort
        right.push(escapeStatusline(rec.model + (effort ? ` ◎${effort}` : '')))
      }
      const usage = rec?.usage
      const cacheRate = usage ? cacheHitRate(usage, rec?.cacheReported === true) : null
      if (cacheRate !== null) right.push(escapeStatusline(`缓存 ${Math.round(cacheRate * 100)}%`))
      // Context = the LATEST step's billed input vs the context window
      // (the session total is a different number — shown as Σ).
      const last = rec?.lastUsage
      const lastBilled = last ? billedInput(last) : 0
      if (rec?.contextWindow && lastBilled > 0) {
        const ratio = Math.min(1, lastBilled / rec.contextWindow)
        right.push(escapeStatusline(`上下文 ${Math.round(ratio * 100)}%`))
        right.push(escapeStatusline(`◧ ${formatTokens(lastBilled)}/${formatTokens(rec.contextWindow)}`))
      } else if (lastBilled > 0) {
        right.push(escapeStatusline(`◧ ${formatTokens(lastBilled)}`))
      }
      if (usage) {
        const total = billedInput(usage) + usage.output
        if (total > 0) right.push(escapeStatusline(`Σ ${formatTokens(total)}`))
      }
      // Whole-log performance projection (official client's TTFT/throughput
      // stats): sessionStats unit, read live from the projection registry.
      const projections = svc('sessionProjections')
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
      const jobs = svc('jobs')
      if (rec !== undefined && jobs !== undefined) {
        try {
          const running = (jobs.list(rec.handle.agent) ?? []).filter((j) => j.status === 'running').length
          if (running > 0) right.push(escapeStatusline(`⚙ ${running}`))
        } catch {}
      }
      // Addressed child session (continuable followup): lineage indicator.
      if (pendingSubagentFollowup !== null) {
        right.push(escapeStatusline(`⇢ ${pendingSubagentFollowup.label}`))
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
      if (rec?.createdAt) right.push(escapeStatusline(formatElapsed(Date.now() - rec.createdAt)))
      if (rec?.model && usage) {
        const cost = estimateCost(rec.model, usage)
        if (cost !== undefined) right.push(escapeStatusline(`$${cost.toFixed(2)}`))
      }
      right.push(escapeStatusline(rec?.provider ?? currentSelection().provider))

      const text = `%#DshTuiStatus# ${left} %= ${right.join(' · ')} `
      // Owned by the Lua side: window events re-apply it so statusline
      // plugins cannot clobber it on window switches.
      void luaCall('require("dsh_tui").set_statusline(...)', [text]).catch(() => {})
    }

    /** Route a subagent lifecycle event to its PARENT session's feed. */
    const feedForSubagent = (info: SubagentInfo) => {
      if (!info?.id) return undefined
      const child = runtimeCtx.sessions.get(info.id)
      const parentId = child?.header?.parentSession
      const rec = parentId !== undefined ? sessions.get(parentId) : undefined
      if (rec) return rec
      // Fallback: subagents usually spawn while their parent is the active session.
      return activeId === null ? undefined : sessions.get(activeId)
    }

    const refreshList = () => {
      const entries = [...sessions.values()].map((s) => ({
        id: s.id,
        title: s.title ?? '', // never undefined — msgpack turns it into vim.NIL
        active: s.id === activeId,
        kind: 'live',
      }))
      for (const h of historyHeaders) {
        if (!sessions.has(h.id)) {
          entries.push({ id: h.id, title: '', active: false, kind: 'history' })
        }
      }
      // The /sessions float reads these (full ids on display); there is no
      // resident list window anymore.
      sessionEntries = entries
    }

    /** Own one live agent: chat buffer + feed + registry entry. */
    const attachSession = async (handle: AgentHandle, modelRef: ModelRef) => {
      const id = handle.agent.session.id
      const ids = await lua.ensureChat(id)
      chatWinId = ids.chatWin
      const rids = await lua.ensureReasoning(id)
      if (rids?.reasoningWin !== null && rids?.reasoningWin !== undefined) reasoningWinId = rids.reasoningWin
      reasoningOpen = rids?.reasoningOpen === true
      const feed = new FeedRenderer(nvim!, ids.chatBuf, ids.chatWin, {
        idsProvider: () => luaCall('return require("dsh_tui").ensure_chat(...)', [id]),
        activeChecker: () => id === activeId,
        reasoningBuf: rids?.reasoningBuf ?? null,
        reasoningView: () => ({ open: reasoningOpen, win: reasoningWinId }),
      })
      sessions.set(id, {
        id, handle, feed, title: undefined, status: undefined, modelRef,
        model: modelRef?.current ? modelRef.current.model : undefined,
        createdAt: handle.agent.session.header?.createdAt ?? Date.now(),
        usage: undefined,
        contextWindow: undefined,
        mode: undefined,
        policy: undefined,
        provider: undefined,
        cacheReported: false,
        lastAssistantMessageId: null,
        goal: null,
        planActive: false,
        imagePoisonWarned: false,
        deliverables: { turn: undefined, paths: [] },
        todos: null,
      })
      // Boot banner: version + build stamp + channel (proves which code runs).
      feed.appendNotice(`dsh-nvim-tui ${BUILD_VERSION} (build ${BUILD_STAMP}) · channel ${channelIdValue}`)
      return id
    }

    /** Create a fresh session+agent and switch to it. `cwdPath` (optional)
     *  overrides the process working directory (validated: must be a dir). */
    const createSession = async (cwdPath?: string) => {
      const selection = currentSelection()
      const modelRef = { current: selection, assembled: void 0 }
      let cwd = process.cwd()
      if (cwdPath) {
        const abs = resolve(cwdPath)
        try {
          if (!statSync(abs).isDirectory()) throw new Error('不是目录')
          cwd = abs
        } catch (err) {
          notice(`无效目录 ${cwdPath}: ${(err as Error).message}`)
          return
        }
      }
      const handle = await runtimeCtx.agents.create({
        sessionId: `session-${randomUUID()}`,
        meta: { cwd },
        agentOptions: {
          provider: selection.provider,
          model: selection.model,
        },
        setup: (agentCtx) => {
          installModelSelection(agentCtx, modelRef as unknown as Parameters<typeof installModelSelection>[1])
        },
      })
      const id = await attachSession(handle, modelRef)
      await switchTo(id)
      refreshList()
      void refreshCommandCatalog()
      notice(`session ${id} (${selection.provider}/${selection.model}${cwdPath ? ` · ${cwd}` : ''})`)
      return id
    }

    /** Resume a persisted session, replay its history into the chat. */
    const resumeSession = async (id: string) => {
      const selection = currentSelection()
      const modelRef = { current: selection, assembled: void 0 }
      const handle = await runtimeCtx.agents.resume({
        resumeSessionId: id,
        agentOptions: {
          provider: selection.provider,
          model: selection.model,
        },
        setup: (agentCtx) => {
          installModelSelection(agentCtx, modelRef as unknown as Parameters<typeof installModelSelection>[1])
        },
      })
      const sid = await attachSession(handle, modelRef)
      const rec = sessions.get(sid)!
      const events = handle.agent.session.events
      rec.feed.appendNotice(`history replay: ${events.length} events`)
      for (const event of events) {
        foldEvent(rec, event)
        rec.feed.applyEvent(event, { history: true })
      }
      await switchTo(sid)
      refreshList()
      notice(`已恢复 ${sid}`)
      return sid
    }

    /** Terminal title: active session title + model (OSC 2 via nvim). */
    const updateTitle = () => {
      if (nvim === null || disposed) return
      const rec = activeId === null ? undefined : sessions.get(activeId)
      const title = rec?.title ?? 'dsh'
      void luaCall('require("dsh_tui").set_title(...)', [title]).catch(() => {})
    }

    const switchTo = async (id: string) => {
      activeId = id
      await lua.setActive(id)
      ensureSpinner()
      updateStatusline()
      updateTitle()
      if (sessions.has(id)) recordState(id)
    }

    const selectSession = async (id: string) => {
      if (disposed) return
      if (sessions.has(id)) {
        await switchTo(id)
        refreshList()
      } else if (historyHeaders.some((h) => h.id === id)) {
        await resumeSession(id)
      } else {
        notice(`未知会话 ${id}`)
      }
    }

    // UI teardown only — must NOT exit the process: the runner row can be
    // reloaded (hmr) while dsh keeps running; the next apply spawns a fresh nvim.
    const teardown = async () => {
      if (disposed) return
      disposed = true
      try {
        feedDisposer?.()
      } catch {}
      for (const dispose of hostDisposers) {
        try {
          dispose()
        } catch {}
      }
      hostDisposers.length = 0
      if (spinnerTimer !== null) {
        clearInterval(spinnerTimer)
        spinnerTimer = null
      }
      if (idleRefreshTimer !== null) {
        clearInterval(idleRefreshTimer)
        idleRefreshTimer = null
      }
      // Unblock pending interactions so the host can drain.
      approvalSettle?.('cancelled')
      approvalSettle = null
      if (questionsResolve) {
        const r = questionsResolve
        questionsResolve = null
        r.reject(new Error('UI torn down'))
      }
      pickerSettle?.(null)
      pickerSettle = null
      if (activeId !== null) recordState(activeId)
      // Persist every live session before disposing its agent. Bounded: an
      // active turn holds the session's append boundary open, and the flush /
      // handle disposal would wait for LLM retries (minutes). The QUIT path
      // races this; the effect-disposer path lets it drain.
      try {
        for (const session of runtimeCtx.sessions.list()) {
          try {
            await runtimeCtx.sessions.flush(session)
          } catch {}
        }
      } catch {}
      for (const rec of sessions.values()) {
        try {
          await rec.handle.dispose()
        } catch (err) {
          console.error('[dsh-nvim-tui] dispose failed:', err)
        }
      }
      sessions.clear()
      await closeNvimWindow()
    }

    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

    /** Guard async UI actions: an unexpected throw must surface as a chat
     *  notice + a log line — never as an unhandled rejection that kills the
     *  whole dsh process (the historical "open a session → dsh dies" bug). */
    const errorLogPath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'nvim-tui-errors.log')
    const guard = (label: string, fn: (...args: any[]) => Promise<unknown>) => async (...args: any[]): Promise<void> => {
      try {
        await fn(...args)
      } catch (err) {
        const e = err as Error | undefined
        try {
          appendFileSync(errorLogPath,
            `${new Date().toISOString()} ${label}: ${e?.stack ?? String(err)}\n`)
        } catch {}
        notice(`⚠ ${label}失败: ${e?.message ?? String(err)}`)
      }
    }

    /** Close the nvim window gracefully (`:qa!` over RPC) so it never prints
     *  "Nvim: Caught deadly signal 'SIGTERM'". kill(2) stays as the fallback
     *  for a wedged RPC or an nvim that already went away. The exit listener
     *  is registered BEFORE the qa! — nvim can exit before the RPC roundtrip
     *  ends and the event would otherwise be missed. */
    const closeNvimWindow = async () => {
      const exited = child === null || child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise((resolve) => child!.once('exit', resolve))
      try {
        if (nvim !== null) {
          await Promise.race([
            nvim!.command('qa!').catch(() => {}),
            sleep(250),
          ])
        }
      } catch {}
      // Give the graceful exit a moment, then force-kill whatever remains.
      await Promise.race([exited, sleep(400)])
      try {
        if (child !== null && child.exitCode === null && child.signalCode === null) {
          child.kill()
        }
      } catch {}
    }

    // Explicit quit (user action, nvim exit, fatal error, signals): close the
    // UI immediately, give graceful persistence a bounded window, then exit —
    // with a hard fallback in case the launcher's graceful shutdown stalls.
    let quitting = false
    const quit = async (code = 0) => {
      if (quitting) return
      quitting = true
      await closeNvimWindow() // the window closes right away, no waiting on the agent
      await Promise.race([teardown(), sleep(2500)])
      requestExit(code)
      // Last resort: whatever hangs (in-flight turn, pending flush, loader
      // shutdown) must not survive this timer.
      setTimeout(() => process.exit(code), 2000)
    }

    const onSignal = () => void quit(0)
    ctx.effect(() => {
      process.on('SIGTERM', onSignal)
      process.on('SIGINT', onSignal)
      return () => {
        process.off('SIGTERM', onSignal)
        process.off('SIGINT', onSignal)
        void teardown()
      }
    })

    /**
     * Send a user message with optional image attachments.
     * `images` entries are SaveImageAttachment-shaped (`{data, mediaType, name}`)
     * — read from a local file (/image) or parsed from pasted data URLs. They
     * are durably committed through the harness `attachments` service so the
     * message content carries only stable image refs; the LLM adapter resolves
     * them into data URLs at request time.
     * agent.followup() ENQUEUES a next-turn message and wakes the driver: a
     * running turn is never interrupted — the input is processed as a later
     * turn of the same drain.
     */
    const followup = async (rec: SessionRec, text: string, images?: Array<SaveImageAttachment | Extract<MessageContent, { type: 'image' }> | string>) => {
      if (disposed || rec === undefined) return
      // Surface the queueing so the message doesn't look lost. (Use /btw to
      // fork a side session instead.)
      if (rec.status === '● running') {
        activeFeed()?.appendNotice('已排队：当前回合结束后处理')
      }
      if (images !== undefined && images.length > 0 && (text ?? '').trim() === '') {
        text = '📎 图片消息'
      }
      const content: MessageContent[] = [{ type: 'text', text }]
      if (images !== undefined && images.length > 0) {
        const attachments = svc('attachments')
        if (attachments === undefined) {
          notice(t('图片发送需要 attachments 服务（attachment-local 未装配）'))
          return
        }
        // Gate on capability: the model must declare image input, OR a
        // visionBridge service must be assembled (dsh-vision-bridge converts
        // the images to text descriptions before the adapter sees them — for
        // text-only gateways/models). Otherwise fail fast instead of letting
        // the turn die inside the adapter (UNSUPPORTED_CONTENT).
        let viaBridge = false
        try {
          const sel = currentSelection()
          const info = await (runtimeCtx.get('llm') as LlmService | undefined)?.resolveModelInfo(sel.provider, sel.model)
          // Only an explicit "image" modality counts as native vision — an
          // ABSENT inputModalities field means text-only and must NOT bypass
          // the gate (it would die in the adapter with UNSUPPORTED_CONTENT).
          const nativeVision = info?.inputModalities?.includes('image') === true
          if (!nativeVision) {
            if (svc('visionBridge') !== undefined) {
              viaBridge = true
            } else {
              notice(`当前模型 ${sel.provider}/${sel.model} 不支持图片输入（网关/text-only；可装配 dsh-vision-bridge 经本地 OCR 转文字，或使用原生识图模型）`)
              return
            }
          }
        } catch {}
        if (viaBridge) {
          notice(t('📎 图片将经识图桥转成文字描述后发送'))
        }
        const max = attachments.imageLimits?.maxImagesPerMessage ?? 4
        if (images.length > max) {
          notice(`最多附带 ${max} 张图片，已截断`)
          images = images.slice(0, max)
        }
        try {
          for (const img of images) {
            content.push({ type: 'image', attachment: await attachments.saveImage(img as SaveImageAttachment) })
          }
        } catch (err) {
          notice(`图片附加失败: ${(err as Error).message}`)
          return
        }
      }
      try {
        rec.handle.agent.followup(createUserMessage({
          content: content as never,
          source: { kind: 'user' },
        }))
      } catch (err) {
        notice(`发送失败: ${(err as Error).message}`)
      }
    }

    const send = (text: string) => {
      if (disposed) return
      const rec = activeId === null ? undefined : sessions.get(activeId)
      if (!rec) {
        pendingInput.push(text)
        return
      }
      // /subagents → 继续对话: this input line goes to the continuable child
      // through the official `subagents.followup` (parent-authority check
      // built in) instead of the main agent.
      if (pendingSubagentFollowup !== null) {
        const target = pendingSubagentFollowup
        pendingSubagentFollowup = null
        const subagentsSvc = svc('subagents')
        if (typeof subagentsSvc?.followup !== 'function') {
          notice(t('子代理续聊不可用（subagents 服务未装配）'))
          return
        }
        const followupFn = subagentsSvc.followup
        void (async () => {
          try {
            await followupFn(rec.handle.agent, target.childId,
              [{ type: 'text', text }],
              { source: { kind: 'user' }, signal: new AbortController().signal })
            notice(`已发送给子代理 ${target.label}: ${text.slice(0, 60)}`)
          } catch (err) {
            notice(`子代理续聊失败: ${(err as Error).message}`)
          }
        })()
        return
      }
      // Pasted data URLs become image attachments; the URL text is stripped.
      const { text: clean, images } = splitImageDataUrls(text)
      // Clipboard images queued via <C-v> ride along with the submitted text.
      const all = [...images, ...pendingImages]
      pendingImages = []
      void followup(rec, clean, all)
    }

    /** <C-v> handler: queue the macOS clipboard image for the next submit. */
    const pasteClipboardImage = () => {
      const rec = activeId === null ? undefined : sessions.get(activeId)
      if (!rec) {
        notice(t('无活跃会话'))
        return
      }
      if (process.platform !== 'darwin') {
        notice(t('剪贴板读图仅支持 macOS（请用 /image <路径>）'))
        return
      }
      // pbpaste -Prefer public.png/tiff: plain pbpaste only returns the
      // clipboard TEXT, which is empty for an image copied with Cmd+C.
      const image = readClipboardImage()
      if (image === null) {
        notice(t('剪贴板里没有图片（截图/复制图片后按 C-v）'))
        return
      }
      pendingImages.push(image)
      notice(`📎 已附加剪贴板图片（共 ${pendingImages.length} 张，回车随消息发送；/image clear 清空）`)
    }

    /** /image [<path>] [prompt] — attach an image and send. No path on macOS
     *  reads the clipboard image via pbpaste (PNG bytes). `/image clear`
     *  drops the <C-v> pending queue. */
    const imageCommand = (a: string | undefined) => {
      if ((a ?? '').trim() === 'clear') {
        const n = pendingImages.length
        pendingImages = []
        notice(n > 0 ? `已清空 ${n} 张待发送图片` : '（没有待发送图片）')
        return
      }
      const rec = activeId === null ? undefined : sessions.get(activeId)
      if (!rec) {
        notice(t('无活跃会话'))
        return
      }
      const m = (a ?? '').match(/^(\S+)(?:\s+([\s\S]*))?$/)
      const prompt = (m?.[2] ?? '').trim()
      let image
      if (m !== null && m[1] !== undefined) {
        try {
          image = readImageFile(m[1])
        } catch (err) {
          notice(`读取图片失败: ${(err as Error).message}`)
          return
        }
      } else if (process.platform === 'darwin') {
        image = readClipboardImage()
        if (image === null) {
          notice(t('剪贴板里没有图片（用法: /image <路径> [提示]；或先复制图片）'))
          return
        }
      } else {
        notice(t('用法: /image <路径> [提示]'))
        return
      }
      void followup(rec, prompt || '📎 图片消息', [image])
    }

    /** /stop — abort the active turn (agent.cancel with a user cause). */
    const stopCommand = () => {
      const rec = activeId === null ? undefined : sessions.get(activeId)
      if (!rec) {
        notice(t('无活跃会话'))
        return
      }
      if (rec.status !== '● running') {
        notice(t('没有运行中的回合'))
        return
      }
      try {
        rec.handle.agent.cancel({ kind: 'user' })
        rec.feed.appendNotice('⏹ 已请求停止当前回合')
      } catch (err) {
        notice(`停止失败: ${(err as Error).message}`)
      }
    }

    /** /steer <directive> — inject steering for the nearest step. */
    const steerCommand = (a: string | undefined) => {
      const text = (a ?? '').trim()
      if (!text) {
        notice(t('用法: /steer <directive>（注入到最近一步的引导指令）'))
        return
      }
      const rec = activeId === null ? undefined : sessions.get(activeId)
      if (!rec) {
        notice(t('无活跃会话'))
        return
      }
      try {
        rec.handle.agent.steer(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }))
        rec.feed.pushBlock('steer', text)
        notice(t('已注入引导指令'))
      } catch (err) {
        notice(`steer 失败: ${(err as Error).message}`)
      }
    }

    // -- host-service commands (goal / compaction / jobs / skills / mcp /
    //    plan / search / rename / feedback / rewind) ------------------------

    /** /compact — manually compact the session context via the compaction
     *  engine; null result means there was nothing worth compacting. */
    const compactCommand = async () => {
      const rec = activeId === null ? undefined : sessions.get(activeId)
      if (!rec) {
        notice(t('无活跃会话'))
        return
      }
      const compaction = svc('compaction')
      if (compaction === undefined) {
        notice(t('compaction 服务未装配（profile 加入 dsh-compaction 后可用）'))
        return
      }
      notice(t('正在压缩上下文…'))
      try {
        const result = await compaction.compactNow(
          { session: rec.handle.agent.session, options: rec.handle.agent.options ?? {} },
          new AbortController().signal,
        )
        if (result === null) {
          notice(t('没有可压缩的历史'))
        } else {
          notice(`已压缩 ${result.shadowedSeqs.length} 条历史 · 约 ${formatTokens(result.shadowedTokenCount)} tokens`)
        }
      } catch (err) {
        notice(`压缩失败: ${(err as Error).message}`)
      }
    }

    /** /goal [show|new <objective>|pause|resume|complete|clear] — the active
     *  goal (compare-and-set on the GoalRef). */
    const goalCommand = (a: string | undefined) => {
      const rec = activeId === null ? undefined : sessions.get(activeId)
      if (!rec) {
        notice(t('无活跃会话'))
        return
      }
      const goals = svc('goals')
      if (goals === undefined) {
        notice(t('goal 服务未装配（profile 加入 dsh-goal 后可用）'))
        return
      }
      const agent = rec.handle.agent
      const goal = goals.get(agent)
      const [op, ...rest] = (a ?? '').trim().split(/\s+/)
      if (op === '' || op === 'show' || op === 'status') {
        if (goal === undefined) {
          notice(t('（无进行中的目标）用法: /goal new <objective>'))
          return
        }
        notice(`🎯 ${goal.objective}`)
        notice(`${goal.phase}${goal.blockedReason ? ` · 阻塞: ${goal.blockedReason.message}` : ''} · ${goal.roundsStarted} 轮 / 上限 ${goal.maxGoalRounds > 0 ? goal.maxGoalRounds : '∞'} · ${goal.activation === 'armed' ? 'armed' : 'disarmed'}`)
        return
      }
      const ref = goal === undefined ? undefined : { id: goal.id, revision: goal.revision }
      try {
        if (op === 'new' || op === 'create') {
          const objective = rest.join(' ').trim()
          if (objective === '') {
            notice(t('用法: /goal new <objective>'))
            return
          }
          goals.create(agent, { objective })
          notice(t('目标已创建'))
        } else if (op === 'pause') {
          goals.pause(agent, ref)
          notice(t('目标已暂停'))
        } else if (op === 'resume') {
          goals.resume(agent, ref)
          notice(t('目标已恢复'))
        } else if (op === 'complete') {
          goals.complete(agent, ref)
          notice(t('目标已标记完成'))
        } else if (op === 'clear') {
          goals.clear(agent, ref)
          notice(t('目标已清空'))
        } else {
          notice(t('用法: /goal [show|new <objective>|pause|resume|complete|clear]'))
        }
      } catch (err) {
        notice(`goal 操作失败: ${(err as Error).message}`)
      }
    }

    /** /plan [on|off|status] — plan mode state. */
    const planCommand = (a: string | undefined) => {
      const rec = activeId === null ? undefined : sessions.get(activeId)
      if (!rec) {
        notice(t('无活跃会话'))
        return
      }
      const planMode = svc('planMode')
      if (planMode === undefined) {
        notice(t('plan-mode 服务未装配'))
        return
      }
      const arg = (a ?? '').trim()
      const state = planMode.get(rec.handle.agent)
      if (arg === '' || arg === 'status') {
        notice(`计划模式: ${state.active ? '开启' : '关闭'}${state.pending ? '（变更待生效）' : ''}`)
        return
      }
      if (arg !== 'on' && arg !== 'off') {
        notice(t('用法: /plan [on|off|status]'))
        return
      }
      const r = planMode.set(rec.handle.agent, arg === 'on')
      notice(`计划模式: ${arg === 'on' ? '开启' : '关闭'}（${r}）`)
    }

    /** /tasks [kill <id>] — job registry view / cancel one job. */
    const tasksCommand = (a: string | undefined) => {
      const rec = activeId === null ? undefined : sessions.get(activeId)
      if (!rec) {
        notice(t('无活跃会话'))
        return
      }
      const jobs = svc('jobs')
      if (jobs === undefined) {
        notice(t('jobs 服务未装配'))
        return
      }
      const arg = (a ?? '').trim()
      if (arg.startsWith('kill ')) {
        const id = arg.slice(5).trim()
        if (id === '') {
          notice(t('用法: /tasks kill <job-id>'))
          return
        }
        const r = jobs.kill(id, rec.handle.agent, 'user asked')
        notice(r === 'requested' ? `已请求取消 ${id}` : `${id} 已结束`)
        return
      }
      const list = jobs.list(rec.handle.agent)
      if (list.length === 0) {
        notice(t('（没有运行中的任务）'))
        return
      }
      const icon = (s: string): string => s === 'running' ? '⏳' : s === 'completed' ? '✓' : s === 'killed' ? '✗' : s === 'failed' ? '⚠' : '·'
      for (const j of list) {
        const elapsed = j.startedAt !== undefined ? ` · ${((Date.now() - j.startedAt) / 1000).toFixed(0)}s` : ''
        notice(`${icon(j.status)} ${j.id} ${j.label ?? ''}${elapsed}`)
      }
    }

    /** /skills [name] — skill catalog; picker → detail float (show_skill). */
    const skillsCommand = async (a: string | undefined) => {
      const rec = activeId === null ? undefined : sessions.get(activeId)
      if (!rec) {
        notice(t('无活跃会话'))
        return
      }
      const skills = svc('skills')
      if (skills === undefined) {
        notice(t('skills 服务未装配'))
        return
      }
      const arg = (a ?? '').trim()
      try {
        const showSkill = async (name: string) => {
          const def = await skills.get(name, { scope: rec.handle.agent })
          if (def === undefined) {
            notice(`未知技能 ${name}`)
            return
          }
          await luaCall('require("dsh_tui").show_skill(...)', [{
            name: def.name,
            description: def.description ?? '',
            whenToUse: def.whenToUse ?? '',
            content: def.content ?? '',
          }]).catch(() => {})
        }
        if (arg !== '') {
          await showSkill(arg)
          return
        }
        const list = await skills.list({ scope: rec.handle.agent })
        if (list.length === 0) {
          notice(t('（没有可用技能）'))
          return
        }
        const sel = await openPicker(t('技能（选择查看详情）'),
          list.map((s) => ({ label: `${s.name} — ${String(s.description ?? '').slice(0, 44)}`, value: s.name })))
        if (sel === null) return
        await showSkill(sel)
      } catch (err) {
        notice(`skills 失败: ${(err as Error).message}`)
      }
    }

    /** Enumerate the active session's subagent children (live + persisted).
     *  Preferred path: the official `subagents.listChildren` directory.
     *  Fallback: scan the live session store + sessionPersistence.list() for
     *  headers with parentSession === parentId and origin 'subagent'. */
    const listSubagentChildren = async (parentId: string): Promise<Array<{ id: string; label: string; running: boolean; mode: string | undefined }>> => {
      const subagentsSvc = svc('subagents')
      if (typeof subagentsSvc?.listChildren === 'function') {
        try {
          const entries = await subagentsSvc.listChildren(parentId)
          const children = entries.filter((e) => e?.kind === 'child').map((e) => ({
            id: e.id,
            label: e.label ?? e.id.slice(0, 8),
            running: e.activity === 'running',
            mode: e.mode,
          }))
          if (children.length > 0 || entries.some((e) => e?.kind === 'child')) return children
        } catch {}
      }
      const seen = new Set<string>()
      const children: Array<{ id: string; label: string; running: boolean; mode: string | undefined }> = []
      const add = (id: string, label: string | undefined, running: boolean, mode: string | undefined) => {
        if (seen.has(id)) return
        seen.add(id)
        children.push({ id, label: label ?? id.slice(0, 8), running, mode })
      }
      for (const s of runtimeCtx.sessions.list?.() ?? []) {
        if (s?.header?.parentSession === parentId && s.header.origin === 'subagent') {
          add(s.id, undefined, true, undefined)
        }
      }
      const persistence = svc('sessionPersistence')
      if (typeof persistence?.list === 'function') {
        try {
          for (const h of await persistence.list()) {
            if (h?.parentSession === parentId && h.origin === 'subagent') {
              add(h.id, undefined, false, undefined)
            }
          }
        } catch {}
      }
      return children
    }

    /** Open a read-only replay of one subagent's session log in a float. */
    const openSubagentView = async (childId: string, label: string) => {
      // Gather the event log: live children stream from the in-memory store
      // (new events keep arriving via session/event routing); settled children
      // are read from persistence without resuming or publishing an agent.
      const live = runtimeCtx.sessions.get(childId)
      let events: SessionEvent[] = []
      if (live) {
        events = [...(live.events ?? [])]
      } else {
        try {
          const persistence = svc('sessionPersistence')
          const inspection = await persistence?.inspect?.(childId)
          events = (inspection?.events ?? []) as SessionEvent[]
        } catch (err) {
          notice(`读取子代理会话失败: ${(err as Error).message}`)
          return
        }
      }
      if (events.length === 0) {
        notice(t('子代理会话无事件（可能尚未开始）'))
        return
      }
      const ids = await luaCall('return require("dsh_tui").open_subagent_view(...)', [label])
      if (!ids || !Number.isInteger(ids.buf) || !Number.isInteger(ids.win)) {
        notice(t('子代理视图打开失败（nvim 浮窗未创建）'))
        return
      }
      const feed = new FeedRenderer(nvim!, ids.buf, ids.win, {
        idsProvider: () => luaCall('return require("dsh_tui").subagent_view_ids()', []),
        activeChecker: () => true,
        // No separate reasoning panel: reasoning blocks render inline, dim.
        reasoningBuf: null,
        reasoningView: () => null,
        inlineReasoning: true,
      })
      subagentView = { childId, feed }
      for (const e of events) feed.applyEvent(e, { history: true })
      // Close the snapshot/live gap: events appended while the view opened.
      if (live) {
        const liveEvents = live.events ?? []
        for (let i = events.length; i < liveEvents.length; i++) {
          feed.applyEvent(liveEvents[i], { history: true })
        }
      }
      await feed.flush()
      if (!live) {
        // Settled replay: land on the FIRST thinking block — the window
        // otherwise opens scrolled to the transcript tail (the final answer),
        // which makes the thinking details look missing. Live views keep
        // tail-following the running stream.
        await luaCall('require("dsh_tui").subagent_view_goto_thinking()', []).catch(() => {})
      }
      notice(`子代理视图: ${label}（${events.length} 事件 · q/Esc 关闭${live ? ' · 实时跟随' : ''}）`)
    }

    /** /subagents — child-agent directory; pick one to view its thinking. */
    const subagentsCommand = async () => {
      const rec = activeId === null ? undefined : sessions.get(activeId)
      if (!rec || activeId === null) {
        notice(t('无活跃会话'))
        return
      }
      try {
        const children = await listSubagentChildren(activeId)
        if (children.length === 0) {
          notice(t('该会话没有子代理（workflow/subagent 运行后此处可回放其思考链）'))
          return
        }
        const sel = await openPicker(t('子代理（选择查看思考链）'), children.map((c) => ({
          label: `${c.label}${c.running ? ' · 运行中' : ' · 已结束'}`,
          value: c.id,
        })))
        if (sel === null) return
        const child = children.find((c) => c.id === sel)
        const action = child?.mode === 'continuable'
          ? await openPicker(t('子代理操作'), [
              { label: '查看思考链回放', value: 'view' },
              { label: '继续对话（下一条输入发给它）', value: 'continue' },
            ])
          : 'view'
        if (action === 'continue') {
          pendingSubagentFollowup = { childId: sel, label: child?.label ?? sel.slice(0, 8) }
          notice(`下一条输入将发给子代理 ${pendingSubagentFollowup.label}（/subagents 可取消，直接输入即发送）`)
          return
        }
        if (action === null) return
        await openSubagentView(sel, child?.label ?? sel.slice(0, 8))
      } catch (err) {
        notice(`subagents 失败: ${(err as Error).message}`)
      }
    }

    /** /plugins — read-only host loader inventory (official Plugins
     *  settings tab counterpart). */
    const pluginsCommand = (): void => {
      const inv = svc('pluginInventory')
      if (typeof inv?.list !== 'function') {
        notice(t('plugin-inventory 服务未装配（dsh-host-plugin-inventory）'))
        return
      }
      const entries = inv.list().entries ?? []
      if (entries.length === 0) {
        notice(t('（loader 没有插件条目）'))
        return
      }
      for (const e of entries) {
        notice(`${e.enabled ? '●' : '○'} ${e.entryId} · ${e.moduleName} · ${e.fiberPhase}`)
      }
    }

    /** /permission [name] — switch the session's permission preset (the
     *  official dsh-permission-presets service: sandbox mode + approval
     *  policy pair; the profile's patch must mount the `permission` row). */
    const permissionCommand = async (a: string | undefined) => {
      const rec = activeId === null ? undefined : sessions.get(activeId)
      if (!rec) {
        notice(t('无活跃会话'))
        return
      }
      const permission = svc('permissionPresets')
      if (permission === undefined || typeof permission.set !== 'function') {
        notice(t('permission-presets 服务未装配（profile patch 加入 dsh-permission-presets 行）'))
        return
      }
      try {
        const names = [...permission.names]
        if (!a) {
          const current = permission.current(rec.handle.agent.session.events)
          for (const name of names) {
            const opt = permission.optionOf(name)
            notice(`${name}${name === current ? ' ✓（当前）' : ''} · ${opt?.label ?? name}${opt?.description ? `) — ${opt.description}` : ''}`)
          }
          return
        }
        const name = String(a).trim()
        if (!names.includes(name)) {
          notice(`未知权限预设 ${name}（可用: ${names.join(' ')})`)
          return
        }
        const opt = permission.optionOf(name)
        const current = permission.current(rec.handle.agent.session.events)
        // Danger-full-access switch asks for an explicit confirmation first
        // (official client's modal acknowledgement counterpart).
        const danger = /full|danger/i.test(name) || /全|危险/.test(opt?.label ?? '')
        if (danger && name !== current) {
          const ok = await openPicker(t('危险权限确认'), [
            { label: '确认切换到全访问（危险操作需谨慎）', value: 'yes' },
            { label: '取消', value: 'no' },
          ])
          if (ok !== 'yes') {
            notice(t('已取消权限切换'))
            return
          }
        }
        permission.set(rec.handle.agent.session, name)
        notice(`权限预设: ${name}`)
        updateStatusline()
      } catch (err) {
        notice(`permission 失败: ${(err as Error).message}`)
      }
    }

    /** Directory picker promise (Lua navigable float → 'dsh-dir-selected'). */
    const openDirPicker = (startPath: string): Promise<string | null> => new Promise((resolve) => {
      dirSettle = resolve
      void luaCall('require("dsh_tui").show_dir_picker(...)', [startPath ?? process.cwd()])
        .catch(() => { dirSettle = null; resolve(null) })
    })

    /** Format an @-mention: quote paths containing whitespace. */
    const formatMention = (path: string): string => (/\s/.test(path) ? `@"${path}"` : `@${path}`)

    /** Local fs candidates (fallback when the fileReferences service is
     *  absent): immediate children of the query's dir matching its prefix. */
    const localFileCandidates = async (cwd: string, query: string): Promise<Array<{ path: string; mention: string }>> => {
      const q = (query ?? '').replace(/^["']/, '')
      const slash = q.lastIndexOf('/')
      const dirPart = slash >= 0 ? q.slice(0, slash + 1) : ''
      const namePart = slash >= 0 ? q.slice(slash + 1) : q
      const base = isAbsolute(q) ? '' : cwd
      const dirPath = join(base, dirPart || '.')
      const out = []
      try {
        for (const name of readdirSync(dirPath, { withFileTypes: true })) {
          if (namePart !== '' && !name.name.startsWith(namePart)) continue
          const rel = (dirPart + name.name + (name.isDirectory() ? '/' : ''))
          out.push({ path: rel, mention: formatMention(rel) })
        }
      } catch {}
      out.sort((x, y) => x.path < y.path ? -1 : 1)
      return out.slice(0, 50)
    }

    /** @-completion query from the input line (dsh-at-query notify).
     *  Files first, then @session references (the official client's unified
     *  `@file`/`@session` source, in the same deterministic order). */
    const atQuery = async (query: string): Promise<void> => {
      const rec = activeId === null ? undefined : sessions.get(activeId)
      const agent = rec?.handle.agent
      let items: Array<{ path: string; mention: string }> = []
      try {
        const fr = svc('fileReferences')
        if (typeof fr?.list === 'function' && agent) {
          const cands = await fr.list(agent, query, new AbortController().signal)
          items = (cands ?? []).map((c) => ({ path: c.path, mention: formatMention(c.path) }))
        } else {
          items = await localFileCandidates(process.cwd(), query)
        }
      } catch {}
      const sessionRef = svc('sessionReferenceResolver')
      if (agent !== undefined && typeof sessionRef?.listCandidates === 'function') {
        try {
          const cands = await sessionRef.listCandidates(agent, query, 8, new AbortController().signal)
          for (const c of cands) {
            // Canonical mention: @[label](dsh-session:<base64url(JSON id)>).
            const uri = 'dsh-session:' + Buffer.from(JSON.stringify(c.sessionId), 'utf8').toString('base64url')
            const label = (c.label ?? c.sessionId).replace(/[\[\]]/g, '\\$&')
            items.push({
              path: `💬 ${label}${c.cwd !== undefined && c.cwd !== '' ? ` · ${c.cwd}` : ''}`,
              mention: `@[${label}](${uri})`,
            })
          }
        } catch {}
      }
      await luaCall('require("dsh_tui").set_at_menu(...)', [items]).catch(() => {})
    }

    /** /attach [path] — image → durable attachment; file/dir → @-mention.
     *  Without an argument a directory picker selects the target. */
    const attachCommand = async (a: string | undefined) => {
      let path: string | null = (a ?? '').trim()
      if (path === '') {
        path = await openDirPicker(process.cwd())
        if (path === null) return
      }
      const abs = isAbsolute(path) ? path : join(process.cwd(), path)
      const media = sniffMediaType(abs as unknown as Uint8Array)
      if (media !== null) {
        const rec = activeId === null ? undefined : sessions.get(activeId)
        const attachments = svc('attachments')
        if (!rec || typeof attachments?.saveImage !== 'function') {
          notice(t('附件服务未装配'))
          return
        }
        try {
          const img = await readImageFile(abs, media)
          const ref = await attachments.saveImage(img)
          pendingImages.push({ type: 'image', attachment: ref })
          notice(`📎 图片已附加: ${imageLabel(ref)}（随下一条消息发送）`)
        } catch (err) {
          notice(`附件失败: ${(err as Error).message}`)
        }
        return
      }
      // Non-image: a path-only @-mention (the official file-reference way —
      // the model reads the file through its tools when needed).
      const rel = isAbsolute(path) ? path : path
      await luaCall('require("dsh_tui").append_input(...)', [formatMention(rel) + ' ']).catch(() => {})
      notice(`已引用: ${rel}（@ 路径会随消息发送，模型按需读取）`)
    }

    /** /deliverables — files this session's current turn produced (mutation
     *  tools' follow-along paths, derived from tool/call arguments). */
    const deliverablesCommand = async () => {
      const rec = activeId === null ? undefined : sessions.get(activeId)
      if (!rec) {
        notice(t('无活跃会话'))
        return
      }
      const paths = rec.deliverables?.paths ?? []
      if (paths.length === 0) {
        notice(t('本回合还没有产出文件（写/改文件的工具运行后会出现在这里）'))
        return
      }
      const sel = await openPicker(t('交付物（Enter 在 nvim 新标签页打开）'),
        paths.map((p) => ({ label: p, value: p })))
      if (sel === null) return
      await luaCall('require("dsh_tui").open_file_tab(...)', [sel]).catch(() => {})
    }

    /** /workflow — live registry view of workflow runs (phases, agents). */
    const workflowCommand = () => {
      if (workflowRuns.size === 0) {
        notice(t('没有工作流记录（workflow 工具运行后此处显示阶段树）'))
        return
      }
      const lines = []
      for (const run of workflowRuns.values()) {
        const elapsed = run.startedAt ? formatElapsed(Date.now() - run.startedAt) : '?'
        lines.push(`◈ ${run.name ?? run.id} · ${run.running ? `运行中 ${elapsed}` : `完成 ${run.stopReason ?? ''}`}`)
        for (const ph of run.phases) {
          lines.push(`  ─ ${ph.title}${ph.startedAt ? ` · ${formatElapsed(Date.now() - ph.startedAt)}` : ''}`)
        }
        for (const ag of run.agents) {
          lines.push(`    ◇ #${ag.seq} ${ag.label}${ag.outcome ? ` · ${ag.outcome}` : ''}`)
        }
        for (const msg of run.logs.slice(-6)) {
          lines.push(`    · ${String(msg).slice(0, 100)}`)
        }
      }
      void luaCall('require("dsh_tui").show_lines_float(...)', ['工作流运行', lines]).catch(() => {})
    }

    /** /settings [edit] — settings overview; `edit` opens settings.yaml in
     *  a new nvim tab (the official document is hot-reloaded). */
    const settingsCommand = async (a: string | undefined) => {
      const settings = svc('settings')
      if (settings === undefined) {
        notice(t('settings 服务未装配'))
        return
      }
      try {
        const setArg = (a ?? '').trim()
        if (setArg.startsWith('set ')) {
          // /settings set <ns> <key.path> <value> — the namespace is a
          // registered settings section (see the overview); typed value
          // (true/false, number, JSON, else string), nested path into the patch.
          const rest = setArg.slice(4).trim()
          const m = rest.match(/^(\S+)\s+(\S+)\s+([\s\S]+)$/)
          if (m === null) {
            notice(t('用法: /settings set <ns> <key.path> <value>（ns 见概览，如 agent-default-model）'))
            return
          }
          const ns = m[1]
          const path = m[2].split('.')
          const raw = m[3].trim()
          let value: unknown = raw
          if (raw === 'true') value = true
          else if (raw === 'false') value = false
          else if (raw === 'null') value = null
          else if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw)
          else { try { value = JSON.parse(raw) } catch {} }
          const patch: Record<string, unknown> = {}
          let node = patch
          for (let i = 0; i < path.length - 1; i++) {
            node = node[path[i]] = (node[path[i]] as Record<string, unknown> | undefined) ?? {}
          }
          node[path[path.length - 1]] = value
          try {
            if (typeof settings.update !== 'function') throw new Error('update 不可用')
            await settings.update(ns, patch)
            notice(`已更新设置 ${ns}.${m[2]} = ${JSON.stringify(value)}`)
          } catch (err) {
            notice(`设置更新失败: ${(err as Error).message}`)
          }
          return
        }
        if (setArg === 'edit') {
          const path = await settings.prepareDocument?.()
          if (typeof path !== 'string' || path === '') {
            notice(t('settings 文档不可编辑（非文件存储）'))
            return
          }
          await luaCall('require("dsh_tui").open_file_tab(...)', [path]).catch(() => {})
          notice(`已在 nvim 新标签页打开 settings 文档: ${path}（保存后热重载）`)
          return
        }
        // Official SettingsDescriptor shape: { ns, schema, value, revision,
        // base?, user?, applies, secrets? } — one descriptor per namespace.
        // The overview renders each namespace's resolved value (redacted,
        // pretty-printed) with user-overridden top-level keys starred.
        const desc = (settings.describe?.({ redactSecrets: true }) ?? []) as Array<{
          ns?: unknown; value?: unknown; user?: unknown; revision?: number; applies?: unknown
        }>
        const docPath = await settings.prepareDocument?.().catch(() => undefined)
        const lines = ['settings 文档: ' + (settings.documentPath ?? docPath ?? '（非文件）') + ' · 可写: ' + (settings.writable ? '是' : '否'), '']
        let total = 0
        for (const d of desc) {
          lines.push(`▸ ${String(d.ns ?? '(unnamed)')}${d.applies !== undefined ? ` · ${String(d.applies)}` : ''}${d.revision !== undefined ? ` · rev ${d.revision}` : ''}`)
          const userKeys = d.user !== null && typeof d.user === 'object' ? Object.keys(d.user as Record<string, unknown>) : []
          const valueText = JSON.stringify(d.value, null, 2) ?? String(d.value ?? '')
          for (const line of valueText.split('\n')) {
            if (total++ > 60) break
            const key = line.match(/^\s*"([^"]+)"/)?.[1]
            const starred = key !== undefined && userKeys.includes(key) ? '* ' : '  '
            lines.push(`${starred}${line}`)
          }
          if (total > 60) break
        }
        lines.push('', '常用修改: i/o 在此打开配置文件编辑（保存后热重载）；/settings set <key.path> <value> 即时写入；/model /effort /theme /permission 即时生效')
        void luaCall('require("dsh_tui").show_lines_float(...)', ['设置', lines, typeof docPath === 'string' ? docPath : null]).catch(() => {})
      } catch (err) {
        notice(`settings 失败: ${(err as Error).message}`)
      }
    }

    /** /trajectory — structured steps of the active session's last turn. */
    const trajectoryCommand = () => {
      const rec = activeId === null ? undefined : sessions.get(activeId)
      if (!rec) {
        notice(t('无活跃会话'))
        return
      }
      const events = rec.handle.agent.session.events
      const turnStart = [...events].reverse().find((e) => e.type === 'turn/start')
      if (turnStart === undefined) {
        notice(t('本会话还没有回合'))
        return
      }
      const turn = turnStart.data?.turn
      const lines = [`回合 #${turn ?? '?'} 步骤轨迹`, '']
      let step = 0
      let toolCount = 0
      for (const e of events) {
        const data = e.data as { turn?: number; step?: number; message?: ChatMessage; name?: string; arguments?: string; error?: unknown } | undefined
        if (e.type === 'turn/start') {
          step = data?.turn === turn ? (data?.step ?? 0) : step
          continue
        }
        if (data === undefined || data.turn !== turn) continue
        if (e.type === 'assistant/message') {
          const text = FeedRenderer.messageText(data.message).replace(/\s+/g, ' ').slice(0, 90)
          lines.push(`步骤 ${data.step ?? '?'} · ${text || '（无文本）'}`)
        } else if (e.type === 'tool/call') {
          lines.push(`  🔧 ${data.name}(${FeedRenderer.argsPreview(data.arguments)})`)
          toolCount++
        } else if (e.type === 'tool/result') {
          const err = data.error !== undefined && data.error !== null ? ' ✗' : ' ✓'
          lines.push(`    ${err}`)
        }
      }
      lines.push('', `工具调用 ${toolCount} 次`)
      void luaCall('require("dsh_tui").show_lines_float(...)', ['步骤轨迹', lines]).catch(() => {})
    }

    /** /sessions — session list float with full ids (no resident window). */
    /** /sessions — workspace-grouped session browser (official client's
     *  sidebar counterpart): workspace headers + their sessions, an ungrouped
     *  section, archived sessions hidden, Enter opens, workspace rows carry
     *  actions. */
    const sessionsCommand = async (): Promise<void> => {
      refreshList()
      const ws = svc('workspaces')
      const workspaceRows = typeof ws?.list === 'function' ? ws.list() : []
      const archived = new Set(ws?.archivedSessionIds ?? [])
      const rows: Array<{ label: string; value: string }> = [
        { label: '＋ 新建会话', value: 'act:new' },
      ]
      const inWs = new Set<string>()
      for (const w of workspaceRows) {
        rows.push({ label: `📁 ${w.title} · ${w.path}`, value: `ws:${w.id}` })
        for (const sid of w.sessionIds) {
          inWs.add(sid)
          if (archived.has(sid)) continue
          const rec = sessions.get(sid)
          const hist = historyHeaders.find((h) => h.id === sid)
          const title = rec?.title ?? hist?.title ?? ''
          rows.push({ label: `    ${sid === activeId ? '▸' : ' '} ${title || sid.slice(0, 8)} · ${sid}`, value: `sess:${sid}` })
        }
      }
      rows.push({ label: '未分组', value: 'ws:none' })
      for (const s of runtimeCtx.sessions.list()) {
        if (inWs.has(s.id) || archived.has(s.id) || s.header?.origin === 'subagent') continue
        const rec = sessions.get(s.id)
        rows.push({ label: `    ${s.id === activeId ? '▸' : ' '} ${rec?.title ?? ''} · ${s.id}`, value: `sess:${s.id}` })
      }
      for (const h of historyHeaders) {
        if (inWs.has(h.id) || archived.has(h.id) || sessions.has(h.id)) continue
        rows.push({ label: `    ${h.title ?? ''} · ${h.id}（历史）`, value: `sess:${h.id}` })
      }
      const sel = await openPicker(t('会话（工作区分组 · Enter 打开）'), rows)
      if (sel === null) return
      if (sel === 'act:new') {
        await createSession()
        return
      }
      if (sel.startsWith('sess:')) {
        await selectSession(sel.slice(5))
        return
      }
      if (sel.startsWith('ws:')) {
        const wid = sel.slice(3)
        const w = workspaceRows.find((x) => x.id === wid)
        if (w === undefined) return
        const act = await openPicker(`工作区 ${w.title}`, [
          { label: '新建会话于此工作区', value: 'new' },
          { label: '重命名工作区（下一条输入作为新名称）', value: 'rename' },
        ])
        if (act === 'new') {
          await createSession(w.path)
        } else if (act === 'rename') {
          pendingRename = { kind: 'workspace', id: wid }
          notice(`下一条输入将作为工作区「${w.title}」的新名称（/sessions 期间可继续操作）`)
        }
        return
      }
    }

    /** /workspace [add <目录> [标题] | delete <id>] — workspace management. */
    const workspaceCommand = async (a: string | undefined): Promise<void> => {
      const ws = svc('workspaces')
      if (ws === undefined || typeof ws.list !== 'function') {
        notice(t('workspaces 服务未装配（profile 加入 dsh-workspace 后可用）'))
        return
      }
      const arg = (a ?? '').trim()
      if (arg === '') {
        const list = ws.list()
        if (list.length === 0) {
          notice(t('（没有工作区，/workspace add <目录> [标题] 添加）'))
          return
        }
        for (const w of list) notice(`📁 ${w.title} · ${w.path} · ${w.sessionIds.length} 会话`)
        return
      }
      if (arg.startsWith('add ')) {
        const [path, ...rest] = arg.slice(4).trim().split(/\s+/)
        if (path === undefined || path === '') {
          notice(t('用法: /workspace add <目录> [标题]'))
          return
        }
        try {
          const title = rest.join(' ').trim() || undefined
          await ws.create?.(path, title)
          notice(`工作区已添加: ${title ?? path}`)
        } catch (err) {
          notice(`添加工作区失败: ${(err as Error).message}`)
        }
        return
      }
      if (arg.startsWith('delete ')) {
        const id = arg.slice(7).trim()
        try {
          const ok = await ws.delete?.(id)
          notice(ok === true ? `工作区已移除（其会话保留为未分组）: ${id}` : `未知工作区: ${id}`)
        } catch (err) {
          notice(`移除失败: ${(err as Error).message}`)
        }
        return
      }
      notice(t('用法: /workspace [add <目录> [标题] | delete <id>]'))
    }

    /** /archive [id] — hide a session from every list (non-destructive). */
    const archiveCommand = async (a: string | undefined): Promise<void> => {
      const ws = svc('workspaces')
      if (typeof ws?.archiveSession !== 'function') {
        notice(t('归档不可用（workspaces 服务未装配）'))
        return
      }
      const rec = activeId === null ? undefined : sessions.get(activeId)
      const target = (a ?? '').trim() || rec?.id
      if (target === undefined || target === '') {
        notice(t('用法: /archive [会话id]（无参数归档当前会话）'))
        return
      }
      try {
        await ws.archiveSession(target)
        notice(`已归档 ${target}（从各列表隐藏）`)
      } catch (err) {
        notice(`归档失败: ${(err as Error).message}`)
      }
    }

    /** /layout [default|panel] — window layout presets (bare cycles). */
    let layoutIdx = 0
    const layoutCommand = (a: string | undefined) => {
      const order = ['default', 'panel']
      let name = (a ?? '').trim()
      if (name === '') {
        layoutIdx = (layoutIdx + 1) % order.length
        name = order[layoutIdx]
      } else if (!order.includes(name)) {
        notice(`未知布局 ${name}（可用: ${order.join(' ')})`)
        return
      } else {
        layoutIdx = order.indexOf(name)
      }
      void luaCall('require("dsh_tui").apply_layout(...)', [name]).catch(() => {})
      notice(`布局: ${name}`)
    }

    /** /bell [on|off] — terminal bell on turn end (approvals always ring). */
    const bellCommand = (a: string | undefined) => {
      if ((a ?? '').trim() !== '') bellOn = String(a).trim() === 'on'
      else bellOn = !bellOn
      notice(`回合结束响铃: ${bellOn ? '开' : '关'}`)
    }

    /** /mcp — MCP tools grouped by server (prefix mcp__<server>__<tool>). */
    const mcpCommand = () => {
      const rec = activeId === null ? undefined : sessions.get(activeId)
      if (!rec) {
        notice(t('无活跃会话'))
        return
      }
      const tools = svc('tools')
      if (tools === undefined) {
        notice(t('tools 服务未装配'))
        return
      }
      const byServer = new Map()
      for (const s of tools.schemas(rec.handle.agent)) {
        if (!s.name.startsWith('mcp__')) continue
        const server = s.name.slice(5).split('__')[0]
        byServer.set(server, (byServer.get(server) ?? 0) + 1)
      }
      if (byServer.size === 0) {
        notice(t('（没有已连接的 MCP server）'))
        return
      }
      for (const [server, count] of byServer) notice(`🔌 ${server}: ${count} 个工具`)
    }

    /** /search <query> — cross-session full-text search → picker → resume. */
    const searchCommand = async (a: string | undefined) => {
      const query = (a ?? '').trim()
      if (query === '') {
        notice(t('用法: /search <关键词>（跨会话全文搜索）'))
        return
      }
      const sessionQuery = svc('sessionQuery')
      if (sessionQuery === undefined) {
        notice(t('session-query 服务未装配（profile 加入 dsh-session-query-sqlite 后可用）'))
        return
      }
      notice(`搜索中: ${query}…`)
      try {
        const page = await sessionQuery.searchSessions({
          query,
          eventFilters: [{ kind: 'type', values: ['user/message', 'assistant/message'] }],
          limit: 20,
        })
        const hits = page.items ?? []
        if (hits.length === 0) {
          notice(t('没有匹配的会话'))
          return
        }
        const sel = await openPicker(`搜索结果（${hits.length}）`,
          hits.map((h) => ({
            label: `${h.title ?? h.sessionId ?? h.id ?? '?'} · ${String(h.bestMatch?.snippet ?? '').slice(0, 48)}`,
            value: String(h.sessionId ?? h.id),
          })))
        if (sel !== null) await selectSession(sel)
      } catch (err) {
        notice(`搜索失败: ${(err as Error).message}`)
      }
    }

    /** /rename <title> — pin the active session's title. */
    const renameCommand = (a: string | undefined) => {
      const title = (a ?? '').trim()
      if (title === '') {
        notice(t('用法: /rename <新标题>'))
        return
      }
      const rec = activeId === null ? undefined : sessions.get(activeId)
      if (!rec) {
        notice(t('无活跃会话'))
        return
      }
      const sessionTitle = svc('sessionTitle')
      if (sessionTitle === undefined) {
        notice(t('session-title 服务未装配'))
        return
      }
      try {
        sessionTitle.rename(runtimeCtx.sessions.get(rec.id), title)
        notice(t('标题已更新'))
      } catch (err) {
        notice(`重命名失败: ${(err as Error).message}`)
      }
    }

    /** /fb up|down [note] — feedback on the last assistant message. */
    const feedbackCommand = async (a: string | undefined) => {
      const rec = activeId === null ? undefined : sessions.get(activeId)
      if (!rec) {
        notice(t('无活跃会话'))
        return
      }
      const feedback = svc('messageFeedback')
      if (feedback === undefined) {
        notice(t('message-feedback 服务未装配'))
        return
      }
      const [op, ...rest] = (a ?? '').trim().split(/\s+/)
      if (op !== 'up' && op !== 'down' && op !== 'clear') {
        notice(t('用法: /fb up|down [备注] | /fb clear'))
        return
      }
      if (rec.lastAssistantMessageId === null || rec.lastAssistantMessageId === undefined) {
        notice(t('本会话还没有助手消息可反馈'))
        return
      }
      try {
        if (op === 'clear') {
          const list = await feedback.list({ sessionId: rec.id })
          const item = list.ok ? list.value.items.find((i) => i.messageId === rec.lastAssistantMessageId) : undefined
          if (item !== undefined) await feedback.delete({ sessionId: rec.id, messageId: rec.lastAssistantMessageId, ifVersion: item.version })
          notice(t('已清除反馈'))
          return
        }
        const list = await feedback.list({ sessionId: rec.id })
        const item = list.ok ? list.value.items.find((i) => i.messageId === rec.lastAssistantMessageId) : undefined
        const note = rest.join(' ').trim() || undefined
        const r = await feedback.put({
          sessionId: rec.id,
          messageId: rec.lastAssistantMessageId,
          rating: op === 'up' ? 'positive' : 'negative',
          ...(note !== undefined ? { note } : {}),
          ifVersion: item?.version ?? null,
        })
        if (r.ok) notice(op === 'up' ? '👍 已反馈' : '👎 已反馈')
        else notice(`反馈失败: ${r.error?.code ?? 'unknown'}`)
      } catch (err) {
        notice(`反馈失败: ${(err as Error).message}`)
      }
    }

    /** /rewind — pick a user-message boundary, truncate the session after
     *  it, and rebuild the chat from the remaining events. */
    const rewindCommand = async (a: string | undefined) => {
      const rec = activeId === null ? undefined : sessions.get(activeId)
      if (!rec) {
        notice(t('无活跃会话'))
        return
      }
      const session = runtimeCtx.sessions.get(rec.id)
      if (session === undefined || typeof session.truncate !== 'function') {
        notice(t('会话截断不可用：宿主 dsh-session 不支持 truncate（可用 /fork 派生替代）'))
        return
      }
      const arg = (a ?? '').trim()
      const boundaries = []
      for (const e of session.events ?? []) {
        if (e.type === 'user/message') {
          const um = (e.data as { message?: ChatMessage } | ChatMessage | undefined)
          const umsg = (um as { message?: ChatMessage } | undefined)?.message ?? (um as ChatMessage | undefined)
          const text = Array.isArray(umsg?.content)
            ? umsg.content.filter((b): b is Extract<MessageContent, { type: 'text' }> => b?.type === 'text' && typeof (b as { text?: unknown }).text === 'string').map((b) => b.text).join(' ')
            : (umsg?.text ?? '')
          boundaries.push({ seq: e.seq, text: String(text).replace(/\s+/g, ' ').slice(0, 48) })
        }
      }
      if (boundaries.length === 0) {
        notice(t('（没有可回退的用户消息）'))
        return
      }
      const recent = boundaries.slice(-8)
      let target
      if (arg !== '' && /^\d+$/.test(arg)) {
        const n = Math.min(Number(arg), boundaries.length)
        target = boundaries[boundaries.length - n]
      } else {
        const sel = await openPicker(t('回退到哪条消息之后（截断其后内容）'),
          recent.map((b) => ({ label: `#${b.seq} ${b.text}`, value: String(b.seq) })))
        if (sel === null) return
        target = boundaries.find((b) => String(b.seq) === sel)
      }
      if (target === undefined) {
        notice(t('未找到目标边界'))
        return
      }
      try {
        const persistence = svc('sessionPersistence')
        if (persistence !== undefined && typeof persistence.truncateStored === 'function') {
          await persistence.truncateStored(rec.id, target.seq)
        }
        session.truncate(target.seq)
        // Rebuild the chat from the truncated events (the harness truncates
        // in place and emits no events).
        rec.feed.clear()
        for (const e of session.events ?? []) {
          foldEvent(rec, e)
          rec.feed.applyEvent(e, { history: true })
        }
        void rec.feed.flush()
        notice(`已回退到 #${target.seq}（其后内容已截断）`)
      } catch (err) {
        notice(`回退失败: ${(err as Error).message}`)
      }
    }

    const onInput = (text: string): void => {
      // Queue edit flow: the next submitted line REPLACES the queued message
      // (official client's per-row edit action).
      if (pendingQueueEdit !== null) {
        const target = pendingQueueEdit
        pendingQueueEdit = null
        const rec = activeId === null ? undefined : sessions.get(activeId)
        const inbox = rec?.handle.agent.inbox as InboxLike | undefined
        const text0 = text.trim()
        if (text0 === '' || typeof inbox?.replace !== 'function') {
          notice(t('已取消编辑（空输入或 inbox 不可用）'))
          return
        }
        try {
          const replaced = inbox.replace(target.messageId, createUserMessage({
            content: [{ type: 'text', text: text0 }],
            source: { kind: 'user' },
          }))
          notice(replaced === true ? '排队消息已更新' : '该消息已被处理，无法再编辑')
        } catch (err) {
          notice(`编辑排队消息失败: ${(err as Error).message}`)
        }
        return
      }
      // Row-action rename flow: the next submitted line IS the new name
      // (the terminal counterpart of the web's rename dialog).
      if (pendingRename !== null) {
        const target = pendingRename
        pendingRename = null
        const name = text.trim()
        if (name === '') { notice(t('已取消重命名（空输入）')); return }
        void (async () => {
          try {
            if (target.kind === 'workspace') {
              const ws = svc('workspaces')
              const ent = ws?.list?.().find((w) => w.id === target.id)
              if (ent?.setTitle === undefined) { notice(t('工作区重命名不可用（workspaces 服务未装配）')); return }
              await ent.setTitle(name)
              notice(`工作区已重命名: ${name}`)
            } else {
              const sessionTitle = svc('sessionTitle')
              if (sessionTitle === undefined) { notice(t('session-title 服务未装配')); return }
              sessionTitle.rename(runtimeCtx.sessions.get(target.id), name)
              notice(t('会话标题已更新'))
            }
          } catch (err) {
            notice(`重命名失败: ${(err as Error).message}`)
          }
        })()
        return
      }
      const trimmed = text.trim()
      if (trimmed) send(trimmed)
    }

    const currentModelLabel = () => {
      const sel = currentSelection()
      return `${sel.provider}/${sel.model}${sel.reasoningEffort ? ` (${sel.reasoningEffort})` : ''}`
    }

    const applyModelSelection = async (next: ModelRef['current']): Promise<void> => {
      const rec = activeId === null ? undefined : sessions.get(activeId)
      if (rec?.modelRef) rec.modelRef.current = next // hot for the active session
      if (rec) rec.model = next.model
      await runtimeCtx.agentDefaultModel.saveSelection(next) // persist default
      notice(`模型已切换: ${next.provider}/${next.model}${next.reasoningEffort ? ` (${next.reasoningEffort})` : ''}`)
      updateStatusline()
    }

    /** /model [provider/model]: picker without an argument, direct switch with. */
    const pickModel = async (arg: string | undefined): Promise<void> => {
      const sel = currentSelection()
      if (arg) {
        const [provider, model] = arg.includes('/') ? arg.split('/') : [sel.provider, arg]
        if (!model) {
          notice(`用法: /model [provider/model]`)
          return
        }
        try {
          await applyModelSelection({ provider, model, reasoningEffort: sel.reasoningEffort })
        } catch (err) {
          notice(`模型切换失败: ${(err as Error).message}`)
        }
        return
      }
      const items = [{ label: `${sel.provider}/${sel.model} · 当前`, value: JSON.stringify(sel), active: true }]
      const picked = await openPicker(t('选择模型'), items)
      if (picked === null) return
      try {
        await applyModelSelection(JSON.parse(picked))
      } catch (err) {
        notice(`模型切换失败: ${(err as Error).message}`)
      }
    }

    /** /fork [directive]: child session seeded with the active history;
     *  an optional directive is sent as its first message. */
    const forkSession = async (directive: string | undefined): Promise<string | undefined> => {
      if (activeId === null) {
        notice(t('没有活跃会话可分叉'))
        return
      }
      try {
        const child = runtimeCtx.sessions.fork(activeId)
        const selection = currentSelection()
        const modelRef = { current: selection, assembled: void 0 }
        const handle = await runtimeCtx.agents.create({
          sessionId: child.id,
          meta: { cwd: process.cwd(), parentSession: activeId, seedLength: (child.events ?? []).length },
          seed: child.events ?? [],
          agentOptions: { provider: selection.provider, model: selection.model },
          setup: (agentCtx) => { installModelSelection(agentCtx, modelRef as unknown as Parameters<typeof installModelSelection>[1]) },
        })
        const id = await attachSession(handle, modelRef)
        await switchTo(id)
        refreshList()
        notice(`已分叉到 ${id}（继承 ${(child.events ?? []).length} 条历史事件）`)
        if (directive && directive.trim()) send(directive.trim())
        return id
      } catch (err) {
        notice(`分叉失败: ${(err as Error).message}`)
        return undefined
      }
    }

    // -- glance segments (statusline visibility toggles) ---------------------
    const GLANCE_SEGMENTS = ['cache', 'context', 'tokens', 'cost', 'elapsed', 'total']
    const hiddenGlance = new Set<string>()

    // -- command helpers ------------------------------------------------------
    const arg = (line: string): string => {
      const m = line.match(/^\S+\s+(.*)$/)
      return m ? m[1].trim() : ''
    }

    /** /effort [off|high|max|auto] */
    const effortCommand = async (a: string | undefined) => {
      if (!a) {
        notice(`当前推理等级: ${currentSelection().reasoningEffort ?? 'auto（模型默认）'}`)
        return
      }
      if (!['off', 'high', 'max', 'auto'].includes(a)) {
        notice(t('用法: /effort [off|high|max|auto]'))
        return
      }
      const next = { ...currentSelection(), reasoningEffort: a === 'auto' ? undefined : a }
      try {
        await applyModelSelection(next)
      } catch (err) {
        notice(`切换失败: ${(err as Error).message}`)
      }
    }

    /** /preset [id] — agent presets (标准/PTC/极简/创造 + user roots).
     *  Mirrors the official `agentPresets.select` flow (dsh-host-apiproxy):
     *  a session's composition is fixed once any turn has run, so switching
     *  afterwards is a caller error (agent-preset-locked). On a blank
     *  session the switch must re-link the live agent (recompose) AND record
     *  `agent-preset/selected` in the session log — the log event alone does
     *  not move the running agent. */
    const presetCommand = async (a: string | undefined) => {
      const presets = svc('agentPresets')
      if (!presets?.list || typeof presets.recompose !== 'function') {
        notice(t('agent-presets 服务未装配（在 profile patch 中加入该行）'))
        return
      }
      try {
        if (!a) {
          for (const p of await presets.list()) notice(`${p.id} · ${p.name ?? ''}`)
          return
        }
        const rec = activeId === null ? undefined : sessions.get(activeId)
        const agent = rec?.handle.agent
        if (!agent) {
          notice(t('没有活动会话，无法切换预设'))
          return
        }
        // Official blank rule (sessionBlank in dsh-host-apiproxy): blank =
        // no `turn/start` event yet. Standalone events like /plan and /goal
        // keep a session blank; any started turn locks the preset, because
        // the history was produced under the old composition's tools.
        if (agent.session.events.some((e) => e.type === 'turn/start')) {
          notice(t('预设已锁定: 会话已开始，官方规则下预设只能在空白会话切换（请新开会话后再试）'))
          return
        }
        const applied = await presets.recompose(agent.ctx, a)
        agent.session.append('agent-preset/selected', { agentPreset: applied.id })
        notice(`已切换预设: ${applied.id}`)
      } catch (err) {
        notice(`preset 失败: ${(err as Error).message}`)
      }
    }

    /** /yolo [on|off] — approval policy ask/never. */
    const yoloCommand = (a: string | undefined) => {
      const rec = activeId === null ? undefined : sessions.get(activeId)
      if (!rec) return
      const policy = a === 'on' ? 'never' : a === 'off' ? 'ask' : rec.policy === 'never' ? 'ask' : 'never'
      try {
        rec.handle.agent.session.append('approval/policy', { policy })
        rec.policy = policy
        updateStatusline()
        notice(`审批策略: ${policy === 'never' ? 'never（全放行）' : 'ask（逐项询问）'}`)
      } catch (err) {
        notice(`yolo 失败: ${(err as Error).message}`)
      }
    }

    /** /density — compact tool cards (title line only). */
    const densityCommand = () => {
      const feed = activeFeed()
      if (!feed) return
      feed.dense = !feed.dense
      notice(`紧凑模式: ${feed.dense ? '开' : '关'}`)
    }

    /** /glance [segment…] — toggle statusline segments. */
    const glanceCommand = (a: string | undefined) => {
      if (!a) {
        const shown = GLANCE_SEGMENTS.filter((s) => !hiddenGlance.has(s))
        notice(`glance 段: ${shown.join(' ') || '（全部隐藏）'} · 用法: /glance <segment>`)
        return
      }
      const seg = GLANCE_SEGMENTS.find((s) => a.startsWith(s))
      if (!seg) {
        notice(`未知段 ${a}（可选: ${GLANCE_SEGMENTS.join(' ')})`)
        return
      }
      if (hiddenGlance.has(seg)) hiddenGlance.delete(seg)
      else hiddenGlance.add(seg)
      updateStatusline()
      notice(`glance ${seg}: ${hiddenGlance.has(seg) ? '隐藏' : '显示'}`)
    }

    /** /cost — accumulated usage + cost for the active session. */
    const costCommand = () => {
      const rec = activeId === null ? undefined : sessions.get(activeId)
      if (!rec?.usage) {
        notice(t('本会话暂无用量数据'))
        return
      }
      const u = rec.usage
      const billed = billedInput(u)
      const cost = rec.model ? estimateCost(rec.model, u) : undefined
      notice(`输入 ${formatTokens(u.input)} · 缓存读 ${formatTokens(u.cacheRead)} · 输出 ${formatTokens(u.output)}`)
      notice(`billed 输入 ${formatTokens(billed)} · 总计 ${formatTokens(billed + u.output)}` +
        (cost !== undefined ? ` · 预估 $${cost.toFixed(2)}` : ''))
    }

    /** /export — write the rendered transcript to a markdown file. */
    const exportCommand = async () => {
      const rec = activeId === null ? undefined : sessions.get(activeId)
      if (!rec) return
      try {
        const lines = await nvim!.request('nvim_buf_get_lines', [rec.feed.bufId, 0, -1, false])
        const path = join(process.cwd(), `dsh-export-${new Date().toISOString().replace(/[:.]/g, '-')}.md`)
        writeFileSync(path, `# ${rec.title ?? rec.id}\n\n` + lines.join('\n') + '\n')
        notice(`已导出: ${path}`)
      } catch (err) {
        notice(`导出失败: ${(err as Error).message}`)
      }
    }

    /** /config — current runtime summary. */
    const configCommand = () => {
      const sel = currentSelection()
      const rec = activeId === null ? undefined : sessions.get(activeId)
      notice(`模型 ${sel.provider}/${sel.model} · effort ${sel.reasoningEffort ?? 'auto'}`)
      notice(`权限 ${modeLabel(rec?.mode)} · 审批 ${rec?.policy ?? 'ask'} · 用户配置 ${config.loadUserConfig !== false ? '已加载' : '关闭'}`)
      notice(`主题覆盖 ${config.theme ? Object.keys(config.theme).length + ' 组' : '无（跟随 colorscheme）'}`)
    }

    /** /restart — respawn the dsh command and exit this process. */
    const restartCommand = () => {
      try {
        const next = spawn(process.argv[0], process.argv.slice(1), { stdio: 'inherit', detached: true })
        next.unref()
        notice(t('正在重启…'))
        setTimeout(() => void quit(0), 300)
      } catch (err) {
        notice(`重启失败: ${(err as Error).message}`)
      }
    }

    /** /remember <text> — append to .dsh/memory/global.md. */
    const rememberCommand = (a: string | undefined) => {
      if (!a) {
        notice(t('用法: /remember <text>'))
        return
      }
      try {
        const dir = join(process.cwd(), '.dsh', 'memory')
        mkdirSync(dir, { recursive: true })
        appendFileSync(join(dir, 'global.md'), `- ${a}\n`)
        notice(t('已写入 .dsh/memory/global.md'))
      } catch (err) {
        notice(`写入失败: ${(err as Error).message}`)
      }
    }

    /** /memory [delete <id>] — list / delete project memory files. */
    const memoryCommand = (a: string | undefined) => {
      const dir = join(process.cwd(), '.dsh', 'memory')
      const a0 = a ?? ''
      try {
        if (a0.startsWith('delete ')) {
          const target = a0.slice(7).trim()
          const file = join(dir, target.endsWith('.md') ? target : `${target}.md`)
          if (!existsSync(file)) {
            notice(`不存在: ${target}`)
            return
          }
          unlinkSync(file)
          notice(`已删除 ${target}`)
          return
        }
        if (!existsSync(dir)) {
          notice(t('（无项目记忆）用法: /remember <text> 写入'))
          return
        }
        for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
          notice(`- ${f}`)
        }
      } catch (err) {
        notice(`memory 失败: ${(err as Error).message}`)
      }
    }

    /** /doctor — terminal capability report. */
    const doctorCommand = async () => {
      let size = null
      try {
        size = await luaCall('return { vim.o.columns, vim.o.lines }', [])
      } catch {}
      notice(`TERM=${process.env.TERM ?? '?'} · TTY=${process.stdout.isTTY} · Node ${process.version}`)
      notice(`终端尺寸 ${size ? `)${size[0]}×${size[1]}` : '?'} · Unicode ✓ · truecolor ${process.env.COLORTERM === 'truecolor' ? '✓' : '按 TERM'}`)
      notice(t('诊断建议: 真彩异常时检查 COLORTERM；宽度异常检查 locale/字体'))
    }

    /** /theme [name] — built-in presets over the colorscheme. */
    const themeCommand = (a: string | undefined) => {
      const presets: Record<string, Record<string, unknown>> = {
        default: {},
        dim: { DshTuiReasoning: { italic: true }, DshTuiNotice: { italic: true } },
        vivid: { DshTuiUser: { bold: true }, DshTuiTool: { italic: true } },
        contrast: { DshTuiUser: { bold: true }, DshTuiTool: { bold: true }, DshTuiError: { bold: true } },
        mono: { DshTuiUser: { underline: true }, DshTuiTool: { underline: true }, DshTuiReasoning: { underline: true } },
      }
      const name = a || 'default'
      const theme = presets[name]
      if (!theme) {
        notice(`未知主题 ${name}（可用: ${Object.keys(presets).join(' ')})`)
        return
      }
      void luaCall('require("dsh_tui").apply_theme(...)', [theme]).catch(() => {})
      notice(`主题: ${name}`)
    }

    /** /queue — pending-message queue (official QueueDock counterpart):
     *  view queued turns and next-step input, edit / remove rows, clear all. */
    const queueCommand = async (): Promise<void> => {
      const rec = activeId === null ? undefined : sessions.get(activeId)
      if (!rec) {
        notice(t('无活跃会话'))
        return
      }
      const inbox = rec.handle.agent.inbox as InboxLike | undefined
      const nextTurn = (inbox?.nextTurn ?? []) as unknown[]
      const nextStep = (inbox?.nextStep ?? []) as unknown[]
      if (nextTurn.length === 0 && nextStep.length === 0) {
        notice(t('（没有排队中的消息）'))
        return
      }
      interface QueueRow { label: string; value: string }
      const rows: QueueRow[] = []
      const add = (list: 'nextTurn' | 'nextStep', msgs: unknown[], prefix: string) => {
        for (const m of msgs) {
          const id = (m as { id?: string }).id
          const text = FeedRenderer.messageText(m as ChatMessage)
          rows.push({
            label: `${prefix}${FeedRenderer.truncate(text.replace(/\s+/g, ' '), 60)}`,
            value: JSON.stringify({ list, id: String(id ?? '') }),
          })
        }
      }
      if (nextTurn.length > 0) rows.push({ label: `── 排队回合 ${nextTurn.length} 条`, value: 'none' })
      add('nextTurn', nextTurn, '  ')
      if (nextStep.length > 0) rows.push({ label: `── 下一步输入 ${nextStep.length} 条`, value: 'none' })
      add('nextStep', nextStep, '  ')
      rows.push({ label: '🗑 清空全部排队', value: 'clear' })
      const sel = await openPicker(t('消息队列'), rows)
      if (sel === null || sel === 'none') return
      if (sel === 'clear') {
        if (typeof inbox?.clear !== 'function') { notice(t('inbox 不可用')); return }
        try { inbox.clear(); notice(t('已清空排队消息')) } catch (err) { notice(`清空失败: ${(err as Error).message}`) }
        return
      }
      let picked: { list: 'nextTurn' | 'nextStep'; id: string } | undefined
      try { picked = JSON.parse(sel) as { list: 'nextTurn' | 'nextStep'; id: string } } catch {}
      if (picked === undefined) return
      const act = await openPicker(t('队列操作'), [
        { label: '删除该条', value: 'del' },
        { label: '编辑该条（下一条输入作为新内容）', value: 'edit' },
      ])
      if (act === 'del') {
        if (typeof inbox?.remove !== 'function') { notice(t('inbox 不可用')); return }
        try {
          const ok = inbox.remove(picked.id)
          notice(ok === true ? '已从队列移除' : '该消息已被处理')
        } catch (err) { notice(`移除失败: ${(err as Error).message}`) }
      } else if (act === 'edit') {
        pendingQueueEdit = { list: picked.list, messageId: picked.id }
        notice(t('下一条输入将替换该排队消息'))
      }
    }

    /** /models — provider/model catalog + current selection (official
     *  model-selection settings counterpart). */
    const modelsCommand = (): void => {
      const sel = currentSelection()
      notice(`当前模型: ${sel.provider}/${sel.model}${sel.reasoningEffort ? ` ◎${sel.reasoningEffort}` : ''}`)
      const llm = runtimeCtx.get('llm') as LlmService | undefined
      if (llm === undefined) {
        notice(t('（llm 服务未装配）'))
        return
      }
      try {
        const live = llm.listProviders?.() ?? []
        const configurable = llm.listConfigurableProviders?.() ?? []
        if (live.length === 0 && configurable.length === 0) {
          notice(t('（没有已注册的 provider；用 /settings 查看模型配置）'))
          return
        }
        for (const p of live) notice(`● ${String(p.id ?? p.provider ?? '?')} · ${String(p.name ?? '')}`)
        for (const p of configurable) {
          if (live.some((l) => String(l.id ?? l.provider) === String(p.provider))) continue
          notice(`○ ${String(p.provider ?? '?')} · ${String(p.displayName ?? '')} · 配置段 ${String(p.settingsNs ?? '?')}`)
        }
      } catch (err) {
        notice(`models 失败: ${(err as Error).message}`)
      }
    }

    /** /context — context composition breakdown (official client's
     *  occupancy ring panel counterpart): ~used/capacity, heuristic
     *  composition rows, claim window. */
    const contextCommand = async (): Promise<void> => {
      const rec = activeId === null ? undefined : sessions.get(activeId)
      if (!rec) {
        notice(t('无活跃会话'))
        return
      }
      const projections = svc('sessionProjections')
      if (typeof projections?.stateOf === 'function') {
        try {
          const b = projections.stateOf(rec.handle.agent.session, 'contextBreakdown') as {
            systemTokens?: number; toolsTokens?: number; messageTokens?: number
            claim?: { start?: number; end?: number; tokens?: number }
          } | undefined
          if (b !== undefined) {
            const used = (b.systemTokens ?? 0) + (b.toolsTokens ?? 0) + (b.messageTokens ?? 0)
            const cap = rec.contextWindow
            notice(`上下文占用 ≈${formatTokens(used)}${cap !== undefined ? `) / ${formatTokens(cap)} · ${Math.round((used / cap) * 100)}%` : ''}`)
            notice(`  system ${formatTokens(b.systemTokens ?? 0)} · tools ${formatTokens(b.toolsTokens ?? 0)} · messages ${formatTokens(b.messageTokens ?? 0)}`)
            if (b.claim !== undefined) {
              notice(`  claim ${formatTokens(b.claim.tokens ?? 0)} tokens（seq ${b.claim.start ?? '?'}–${b.claim.end ?? '?'}）`)
            }
            return
          }
        } catch {}
      }
      const usage = rec.lastUsage ?? rec.usage
      notice(`上下文占用（按事件折叠）: ${usage !== undefined ? `)◧ ${formatTokens(billedInput(usage))}${rec.contextWindow !== undefined ? `/${formatTokens(rec.contextWindow)}` : ''}` : '暂无数据'}`)
    }

    /** /locale [zh|en] — switch runner UI language (official client's
     *  locale preference; Lua-side hints stay Chinese for now). */
    const localeCommand = (a: string | undefined): void => {
      const want = (a ?? '').trim()
      if (want === '') {
        notice(`语言: ${locale() === 'en' ? 'en' : 'zh'}（/locale zh|en 切换）`)
        return
      }
      if (want !== 'zh' && want !== 'en') {
        notice('用法: /locale zh|en')
        return
      }
      setLocale(want)
      refreshList()
      void refreshCommandCatalog()
      updateStatusline()
      notice(`语言已切换: ${want}`)
    }

    /** /status — active session snapshot. */
    const statusCommand = () => {
      const rec = activeId === null ? undefined : sessions.get(activeId)
      if (!rec) {
        notice(t('无活跃会话'))
        return
      }
      notice(`${rec.id} · ${rec.title ?? '（无标题）'} · ${rec.status ?? '○ idle'}`)
      notice(`模型 ${rec.model ?? '?'} · 权限 ${modeLabel(rec.mode)} · 审批 ${rec.policy ?? 'ask'}`)
    }

    // Full command registry (tianshu command surface + our additions).
    // Single source of truth: the dispatch table, the grouped /help output
    // and the completion-menu catalog sent to nvim all derive from here.
    //   name  — command token          desc  — completion-menu description
    //   usage — argument hint (/help)  group — /help grouping
    interface CommandSpec {
      name: string
      desc: string
      usage?: string
      group?: string
      fn: (arg: string | undefined) => void
    }
    const commandSpecs: CommandSpec[] = [
      { name: '/exit', desc: t('退出 dsh'), usage: t('退出'), group: t('系统'), fn: () => void quit(0) },
      { name: '/quit', desc: t('退出（/exit 别名）'), usage: t(''), group: t('系统'), fn: () => void quit(0) },
      { name: '/restart', desc: t('重启 dsh 进程'), usage: t('重启'), group: t('系统'), fn: () => restartCommand() },
      { name: '/help', desc: t('分组列出全部命令'), usage: t(''), group: t('系统'), fn: () => void helpCommand() },
      { name: '/sessions', desc: t('会话浏览器（工作区分组）'), usage: t('会话列表'), group: t('系统'), fn: () => void sessionsCommand() },
      { name: '/workspace', desc: t('工作区管理'), usage: t('[add <目录> [标题] | delete <id>]'), group: t('会话'), fn: (a) => void workspaceCommand(a) },
      { name: '/archive', desc: t('归档会话（从列表隐藏）'), usage: t('[会话id]'), group: t('会话'), fn: (a) => void archiveCommand(a) },
      { name: '/panel', desc: t('展开/收起活动面板'), usage: t('活动面板'), group: t('系统'), fn: () => void luaCall('require("dsh_tui").toggle_reasoning()', []).catch(() => {}) },
      { name: '/new', desc: t('新建会话（可带目录）'), usage: t('[目录]'), group: t('会话'), fn: (a) => void createSession((a ?? '').trim() || undefined) },
      { name: '/clear', desc: t('清空当前会话屏幕'), usage: t(''), group: t('会话'), fn: () => activeFeed()?.clear() },
      { name: '/fork', desc: t('分叉当前会话'), usage: t('[directive]'), group: t('会话'), fn: (a) => void forkSession(a) },
      { name: '/branch', desc: t('分叉（/fork 别名）'), usage: t(''), group: t('会话'), fn: (a) => void forkSession(a) },
      { name: '/btw', desc: t('侧问：分叉新会话并发送问题'), usage: t('<问题>'), group: t('会话'), fn: (a) => {
        if (!a) {
          notice(t('用法: /btw <question>（分叉新会话并发送该问题）'))
          return
        }
        void forkSession(a)
      } },
      { name: '/stop', desc: t('停止当前回合'), usage: t(''), group: t('会话'), fn: () => stopCommand() },
      { name: '/steer', desc: t('注入引导指令'), usage: t('<directive>'), group: t('会话'), fn: (a) => steerCommand(a) },
      { name: '/model', desc: t('选择/切换模型'), usage: t('[provider/model]'), group: t('模型'), fn: (a) => void pickModel(a) },
      { name: '/effort', desc: t('推理等级'), usage: t('off|high|max|auto'), group: t('模型'), fn: (a) => effortCommand(a) },
      { name: '/preset', desc: t('agent 预设（仅空白会话可切换）'), usage: t('[id]'), group: t('模型'), fn: (a) => presetCommand(a) },
      { name: '/yolo', desc: t('审批策略开关'), usage: t('on|off'), group: t('审批'), fn: (a) => yoloCommand(a) },
      { name: '/density', desc: t('紧凑卡片模式'), usage: t('紧凑卡片'), group: t('显示'), fn: () => densityCommand() },
      { name: '/glance', desc: t('状态栏段显隐'), usage: t('<cache|context|tokens|cost|elapsed|total>'), group: t('显示'), fn: (a) => glanceCommand(a) },
      { name: '/theme', desc: t('内置主题预设'), usage: t('default|dim|vivid|contrast|mono'), group: t('显示'), fn: (a) => themeCommand(a) },
      { name: '/cost', desc: t('用量与成本'), usage: t('用量成本'), group: t('信息'), fn: () => costCommand() },
      { name: '/export', desc: t('导出转录 md'), usage: t('导出转录'), group: t('信息'), fn: () => void exportCommand() },
      { name: '/config', desc: t('配置摘要'), usage: t('配置'), group: t('信息'), fn: () => configCommand() },
      { name: '/status', desc: t('会话快照'), usage: t('会话快照'), group: t('信息'), fn: () => statusCommand() },
      { name: '/context', desc: t('上下文组成分解'), usage: t('上下文组成'), group: t('信息'), fn: () => void contextCommand() },
      { name: '/queue', desc: t('消息队列（编辑/删除/清空）'), usage: t('消息队列'), group: t('会话'), fn: () => void queueCommand() },
      { name: '/models', desc: t('模型/供应商目录'), usage: t('模型目录'), group: t('模型'), fn: () => modelsCommand() },
      { name: '/doctor', desc: t('终端诊断'), usage: t('终端诊断'), group: t('信息'), fn: () => void doctorCommand() },
      { name: '/remember', desc: t('写入项目记忆'), usage: t('<text>'), group: t('记忆'), fn: (a) => rememberCommand(a) },
      { name: '/memory', desc: t('浏览/删除项目记忆'), usage: t('[delete <id>]'), group: t('记忆'), fn: (a) => memoryCommand(a) },
      { name: '/image', desc: t('发送图片附件（识图）'), usage: t('<路径> [提示]'), group: t('会话'), fn: (a) => imageCommand(a) },
      { name: '/compact', desc: t('压缩上下文'), usage: t(''), group: t('会话'), fn: () => void compactCommand() },
      { name: '/goal', desc: t('查看/管理目标'), usage: t('[new <目标>|pause|resume|complete|clear]'), group: t('会话'), fn: (a) => goalCommand(a) },
      { name: '/plan', desc: t('计划模式开关'), usage: t('[on|off|status]'), group: t('会话'), fn: (a) => planCommand(a) },
      { name: '/rewind', desc: t('回退到某条消息'), usage: t('[第N条]'), group: t('会话'), fn: (a) => void rewindCommand(a) },
      { name: '/rename', desc: t('重命名会话'), usage: t('<新标题>'), group: t('会话'), fn: (a) => renameCommand(a) },
      { name: '/search', desc: t('跨会话全文搜索'), usage: t('<关键词>'), group: t('会话'), fn: (a) => void searchCommand(a) },
      { name: '/tasks', desc: t('任务列表/取消'), usage: t('[kill <job-id>]'), group: t('会话'), fn: (a) => tasksCommand(a) },
      { name: '/skills', desc: t('技能浏览'), usage: t('[技能名]'), group: t('会话'), fn: (a) => void skillsCommand(a) },
      { name: '/mcp', desc: t('MCP server 工具统计'), usage: t(''), group: t('信息'), fn: () => mcpCommand() },
      { name: '/plugins', desc: t('宿主插件清单（只读）'), usage: t('插件清单'), group: t('信息'), fn: () => pluginsCommand() },
      { name: '/locale', desc: t('语言 (zh/en)'), usage: '[zh|en]', group: t('系统'), fn: (a) => localeCommand(a) },
      { name: '/fb', desc: t('反馈最后一条回答'), usage: t('up|down [备注]'), group: t('会话'), fn: (a) => void feedbackCommand(a) },
      { name: '/subagents', desc: t('子代理目录（回放/续聊思考链）'), usage: t(''), group: t('会话'), fn: () => subagentsCommand() },
      { name: '/workflow', desc: t('工作流运行视图（阶段树）'), usage: t(''), group: t('会话'), fn: () => workflowCommand() },
      { name: '/permission', desc: t('权限预设（沙箱+审批组合）'), usage: t('[name]'), group: t('审批'), fn: (a) => permissionCommand(a) },
      { name: '/attach', desc: t('附加文件/目录（图片为附件，其余为 @ 引用）'), usage: t('[路径]'), group: t('会话'), fn: (a) => attachCommand(a) },
      { name: '/deliverables', desc: t('本回合交付物（打开产物文件）'), usage: t(''), group: t('信息'), fn: () => deliverablesCommand() },
      { name: '/settings', desc: t('设置总览/编辑'), usage: t('[edit]'), group: t('系统'), fn: (a) => settingsCommand(a) },
      { name: '/trajectory', desc: t('回合步骤轨迹'), usage: t(''), group: t('信息'), fn: () => trajectoryCommand() },
      { name: '/layout', desc: t('布局预设'), usage: t('default|panel'), group: t('显示'), fn: (a) => layoutCommand(a) },
      { name: '/bell', desc: t('回合结束响铃开关'), usage: t('[on|off]'), group: t('系统'), fn: (a) => bellCommand(a) },
    ]
    const commands = Object.fromEntries(commandSpecs.map((s) => [s.name, s.fn]))

    /** Completion-menu catalog for nvim: name + description per command. */
    const commandCatalog = () => commandSpecs.map(({ name, desc }) => ({ name, desc }))

    /** Refresh the `/` completion catalog: built-in commands plus skill
     *  entries (the official client's slash trigger merges command and skill
     *  sources; `/skills:<name>` shows the skill detail float). */
    const refreshCommandCatalog = async (): Promise<void> => {
      const entries = commandSpecs.map(({ name, desc }) => ({ name, desc }))
      const rec = activeId === null ? undefined : sessions.get(activeId)
      const skills = svc('skills')
      if (rec !== undefined && skills !== undefined) {
        try {
          const list = await skills.list({ scope: rec.handle.agent })
          for (const sk of list) {
            entries.push({ name: `/skills:${sk.name}`, desc: String(sk.description ?? '').slice(0, 40) })
          }
        } catch {}
      }
      await luaCall('require("dsh_tui").set_commands(...)', [entries]).catch(() => {})
    }

    const helpCommand = () => {
      const groups = new Map()
      for (const s of commandSpecs) {
        const list = groups.get(s.group) ?? []
        list.push(s.usage ? `${s.name} ${s.usage}` : s.name)
        groups.set(s.group, list)
      }
      for (const [group, entries] of groups) notice(`${group}: ${entries.join(' · ')}`)
    }

    const onCommand = (line: string): void => {
      if (line.startsWith('/skills:')) {
        void skillsCommand(line.slice('/skills:'.length).trim())
        return
      }
      const m = line.match(/^(\S+)(?:\s+(.*))?$/)
      const name = m?.[1] ?? ''
      const rest = m?.[2] ?? ''
      const fn = commands[name]
      if (fn) fn(rest)
      else notice(`未知命令 ${name || line}（/help 查看可用命令）`)
    }

    void (async () => {
      const spawned = await spawnNvim({
        extraArgs: headless ? ['--headless'] : [],
        isolateXdg: headless, // sandbox/CI: private XDG dirs for the child
        loadUserConfig: config.loadUserConfig !== false &&
          process.env.DSH_NVIM_TUI_LOAD_USER_CONFIG !== '0',
        onExit: () => {
          // A child exit we initiated (teardown/:qa!) must not re-trigger
          // quit(); only a spontaneous nvim death closes the UI.
          if (!disposed) void quit(0)
        },
      })
      child = spawned.child

      // nvim now owns the terminal; keep our own process silent so DSH
      // logging cannot corrupt the TUI.
      const silent = () => {}
      console.log = silent
      console.warn = silent
      console.error = silent

      nvim = await connectNvim(spawned.sockPath)
      const channelId = await nvim.channelId
      channelIdValue = channelId
      await luaCall('require("dsh_tui").attach(...)', [channelId])
      // Slash-command catalog for the completion menu (name + description);
      // nvim shows it as soon as the input starts with '/'.
      await luaCall('require("dsh_tui").set_commands(...)', [commandCatalog()]).catch(() => {})
      void refreshCommandCatalog()
      // Theme overrides from the runner config (profile cordis.patch.yml).
      if (config.theme !== undefined && config.theme !== null && typeof config.theme === 'object') {
        await luaCall('require("dsh_tui").apply_theme(...)', [config.theme]).catch(() => {})
      }

      nvim!.on('disconnect', () => void quit(0))
      nvim!.on('notification', async (method, args) => {
        if (disposed) return
        if (method === 'dsh-input') {
          try { onInput(String(args?.[0] ?? '')) } catch (err) { notice(`⚠ 输入处理失败: ${(err as Error).message}`) }
        } else if (method === 'dsh-command') {
          try { onCommand(String(args?.[0] ?? '')) } catch (err) { notice(`⚠ 命令失败: ${(err as Error).message}`) }
        }
        else if (method === 'dsh-session-select') void guard('切换会话', selectSession)(String(args?.[0] ?? ''))
        else if (method === 'dsh-session-new') void guard('新建会话', createSession)()
        else if (method === 'dsh-reasoning-toggled') {
          reasoningOpen = args?.[0] === true
          if (reasoningOpen) {
            const ids = await luaCall('return require("dsh_tui").ids()', []).catch(() => null)
            reasoningWinId = ids?.reasoningWin ?? null
          }
        }
        else if (method === 'dsh-approval-decided') {
          const outcome = String(args?.[0] ?? 'n') === 'y' ? 'allowed-once' : 'rejected'
          approvalSettle?.(outcome)
          approvalSettle = null
        }
        else if (method === 'dsh-questions-answered') {
          const answers = args?.[0] ?? []
          questionsResolve?.resolve({ answers })
          questionsResolve = null
        }
        else if (method === 'dsh-questions-cancelled') {
          const reject = questionsResolve
          questionsResolve = null
          reject?.reject(new Error('cancelled by user'))
        }
        else if (method === 'dsh-picker-selected') {
          pickerSettle?.(args?.[0])
          pickerSettle = null
        }
        else if (method === 'dsh-picker-cancelled') {
          pickerSettle?.(null)
          pickerSettle = null
        }
        else if (method === 'dsh-subagent-view-closed') {
          subagentView = null
        }
        else if (method === 'dsh-dir-selected') {
          const picked = args?.[0]
          dirSettle?.(picked ?? null)
          dirSettle = null
        }
        else if (method === 'dsh-at-query') {
          const query = args?.[0]?.query ?? ''
          void guard('文件引用补全', atQuery)(String(query))
        }
        else if (method === 'dsh-quit') void quit(0)
        else if (method === 'dsh-paste-image') pasteClipboardImage()
      })

      // Session elapsed / stats tick slowly while idle (the spinner interval
      // already covers the running state at 180ms).
      idleRefreshTimer = setInterval(() => {
        if (!disposed) updateStatusline()
      }, 30000)

      // Event dispatch: each session's transcript goes to its own feed.
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
      feedDisposer = runtimeCtx.on('session/event', (owner, event) => {
        if (disposed) return
        // Open subagent transcript view: route the child's live events into
        // its read-only feed (reasoning/text/tools keep streaming in place).
        if (subagentView !== null && owner.id === subagentView.childId) {
          subagentView.feed.applyEvent(event)
          return
        }
        const rec = sessions.get(owner.id)
        if (!rec) return
        // Deliverables: files the current turn produced, derived from
        // mutation tools' follow-along args (official client uses the tools'
        // render-intent locations; the tool/result payload does not carry
        // them, so this is a name+args heuristic over the same set).
        if (event.type === 'turn/start') {
          rec.deliverables = { turn: event.data?.turn, paths: [] }
        } else if (event.type === 'tool/call' && event.data?.name !== undefined) {
          const p = producedPathFromCall(event.data.name, event.data.arguments)
          if (p !== null && !(rec.deliverables?.paths ?? []).includes(p)) {
            rec.deliverables = rec.deliverables ?? { turn: undefined, paths: [] }
            rec.deliverables.paths.push(p)
          }
        }
        // Turn finished on the ACTIVE session → terminal bell (toggle /bell).
        if (event.type === 'turn/end' && owner.id === activeId && bellOn) {
          void luaCall('require("dsh_tui").bell()', []).catch(() => {})
        }
        if (event.type === 'session/title' && typeof event.data?.title === 'string') {
          rec.title = event.data.title
          refreshList()
          if (owner.id === activeId) {
            updateStatusline()
            updateTitle()
          }
          return
        }
        // A user message that still carries an image block means it bypassed
        // the vision bridge (or predates it) — it permanently poisons the
        // session history: every later turn re-sends it and the text-only
        // adapter rejects the whole request. Warn once and point at /rewind.
        if (event.type === 'user/message' &&
          Array.isArray(event.data?.message?.content) &&
          event.data.message.content.some((b: MessageContent) => b?.type === 'image')) {
          if (!rec.imagePoisonWarned) {
            rec.imagePoisonWarned = true
            if (owner.id === activeId) {
              notice(t('⚠ 检测到未走识图桥的带图消息（历史污染：后续每轮都会失败）。用 /rewind 回退到该消息之前即可修复'))
            }
          }
        }
        // Track the last assistant message id (message feedback target) and
        // fold plan/goal state for the statusline.
        if (event.type === 'assistant/message' && typeof event.data?.message?.id === 'string') {
          rec.lastAssistantMessageId = event.data.message.id
        } else if (event.type === 'plan/mode') {
          rec.planActive = event.data?.active === true
          if (owner.id === activeId) {
            updateStatusline()
            notice(`计划模式已${rec.planActive ? '开启' : '关闭'}`)
          }
        } else if (event.type === 'goal/change') {
          rec.goal = (event.data?.goal as GoalState | undefined) ?? null
          if (owner.id === activeId) updateStatusline()
        }
        foldEvent(rec, event)
        rec.feed.applyEvent(event)
        // Headless e2e: first completed turn of the initial session ends the test.
        if (headless && event.type === 'turn/end' && owner.id === activeId) {
          rec.feed.commitTail()
          void rec.feed.flush().then(() => dumpAndQuit())
        }
      })

      // Host events: agent lifecycle status → statusline, subagent/workflow
      // cards → the owning session's feed.
      hostDisposers.push(runtimeCtx.on('agent/status', (payload) => {
        if (disposed) return
        const { agent, status } = payload ?? {}
        const rec = sessions.get(agent?.session?.id)
        if (!rec) return
        if (status === 'running') {
          rec.status = '● running'
          rec.runningSince = Date.now()
        } else {
          rec.status = '○ idle'
          rec.runningSince = null
        }
        if (rec.id === activeId) {
          ensureSpinner()
          updateStatusline()
        }
      }))
      hostDisposers.push(runtimeCtx.on('subagent/start', (info) => {
        if (disposed) return
        feedForSubagent(info)?.feed.subagentStart(info)
      }))
      hostDisposers.push(runtimeCtx.on('subagent/end', (info) => {
        if (disposed) return
        feedForSubagent(info)?.feed.subagentEnd(info)
      }))
      hostDisposers.push(runtimeCtx.on('workflow/start', (info) => {
        if (disposed) return
        const runId = info?.id ?? '?'
        const run = workflowRuns.get(runId) ?? { id: runId, name: info?.meta?.name ?? runId, startedAt: Date.now(), phases: [], agents: [], logs: [], running: true, stopReason: undefined }
        run.startedAt = Date.now()
        run.running = true
        workflowRuns.set(runId, run)
        activeFeed()?.workflowStart(info)
      }))
      hostDisposers.push(runtimeCtx.on('workflow/phase', (info, title) => {
        if (disposed) return
        const run = workflowRuns.get(info?.id)
        if (run) {
          run.phases.push({ title, startedAt: Date.now() })
        }
        activeFeed()?.workflowPhase(info, title)
      }))
      hostDisposers.push(runtimeCtx.on('workflow/log', (info, message) => {
        if (disposed) return
        const run = workflowRuns.get(info?.id)
        if (run) run.logs.push(message)
      }))
      hostDisposers.push(runtimeCtx.on('workflow/agent-start', (info, agent) => {
        if (disposed) return
        const run = workflowRuns.get(info?.id)
        if (run) run.agents.push({ seq: agent?.seq ?? 0, label: agent?.label ?? '', outcome: undefined })
      }))
      hostDisposers.push(runtimeCtx.on('workflow/agent-end', (info, agent) => {
        if (disposed) return
        const run = workflowRuns.get(info?.id)
        if (run) {
          const entry = run.agents.find((e) => e.seq === agent?.seq)
          if (entry) entry.outcome = agent?.outcome ?? 'settled'
        }
      }))
      hostDisposers.push(runtimeCtx.on('workflow/end', (info, result) => {
        if (disposed) return
        const run = workflowRuns.get(info?.id)
        if (run) {
          run.running = false
          run.stopReason = result?.stopReason
        }
        activeFeed()?.workflowEnd(info, result)
      }))

      // Approval requests: show the floating window and decide.
      hostDisposers.push(runtimeCtx.on('approval/request', (req, next) => {
        if (disposed) return next()
        return new Promise((resolve) => {
          let settled = false
          const cleanup = () => {
            req.signal?.removeEventListener('abort', onAbort)
          }
          const onAbort = () => {
            if (settled) return
            settled = true
            cleanup()
            approvalSettle = null
            resolve('cancelled')
          }
          req.signal?.addEventListener('abort', onAbort, { once: true })
          approvalSettle = (outcome) => {
            if (settled) return
            settled = true
            cleanup()
            resolve(outcome)
          }
          const rec = sessions.get(req.agent?.session?.id)
          rec?.feed.appendNotice(`⚠ 审批请求: ${req.toolName ?? '?'}${req.reason ? ` — ${req.reason}` : ''}`)
          // Approvals always ring — attention is required, bell toggle or not.
          void luaCall('require("dsh_tui").bell()', []).catch(() => {})
          void luaCall('require("dsh_tui").show_approval(...)', [{
            toolName: req.toolName ?? '',
            reason: req.reason ?? '',
          }]).catch(() => {
            if (!settled) {
              settled = true
              cleanup()
              approvalSettle = null
              resolve('rejected')
            }
          })
        })
      }))

      // User questions: register as the interactive answerer.
      const userQuestions = svc('userQuestions')
      if (userQuestions?.registerProvider) {
        hostDisposers.push(userQuestions.registerProvider({
          ask: (request) => new Promise((resolve, reject) => {
            questionsResolve = { resolve, reject }
            request.signal?.addEventListener('abort', () => {
              if (questionsResolve) {
                const r = questionsResolve
                questionsResolve = null
                r.reject(new Error('cancelled by caller'))
              }
            }, { once: true })
            void luaCall('require("dsh_tui").show_questions(...)', [request.questions ?? []])
              .catch(() => {
                if (questionsResolve) {
                  const r = questionsResolve
                  questionsResolve = null
                  r.reject(new Error('no UI'))
                }
              })
          }),
        }))
      }

      // History list for resume: only THIS project's project-level sessions.
      // Subagent children are bare-UUID ids (no `session-` prefix) — excluded,
      // as are sessions created in other working directories.
      const persistence = svc('sessionPersistence')
      if (persistence?.list) {
        try {
          const all = await persistence.list()
          const cwd = process.cwd()
          historyHeaders = all.filter((h) => h.cwd === cwd && /^session-/.test(h.id))
        } catch {}
      }

      // Boot: explicit resume id (env/config) wins; otherwise auto-resume the
      // LAST active session of this project (claude --continue behaviour),
      // falling back to the newest persisted one; a fresh session only when
      // there is no history (or resumeLatest is disabled).
      const resumeId = config.resumeSessionId ?? process.env.DSH_NVIM_TUI_RESUME
      const autoResume = config.resumeLatest !== false && process.env.DSH_NVIM_TUI_RESUME_LATEST !== '0'
      try {
        if (resumeId) {
          await resumeSession(resumeId)
        } else if (autoResume && historyHeaders.length > 0) {
          const state = readState()
          const fromState = state?.sessionId && state.cwd === process.cwd() &&
            historyHeaders.some((h) => h.id === state.sessionId)
            ? state.sessionId
            : null
          const newest = [...historyHeaders]
            .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]?.id
          const target = fromState ?? newest
          if (target) {
            await resumeSession(target)
            notice(t('已自动恢复上次会话（/new 新建）'))
          } else {
            await createSession()
          }
        } else {
          await createSession()
        }
      } catch (err) {
        // A broken history session must never take the whole TUI down:
        // log it, fall back to a fresh session.
        const e = err as Error | undefined
        try {
          appendFileSync(errorLogPath,
            `${new Date().toISOString()} 自动恢复: ${e?.stack ?? String(err)}\n`)
        } catch {}
        notice(`⚠ 历史会话恢复失败（${e?.message ?? String(err)}），已新建会话`)
        await createSession()
      }
      refreshList()

      const watchdog = setTimeout(() => {
        if (headless) dumpAndQuit()
      }, watchdogMs)

      const dumpAndQuit = async () => {
        clearTimeout(watchdog)
        if (disposed) return
        if (headless) {
          try {
            const feed = activeFeed()!
            const lines = await nvim!.request('nvim_buf_get_lines', [feed.bufId, 0, -1, false])
            const listLines = sessionEntries.map((s) =>
              `[ ${s.id === activeId ? '▸' : ' '} ${s.title || '（无标题）'} · ${s.id} · ${s.kind}`)
            writeFileSync(dumpPath, `# dsh-nvim-tui e2e dump (${new Date().toISOString()})\n` +
              '## session list\n' +
              listLines.join('\n') + '\n' +
              '## active chat\n' +
              lines.map((l: unknown) => `| ${l}`).join('\n') + '\n')
          } catch (err) {
            writeFileSync(dumpPath, `# dump failed: ${(err as Error).message}\n`)
          }
        }
        await quit(0)
      }

      // Drain input that arrived before the first agent was ready.
      if (pendingInput.length > 0) {
        const queued = pendingInput.splice(0)
        for (const text of queued) send(text)
      }

      // Headless e2e: kick one real agent turn with the configured prompt.
      const headlessPrompt = config.prompt ?? process.env.DSH_NVIM_TUI_PROMPT
      if (headless && headlessPrompt) send(headlessPrompt)
    })().catch((err: unknown) => {
      // After teardown started, in-flight RPC writes can fail with EPIPE —
      // that is the shutdown race, not a product failure.
      if (disposed) return
      console.error('[dsh-nvim-tui] fatal:', err)
      void quit(1)
    })
  })
}
