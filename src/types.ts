import type { Context } from '@deepseek-ai/cordis'

/**
 * Shared type layer for the dsh-nvim-tui runner.
 *
 * Session events, host event payloads, and the structural service
 * interfaces this bundle consumes from the harness runtime. Everything is
 * declared LOCALLY (structural) on purpose: the services are assembled by
 * the host profile at runtime and are not package dependencies of this
 * bundle, so the emitted .d.ts must not reference packages consumers may
 * not have installed (the exception: peer/eco packages like cordis are
 * always present in a dsh host).
 *
 * @module dsh-nvim-tui/types
 */

/** One TokenUsage record (disjoint counters, folded per session). */
export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** Session usage accumulator (stats.js). */
export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Durable image attachment reference (dsh-attachment). */
export interface ImageAttachmentRef {
  mediaType: string
  bytes?: number
  width?: number
  height?: number
  [key: string]: unknown
}

/** One message content block. */
export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; attachment: ImageAttachmentRef }
  | { type: string; [key: string]: unknown }

/**
 * Producer attribution for a message (dsh-llm MessageSource, structural).
 * `kind` answers WHO produced it ('user' human / 'plugin' host-injected /
 * 'model' / 'tool'); `form` answers WHAT KIND of thing it is (instructions /
 * catalog / snapshot / notice / relay / recall — semantic, never visual).
 * A `notice` form collapses to its one-line `summary`.
 */
export interface MessageSourceLike {
  kind?: string
  form?: string
  summary?: string
  plugin?: string
  [key: string]: unknown
}

/** A chat message (assistant messages carry id/usage; results carry source). */
export interface ChatMessage {
  id?: string
  content?: MessageContent[]
  text?: string
  usage?: TokenUsage
  source?: { callId?: string; [key: string]: unknown }
  [key: string]: unknown
}

/** Streaming chunk from the LLM adapter. */
export type AssistantChunk =
  | { type: 'reasoning-delta'; text: string }
  | { type: 'text-delta'; text: string }
  | { type: 'finish'; reason: {
      kind: string
      failure?: { message?: string; [key: string]: unknown }
      error?: { message?: string; [key: string]: unknown }
      [key: string]: unknown
    } }

/** One session-log event. `data` IS the message for user/message variants.
 *  Only the event kinds this bundle consumes are members — the union doubles
 *  as the discriminator for switch/=== narrowing (no catch-all member, which
 *  would defeat narrowing). Unknown kinds arrive as `unknown` and are
 *  dropped by the default branch. */
type SessionEventBase = { time?: number; seq?: number }
export type SessionEvent =
  | (SessionEventBase & { type: 'turn/start'; data?: { turn?: number; [key: string]: unknown } })
  | (SessionEventBase & { type: 'turn/end'; data?: Record<string, unknown> })
  | (SessionEventBase & { type: 'user/message'; data?: ChatMessage | { message?: ChatMessage } })
  | (SessionEventBase & { type: 'assistant/message'; data?: { turn?: number; step?: number; message?: ChatMessage; usage?: TokenUsage; interrupted?: true } })
  | (SessionEventBase & { type: 'assistant/chunk'; data?: { turn?: number; step?: number; chunk?: AssistantChunk } })
  | (SessionEventBase & { type: 'tool/call'; data?: { turn?: number; step?: number; callId?: string; name?: string; arguments?: string } })
  | (SessionEventBase & { type: 'tool/result'; data?: { turn?: number; step?: number; message?: ChatMessage; error?: { code?: string; name?: string; [key: string]: unknown } | null } })
  | (SessionEventBase & { type: 'session/title'; data?: { title?: string } })
  | (SessionEventBase & { type: 'agent/status'; data?: { status?: string } })
  | (SessionEventBase & { type: 'request/context'; data?: { contextWindow?: number; provider?: string } })
  | (SessionEventBase & { type: 'sandbox/mode'; data?: { mode?: string } })
  | (SessionEventBase & { type: 'approval/policy'; data?: { policy?: string } })
  | (SessionEventBase & { type: 'plan/mode'; data?: { active?: boolean } })
  | (SessionEventBase & { type: 'goal/change'; data?: { goal?: unknown } })
  | (SessionEventBase & { type: 'todo/write'; data?: { todos?: Array<{ content: string; status: string }> } })
  | (SessionEventBase & { type: 'compaction/start'; data?: { compactionId?: string; sourceCommandId?: string } })
  | (SessionEventBase & { type: 'compaction/summary'; data?: { compactionId?: string; sourceCommandId?: string; summary?: string | Array<{ type?: string; text?: string }>; shadowedSeqs?: number[]; shadowedTokenCount?: number } })
  | (SessionEventBase & { type: 'compaction/end'; data?: { compactionId?: string } })
  | (SessionEventBase & { type: 'llm/retry'; data?: { retryId?: string; retry?: number; maxRetries?: number; mode?: string; delayMs?: number; failure?: { message?: string; code?: string; [k: string]: unknown } } })
  | (SessionEventBase & { type: 'llm/retry-started'; data?: { retryId?: string; retry?: number } })
  | (SessionEventBase & { type: 'tool-workflow/run-start'; data?: { runId?: string; name?: string } })
  | (SessionEventBase & { type: 'tool-workflow/agent-start'; data?: { runId?: string; seq?: number; label?: string; phase?: string; childId?: string } })
  | (SessionEventBase & { type: 'tool-workflow/agent-end'; data?: { runId?: string; seq?: number; outcome?: string } })
  | (SessionEventBase & { type: 'tool-workflow/run-end'; data?: { runId?: string; stopReason?: string } })

/** agent/status host event payload. */
export interface AgentStatusPayload {
  agent?: { session?: { id?: string } }
  status?: string
}

/** subagent/start / subagent/end payload. */
export interface SubagentInfo {
  runId?: string
  provider?: string
  id?: string
  stopReason?: string
}

/** workflow/start payload. */
export interface WorkflowInfo {
  id?: string
  meta?: { name?: string; [key: string]: unknown }
  [key: string]: unknown
}

/** workflow/end result. */
export interface WorkflowResult {
  stopReason?: string
  error?: string
}

/** approval/request payload. */
export interface ApprovalRequest {
  toolName?: string
  reason?: string
  agent?: { session?: { id?: string } }
  signal?: { addEventListener: (ev: string, cb: () => void, opts?: unknown) => void; removeEventListener?: (ev: string, cb: () => void) => void }
}

/** One user question (userQuestions service). */
export interface UserQuestion {
  id: string
  question: string
  detail?: string
  header?: string
  multiSelect?: boolean
  options?: Array<{ label: string; description?: string }>
}

// ---------------------------------------------------------------------------
// Service surfaces (structural — what this bundle actually calls)
// ---------------------------------------------------------------------------

/** Symbol-keyed host prompt queue on the dsh-subagent service instance
 *  (Symbol.for('dsh.subagent.queuePrompt')): queue one human prompt as a
 *  distinct child turn. Signature: (parentAgent, childId, content, source,
 *  signal) → inbox MessageId. The service exposes NO public method name for
 *  this face — only the symbol. */
export const queueSubagentPromptKey: symbol = Symbol.for('dsh.subagent.queuePrompt')

/** dsh-subagent directory service. */
export interface SubagentsService {
  listChildren?: (parentSessionId: string) => Promise<Array<{
    kind?: string
    id: string
    label?: string
    activity?: string
    mode?: string
    reason?: string
    hasChildren?: boolean
  }>>
  /** Host prompt queue + other symbol-keyed runtime faces. */
  [key: symbol]: unknown
}

/** dsh-session-persistence: history list + read-only inspection. */
export interface SessionPersistenceService {
  list?: () => Promise<Array<{
    id: string
    cwd?: string
    origin?: string
    parentSession?: string
    createdAt?: number
    title?: string
  }>>
  inspect?: (id: string) => Promise<{ events?: unknown[] } | undefined>
  truncateStored?: (id: string, seq: unknown) => Promise<unknown> | unknown
}

/** dsh-attachment durable image save. */
export interface AttachmentsService {
  saveImage: (img: SaveImageAttachment) => Promise<ImageAttachmentRef>
  imageLimits?: { maxImagesPerMessage?: number }
}

/** Input-side image shape (bytes + type + optional name). */
export interface SaveImageAttachment {
  data: Uint8Array
  mediaType: string
  name?: string
}

/** dsh-compaction service (compactNow is called with the live agent). */
export interface CompactionService {
  compactNow: (
    agent: unknown,
    signal: AbortSignal,
    sourceCommandId?: string,
  ) => Promise<{ shadowedSeqs: unknown[]; shadowedTokenCount: number } | null>
}

/** dsh-goal service. */
export interface GoalState {
  id: string
  revision: number
  objective: string
  phase: string
  blockedReason?: { message: string }
  roundsStarted: number
  maxGoalRounds: number
  activation: string
}
export interface GoalsService {
  get: (agent: unknown) => GoalState | undefined
  create: (agent: unknown, opts: { objective: string }) => void
  pause: (agent: unknown, ref?: { id: string; revision: number }) => void
  resume: (agent: unknown, ref?: { id: string; revision: number }) => void
  complete: (agent: unknown, ref?: { id: string; revision: number }) => void
  clear: (agent: unknown, ref?: { id: string; revision: number }) => void
}

/** dsh-plan-mode service. */
export interface PlanModeService {
  get: (agent: unknown) => { active: boolean; pending?: boolean }
  set: (agent: unknown, on: boolean) => string
}

/** dsh-jobs service (workflow/job registry). */
export interface JobsService {
  kill: (jobId: string, agent: unknown, reason: string) => string
  list: (agent: unknown) => Array<{ id: string; label?: string; status: string; startedAt?: number }>
  /** Effect-scoped observer: fires after every visible-set commit. */
  onJobsChanged?: (listener: (owner: unknown) => void) => () => void
  /** Effect-scoped completion listener: terminal snapshot + exact owner. */
  onJobDone?: (listener: (snap: { label?: string; status?: string }, owner: unknown) => void) => () => void
}

/** dsh-skill service. */
export interface SkillsService {
  get: (name: string, scope: { scope: unknown }) => Promise<SkillDef | undefined>
  list: (scope: { scope: unknown }) => Promise<SkillDef[]>
}

export interface SkillDef {
  name: string
  description?: string
  whenToUse?: string
  content?: string
}

/** dsh-permission-presets service. */
export interface PermissionPresetsService {
  names: Iterable<string>
  set: (session: unknown, name: string) => void
  current: (session: unknown) => string
  optionOf: (name: string) => { value?: string; name?: string; description?: string } | undefined
}

/** The cordis loader service (in-process entry listing). */
export interface LoaderService {
  entries?: () => Array<{ id: string; options?: { name?: string; group?: string }; disabled?: boolean }>
}

/** dsh-host-plugin-inventory (read-only loader entry projection).
 *  0.1.2-alpha.2: list() is async. */
export interface PluginInventoryService {
  list?: () => Promise<{ entries?: Array<{ entryId: string; moduleName: string; enabled: boolean; fiberPhase: string }>; agentPresets?: unknown }>
}

/** dsh-session-projection registry (whole-log projection reads). */
export interface SessionProjectionsService {
  stateOf?: (session: unknown, key: string) => unknown
  snapshot?: (session: unknown) => Record<string, unknown>
}

/** dsh-workspace registry (workspace grouping + session archive). */
export interface WorkspaceEntityLike {
  id: string
  path: string
  title: string
  sessionIds: readonly string[]
  setTitle?: (title: string) => Promise<void>
}
export interface WorkspacesService {
  list: () => WorkspaceEntityLike[]
  create?: (path: string, title?: string) => Promise<{ id: string }>
  delete?: (id: string) => Promise<boolean>
  archiveSession?: (sessionId: string) => Promise<void>
  archivedSessionIds?: readonly string[]
}

/** dsh-session-reference resolver (in-process candidate listing). */
export interface SessionReferenceService {
  listCandidates?: (agent: unknown, query?: string, limit?: number, signal?: AbortSignal) => Promise<Array<{
    sessionId: string
    label: string
    cwd?: string
    createdAt: number
    sameWorkspace?: boolean
  }>>
}

/** dsh-file-reference service. */
export interface FileReferencesService {
  list?: (agent: unknown, query: string, signal: AbortSignal) => Promise<Array<{ path: string }>>
}

/** dsh-settings service. */
export interface SettingsService {
  update?: (ns: string, patch: Record<string, unknown>, expectedRevision?: number) => Promise<void>
  prepareDocument?: () => Promise<string | undefined>
  describe?: (opts?: { redactSecrets?: boolean }) => Array<{
    ns?: string
    schema?: unknown
    value?: unknown
    revision?: unknown
    [k: string]: unknown
  }>
  documentPath?: string
  writable?: boolean
}

/** dsh-tools (MCP) service. */
export interface ToolsService {
  schemas: (agent: unknown) => Array<{ name: string }>
}

/** dsh-session-query service. */
export interface SessionQueryService {
  searchSessions: (opts: {
    query: string
    eventFilters?: unknown[]
    limit: number
  }) => Promise<{ items?: Array<{ header?: { id?: string; [key: string]: unknown }; live?: boolean; persisted?: boolean; bestMatch?: { snippet?: string } }> }>
}

/** dsh-session-title service. */
export interface SessionTitleService {
  rename: (session: unknown, title: string) => void
}

/** dsh-message-feedback service. */
export interface MessageFeedbackService {
  list: (opts: { sessionId: string }) => Promise<{ ok: boolean; value: { items: Array<{ messageId: string; version?: unknown }> } }>
  delete: (opts: { sessionId: string; messageId: string; ifVersion: unknown }) => Promise<unknown>
  put: (opts: {
    sessionId: string
    messageId: string
    rating: string
    note?: string
    ifVersion: unknown
  }) => Promise<{ ok: boolean; error?: { code?: string } }>
}

/** dsh-user-questions waterfall request (0.1.2-alpha.2: `user-questions/request` event). */
export interface UserQuestionRequest {
  questions?: UserQuestion[]
  agent?: { session?: { id?: string } }
  signal?: AbortSignal
}

/** dsh-user-questions answer (the waterfall's resolved value). */
export interface UserQuestionAnswer {
  answers: Array<{ id: string; selected?: string[]; custom?: string }>
}

/** dsh-agent-presets service. */
export interface AgentPresetsService {
  list?: () => Promise<Array<{ id: string; name?: string }>>
  recompose?: (agentCtx: unknown, presetId: string) => Promise<{ id: string }>
}

/** A live session record from the harness store. */
export interface HarnessSession {
  id: string
  header?: {
    parentSession?: string
    origin?: string
    createdAt?: number
    cwd?: string
    [key: string]: unknown
  }
  /** alpha.4+: the full immutable event log (replaced the removed `events`). */
  snapshotEvents?: () => SessionEvent[]
  /** pre-alpha.4 hosts: public `events` property (removed by the alpha.4
   *  SessionSeq 品牌化重构). */
  events?: SessionEvent[]
  append: (type: string, data: unknown, opts?: {
    surfaceOp?: 'append' | { op: 'replace'; start: number; end: number }
    sourceEventSeqs?: number[]
  }) => unknown
  [key: string]: unknown
}

/** The harness session store. */
export interface SessionStore {
  get: (id: string) => HarnessSession | undefined
  list: () => HarnessSession[]
  flush: (session: HarnessSession) => Promise<unknown>
  fork: (parentId: string) => HarnessSession
}

/** The agent inbox projection (queued next-turn / next-step messages). */
export interface InboxLike {
  nextTurn?: readonly unknown[]
  nextStep?: readonly unknown[]
  remove?: (messageId: string) => boolean
  replace?: (messageId: string, newMessage: unknown) => boolean
  clear?: () => void
}

/** An owned live agent handle. */
export interface AgentHandle {
  agent: {
    session: HarnessSession
    status?: string
    cancel: (cause: unknown) => void
    followup: (message: unknown) => void
    steer: (directive: unknown) => void
    inbox?: InboxLike
    [key: string]: unknown
  }
  dispose: () => Promise<unknown>
}

/** The harness agents service. */
export interface AgentsService {
  create: (options: {
    sessionId: string
    meta?: Record<string, unknown>
    agentOptions?: Record<string, unknown>
    seed?: unknown[]
    /** alpha.4+: exact fork-inherited prefix length (pairs with meta.isSeeded). */
    inheritedEventCount?: number
    setup?: (agentCtx: Context) => void
  }) => Promise<AgentHandle>
  resume: (options: {
    resumeSessionId: string
    agentOptions?: Record<string, unknown>
    setup?: (agentCtx: Context) => void
  }) => Promise<AgentHandle>
}

/** dsh-agent-default-model selection. */
export interface ModelSelection {
  currentSelection: () => { provider: string; model: string; reasoningEffort?: string; [key: string]: unknown }
  saveSelection: (next: unknown) => Promise<unknown>
}

/** LLM service (model info / providers). */
export interface LlmService {
  resolveModelInfo: (provider: string, model: string) => Promise<{ inputModalities?: string[] } | undefined>
  listProviders: () => Array<{ id?: string; name?: string; provider?: string }>
  listConfigurableProviders?: () => Array<{ provider?: string; displayName?: string; settingsNs?: string }>
}

/**
 * The harness runtime context as consumed by this bundle: the cordis context
 * narrowed to the injected services (sessions/agents/agentDefaultModel) plus
 * the loosely-typed service registry and event bus.
 */
export interface RuntimeCtx {
  get(name: string): unknown
  on(name: string, cb: (...args: any[]) => unknown): () => void
  sessions: SessionStore
  agents: AgentsService
  agentDefaultModel: ModelSelection
  llm?: LlmService
}

/** Runner configuration (cordis.patch.yml `config:` block / RunnerConfig row).
 *  Also accepts arbitrary extra keys (forwarded to module configs). */
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
