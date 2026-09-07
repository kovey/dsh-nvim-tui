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
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { NeovimClient } from 'neovim'
import type { FeedRenderer } from './feed.js'
import type { ExtEventName, ExtSessionEventFilter, TuiExtApi } from './ext-api.js'
import { diffTexts, fileDiffsFromMeta } from './diff.js'
import { t } from './i18n.js'
import type { RunnerConfig } from './types.js'
import type {
  AgentHandle, AgentPresetsService, ApprovalRequest, AttachmentsService, CompactionService,
  FileReferencesService, GoalsService, GoalState, HarnessSession, JobsService,
  MessageContent, MessageFeedbackService, ModelSelection, PermissionPresetsService,
  PlanModeService, RuntimeCtx, SaveImageAttachment, SessionEvent,
  LoaderService, PluginInventoryService, SessionPersistenceService, SessionProjectionsService, SessionQueryService, SessionReferenceService,
  SessionTitleService, SettingsService, SkillsService, SubagentInfo,
  SubagentsService, ToolsService, Usage,
  WorkspacesService,
} from './types.js'

/** Version + build stamp shown in the boot banner (proof of which code runs). */
export const BUILD_VERSION = '0.3.1'
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
  sessionReferenceResolver: SessionReferenceService
  sessionTitle: SessionTitleService
  messageFeedback: MessageFeedbackService
  sessionPersistence: SessionPersistenceService
  agentPresets: AgentPresetsService
  workspaceRegistry: WorkspacesService
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
  /** Instant the most recent turn STARTED (vision restore ordering). */
  lastTurnStartAt: number
  /** Live background jobs of this session (running + stopping). */
  bgJobs: number
  todos: { completed: number; inProgress: number; pending: number } | null
  todosItems: Array<{ content: string; status: string }>
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

/** Domain slices (P0 architecture): the flat App members regrouped by
 *  domain. The root App keeps kernel primitives as REAL properties and
 *  forwards every legacy flat member through get/set accessors into its
 *  slice — existing modules compile unchanged while the state physically
 *  lives in slices. P1 removes the accessors and narrows module signatures.
 */
export interface AppSlices {
  /** nvim process / window lifecycle + boot entry. */
  runtime: {
    nvim: NeovimClient | null
    child: ReturnType<typeof import('node:child_process')['spawn']> | null
    channelIdValue: number | null
    disposed: boolean
    quitting: boolean
    chatWinId: number | null
    reasoningOpen: boolean
    reasoningWinId: number | null
    feedDisposer: (() => void) | null
    hostDisposers: Array<() => void>
    spinnerTimer: ReturnType<typeof setInterval> | null
    spinnerIndex: number
    idleRefreshTimer: ReturnType<typeof setInterval> | null
    boot: () => Promise<void>
  }
  /** Sessions, history, active-session state + subagent registry. */
  sessions: {
    sessions: Map<string, SessionRec>
    activeId: string | null
    historyHeaders: Array<{ id: string; cwd?: string; createdAt?: number; title?: string; origin?: string; inheritedEventCount?: number }>
    historyById: Map<string, { id: string; cwd?: string; createdAt?: number; title?: string; origin?: string; inheritedEventCount?: number }>
    sessionEntries: Array<{ id: string; title: string; active: boolean; kind: string }>
    runningSubagents: Map<string, { parentId: string; label: string; startedAt: number }>
    childParent: Map<string, { parentId: string; label: string }>
    refreshHistory: () => Promise<void>
    refreshList: () => void
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
    pendingFileSnaps: Map<string, { display: string; before: string | null }>
    renderedDiffCalls: WeakMap<FeedRenderer, Set<string>>
    pendingEchoes: Map<string, string[]>
  }
  /** Extension surface (ext-api.ts owns; installs run before boot). */
  ext: {
    extApi: TuiExtApi
    extReadyResolve: (() => void) | null
    extFire: (event: ExtEventName, payload: unknown) => void
    extSessionSubs: Array<{ filter: ExtSessionEventFilter; cb: (sid: string, ev: SessionEvent) => void }>
    extDispatchSessionEvent: (sessionId: string, event: SessionEvent) => void
    extLuaSubs: Map<string, Set<string> | 'all'>
    extNodeCleanup: (() => void | Promise<void>) | null
    pendingCardInput: { mark: number; actionIdx: number; prompt: string } | null
    extNodeHandlers: Map<string, { handler: (method: string, args: unknown[]) => unknown | Promise<unknown>; timeoutMs: number }>
    extStatusSegments: Map<string, { text: string; priority: number }>
  }
  /** Transcript / event-stream reconstruction. */
  trans: {
    sessionEvents: (session: HarnessSession) => SessionEvent[]
    synthesizeToolResult: (rec: SessionRec, callId: string, seq: number | undefined, turn: unknown, step: unknown) => void
    surfaceReplace: (session: HarnessSession, type: string, seq: number, data: unknown) => void
    repairOrphanToolCalls: (rec: SessionRec) => number
    workflowRuns: Map<string, WorkflowRun>
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
    registerCommands: (specs: CommandSpec[]) => void
    commandCatalog: () => Array<{ name: string; desc: string }>
    refreshCommandCatalog: () => Promise<void>
    pendingInput: string[]
    pendingImages: Array<SaveImageAttachment | Extract<MessageContent, { type: 'image' }>>
    pendingRename: { kind: 'workspace'; id: string } | { kind: 'session'; id: string } | null
    pendingQueueEdit: { list: 'nextTurn' | 'nextStep'; messageId: string } | null
    approvalSettle: ((outcome: string) => void) | null
    approvalReq: ApprovalRequest | null
    questionsResolve: { resolve: (v: { answers: unknown[] }) => void; reject: (e: Error) => void } | null
    pickerSettle: ((value: string | null) => void) | null
    dirSettle: ((picked: string | null) => void) | null
    bellOn: boolean
    subagentView: { childId: string; feed: FeedRenderer } | null
    subagentChat: { childId: string; parentId: string; label: string; feed: FeedRenderer } | null
    pendingSubagentFollowup: { childId: string; label: string } | null
    openSubagentView: (childId: string, label: string) => Promise<void>
    openSubagentChat: (childId: string, label: string) => Promise<void>
    sendToSubagent: (text: string) => void
  }
}

/** The complete cross-module surface. State lives in `slices` (P0); the flat
 *  members remain declared here for source compatibility and are forwarded
 *  through accessor pairs — P1 narrows modules to their slices and drops
 *  both the accessors and these declarations. */
export interface App {
  // -- kernel (REAL properties; the only thing P1 leaves on the root) --------
  ctx: Context
  runtimeCtx: RuntimeCtx
  config: RunnerConfig
  headless: boolean
  watchdogMs: number
  dumpPath: string
  errorLogPath: string
  svc: <K extends keyof ServiceMap>(name: K) => ServiceMap[K] | undefined
  luaCall: (code: string, args?: unknown[]) => Promise<any>
  lua: {
    ensureChat: (id: string) => Promise<any>
    ensureReasoning: (id: string) => Promise<any>
    setActive: (id: string) => Promise<any>
  }
  requestExit: (code?: number) => void
  notice: (text: unknown) => void
  openPicker: (title: string, items: Array<{ label: string; value: string; active?: boolean }>) => Promise<string | null>
  guard: (label: string, fn: (...args: any[]) => Promise<unknown>) => (...args: any[]) => Promise<void>
  sleep: (ms: number) => Promise<void>
  exitDiag: (kind: string, ...detail: unknown[]) => void
  quit: (code?: number) => Promise<void>
  teardown: () => Promise<void>
  closeNvimWindow: () => Promise<void>
  /** The domain slices (the physical state home). */
  slices: AppSlices

  // -- legacy flat members (P0 accessor-forwarded into slices) ----------------
  nvim: NeovimClient | null
  child: ReturnType<typeof import('node:child_process')['spawn']> | null
  channelIdValue: number | null
  disposed: boolean
  quitting: boolean
  chatWinId: number | null
  reasoningOpen: boolean
  reasoningWinId: number | null
  feedDisposer: (() => void) | null
  hostDisposers: Array<() => void>
  spinnerTimer: ReturnType<typeof setInterval> | null
  spinnerIndex: number
  idleRefreshTimer: ReturnType<typeof setInterval> | null
  boot: () => Promise<void>

  sessions: Map<string, SessionRec>
  activeId: string | null
  historyHeaders: Array<{ id: string; cwd?: string; createdAt?: number; title?: string; origin?: string; inheritedEventCount?: number }>
  historyById: Map<string, { id: string; cwd?: string; createdAt?: number; title?: string; origin?: string; inheritedEventCount?: number }>
  sessionEntries: Array<{ id: string; title: string; active: boolean; kind: string }>
  runningSubagents: Map<string, { parentId: string; label: string; startedAt: number }>
  childParent: Map<string, { parentId: string; label: string }>
  refreshHistory: () => Promise<void>
  refreshList: () => void
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

  activeFeed: () => FeedRenderer | undefined
  feedForSubagent: (info: SubagentInfo) => SessionRec | undefined
  welcomeLines: () => { above: Array<{ text: string; group?: string }>; below: Array<{ text: string; group?: string }> }
  ensureSpinner: () => void
  updateStatusline: () => void
  refreshBgJobs: () => void
  foldEvent: (rec: SessionRec, event: SessionEvent) => void
  maybePushFileDiff: (feed: FeedRenderer, event: SessionEvent, labelPrefix?: string) => void
  readFileSnapshot: (p: string) => Promise<string | null>
  pendingFileSnaps: Map<string, { display: string; before: string | null }>
  renderedDiffCalls: WeakMap<FeedRenderer, Set<string>>
  pendingEchoes: Map<string, string[]>

  extApi: TuiExtApi
  extReadyResolve: (() => void) | null
  extFire: (event: ExtEventName, payload: unknown) => void
  extSessionSubs: Array<{ filter: ExtSessionEventFilter; cb: (sid: string, ev: SessionEvent) => void }>
  extDispatchSessionEvent: (sessionId: string, event: SessionEvent) => void
  extLuaSubs: Map<string, Set<string> | 'all'>
  extNodeCleanup: (() => void | Promise<void>) | null
  pendingCardInput: { mark: number; actionIdx: number; prompt: string } | null
  extNodeHandlers: Map<string, { handler: (method: string, args: unknown[]) => unknown | Promise<unknown>; timeoutMs: number }>
  extStatusSegments: Map<string, { text: string; priority: number }>

  sessionEvents: (session: HarnessSession) => SessionEvent[]
  synthesizeToolResult: (rec: SessionRec, callId: string, seq: number | undefined, turn: unknown, step: unknown) => void
  surfaceReplace: (session: HarnessSession, type: string, seq: number, data: unknown) => void
  repairOrphanToolCalls: (rec: SessionRec) => number
  workflowRuns: Map<string, WorkflowRun>

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
  registerCommands: (specs: CommandSpec[]) => void
  commandCatalog: () => Array<{ name: string; desc: string }>
  refreshCommandCatalog: () => Promise<void>
  pendingInput: string[]
  pendingImages: Array<SaveImageAttachment | Extract<MessageContent, { type: 'image' }>>
  pendingRename: { kind: 'workspace'; id: string } | { kind: 'session'; id: string } | null
  pendingQueueEdit: { list: 'nextTurn' | 'nextStep'; messageId: string } | null
  approvalSettle: ((outcome: string) => void) | null
  approvalReq: ApprovalRequest | null
  questionsResolve: { resolve: (v: { answers: unknown[] }) => void; reject: (e: Error) => void } | null
  pickerSettle: ((value: string | null) => void) | null
  dirSettle: ((picked: string | null) => void) | null
  bellOn: boolean
  subagentView: { childId: string; feed: FeedRenderer } | null
  subagentChat: { childId: string; parentId: string; label: string; feed: FeedRenderer } | null
  pendingSubagentFollowup: { childId: string; label: string } | null
  openSubagentView: (childId: string, label: string) => Promise<void>
  openSubagentChat: (childId: string, label: string) => Promise<void>
  sendToSubagent: (text: string) => void
}

/** Build the App object. All state and core services live here; module-owned
 *  functions start as no-ops and are installed afterwards. `ctx` is the
 *  cordis plugin context (inject/effect); `runtimeCtx` is the injected
 *  runtime with the agent/session services. */
export function createApp(ctx: Context, runtimeCtx: RuntimeCtx, config: RunnerConfig): App {
  const svc = <K extends keyof ServiceMap>(name: K): ServiceMap[K] | undefined =>
    runtimeCtx.get(name) as ServiceMap[K] | undefined

  /** msgpack-RPC boundary: nvim.lua results are structurally unknown. */
  const luaCall = (code: string, args: unknown[] = []): Promise<any> => {
    return app.nvim === null ? Promise.reject(new Error('nvim not connected')) :
      app.nvim.lua(code, args as never[])
  }

  const headless = config.headless === true || process.env.DSH_NVIM_TUI_HEADLESS === '1'
  const watchdogMs = Number(config.watchdogMs ?? process.env.DSH_NVIM_TUI_WATCHDOG_MS ?? 120000)
  const dumpPath = config.dumpPath ?? process.env.DSH_NVIM_TUI_DUMP ??
    `/tmp/dsh-nvim-tui-e2e-${process.pid}.txt`
  const errorLogPath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'nvim-tui-errors.log')

  const slices: AppSlices = {
    runtime: {
      nvim: null,
      child: null,
      channelIdValue: null,
      disposed: false,
      quitting: false,
      chatWinId: null,
      reasoningOpen: false,
      reasoningWinId: null,
      feedDisposer: null,
      hostDisposers: [],
      spinnerTimer: null,
      spinnerIndex: 0,
      idleRefreshTimer: null,
      boot: async () => {},
    },
    sessions: {
      sessions: new Map(),
      activeId: null,
      historyHeaders: [],
      historyById: new Map(),
      sessionEntries: [],
      runningSubagents: new Map(),
      childParent: new Map(),
      refreshHistory: async () => {},
      refreshList: () => {},
      readState: () => null,
      recordState: () => {},
      createSession: async () => {},
      resumeSession: async () => {},
      updateTitle: () => {},
      switchTo: async () => {},
      selectSession: async () => {},
      forkSession: async () => undefined,
      attachSession: async () => {},
      listSubagentChildren: async () => [],
      seedRunningSubagents: async () => {},
      cleanSubagentChain: async () => false,
      runningSubagentsOf: () => [],
    },
    ui: {
      activeFeed: () => undefined,
      feedForSubagent: () => undefined,
      welcomeLines: () => ({ above: [], below: [] }),
      ensureSpinner: () => {},
      updateStatusline: () => {},
      refreshBgJobs: () => {},
      foldEvent: () => {},
      maybePushFileDiff: () => {},
      readFileSnapshot: async () => null,
      pendingFileSnaps: new Map(),
      renderedDiffCalls: new WeakMap(),
      pendingEchoes: new Map(),
    },
    ext: {
      extApi: null as unknown as TuiExtApi, // installExtApi fills it before boot
      extReadyResolve: null,
      extFire: () => {},
      extSessionSubs: [],
      extDispatchSessionEvent: () => {},
      extLuaSubs: new Map(),
      extNodeCleanup: null,
      pendingCardInput: null,
      extNodeHandlers: new Map(),
      extStatusSegments: new Map(),
    },
    trans: {
      sessionEvents: () => [],
      synthesizeToolResult: () => {},
      surfaceReplace: () => {},
      repairOrphanToolCalls: () => 0,
      workflowRuns: new Map(),
    },
    agent: {
      followup: async () => {},
      queueSubagentPrompt: async () => {},
      send: () => {},
      pasteClipboardImage: () => {},
      applyModelSelection: async () => {},
      pickModel: async () => {},
      stopCommand: () => {},
      onInput: () => {},
      onCommand: () => {},
      helpCommand: async () => {},
      restartCommand: () => {},
      openDirPicker: async () => null,
      atQuery: async () => {},
      currentSelection: () => runtimeCtx.agentDefaultModel.currentSelection(),
      commandSpecs: [],
      registerCommands: (specs: CommandSpec[]) => {
        // Duplicate-name protection (internal modules register first, ext
        // commands land later at runtime): the second registrant is skipped
        // with a notice instead of shadowing the first handler.
        for (const s of specs) {
          if (app.slices.agent.commandSpecs.some((e) => e.name === s.name)) {
            app.notice(`⚠ 命令 ${s.name} 已注册，忽略重复`)
            continue
          }
          app.slices.agent.commandSpecs.push(s)
        }
      },
      commandCatalog: () => app.slices.agent.commandSpecs.map(({ name, desc }) => ({ name, desc })),
      refreshCommandCatalog: async () => {},
      pendingInput: [],
      pendingImages: [],
      pendingRename: null,
      pendingQueueEdit: null,
      approvalSettle: null,
      approvalReq: null,
      questionsResolve: null,
      pickerSettle: null,
      dirSettle: null,
      bellOn: true,
      subagentView: null,
      subagentChat: null,
      pendingSubagentFollowup: null,
      openSubagentView: async () => {},
      openSubagentChat: async () => {},
      sendToSubagent: () => {},
    },
  }

  // Kernel primitives live on the root as REAL properties; every other flat
  // member is an accessor pair forwarding into its slice (P0 — modules keep
  // reading/writing `app.xxx` unchanged).
  const app: App = {
    ctx,
    runtimeCtx,
    config,
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
    slices,
  } as unknown as App

  /** Which slice each legacy flat member lives in (the accessor map). */
  const FLAT_FIELDS: Record<string, keyof AppSlices> = {
    nvim: 'runtime', child: 'runtime', channelIdValue: 'runtime', disposed: 'runtime',
    quitting: 'runtime', chatWinId: 'runtime', reasoningOpen: 'runtime', reasoningWinId: 'runtime',
    feedDisposer: 'runtime', hostDisposers: 'runtime', spinnerTimer: 'runtime',
    spinnerIndex: 'runtime', idleRefreshTimer: 'runtime', boot: 'runtime',
    sessions: 'sessions', activeId: 'sessions', historyHeaders: 'sessions',
    historyById: 'sessions', sessionEntries: 'sessions', runningSubagents: 'sessions',
    childParent: 'sessions', refreshHistory: 'sessions', refreshList: 'sessions',
    readState: 'sessions', recordState: 'sessions', createSession: 'sessions',
    resumeSession: 'sessions', updateTitle: 'sessions', switchTo: 'sessions',
    selectSession: 'sessions', forkSession: 'sessions', attachSession: 'sessions',
    listSubagentChildren: 'sessions', seedRunningSubagents: 'sessions',
    cleanSubagentChain: 'sessions', runningSubagentsOf: 'sessions',
    activeFeed: 'ui', feedForSubagent: 'ui', welcomeLines: 'ui', ensureSpinner: 'ui',
    updateStatusline: 'ui', refreshBgJobs: 'ui', foldEvent: 'ui', maybePushFileDiff: 'ui',
    readFileSnapshot: 'ui', pendingFileSnaps: 'ui', renderedDiffCalls: 'ui', pendingEchoes: 'ui',
    extApi: 'ext', extReadyResolve: 'ext', extFire: 'ext', extSessionSubs: 'ext',
    extDispatchSessionEvent: 'ext', extLuaSubs: 'ext', extNodeCleanup: 'ext',
    pendingCardInput: 'ext', extNodeHandlers: 'ext', extStatusSegments: 'ext',
    sessionEvents: 'trans', synthesizeToolResult: 'trans', surfaceReplace: 'trans',
    repairOrphanToolCalls: 'trans', workflowRuns: 'trans',
    followup: 'agent', queueSubagentPrompt: 'agent', send: 'agent', pasteClipboardImage: 'agent',
    applyModelSelection: 'agent', pickModel: 'agent', stopCommand: 'agent', onInput: 'agent',
    onCommand: 'agent', helpCommand: 'agent', restartCommand: 'agent', openDirPicker: 'agent',
    atQuery: 'agent', currentSelection: 'agent', commandSpecs: 'agent',
    registerCommands: 'agent', commandCatalog: 'agent', refreshCommandCatalog: 'agent',
    pendingInput: 'agent', pendingImages: 'agent', pendingRename: 'agent',
    pendingQueueEdit: 'agent', approvalSettle: 'agent', approvalReq: 'agent',
    questionsResolve: 'agent', pickerSettle: 'agent', dirSettle: 'agent', bellOn: 'agent',
    subagentView: 'agent', subagentChat: 'agent', pendingSubagentFollowup: 'agent',
    openSubagentView: 'agent', openSubagentChat: 'agent', sendToSubagent: 'agent',
  }
  for (const [name, slice] of Object.entries(FLAT_FIELDS)) {
    Object.defineProperty(app, name, {
      get: () => (slices[slice] as unknown as Record<string, unknown>)[name],
      set: (v: unknown) => {
        ;(slices[slice] as unknown as Record<string, unknown>)[name] = v
      },
      enumerable: true,
      configurable: true,
    })
  }

  // -- process exit plumbing ---------------------------------------------------
  const appExitService = svc('appExit')
  app.requestExit = (code = 0) => {
    if (typeof appExitService === 'function') appExitService(code)
    else process.exit(code)
  }

  if (headless) appendFileSync(`${dumpPath}.applies`, `apply ${new Date().toISOString()}\n`)

  app.activeFeed = () => {
    const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
    return rec?.feed
  }
  app.notice = (text: unknown): void => { app.activeFeed()?.appendNotice(text) }

  app.openPicker = (title: string, items: Array<{ label: string; value: string; active?: boolean }>) =>
    new Promise<string | null>((resolve) => {
      app.pickerSettle = resolve
      void luaCall('require("dsh_tui").show_picker(...)', [title, items])
        .catch(() => { app.pickerSettle = null; resolve(null) })
    })

  // -- last-active-session state (claude --continue behaviour) -------------------
  const statePath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-nvim-tui-state.json')
  app.readState = () => {
    try {
      return JSON.parse(readFileSync(statePath, 'utf8'))
    } catch {
      return null
    }
  }
  app.recordState = (id: string) => {
    try {
      // Record the SESSION's own cwd, not the shell's: an old session opened
      // from another directory should resume from ITS project dir on the next
      // launch (claude --continue per-project semantics).
      const hdr = app.sessions.get(id)?.handle.agent.session.header as { cwd?: unknown } | undefined
      const cwd = typeof hdr?.cwd === 'string' ? hdr.cwd : process.cwd()
      writeFileSync(statePath, JSON.stringify({ sessionId: id, cwd, at: Date.now() }))
    } catch {}
  }

  /** (Re)load the persisted session directory. `historyHeaders` keeps the
   *  current-cwd slice (boot auto-resume); `historyById` holds everything
   *  openable via /sessions. */
  app.refreshHistory = async (): Promise<void> => {
    const persistence = svc('sessionPersistence')
    if (typeof persistence?.list !== 'function') return
    try {
      const all = await persistence.list()
      const cwd = process.cwd()
      // Persisted titles live in the projection cache (SessionHeader carries
      // no title field): read the cached `title` projection per header so a
      // user rename survives restarts in /sessions without opening the log.
      // The cache is its own service (`sessionProjectionCache`); fall back to
      // the base registry for profiles that expose the read there.
      const projections = svc('sessionProjectionCache') ?? svc('sessionProjections')
      const cachedTitle = (h: { id: string; inheritedEventCount?: number }): string | undefined => {
        if (typeof projections?.cachedSnapshot !== 'function') return undefined
        try {
          const snap = projections.cachedSnapshot(h, h.inheritedEventCount ?? 0, ['title'])
          const title = snap?.values?.title
          return typeof title === 'string' && title !== '' ? title : undefined
        } catch {
          return undefined
        }
      }
      app.historyHeaders = all
        .filter((h) => h.cwd === cwd && /^session-/.test(h.id) && h.origin !== 'subagent')
        .map((h) => ({ ...h, title: cachedTitle(h) ?? h.title }))
      app.historyById.clear()
      for (const h of all) {
        if (/^session-/.test(h.id) && h.origin !== 'subagent') {
          app.historyById.set(h.id, { ...h, title: cachedTitle(h) ?? h.title })
        }
      }
    } catch {}
  }

  /** Read a file as a diff snapshot (null when absent/unreadable/binary/
   *  oversized — those cases render no diff block). */
  app.readFileSnapshot = async (p: string): Promise<string | null> => {
    try {
      const abs = resolve(p)
      const st = await stat(abs)
      if (!st.isFile() || st.size > 256 * 1024) return null
      const text = await readFile(abs, 'utf8')
      return text.includes('\0') ? null : text
    } catch {
      return null
    }
  }

  /** tool/result: render ✎ diff blocks into the feed that rendered the
   *  tool line. Primary source = the tool's official presentationMeta
   *  (`meta.diffs = [{ path, oldText, newText }]` — exact, cwd-immune);
   *  falls back to the pre-call file snapshot for flows the meta misses
   *  (creates, deletes). Also runs during history REPLAYS: the persisted
   *  events carry the same meta, so diff blocks survive restarts. */
  app.maybePushFileDiff = (feed: FeedRenderer, event: SessionEvent, labelPrefix = ''): void => {
    if (event.type !== 'tool/result') return
    const callId = event.data?.message?.source?.callId
    // One diff render per tool call per feed: replay loops and live event
    // re-emission must never stack the same ✎ block twice.
    const seenCalls = app.renderedDiffCalls.get(feed) ?? new Set<string>()
    const callKey = typeof callId === 'string' ? callId : ''
    if (callKey !== '' && seenCalls.has(callKey)) return
    if (callKey !== '') seenCalls.add(callKey)
    app.renderedDiffCalls.set(feed, seenCalls)
    const metaDiffs = fileDiffsFromMeta((event.data as { meta?: unknown } | undefined)?.meta)
    if (metaDiffs !== null) {
      if (callKey !== '') app.pendingFileSnaps.delete(callKey)
      for (const d of metaDiffs.slice(0, 4)) {
        const block = diffTexts(d.oldText ?? null, d.newText ?? null)
        if (block.stats.added === 0 && block.stats.removed === 0) continue
        const action = d.oldText === undefined
          ? t('新增')
          : d.newText === undefined
            ? t('删除')
            : t('修改')
        feed.pushDiff(`✎ ${labelPrefix}${action} ${d.path} (+${block.stats.added} −${block.stats.removed})`, block.lines)
      }
      return
    }
    if (typeof callId !== 'string' || callId === '') return
    const snap = app.pendingFileSnaps.get(callId)
    if (snap === undefined) return
    app.pendingFileSnaps.delete(callId)
    void app.readFileSnapshot(snap.display).then((after) => {
      if (app.disposed) return
      const block = diffTexts(snap.before, after)
      if (block.stats.added === 0 && block.stats.removed === 0) return
      const action = snap.before === null ? t('新增') : after === null ? t('删除') : t('修改')
      feed.pushDiff(`✎ ${labelPrefix}${action} ${snap.display} (+${block.stats.added} −${block.stats.removed})`, block.lines)
    })
  }

  /** Route a subagent lifecycle event to its PARENT session's feed. */
  app.feedForSubagent = (info: SubagentInfo) => {
    if (!info?.id) return undefined
    const child = runtimeCtx.sessions.get(info.id)
    const parentId = child?.header?.parentSession
    const rec = parentId !== undefined ? app.sessions.get(parentId) : undefined
    if (rec) return rec
    // Fallback: subagents usually spawn while their parent is the active session.
    return app.activeId === null ? undefined : app.sessions.get(app.activeId)
  }

  app.refreshList = () => {
    const entries = [...app.sessions.values()].map((s) => ({
      id: s.id,
      title: s.title ?? '', // never undefined — msgpack turns it into vim.NIL
      active: s.id === app.activeId,
      kind: 'live',
    }))
    for (const h of app.historyHeaders) {
      if (!app.sessions.has(h.id)) {
        entries.push({ id: h.id, title: h.title ?? '', active: false, kind: 'history' })
      }
    }
    app.sessionEntries = entries
  }

  /** Refresh the `/` completion catalog: built-in commands plus skill
   *  entries (the official client's slash trigger merges command and skill
   *  sources; `/skills:<name>` shows the skill detail float). */
  app.refreshCommandCatalog = async (): Promise<void> => {
    const entries = app.commandSpecs.map(({ name, desc }) => ({ name, desc }))
    const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId)
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

  // -- exit path ----------------------------------------------------------------
  /** Exit-path diagnostics: WHY the UI closed (signal / nvim exit / fatal /
   *  explicit quit) — appended to the errors log, since a spontaneous host
   *  shutdown otherwise leaves no trace at all. */
  app.exitDiag = (kind: string, ...detail: unknown[]) => {
    try {
      appendFileSync(errorLogPath,
        `${new Date().toISOString()} 退出诊断: ${kind} ${detail.map((d) => String(d)).join(' ')}\n`)
    } catch {}
  }

  /** Close the nvim window gracefully (`:qa!` over RPC) so it never prints
   *  "Nvim: Caught deadly signal 'SIGTERM'". kill(2) stays as the fallback
   *  for a wedged RPC or an nvim that already went away. The exit listener
   *  is registered BEFORE the qa! — nvim can exit before the RPC roundtrip
   *  ends and the event would otherwise be missed. */
  app.closeNvimWindow = async () => {
    const exited = app.child === null || app.child.exitCode !== null || app.child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => app.child!.once('exit', resolve))
    try {
      if (app.nvim !== null) {
        await Promise.race([
          app.nvim!.command('qa!').catch(() => {}),
          app.sleep(250),
        ])
      }
    } catch {}
    // Give the graceful exit a moment, then force-kill whatever remains.
    await Promise.race([exited, app.sleep(400)])
    try {
      if (app.child !== null && app.child.exitCode === null && app.child.signalCode === null) {
        app.child.kill()
      }
    } catch {}
  }

  /** UI teardown only — must NOT exit the process: the runner row can be
   *  reloaded (hmr) while dsh keeps running; the next apply spawns a fresh nvim. */
  app.teardown = async () => {
    if (app.disposed) return
    app.disposed = true
    try {
      app.feedDisposer?.()
    } catch {}
    for (const dispose of app.hostDisposers) {
      try {
        dispose()
      } catch {}
    }
    app.hostDisposers.length = 0
    if (app.spinnerTimer !== null) {
      clearInterval(app.spinnerTimer)
      app.spinnerTimer = null
    }
    if (app.idleRefreshTimer !== null) {
      clearInterval(app.idleRefreshTimer)
      app.idleRefreshTimer = null
    }
    // Unblock pending interactions so the host can drain.
    app.approvalSettle?.('cancelled')
    app.approvalSettle = null
    if (app.questionsResolve) {
      const r = app.questionsResolve
      app.questionsResolve = null
      r.reject(new Error('UI torn down'))
    }
    app.pickerSettle?.(null)
    app.pickerSettle = null
    if (app.activeId !== null) app.recordState(app.activeId)
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
    for (const rec of app.sessions.values()) {
      try {
        await rec.handle.dispose()
      } catch (err) {
        console.error('[dsh-nvim-tui] dispose failed:', err)
      }
    }
    app.sessions.clear()
    app.childParent.clear()
    // Extension surface: broadcast teardown (Node subscribers + nvim-side
    // User DshTuiShutdown autocmd) so extensions release windows/handles
    // BEFORE the nvim window closes. The QUIT path already fired both
    // pre-close (the window is gone by the time teardown runs) — skip there.
    try {
      if (!app.quitting) {
        await app.extNodeCleanup?.()
        app.extFire('tui:teardown', {})
        void app.luaCall('require("dsh_tui.api").emit(...)', ['Shutdown', {}]).catch(() => {})
      }
    } catch {}
    app.extLuaSubs.clear()
    await app.closeNvimWindow()
  }

  /** Explicit quit (user action, nvim exit, fatal error, signals): close the
   *  UI immediately, give graceful persistence a bounded window, then exit —
   *  with a hard fallback in case the launcher's graceful shutdown stalls. */
  app.quit = async (code = 0) => {
    if (app.quitting) return
    app.quitting = true
    app.exitDiag('quit', `code=${code}`, `disposed=${app.disposed}`)
    try {
      // Tell nvim-side extensions BEFORE the window closes — the teardown
      // path below runs after ':qa!' and can no longer reach them. Node-side
      // panel/region slots release first (they hold Lua registry entries).
      try {
        await app.extNodeCleanup?.()
        app.extFire('tui:teardown', {})
        void app.luaCall('require("dsh_tui.api").emit(...)', ['Shutdown', {}]).catch(() => {})
      } catch {}
      await app.closeNvimWindow() // the window closes right away, no waiting on the agent
      await Promise.race([app.teardown(), app.sleep(2500)])
      app.requestExit(code)
    } catch (err) {
      app.exitDiag('quit-error', err instanceof Error ? (err.stack ?? err.message) : String(err))
    }
    // Last resort: whatever hangs (in-flight turn, pending flush, loader
    // shutdown) must not survive this timer.
    setTimeout(() => process.exit(code), 2000)
  }

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
  ctx.effect(() => {
    process.on('SIGTERM', () => onSignal('SIGTERM'))
    process.on('SIGINT', () => onSignal('SIGINT'))
    process.on('SIGHUP', () => onSignal('SIGHUP'))
    return () => {
      process.off('SIGTERM', () => onSignal('SIGTERM'))
      process.off('SIGINT', () => onSignal('SIGINT'))
      process.off('SIGHUP', () => onSignal('SIGHUP'))
      process.off('unhandledRejection', onUnhandledRejection)
      process.off('uncaughtException', onUncaughtException)
      void app.teardown()
    }
  })

  return app
}
