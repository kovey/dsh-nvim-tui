import type { Context } from '@deepseek-ai/cordis';
import type { NeovimClient } from 'neovim';
import type { FeedRenderer } from './feed.js';
import type { ExtEventName, ExtSessionEventFilter, TuiExtApi } from './ext-api.js';
import type { RunnerConfig } from './types.js';
import type { AgentHandle, AgentPresetsService, ApprovalRequest, AttachmentsService, CompactionService, FileReferencesService, GoalsService, GoalState, HarnessSession, JobsService, MessageContent, MessageFeedbackService, ModelSelection, PermissionPresetsService, PlanModeService, RuntimeCtx, SaveImageAttachment, SessionEvent, LoaderService, PluginInventoryService, SessionPersistenceService, SessionProjectionsService, SessionQueryService, SessionReferenceService, SessionTitleService, SettingsService, SkillsService, SubagentInfo, SubagentsService, ToolsService, Usage, WorkspacesService } from './types.js';
/** Version + build stamp shown in the boot banner (proof of which code runs). */
export declare const BUILD_VERSION = "0.2.16";
export declare const BUILD_STAMP: string;
export interface ServiceMap {
    appExit: (code?: number) => void;
    attachments: AttachmentsService;
    subagents: SubagentsService;
    compaction: CompactionService;
    goals: GoalsService;
    planMode: PlanModeService;
    jobs: JobsService;
    skills: SkillsService;
    permissionPresets: PermissionPresetsService;
    fileReferences: FileReferencesService;
    settings: SettingsService;
    tools: ToolsService;
    sessionQuery: SessionQueryService;
    sessionProjections: SessionProjectionsService;
    sessionProjectionCache: SessionProjectionsService;
    pluginInventory: PluginInventoryService;
    loader: LoaderService;
    sessionReferenceResolver: SessionReferenceService;
    sessionTitle: SessionTitleService;
    messageFeedback: MessageFeedbackService;
    sessionPersistence: SessionPersistenceService;
    agentPresets: AgentPresetsService;
    workspaceRegistry: WorkspacesService;
}
/** One slash command: metadata for /help + the completion catalog, plus the
 *  handler. Modules register their own commands with registerCommands(). */
export interface CommandSpec {
    name: string;
    desc: string;
    usage: string;
    group: string;
    fn: (arg: string) => unknown;
}
export interface ModelRef {
    current: ReturnType<ModelSelection['currentSelection']>;
    assembled?: unknown;
}
export interface SessionRec {
    id: string;
    handle: AgentHandle;
    feed: FeedRenderer;
    title: string | undefined;
    status: string | undefined;
    modelRef: ModelRef;
    model: string | undefined;
    createdAt: number;
    usage: Usage | undefined;
    contextWindow: number | undefined;
    mode: string | undefined;
    policy: string | undefined;
    provider: string | undefined;
    cacheReported: boolean;
    lastUsage?: Usage;
    lastAssistantMessageId: string | null;
    goal: GoalState | null;
    planActive: boolean;
    imagePoisonWarned: boolean;
    deliverables: {
        turn: number | undefined;
        paths: string[];
    };
    /** Image turn in flight: previous selection to restore + switch instant. */
    visionTmp: {
        prev: ReturnType<ModelSelection['currentSelection']>;
        switchAt: number;
    } | null;
    /** Instant the most recent turn STARTED (vision restore ordering). */
    lastTurnStartAt: number;
    /** Live background jobs of this session (running + stopping). */
    bgJobs: number;
    todos: {
        completed: number;
        inProgress: number;
        pending: number;
    } | null;
    todosItems: Array<{
        content: string;
        status: string;
    }>;
    runningSince?: number | null;
    /** tool/call events whose tool/result has not arrived yet (live-turn
     *  orphan detection for the duplicate-dsh-tools scheduler crash). */
    pendingToolCalls: Map<string, {
        seq: number;
        turn: unknown;
        step: unknown;
    }>;
    [key: string]: unknown;
}
export interface WorkflowRun {
    id: string;
    name: string;
    startedAt: number;
    phases: Array<{
        title: string;
        startedAt: number;
    }>;
    agents: Array<{
        seq: number;
        label: string;
        outcome?: string;
    }>;
    logs: string[];
    running: boolean;
    stopReason: string | undefined;
}
/** The complete cross-module surface. State lives here; functions that
 *  another module needs are members (filled by the owning module's install,
 *  no-op before that — safe because installs run before boot). */
export interface App {
    ctx: Context;
    runtimeCtx: RuntimeCtx;
    config: RunnerConfig;
    headless: boolean;
    watchdogMs: number;
    dumpPath: string;
    errorLogPath: string;
    nvim: NeovimClient | null;
    child: ReturnType<typeof import('node:child_process')['spawn']> | null;
    channelIdValue: number | null;
    disposed: boolean;
    quitting: boolean;
    chatWinId: number | null;
    reasoningOpen: boolean;
    reasoningWinId: number | null;
    feedDisposer: (() => void) | null;
    hostDisposers: Array<() => void>;
    spinnerTimer: ReturnType<typeof setInterval> | null;
    spinnerIndex: number;
    idleRefreshTimer: ReturnType<typeof setInterval> | null;
    sessions: Map<string, SessionRec>;
    activeId: string | null;
    historyHeaders: Array<{
        id: string;
        cwd?: string;
        createdAt?: number;
        title?: string;
        origin?: string;
        inheritedEventCount?: number;
    }>;
    historyById: Map<string, {
        id: string;
        cwd?: string;
        createdAt?: number;
        title?: string;
        origin?: string;
        inheritedEventCount?: number;
    }>;
    sessionEntries: Array<{
        id: string;
        title: string;
        active: boolean;
        kind: string;
    }>;
    runningSubagents: Map<string, {
        parentId: string;
        label: string;
        startedAt: number;
    }>;
    childParent: Map<string, {
        parentId: string;
        label: string;
    }>;
    pendingFileSnaps: Map<string, {
        display: string;
        before: string | null;
    }>;
    renderedDiffCalls: WeakMap<FeedRenderer, Set<string>>;
    pendingEchoes: Map<string, string[]>;
    workflowRuns: Map<string, WorkflowRun>;
    commandSpecs: CommandSpec[];
    extApi: TuiExtApi;
    extReadyResolve: (() => void) | null;
    extFire: (event: ExtEventName, payload: unknown) => void;
    extSessionSubs: Array<{
        filter: ExtSessionEventFilter;
        cb: (sid: string, ev: SessionEvent) => void;
    }>;
    extDispatchSessionEvent: (sessionId: string, event: SessionEvent) => void;
    /** Lua-side extension registry mirrors: extId → subscribed event kinds
     *  ('all' = unfiltered), fed by dsh-ext-register notifications (P3 uses
     *  it to route the session-event mirror). */
    extLuaSubs: Map<string, Set<string> | 'all'>;
    /** dsh-ext bus: extId → request handler registered by a Node-side
     *  consumer via `luaExt.on` (answered over the shared RPC channel). */
    extNodeHandlers: Map<string, (method: string, args: unknown[]) => unknown | Promise<unknown>>;
    /** Statusline segments contributed by extensions (id → text+priority). */
    extStatusSegments: Map<string, {
        text: string;
        priority: number;
    }>;
    pendingInput: string[];
    pendingImages: Array<SaveImageAttachment | Extract<MessageContent, {
        type: 'image';
    }>>;
    subagentView: {
        childId: string;
        feed: FeedRenderer;
    } | null;
    subagentChat: {
        childId: string;
        parentId: string;
        label: string;
        feed: FeedRenderer;
    } | null;
    pendingSubagentFollowup: {
        childId: string;
        label: string;
    } | null;
    pendingRename: {
        kind: 'workspace';
        id: string;
    } | {
        kind: 'session';
        id: string;
    } | null;
    pendingQueueEdit: {
        list: 'nextTurn' | 'nextStep';
        messageId: string;
    } | null;
    approvalSettle: ((outcome: string) => void) | null;
    approvalReq: ApprovalRequest | null;
    questionsResolve: {
        resolve: (v: {
            answers: unknown[];
        }) => void;
        reject: (e: Error) => void;
    } | null;
    pickerSettle: ((value: string | null) => void) | null;
    dirSettle: ((picked: string | null) => void) | null;
    bellOn: boolean;
    svc: <K extends keyof ServiceMap>(name: K) => ServiceMap[K] | undefined;
    luaCall: (code: string, args?: unknown[]) => Promise<any>;
    lua: {
        ensureChat: (id: string) => Promise<any>;
        ensureReasoning: (id: string) => Promise<any>;
        setActive: (id: string) => Promise<any>;
    };
    requestExit: (code?: number) => void;
    currentSelection: () => ReturnType<ModelSelection['currentSelection']>;
    activeFeed: () => FeedRenderer | undefined;
    notice: (text: unknown) => void;
    openPicker: (title: string, items: Array<{
        label: string;
        value: string;
        active?: boolean;
    }>) => Promise<string | null>;
    guard: (label: string, fn: (...args: any[]) => Promise<unknown>) => (...args: any[]) => Promise<void>;
    sleep: (ms: number) => Promise<void>;
    exitDiag: (kind: string, ...detail: unknown[]) => void;
    quit: (code?: number) => Promise<void>;
    readState: () => unknown;
    recordState: (id: string) => void;
    refreshHistory: () => Promise<void>;
    readFileSnapshot: (p: string) => Promise<string | null>;
    maybePushFileDiff: (feed: FeedRenderer, event: SessionEvent, labelPrefix?: string) => void;
    feedForSubagent: (info: SubagentInfo) => SessionRec | undefined;
    refreshList: () => void;
    registerCommands: (specs: CommandSpec[]) => void;
    commandCatalog: () => Array<{
        name: string;
        desc: string;
    }>;
    refreshCommandCatalog: () => Promise<void>;
    teardown: () => Promise<void>;
    closeNvimWindow: () => Promise<void>;
    foldEvent: (rec: SessionRec, event: SessionEvent) => void;
    updateStatusline: () => void;
    ensureSpinner: () => void;
    refreshBgJobs: () => void;
    runningSubagentsOf: (parentId: string | null) => Array<{
        parentId: string;
        label: string;
        startedAt: number;
    }>;
    sessionEvents: (session: HarnessSession) => SessionEvent[];
    synthesizeToolResult: (rec: SessionRec, callId: string, seq: number | undefined, turn: unknown, step: unknown) => void;
    surfaceReplace: (session: HarnessSession, type: string, seq: number, data: unknown) => void;
    repairOrphanToolCalls: (rec: SessionRec) => number;
    attachSession: (handle: AgentHandle, modelRef: ModelRef) => Promise<void>;
    welcomeLines: () => {
        above: Array<{
            text: string;
            group?: string;
        }>;
        below: Array<{
            text: string;
            group?: string;
        }>;
    };
    createSession: (cwdPath?: string) => Promise<void>;
    resumeSession: (id: string) => Promise<void>;
    updateTitle: () => void;
    switchTo: (id: string) => Promise<void>;
    selectSession: (id: string) => Promise<void>;
    followup: (rec: SessionRec, text: string, images?: Array<SaveImageAttachment | Extract<MessageContent, {
        type: 'image';
    }> | string>) => Promise<void>;
    queueSubagentPrompt: (parentAgent: unknown, childId: string, text: string) => Promise<void>;
    send: (text: string) => void;
    pasteClipboardImage: () => void;
    applyModelSelection: (next: ModelRef['current']) => Promise<void>;
    pickModel: (arg: string | undefined) => Promise<void>;
    stopCommand: () => void;
    openDirPicker: (startPath: string) => Promise<string | null>;
    atQuery: (query: string, start?: number) => Promise<void>;
    forkSession: (directive: string | undefined) => Promise<string | undefined>;
    listSubagentChildren: (parentId: string) => Promise<Array<{
        id: string;
        label: string;
        running: boolean;
        mode: string | undefined;
        createdAt?: number;
    }>>;
    seedRunningSubagents: (parentId: string) => Promise<void>;
    cleanSubagentChain: (parentId: string, childId: string) => Promise<boolean>;
    openSubagentView: (childId: string, label: string) => Promise<void>;
    openSubagentChat: (childId: string, label: string) => Promise<void>;
    sendToSubagent: (text: string) => void;
    onInput: (text: string) => void;
    onCommand: (line: string) => void;
    helpCommand: () => Promise<void>;
    restartCommand: () => void;
    boot: () => Promise<void>;
}
/** Build the App object. All state and core services live here; module-owned
 *  functions start as no-ops and are installed afterwards. `ctx` is the
 *  cordis plugin context (inject/effect); `runtimeCtx` is the injected
 *  runtime with the agent/session services. */
export declare function createApp(ctx: Context, runtimeCtx: RuntimeCtx, config: RunnerConfig): App;
