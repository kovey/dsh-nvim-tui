import type { Context } from '@deepseek-ai/cordis';
import type { NeovimClient } from 'neovim';
import type { FeedRenderer } from '../feed/feed.js';
import type { ExtEventName, ExtSessionEventFilter, TuiExtApi } from './ext-types.js';
import type { RunnerConfig } from './types.js';
import type { AgentHandle, AgentPresetsService, ApprovalRequest, AttachmentsService, CompactionService, DifficultyState, FileReferencesService, GoalsService, GoalState, HarnessSession, JobsService, MessageContent, MessageFeedbackService, ModelSelection, PermissionPresetsService, PlanModeService, RuntimeCtx, SaveImageAttachment, SessionEvent, LoaderService, PluginInventoryService, SessionPersistenceService, SessionProjectionsService, SessionQueryService, SessionReferenceService, SessionTitleService, SettingsService, SkillsService, SubagentInfo, SubagentsService, ToolsService, Usage, WorkspacesService } from './types.js';
/** Version + build stamp shown in the boot banner (proof of which code runs). */
/** The active session's working directory (falls back to the process cwd
 *  when no session is attached) — local-file commands must resolve against
 *  THIS, not process.cwd(): /search can resume a session from another
 *  project directory while the shell cwd stays put. */
export declare const activeSessionCwd: (app: App) => string;
export declare const BUILD_VERSION = "0.3.4";
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
    /** Credential-reference seam: resolve(envRefName) → { value } | undefined
     *  (provider-owned key storage; the official Models page writes it). */
    credentials: {
        resolve?: (ref: string) => Promise<{
            value?: unknown;
        } | undefined>;
    };
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
    /** 难度路由状态（kernel/difficulty.ts）。 */
    difficulty: DifficultyState;
    /** 本回合工具失败次数（难度信号，turn/start 清零）。 */
    toolErrors: number;
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
    /** Jobs board cache: id → last known state (fed by jobs.list + onJobDone;
     *  terminal states survive the live-list drop so the FINAL board can
     *  commit with ✓/✗/⚠ marks). */
    jobsCache: Map<string, {
        label?: string;
        status: string;
        startedAt?: number;
    }>;
    /** Committed batch identity (id:status 排序拼接)：终态板提交一次后，30s
     *  心跳重新拉到的同一批终态任务不得再次提交。 */
    committedJobsKey: string;
    /** id:status of every job already committed to the chat flow — the merge
     *  skips them so a LATER batch finishing cannot re-commit the old board
     *  (pre-review: cache.delete was undone by the next heartbeat's merge). */
    committedJobKeys: Set<string>;
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
/** One queued approval request (head renders the float; the rest wait in
 *  order — parent + subagents can ask CONCURRENTLY). */
export interface ApprovalEntry {
    req: ApprovalRequest;
    settle: (outcome: string) => void;
    cancelled?: boolean;
}
/** One queued user-question waterfall. */
export interface QuestionsEntry {
    questions: unknown[];
    resolve: (v: {
        answers: unknown[];
    }) => void;
    reject: (e: Error) => void;
    cancelled?: boolean;
}
/** Domain slices: the shared runner state, regrouped by domain. The root
 *  App keeps ONLY the kernel primitives; every other piece of state lives
 *  here and modules read/write it through `app.slices.<domain>.<field>`.
 *  New state MUST land in a slice — scripts/check-arch.mjs enforces it.
 */
export interface AppSlices {
    /** nvim process / window lifecycle + boot entry. */
    runtime: {
        readonly nvim: NeovimClient | null;
        readonly child: ReturnType<typeof import('node:child_process')['spawn']> | null;
        readonly channelIdValue: number | null;
        readonly disposed: boolean;
        readonly quitting: boolean;
        readonly chatWinId: number | null;
        readonly reasoningOpen: boolean;
        readonly reasoningWinId: number | null;
        readonly feedDisposer: (() => void) | null;
        readonly hostDisposers: Array<() => void>;
        readonly spinnerTimer: ReturnType<typeof setInterval> | null;
        readonly spinnerIndex: number;
        readonly idleRefreshTimer: ReturnType<typeof setInterval> | null;
        /** /restart requested: the successor spawns in quit() AFTER the old
         *  nvim fully released the terminal and the session logs flushed. */
        readonly restartPending: boolean;
        /** Child exit observed while boot is still connecting (startup config
         *  error): recorded so boot's catch exits non-zero instead of 0. */
        readonly childExitDuringBoot: {
            code: number | null;
            signal: string | null;
        } | null;
        boot: () => Promise<void>;
        /** Owner ops: cross-domain consumers mutate runtime state ONLY here. */
        setChatWin: (id: number | null) => void;
        setReasoning: (open: boolean, win: number | null) => void;
        spinnerSet: (timer: ReturnType<typeof setInterval> | null) => void;
        spinnerStep: (mod: number) => void;
        setRestartPending: (v: boolean) => void;
    };
    /** Sessions, history, active-session state + subagent registry. */
    sessions: {
        readonly live: Map<string, SessionRec>;
        readonly activeId: string | null;
        readonly historyHeaders: Array<{
            id: string;
            cwd?: string;
            createdAt?: number;
            title?: string;
            origin?: string;
            inheritedEventCount?: number;
        }>;
        readonly historyById: Map<string, {
            id: string;
            cwd?: string;
            createdAt?: number;
            title?: string;
            origin?: string;
            inheritedEventCount?: number;
        }>;
        readonly sessionEntries: Array<{
            id: string;
            title: string;
            active: boolean;
            kind: string;
        }>;
        readonly runningSubagents: Map<string, {
            parentId: string;
            label: string;
            startedAt: number;
        }>;
        readonly childParent: Map<string, {
            parentId: string;
            label: string;
        }>;
        refreshHistory: () => Promise<void>;
        refreshList: () => void;
        disposeLiveSession: (id: string) => Promise<void>;
        readState: () => unknown;
        recordState: (id: string) => void;
        createSession: (cwdPath?: string) => Promise<void>;
        resumeSession: (id: string) => Promise<void>;
        updateTitle: () => void;
        switchTo: (id: string) => Promise<void>;
        selectSession: (id: string) => Promise<void>;
        forkSession: (directive: string | undefined) => Promise<string | undefined>;
        attachSession: (handle: AgentHandle, modelRef: ModelRef) => Promise<void>;
        listSubagentChildren: (parentId: string) => Promise<Array<{
            id: string;
            label: string;
            running: boolean;
            mode: string | undefined;
            createdAt?: number;
        }>>;
        seedRunningSubagents: (parentId: string) => Promise<void>;
        cleanSubagentChain: (parentId: string, childId: string) => Promise<boolean>;
        runningSubagentsOf: (parentId: string | null) => Array<{
            parentId: string;
            label: string;
            startedAt: number;
        }>;
    };
    /** Feed rendering / window surface helpers. */
    ui: {
        activeFeed: () => FeedRenderer | undefined;
        feedForSubagent: (info: SubagentInfo) => SessionRec | undefined;
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
        ensureSpinner: () => void;
        updateStatusline: () => void;
        refreshBgJobs: () => void;
        foldEvent: (rec: SessionRec, event: SessionEvent) => void;
        maybePushFileDiff: (feed: FeedRenderer, event: SessionEvent, labelPrefix?: string) => void;
        readFileSnapshot: (p: string) => Promise<string | null>;
        readonly pendingFileSnaps: Map<string, {
            display: string;
            before: string | null;
        }>;
        readonly renderedDiffCalls: WeakMap<FeedRenderer, Set<string>>;
        readonly pendingEchoes: Map<string, string[]>;
    };
    /** Extension surface (ext-api.ts owns; installs run before boot). */
    ext: {
        extApi: TuiExtApi;
        readonly extReadyResolve: (() => void) | null;
        extFire: (event: ExtEventName, payload: unknown) => void;
        readonly extSessionSubs: Array<{
            filter: ExtSessionEventFilter;
            cb: (sid: string, ev: SessionEvent) => void;
        }>;
        extDispatchSessionEvent: (sessionId: string, event: SessionEvent) => void;
        readonly extLuaSubs: Map<string, Set<string> | 'all'>;
        extNodeCleanup: (() => void | Promise<void>) | null;
        readonly pendingCardInput: {
            mark: number;
            actionIdx: number;
            prompt: string;
        } | null;
        readonly extNodeHandlers: Map<string, {
            handler: (method: string, args: unknown[]) => unknown | Promise<unknown>;
            timeoutMs: number;
            token?: symbol;
        }>;
        readonly extStatusSegments: Map<string, {
            text: string;
            priority: number;
        }>;
        /** Owner ops: cross-domain consumers mutate ext state ONLY here. */
        setPendingCardInput: (v: {
            mark: number;
            actionIdx: number;
            prompt: string;
        } | null) => void;
        fireExtReady: () => boolean;
    };
    /** Transcript / event-stream reconstruction. */
    trans: {
        sessionEvents: (session: HarnessSession) => SessionEvent[];
        synthesizeToolResult: (rec: SessionRec, callId: string, seq: number | undefined, turn: unknown, step: unknown) => void;
        surfaceReplace: (session: HarnessSession, type: string, seq: number, data: unknown) => void;
        repairOrphanToolCalls: (rec: SessionRec) => number;
        readonly workflowRuns: Map<string, WorkflowRun>;
    };
    /** Agent interaction: commands, input routing, pending UI, subagent chat. */
    agent: {
        followup: (rec: SessionRec, text: string, images?: Array<SaveImageAttachment | Extract<MessageContent, {
            type: 'image';
        }> | string>) => Promise<void>;
        queueSubagentPrompt: (parentAgent: unknown, childId: string, text: string) => Promise<void>;
        send: (text: string) => void;
        pasteClipboardImage: () => void;
        applyModelSelection: (next: ModelRef['current']) => Promise<void>;
        pickModel: (arg: string | undefined) => Promise<void>;
        stopCommand: () => void;
        onInput: (text: string) => void;
        onCommand: (line: string) => void;
        helpCommand: () => Promise<void>;
        restartCommand: () => void;
        openDirPicker: (startPath: string) => Promise<string | null>;
        atQuery: (query: string, start?: number) => Promise<void>;
        currentSelection: () => ReturnType<ModelSelection['currentSelection']>;
        commandSpecs: CommandSpec[];
        readonly pendingInput: string[];
        readonly pendingImages: Array<SaveImageAttachment | Extract<MessageContent, {
            type: 'image';
        }>>;
        readonly pendingRename: {
            kind: 'workspace';
            id: string;
        } | {
            kind: 'session';
            id: string;
            background?: boolean;
        } | null;
        readonly pendingQueueEdit: {
            list: 'nextTurn' | 'nextStep';
            messageId: string;
        } | null;
        readonly approvalSettle: ((outcome: string) => void) | null;
        readonly approvalReq: ApprovalRequest | null;
        /** Queue for CONCURRENT approval requests (parent + subagents can both
         *  ask): the head renders the float; the rest wait in order. */
        readonly approvalQueue: ApprovalEntry[];
        readonly questionsResolve: {
            resolve: (v: {
                answers: unknown[];
            }) => void;
            reject: (e: Error) => void;
        } | null;
        /** Queue for CONCURRENT user-question waterfalls (same head/tail split). */
        readonly questionsQueue: QuestionsEntry[];
        enqueueApproval: (e: ApprovalEntry) => void;
        abortApproval: (e: ApprovalEntry) => void;
        drainApprovals: (outcome: string) => void;
        enqueueQuestions: (e: QuestionsEntry) => void;
        abortQuestions: (e: QuestionsEntry) => void;
        drainQuestions: () => void;
        readonly pickerSettle: ((value: string | null) => void) | null;
        readonly dirSettle: ((picked: string | null) => void) | null;
        readonly bellOn: boolean;
        readonly subagentView: {
            childId: string;
            feed: FeedRenderer;
        } | null;
        readonly subagentChat: {
            childId: string;
            parentId: string;
            label: string;
            feed: FeedRenderer;
        } | null;
        readonly pendingSubagentFollowup: {
            childId: string;
            label: string;
        } | null;
        openSubagentView: (childId: string, label: string) => Promise<void>;
        openSubagentChat: (childId: string, label: string) => Promise<void>;
        sendToSubagent: (text: string) => void;
        /** Owner ops: cross-domain consumers mutate agent state ONLY here. */
        setApproval: (entry: ApprovalRequest | null, settle: ((outcome: string) => void) | null) => void;
        settleApproval: (outcome: string) => void;
        setPickerSettle: (fn: ((value: string | null) => void) | null) => void;
        settlePicker: (value: string | null) => void;
        setQuestions: (r: {
            resolve: (v: {
                answers: unknown[];
            }) => void;
            reject: (e: Error) => void;
        } | null) => void;
        settleQuestions: (answers: unknown[]) => void;
        rejectQuestions: (reason?: string) => void;
        setDirSettle: (fn: ((picked: string | null) => void) | null) => void;
        resolveDirPicker: (picked: string | null) => void;
        setPendingRename: (v: {
            kind: 'workspace';
            id: string;
        } | {
            kind: 'session';
            id: string;
            background?: boolean;
        } | null) => void;
        setPendingQueueEdit: (v: {
            list: 'nextTurn' | 'nextStep';
            messageId: string;
        } | null) => void;
        setSubagentView: (v: {
            childId: string;
            feed: FeedRenderer;
        } | null) => void;
        setSubagentChat: (v: {
            childId: string;
            parentId: string;
            label: string;
            feed: FeedRenderer;
        } | null) => void;
        readonly livePopup: {
            kind: 'jobs' | 'todo';
            update: (items: Array<{
                label: string;
                value: string;
            }>) => void;
        } | null;
        setLivePopup: (v: {
            kind: 'jobs' | 'todo';
            update: (items: Array<{
                label: string;
                value: string;
            }>) => void;
        } | null) => void;
        /** Clear the transient input-flow state (rename/queue-edit prompts,
         *  pending images, subagent followup) — session switches use it so a
         *  half-finished flow never leaks into the next session. */
        clearPendings: () => void;
    };
}
/** Writable view of one slice — owners cast to it inside their own
 *  files; every other file sees readonly state and must go through the
 *  domain ops. */
export type WritableSlice<T> = {
    -readonly [K in keyof T]: T[K];
};
/** The complete cross-module surface: kernel primitives + the domain
 *  slices. Nothing else may live on the root (check-arch.mjs guards). */
export interface App {
    ctx: Context;
    runtimeCtx: RuntimeCtx;
    config: RunnerConfig;
    headless: boolean;
    watchdogMs: number;
    dumpPath: string;
    errorLogPath: string;
    svc: <K extends keyof ServiceMap>(name: K) => ServiceMap[K] | undefined;
    luaCall: (code: string, args?: unknown[]) => Promise<any>;
    lua: {
        ensureChat: (id: string) => Promise<any>;
        ensureReasoning: (id: string) => Promise<any>;
        setActive: (id: string) => Promise<any>;
    };
    requestExit: (code?: number) => void;
    notice: (text: unknown) => void;
    openPicker: (title: string, items: Array<{
        label: string;
        value: string;
        active?: boolean;
    }>) => Promise<string | null>;
    /** Live picker: same float, but `update` re-renders the OPEN popup in
     *  place (jobs/todo lists refresh their statuses without closing). */
    openLivePicker: (title: string, items: Array<{
        label: string;
        value: string;
    }>) => {
        pick: Promise<string | null>;
        update: (items: Array<{
            label: string;
            value: string;
        }>) => void;
    };
    guard: (label: string, fn: (...args: any[]) => Promise<unknown>) => (...args: any[]) => Promise<void>;
    sleep: (ms: number) => Promise<void>;
    exitDiag: (kind: string, ...detail: unknown[]) => void;
    quit: (code?: number) => Promise<void>;
    teardown: () => Promise<void>;
    closeNvimWindow: () => Promise<void>;
    /** Command registry (kernel bootstrap facility: every module registers
     *  its specs at install time, so the mechanism exists from t=0). */
    registerCommands: (specs: CommandSpec[]) => CommandSpec[];
    commandCatalog: () => Array<{
        name: string;
        desc: string;
    }>;
    refreshCommandCatalog: () => Promise<void>;
    /** Registered command specs — the kernel registry's storage (modules
     *  register at install time, so it must live from t=0). */
    commandSpecs: CommandSpec[];
    /** The domain slices (the physical state home). */
    slices: AppSlices;
}
/** Build the App object. All state and core services live here; module-owned
 *  functions start as no-ops and are installed afterwards. `ctx` is the
 *  cordis plugin context (inject/effect); `runtimeCtx` is the injected
 *  runtime with the agent/session services. */
export declare function createApp(ctx: Context, runtimeCtx: RuntimeCtx, config: RunnerConfig): App;
