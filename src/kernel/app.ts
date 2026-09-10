/**
 * dsh_tui App: the shared runner state + service surface on the Node side —
 * the analogue of nvim/lua/dsh_tui/state.lua. EVERY behavior module reads
 * state and services through this ONE object; modules never reach into each
 * other's closures. index.ts composes the modules over it (the analogue of
 * nvim/lua/dsh_tui/init.lua's facade).
 *
 * Composition contract:
 *  - `createApp(ctx, config)` builds the state + core services + no-op slots.
 *  - Each module's `install(app)` fills the slots it owns and registers its
 *    slash commands via `app.registerCommands([...])` (late binding: install
 *    order never matters, runtime calls always see the real implementations).
 *  - `boot(app)` (boot.ts) runs the main body LAST, after every install.
 *
 * @module dsh-nvim-tui/app
 */
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { NeovimClient } from 'neovim'
import type { FeedRenderer } from '../feed/feed.js'
import type { ExtEventName, ExtSessionEventFilter, TuiExtApi } from './ext-types.js'
import type { RunnerConfig } from './types.js'
import type {
  AgentHandle, AgentPresetsService, ApprovalRequest, AttachmentsService, CompactionService,
  DifficultyState, FileReferencesService, GoalsService, GoalState, HarnessSession, JobsService, LlmService,
  MessageContent, MessageFeedbackService, ModelSelection, PermissionPresetsService,
  PlanModeService, RuntimeCtx, SaveImageAttachment, SessionEvent, SessionStore,
  LoaderService, PluginInventoryService, SessionPersistenceService, SessionProjectionsService, SessionQueryService, SessionReferenceService,
  SessionTitleService, SettingsService, SkillsService, SubagentInfo,
  SubagentsService, ToolsService, Usage,
  WorkspacesService,
} from './types.js'

/** Version + build stamp shown in the boot banner (proof of which code runs). */
/** The active session's working directory (falls back to the process cwd
 *  when no session is attached) — local-file commands must resolve against
 *  THIS, not process.cwd(): /search can resume a session from another
 *  project directory while the shell cwd stays put. */
export const activeSessionCwd = (app: App): string => {
  const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
  const cwd = rec?.handle?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
}

/** dsh 0.1.5 persistence.list() returns snapshots ({header, revision, …});
 *  pre-0.1.5 hosts returned the header directly. Normalize either shape. */
export const persistedHeader = (item: { header?: unknown; id?: string } | null | undefined): { id?: string; [key: string]: unknown } | null => {
  if (item === null || item === undefined) return null
  const h = (item as { header?: unknown }).header
  if (h !== null && h !== undefined && typeof h === 'object') return h as { id?: string; [key: string]: unknown }
  return item as { id?: string; [key: string]: unknown }
}

export const BUILD_VERSION = '0.3.5'
export const BUILD_STAMP = new Date().toISOString().slice(0, 16).replace('T', ' ')

// ---------------------------------------------------------------------------
// Typed service registry: each harness service this bundle consumes, keyed by
// its runtime name. `get` returns undefined when unmounted.
// ---------------------------------------------------------------------------
export interface ServiceMap {
  appExit: (code?: number) => void
  attachments: AttachmentsService
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
  sessionProjectionCache: SessionProjectionsService
  pluginInventory: PluginInventoryService
  loader: LoaderService
  llm: LlmService
  sessionReferenceResolver: SessionReferenceService
  sessionTitle: SessionTitleService
  messageFeedback: MessageFeedbackService
  sessionPersistence: SessionPersistenceService
  agentPresets: AgentPresetsService
  workspaceRegistry: WorkspacesService
  /** Credential-reference seam: resolve(envRefName) → { value } | undefined
   *  (provider-owned key storage; the official Models page writes it). */
  credentials: { resolve?: (ref: string) => Promise<{ value?: unknown } | undefined> }
}

/** One slash command: metadata for /help + the completion catalog, plus the
 *  handler. Modules register their own commands with registerCommands(). */
export interface CommandSpec {
  name: string
  desc: string
  usage: string
  group: string
  fn: (arg: string) => unknown
}

export interface ModelRef {
  current: ReturnType<ModelSelection['currentSelection']>
  assembled?: unknown
}

export interface SessionRec {
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
  /** Image turn in flight: previous selection to restore + switch instant. */
  visionTmp: { prev: ReturnType<ModelSelection['currentSelection']>; switchAt: number } | null
  /** 难度路由状态（kernel/difficulty.ts）。 */
  difficulty: DifficultyState
  /** 本回合工具失败次数（难度信号，turn/start 清零）。 */
  toolErrors: number
  /** Instant the most recent turn STARTED (vision restore ordering). */
  lastTurnStartAt: number
  /** Live background jobs of this session (running + stopping). */
  bgJobs: number
  todos: { completed: number; inProgress: number; pending: number } | null
  todosItems: Array<{ content: string; status: string }>
  /** Jobs board cache: id → last known state (fed by jobs.list + onJobDone;
   *  terminal states survive the live-list drop so the FINAL board can
   *  commit with ✓/✗/⚠ marks). */
  jobsCache: Map<string, { label?: string; status: string; startedAt?: number }>
  /** Committed batch identity (id:status 排序拼接)：终态板提交一次后，30s
   *  心跳重新拉到的同一批终态任务不得再次提交。 */
  committedJobsKey: string
  /** id:status of every job already committed to the chat flow — the merge
   *  skips them so a LATER batch finishing cannot re-commit the old board
   *  (pre-review: cache.delete was undone by the next heartbeat's merge). */
  committedJobKeys: Set<string>
  runningSince?: number | null
  /** tool/call events whose tool/result has not arrived yet (live-turn
   *  orphan detection for the duplicate-dsh-tools scheduler crash). */
  pendingToolCalls: Map<string, { seq: number; turn: unknown; step: unknown }>
  [key: string]: unknown
}

export interface WorkflowRun {
  id: string
  name: string
  startedAt: number
  phases: Array<{ title: string; startedAt: number }>
  agents: Array<{ seq: number; label: string; outcome?: string }>
  logs: string[]
  running: boolean
  stopReason: string | undefined
}

/** One queued approval request (head renders the float; the rest wait in
 *  order — parent + subagents can ask CONCURRENTLY). */
export interface ApprovalEntry {
  req: ApprovalRequest
  settle: (outcome: string) => void
  cancelled?: boolean
}

/** One queued user-question waterfall. */
export interface QuestionsEntry {
  questions: unknown[]
  resolve: (v: { answers: unknown[] }) => void
  reject: (e: Error) => void
  cancelled?: boolean
}

/** Domain slices: the shared runner state, regrouped by domain. The root
 *  App keeps ONLY the kernel primitives; every other piece of state lives
 *  here and modules read/write it through `app.slices.<domain>.<field>`.
 *  New state MUST land in a slice — scripts/check-arch.mjs enforces it.
 */
export interface AppSlices {
  /** nvim process / window lifecycle + boot entry. */
  runtime: {
    readonly nvim: NeovimClient | null
    readonly child: ReturnType<typeof import('node:child_process')['spawn']> | null
    readonly channelIdValue: number | null
    readonly disposed: boolean
    readonly quitting: boolean
    readonly chatWinId: number | null
    readonly reasoningOpen: boolean
    readonly reasoningWinId: number | null
    readonly feedDisposer: (() => void) | null
    readonly hostDisposers: Array<() => void>
    readonly spinnerTimer: ReturnType<typeof setInterval> | null
    readonly spinnerIndex: number
    readonly idleRefreshTimer: ReturnType<typeof setInterval> | null
    /** /restart requested: the successor spawns in quit() AFTER the old
     *  nvim fully released the terminal and the session logs flushed. */
    readonly restartPending: boolean
    /** Child exit observed while boot is still connecting (startup config
     *  error): recorded so boot's catch exits non-zero instead of 0. */
    readonly childExitDuringBoot: { code: number | null; signal: string | null } | null
    boot: () => Promise<void>
    /** Owner ops: cross-domain consumers mutate runtime state ONLY here. */
    setChatWin: (id: number | null) => void
    setReasoning: (open: boolean, win: number | null) => void
    spinnerSet: (timer: ReturnType<typeof setInterval> | null) => void
    spinnerStep: (mod: number) => void
    setRestartPending: (v: boolean) => void
  }
  /** Sessions, history, active-session state + subagent registry. */
  sessions: {
    readonly live: Map<string, SessionRec>
    readonly activeId: string | null
    readonly historyHeaders: Array<{ id: string; cwd?: string; createdAt?: number; title?: string; origin?: string; inheritedEventCount?: number }>
    readonly historyById: Map<string, { id: string; cwd?: string; createdAt?: number; title?: string; origin?: string; inheritedEventCount?: number }>
    readonly sessionEntries: Array<{ id: string; title: string; active: boolean; kind: string }>
    readonly runningSubagents: Map<string, { parentId: string; label: string; startedAt: number }>
    readonly childParent: Map<string, { parentId: string; label: string }>
    refreshHistory: () => Promise<void>
    refreshList: () => void
    disposeLiveSession: (id: string) => Promise<void>
    readState: () => unknown
    recordState: (id: string) => void
    createSession: (cwdPath?: string) => Promise<void>
    resumeSession: (id: string) => Promise<void>
    updateTitle: () => void
    switchTo: (id: string) => Promise<void>
    selectSession: (id: string) => Promise<void>
    forkSession: (directive: string | undefined) => Promise<string | undefined>
    attachSession: (handle: AgentHandle, modelRef: ModelRef) => Promise<void>
    listSubagentChildren: (parentId: string) => Promise<Array<{ id: string; label: string; running: boolean; mode: string | undefined; createdAt?: number }>>
    seedRunningSubagents: (parentId: string) => Promise<void>
    cleanSubagentChain: (parentId: string, childId: string) => Promise<boolean>
    runningSubagentsOf: (parentId: string | null) => Array<{ parentId: string; label: string; startedAt: number }>
  }
  /** Feed rendering / window surface helpers. */
  ui: {
    activeFeed: () => FeedRenderer | undefined
    feedForSubagent: (info: SubagentInfo) => SessionRec | undefined
    welcomeLines: () => { above: Array<{ text: string; group?: string }>; below: Array<{ text: string; group?: string }> }
    ensureSpinner: () => void
    updateStatusline: () => void
    refreshBgJobs: () => void
    foldEvent: (rec: SessionRec, event: SessionEvent) => void
    maybePushFileDiff: (feed: FeedRenderer, event: SessionEvent, labelPrefix?: string) => void
    readFileSnapshot: (p: string) => Promise<string | null>
    readonly pendingFileSnaps: Map<string, { display: string; before: string | null }>
    readonly renderedDiffCalls: WeakMap<FeedRenderer, Set<string>>
    readonly pendingEchoes: Map<string, string[]>
    /** Notices emitted before the first session attached (flushed on attach). */
    readonly pendingNotices: unknown[]
  }
  /** Extension surface (ext-api.ts owns; installs run before boot). */
  ext: {
    extApi: TuiExtApi
    readonly extReadyResolve: (() => void) | null
    extFire: (event: ExtEventName, payload: unknown) => void
    readonly extSessionSubs: Array<{ filter: ExtSessionEventFilter; cb: (sid: string, ev: SessionEvent) => void }>
    extDispatchSessionEvent: (sessionId: string, event: SessionEvent) => void
    readonly extLuaSubs: Map<string, Set<string> | 'all'>
    extNodeCleanup: (() => void | Promise<void>) | null
    readonly pendingCardInput: { mark: number; actionIdx: number; prompt: string } | null
    readonly extNodeHandlers: Map<string, { handler: (method: string, args: unknown[]) => unknown | Promise<unknown>; timeoutMs: number; token?: symbol }>
    readonly extStatusSegments: Map<string, { text: string; priority: number }>
    /** Owner ops: cross-domain consumers mutate ext state ONLY here. */
    setPendingCardInput: (v: { mark: number; actionIdx: number; prompt: string } | null) => void
    fireExtReady: () => boolean
  }
  /** Transcript / event-stream reconstruction. */
  trans: {
    sessionEvents: (session: HarnessSession) => SessionEvent[]
    synthesizeToolResult: (rec: SessionRec, callId: string, seq: number | undefined, turn: unknown, step: unknown) => void
    surfaceReplace: (session: HarnessSession, type: string, seq: number, data: unknown) => void
    repairOrphanToolCalls: (rec: SessionRec) => number
    readonly workflowRuns: Map<string, WorkflowRun>
  }
  /** Agent interaction: commands, input routing, pending UI, subagent chat. */
  agent: {
    followup: (rec: SessionRec, text: string, images?: Array<SaveImageAttachment | Extract<MessageContent, { type: 'image' }> | string>) => Promise<void>
    queueSubagentPrompt: (parentAgent: unknown, childId: string, text: string) => Promise<void>
    send: (text: string) => void
    pasteClipboardImage: () => void
    applyModelSelection: (next: ModelRef['current']) => Promise<void>
    pickModel: (arg: string | undefined) => Promise<void>
    stopCommand: () => void
    onInput: (text: string) => void
    onCommand: (line: string) => void
    helpCommand: () => Promise<void>
    restartCommand: () => void
    openDirPicker: (startPath: string) => Promise<string | null>
    atQuery: (query: string, start?: number) => Promise<void>
    currentSelection: () => ReturnType<ModelSelection['currentSelection']>
    commandSpecs: CommandSpec[]
    readonly pendingInput: string[]
    readonly pendingImages: Array<SaveImageAttachment | Extract<MessageContent, { type: 'image' }>>
    readonly pendingRename: { kind: 'workspace'; id: string } | { kind: 'session'; id: string; background?: boolean } | null
    readonly pendingQueueEdit: { list: 'nextTurn' | 'nextStep'; messageId: string } | null
    readonly approvalSettle: ((outcome: string) => void) | null
    readonly approvalReq: ApprovalRequest | null
    /** Queue for CONCURRENT approval requests (parent + subagents can both
     *  ask): the head renders the float; the rest wait in order. */
    readonly approvalQueue: ApprovalEntry[]
    readonly questionsResolve: { resolve: (v: { answers: unknown[] }) => void; reject: (e: Error) => void } | null
    /** Queue for CONCURRENT user-question waterfalls (same head/tail split). */
    readonly questionsQueue: QuestionsEntry[]
    enqueueApproval: (e: ApprovalEntry) => void
    abortApproval: (e: ApprovalEntry) => void
    drainApprovals: (outcome: string) => void
    enqueueQuestions: (e: QuestionsEntry) => void
    abortQuestions: (e: QuestionsEntry) => void
    drainQuestions: () => void
    readonly pickerSettle: ((value: string | null) => void) | null
    readonly dirSettle: ((picked: string | null) => void) | null
    readonly bellOn: boolean
    readonly subagentView: { childId: string; feed: FeedRenderer } | null
    readonly subagentChat: { childId: string; parentId: string; label: string; feed: FeedRenderer } | null
    readonly pendingSubagentFollowup: { childId: string; label: string } | null
    openSubagentView: (childId: string, label: string) => Promise<void>
    openSubagentChat: (childId: string, label: string) => Promise<void>
    sendToSubagent: (text: string) => void
    /** Owner ops: cross-domain consumers mutate agent state ONLY here. */
    setApproval: (entry: ApprovalRequest | null, settle: ((outcome: string) => void) | null) => void
    settleApproval: (outcome: string) => void
    setPickerSettle: (fn: ((value: string | null) => void) | null) => void
    settlePicker: (value: string | null) => void
    setQuestions: (r: { resolve: (v: { answers: unknown[] }) => void; reject: (e: Error) => void } | null) => void
    settleQuestions: (answers: unknown[]) => void
    rejectQuestions: (reason?: string) => void
    setDirSettle: (fn: ((picked: string | null) => void) | null) => void
    resolveDirPicker: (picked: string | null) => void
    setPendingRename: (v: { kind: 'workspace'; id: string } | { kind: 'session'; id: string; background?: boolean } | null) => void
    setPendingQueueEdit: (v: { list: 'nextTurn' | 'nextStep'; messageId: string } | null) => void
    setSubagentView: (v: { childId: string; feed: FeedRenderer } | null) => void
    setSubagentChat: (v: { childId: string; parentId: string; label: string; feed: FeedRenderer } | null) => void
    readonly livePopup: { kind: 'jobs' | 'todo'; update: (items: Array<{ label: string; value: string }>) => void } | null
    setLivePopup: (v: { kind: 'jobs' | 'todo'; update: (items: Array<{ label: string; value: string }>) => void } | null) => void
    /** Clear the transient input-flow state (rename/queue-edit prompts,
     *  pending images, subagent followup) — session switches use it so a
     *  half-finished flow never leaks into the next session. */
    clearPendings: () => void
  }
}

/** Writable view of one slice — owners cast to it inside their own
 *  files; every other file sees readonly state and must go through the
 *  domain ops. */
export type WritableSlice<T> = { -readonly [K in keyof T]: T[K] }

/** The complete cross-module surface: kernel primitives + the domain
 *  slices. Nothing else may live on the root (check-arch.mjs guards). */
export interface App {
  // -- kernel (REAL properties; the only thing P1 leaves on the root) --------
  ctx: Context
  runtimeCtx: RuntimeCtx
  config: RunnerConfig
  headless: boolean
  watchdogMs: number
  dumpPath: string
  errorLogPath: string
  /** Live-session store: dsh 0.1.5 removed the `sessions` service — this
   *  adapter reads the agents registry (`Agent.session`). Never assign to
   *  the cordis context (property set = service registration semantics). */
  liveSessions: SessionStore
  svc: <K extends keyof ServiceMap>(name: K) => ServiceMap[K] | undefined
  luaCall: (code: string, args?: unknown[]) => Promise<any>
  lua: {
    ensureChat: (id: string) => Promise<any>
    ensureReasoning: (id: string) => Promise<any>
    setActive: (id: string) => Promise<any>
  }
  requestExit: (code?: number) => void
  /** Drain notices buffered before any session was active into `feed`. */
  flushPendingNotices: (feed: { appendNotice: (t: unknown) => void }) => void
  notice: (text: unknown) => void
  openPicker: (title: string, items: Array<{ label: string; value: string; active?: boolean }>) => Promise<string | null>
  /** Live picker: same float, but `update` re-renders the OPEN popup in
   *  place (jobs/todo lists refresh their statuses without closing). */
  openLivePicker: (title: string, items: Array<{ label: string; value: string }>) => {
    pick: Promise<string | null>
    update: (items: Array<{ label: string; value: string }>) => void
  }
  guard: (label: string, fn: (...args: any[]) => Promise<unknown>) => (...args: any[]) => Promise<void>
  sleep: (ms: number) => Promise<void>
  exitDiag: (kind: string, ...detail: unknown[]) => void
  quit: (code?: number) => Promise<void>
  teardown: () => Promise<void>
  closeNvimWindow: () => Promise<void>
  /** Command registry (kernel bootstrap facility: every module registers
   *  its specs at install time, so the mechanism exists from t=0). */
  registerCommands: (specs: CommandSpec[]) => CommandSpec[]
  commandCatalog: () => Array<{ name: string; desc: string }>
  refreshCommandCatalog: () => Promise<void>
  /** Registered command specs — the kernel registry's storage (modules
   *  register at install time, so it must live from t=0). */
  commandSpecs: CommandSpec[]
  /** The domain slices (the physical state home). */
  slices: AppSlices
}

/** Build the App object. All state and core services live here; module-owned
 *  functions start as no-ops and are installed afterwards. `ctx` is the
 *  cordis plugin context (inject/effect); `runtimeCtx` is the injected
 *  runtime with the agent/session services. */
export function createApp(ctx: Context, runtimeCtx: RuntimeCtx, config: RunnerConfig): App {
  const svc = <K extends keyof ServiceMap>(name: K): ServiceMap[K] | undefined =>
    runtimeCtx.get(name) as ServiceMap[K] | undefined

  // dsh 0.1.5 removed the `sessions` service: the live-session store is the
  // agents registry itself (`ctx.agents.get/list` return Agents whose
  // `.session` is the live session). Build the store-shaped adapter HERE —
  // assigning a property onto the cordis context is service-registration
  // semantics and deadlocks inside the inject callback.
  const agentsReg = runtimeCtx.get('agents') as unknown as {
    get?: (id: string) => { session?: unknown } | undefined
    list?: () => Array<{ session?: unknown }>
  }
  const liveSessions: SessionStore = {
    get: (id) => {
      const s = agentsReg?.get?.(id)?.session
      return (s === null || s === undefined ? undefined : s) as HarnessSession | undefined
    },
    list: () => (agentsReg?.list?.() ?? [])
      .map((a) => a.session)
      .filter((s): s is HarnessSession => s !== null && s !== undefined),
  }

  /** msgpack-RPC boundary: nvim.lua results are structurally unknown. */
  const luaCall = (code: string, args: unknown[] = []): Promise<any> => {
    return app.slices.runtime.nvim === null ? Promise.reject(new Error('nvim not connected')) :
      app.slices.runtime.nvim.lua(code, args as never[])
  }

  const headless = config.headless === true || process.env.DSH_NVIM_TUI_HEADLESS === '1'
  const watchdogMsRaw = Number(config.watchdogMs ?? process.env.DSH_NVIM_TUI_WATCHDOG_MS ?? 120000)
  const watchdogMs = Number.isFinite(watchdogMsRaw) && watchdogMsRaw > 0 ? watchdogMsRaw : 120000
  const dumpPath = config.dumpPath ?? process.env.DSH_NVIM_TUI_DUMP ??
    `/tmp/dsh-nvim-tui-e2e-${process.pid}.txt`
  const errorLogPath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'nvim-tui-errors.log')

  // Domain shells: owners inject their defaults + implementations at
  // install time (I2) — createApp only guarantees the SHAPE, never the
  // state. Installs all run before boot, and kernel code only reads slices
  // lazily at call time.
  const slices = { runtime: {}, sessions: {}, ui: {}, ext: {}, trans: {}, agent: {} } as unknown as AppSlices
  // Kernel primitives live on the root as REAL properties; everything else
  // is domain state in `slices`.
  const app: App = {
    ctx,
    runtimeCtx,
    config,
    liveSessions,
    headless,
    watchdogMs,
    dumpPath,
    errorLogPath,
    svc,
    luaCall,
    lua: {
      ensureChat: (id: string): Promise<any> => luaCall('return require("dsh_tui").ensure_chat(...)', [id]),
      ensureReasoning: (id: string): Promise<any> => luaCall('return require("dsh_tui").ensure_reasoning(...)', [id]),
      setActive: (id: string): Promise<any> => luaCall('require("dsh_tui").set_active(...)', [id]),
    },
    requestExit: () => {},
    notice: () => {},
    openPicker: async () => null,
    guard: (label: string, fn: (...args: any[]) => Promise<unknown>) => async (...args: any[]) => {
      try {
        await fn(...args)
      } catch (err) {
        const e = err as Error | undefined
        try {
          appendFileSync(errorLogPath,
            `${new Date().toISOString()} ${label}: ${e?.stack ?? String(err)}\n`)
        } catch {}
        app.notice(`⚠ ${label}失败: ${e?.message ?? String(err)}`)
      }
    },
    sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
    exitDiag: () => {},
    quit: async () => {},
    teardown: async () => {},
    closeNvimWindow: async () => {},
    commandSpecs: [],
    // Command registry (kernel bootstrap facility: EVERY module registers
    // its specs at install time, so the mechanism must exist from t=0 —
    // the owner-module pattern does not apply to cross-module facilities).
    registerCommands: (specs: CommandSpec[]): CommandSpec[] => {
      // Duplicate-name protection (internal modules register first, ext
      // commands land later at runtime): the second registrant is skipped
      // with a notice instead of shadowing the first handler. Returns the
      // specs ACTUALLY registered — disposers must only remove their own.
      const accepted: CommandSpec[] = []
      for (const s of specs) {
        if (app.commandSpecs.some((e) => e.name === s.name)) {
          app.notice(`⚠ 命令 ${s.name} 已注册，忽略重复`)
          continue
        }
        app.commandSpecs.push(s)
        accepted.push(s)
      }
      return accepted
    },
    commandCatalog: () => app.commandSpecs.map(({ name, desc }) => ({ name, desc })),
    refreshCommandCatalog: async (): Promise<void> => {
      const entries = app.commandSpecs.map(({ name, desc }) => ({ name, desc }))
      const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
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
    },
    slices,
  } as unknown as App

  // -- process exit plumbing ---------------------------------------------------
  const appExitService = svc('appExit')
  app.requestExit = (code = 0) => {
    if (typeof appExitService === 'function') appExitService(code)
    else process.exit(code)
  }

  app.slices.ui.activeFeed = () => {
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
    return rec?.feed
  }
  app.notice = (text: unknown): void => {
    // Startup window: before the first session attaches there is NO feed to
    // render into, and every real failure notice (session-history load,
    // onboarding, profile warnings…) was silently dropped. Buffer them and
    // flush into the first ACTIVE session's feed.
    const feed = app.slices.ui.activeFeed()
    if (feed === undefined) {
      const q = app.slices.ui.pendingNotices
      q.push(text)
      if (q.length > 20) q.shift()
      return
    }
    feed.appendNotice(text)
  }

  /** Flush notices buffered before any session was active (owner: sessions). */
  app.flushPendingNotices = (feed: { appendNotice: (t: unknown) => void }): void => {
    const q = app.slices.ui.pendingNotices
    if (q.length === 0) return
    for (const t of q.splice(0, q.length)) feed.appendNotice(t)
  }

  app.openPicker = (title: string, items: Array<{ label: string; value: string; active?: boolean }>) =>
    new Promise<string | null>((resolve) => {
      // Single-slot semantics: a second picker supersedes the first — settle
      // the previous one as cancelled so its awaiter can never hang forever
      // (the tui_command tool can open two pickers back-to-back).
      if (app.slices.agent.pickerSettle !== null) app.slices.agent.settlePicker(null)
      app.slices.agent.setPickerSettle(resolve)
      void luaCall('require("dsh_tui").show_picker(...)', [title, items])
        .catch(() => {
          // Identity-checked failure settle: a STALE picker's failed open
          // must not cancel its successor (pre-review: the unconditional
          // settlePicker(null) settled picker #2 when picker #1's luaCall
          // rejected late — the user's #2 choice was silently discarded).
          if (app.slices.agent.pickerSettle === resolve) app.slices.agent.settlePicker(null)
        })
    })

  app.openLivePicker = (title: string, items: Array<{ label: string; value: string }>) => ({
    pick: app.openPicker(title, items),
    update: (next: Array<{ label: string; value: string }>) => {
      void luaCall('require("dsh_tui").update_picker(...)', [next]).catch(() => {})
    },
  })

  // -- process-level error/signal hooks ------------------------------------------
  // alpha.4 host fail-loud: ANY unhandled rejection/uncaught exception in
  // the process disposes the whole tree and hard-exits (proc.exit(1)) —
  // silently as far as our own logs go. Log it FIRST (sync) so the culprit
  // survives even when the host's fail-loud exit races our teardown.
  const logProcessError = (kind: string, err: unknown) => {
    try {
      appendFileSync(errorLogPath,
        `${new Date().toISOString()} 进程诊断: ${kind}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    } catch {}
  }
  const onUnhandledRejection = (err: unknown) => logProcessError('unhandledRejection', err)
  const onUncaughtException = (err: unknown) => logProcessError('uncaughtException', err)
  const onSignal = (sig: string) => {
    app.exitDiag('signal', sig)
    void app.quit(0)
  }
  process.on('unhandledRejection', onUnhandledRejection)
  process.on('uncaughtException', onUncaughtException)
  // Named handlers: the cleanup below must remove the SAME function identity
  // (an inline arrow would never match → one leaked listener per re-apply).
  const onSigterm = (): void => onSignal('SIGTERM')
  const onSigint = (): void => onSignal('SIGINT')
  const onSighup = (): void => onSignal('SIGHUP')
  ctx.effect(() => {
    process.on('SIGTERM', onSigterm)
    process.on('SIGINT', onSigint)
    process.on('SIGHUP', onSighup)
    return () => {
      process.off('SIGTERM', onSigterm)
      process.off('SIGINT', onSigint)
      process.off('SIGHUP', onSighup)
      process.off('unhandledRejection', onUnhandledRejection)
      process.off('uncaughtException', onUncaughtException)
      void app.teardown()
    }
  })

  return app
}
