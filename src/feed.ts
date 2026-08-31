/**
 * FeedRenderer: maps DSH session/event transcript events into the nvim chat
 * buffer. Pure presentation — keeps a line model in memory and syncs it to
 * the buffer, throttled.
 *
 * Model:
 *  - `base`: committed RAW lines (markup included; parsed at flush)
 *  - `tail`: the currently streaming assistant text (rewritten in place, so a
 *    full `assistant/message` naturally replaces the streamed prefix)
 *  - `calls`: tool/call records paired with their tool/result (elapsed, error)
 *
 * Rendering:
 *  - Incremental `nvim_buf_set_lines`: the view is diffed against the last
 *    flushed view and only changed rows are rewritten.
 *  - Role highlights (user/notice/tool/error/subagent/workflow) are derived
 *    from line prefixes; inline `**bold**` / `` `code` `` / ```fences``` are
 *    stripped in the buffer and rendered as extmark spans; markdown tables
 *    become aligned box-drawing tables (lib/table.js). The whole highlight
 *    pass for a flush runs as ONE Lua RPC.
 *
 * Concurrency contract:
 *  - `nvim_buf_set_lines` is the only blocking step of a flush.
 *  - Cursor moves and statusline writes are fire-and-forget: a wedged RPC must
 *    never block the feed.
 *  - Events arriving during a flush set `dirty`; the flush chains a follow-up.
 */
import { NeovimClient } from 'neovim'
import { whaleFrames, whaleRowsIndented } from './whale.js'

import { transformTables } from './table.js'
import { imageLabel } from './images.js'
import { formatElapsed, formatTokens } from './stats.js'
import { t } from './i18n.js'
import type { ChatMessage, ImageAttachmentRef, MessageContent, SessionEvent } from './types.js'

const INLINE_RE = /(\*\*[^*]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\))/g
/** Exact ✎ diff header: ✎ (新增|修改|删除) <path> (+N −M) — the ONLY line
 *  that may open a diff region (random '✎ …' content stays plain). */
const DIFF_HEADER_RE = /^✎ \S+ (.+) \(\+\d+ −\d+\)$/
const FENCE_RE = /^\s*```/
const HEADING_RE = /^(#{1,6})\s+/
const QUOTE_RE = /^>\s?/

/** UTF-8 byte length — nvim highlight columns are byte-indexed. */
const utf8Len = (s: string): number => Buffer.byteLength(s, 'utf8')

/** Inline highlight span (byte offsets into the rendered line). */
export interface Span {
  s: number
  e: number
  group: string
}

/** One parsed view row (markup stripped, spans byte-indexed). */
export interface ParsedLine {
  text: string
  spans: Span[]
  code: boolean
  fenceToggled: boolean
  group?: string
}

const ROLE_BY_PREFIX: Array<[RegExp, string]> = [
  [/^> /, 'DshTuiUser'],
  [/^➤ /, 'DshTuiUser'],
  [/^· /, 'DshTuiNotice'],
  [/^·· /, 'DshTuiReasoning'],
  [/^── /, 'DshTuiDivider'],
  [/^⚠ /, 'DshTuiError'],
  [/^🔧 /, 'DshTuiTool'],
  [/^✓ /, 'DshTuiTool'],
  [/^✗ /, 'DshTuiTool'],
  [/^◇ /, 'DshTuiSubagent'],
  [/^◈ /, 'DshTuiWorkflow'],
]

export interface FeedOptions {
  flushDelayMs?: number
  idsProvider?: (() => Promise<unknown>) | null
  activeChecker?: (() => boolean) | null
  reasoningBuf?: number | null
  reasoningView?: (() => { open: boolean; win: number | null } | null) | null
  inlineReasoning?: boolean
  /** Blue whale wallpaper/watermark (default off; the runner enables it). */
  whale?: boolean
  /** Empty-state welcome block: lines ABOVE the whale (big banner + title)
   *  and lines BELOW it (usage hints); rows may carry a highlight group. */
  welcome?: () => { above?: WelcomeLine[]; below?: WelcomeLine[] }
}

export interface WelcomeLine {
  text: string
  group?: string
}

interface ToolCallRecord {
  name: string
  startedAt: number
}

export class FeedRenderer {
  nvim: NeovimClient
  bufId: number
  winId: number
  flushDelayMs: number
  idsProvider: (() => Promise<unknown>) | null
  // Only the ACTIVE session may move the shared chat window's cursor.
  activeChecker: () => boolean
  // Activity panel: reasoning stream + tool records go to this buffer; the
  // chat only shows ONE compact progress line. reasoningView() -> {open, win}.
  reasoningBuf: number | null
  reasoningView: () => { open: boolean; win: number | null } | null
  // Read-only replays without a panel (subagent view): reasoning blocks
  // render INLINE in the chat stream instead of only a record line.
  inlineReasoning: boolean
  panelLines: string[] // committed panel content (reasoning blocks + tools)
  panelFlushed: number // rows already written (complete lines)
  panelVersion: number
  lastPanelVersion: number
  toolActivity: { name: string; startedAt: number } | null // while a tool is running
  base: string[]
  tail: string
  // Reasoning (model thinking) stream: rendered dim between base and tail
  // while open, committed to base when the first answer text / tool arrives.
  reasoningTail: string
  reasoningStartedAt: number | null
  // "The model is working" placeholder: turn started but nothing rendered yet.
  turnStartedAt: number | null
  turnMarkerBase: number | null
  calls: Map<string, ToolCallRecord> // callId -> { name, startedAt }
  subagents: Map<string, { provider: string; startedAt: number }> // runId -> …
  timer: ReturnType<typeof setTimeout> | null
  flushing: Promise<void> | null
  tokenNs: number | null // treesitter highlight marks (feed ns + separate)
  lastActivityCount: number // transient activity rows in the previous view
  dirty: boolean
  ns: number | null // extmark namespace, created on first flush
  lastView: string[] // last flushed buffer text, diffed per flush
  dense: boolean // /density: compact tool cards (title line only)
  whale: boolean // blue whale wallpaper (empty) + watermark (content)
  welcome: (() => { above?: WelcomeLine[]; below?: WelcomeLine[] }) | null // empty-state hero block
  whaleFrame: number // animation frame index (wallpaper only)
  whaleTicker: ReturnType<typeof setInterval> | null
  ticker: ReturnType<typeof setTimeout> | null
  eventTime: number

  constructor(nvim: NeovimClient, bufId: number, winId: number, {
    flushDelayMs = 40,
    idsProvider = null,
    activeChecker = null,
    reasoningBuf = null,
    reasoningView = null,
    inlineReasoning = false,
    whale = false,
    welcome,
  }: FeedOptions = {}) {
    this.nvim = nvim
    this.bufId = bufId
    this.winId = winId
    this.flushDelayMs = flushDelayMs
    this.idsProvider = idsProvider
    this.activeChecker = activeChecker ?? (() => true)
    this.whale = whale
    this.welcome = welcome ?? null
    this.whaleFrame = 0
    this.whaleTicker = null
    this.reasoningBuf = reasoningBuf
    this.reasoningView = reasoningView ?? (() => null)
    this.inlineReasoning = inlineReasoning
    this.panelLines = []
    this.panelFlushed = 0
    this.panelVersion = 0
    this.lastPanelVersion = -1
    this.toolActivity = null
    this.base = []
    this.tail = ''
    this.reasoningTail = ''
    this.reasoningStartedAt = null
    this.turnStartedAt = null
    this.turnMarkerBase = null
    this.calls = new Map()
    this.subagents = new Map()
    this.timer = null
    this.flushing = null
    this.tokenNs = null
    this.lastActivityCount = 0
    this.dirty = false
    this.ns = null
    this.lastView = []
    this.dense = false
    this.ticker = null
    this.eventTime = 0
  }

  /** Clear the transcript (the /clear command). */
  clear(): void {
    this.base = []
    this.tail = ''
    this.reasoningTail = ''
    this.reasoningStartedAt = null
    this.turnStartedAt = null
    this.turnMarkerBase = null
    this.calls.clear()
    this.toolActivity = null
    if (this.ticker !== null) clearTimeout(this.ticker)
    if (this.reasoningBuf !== null) {
      this.panelLines = []
      this.panelFlushed = 0
      this.panelVersion++
    }
    this.schedule()
  }

  /** Notice line (runner lifecycle, status). Multi-line text (e.g. an error
   *  message with a stack trace) is collapsed to ONE line: a string with
   *  embedded newlines fed to nvim_buf_set_lines throws E5108 and kills the
   *  whole flush — the /subagents E95 failure notice was invisible this way
   *  and every later render that included it silently failed. */
  appendNotice(text: unknown): void {
    const clean = String(text).replace(/\s+/g, ' ').trim()
    this.base.push(`· ${clean}`)
    this.schedule()
  }

  pushBlock(role: string, text: string): void {
    this.base.push('')
    if (role === 'user') {
      for (const line of text.split('\n')) this.base.push(`> ${line}`)
    } else if (role === 'steer') {
      for (const line of text.split('\n')) this.base.push(`➤ ${line}`)
    } else {
      for (const line of text.split('\n')) this.base.push(line)
    }
    this.schedule()
  }

  /** User bubble with image attachment labels (📎 lines under the text). */
  pushUser(text: string, imageLabels: string[]): void {
    this.base.push('')
    if (text) {
      for (const line of text.split('\n')) this.base.push(`> ${line}`)
    }
    for (const label of imageLabels ?? []) this.base.push(`> ${label}`)
    this.schedule()
  }

  pushTool(line: string): void {
    this.base.push('', line)
    this.schedule()
  }

  /** File-change diff block (✎ header + `+ `/`- `/context lines). ALWAYS
   *  renders in the chat — the panel stays the compact activity log (the
   *  tool ✓ line still routes there when it is open), while the diff is the
   *  content the user wants to read in the conversation. Lines are rendered
   *  verbatim — no markdown stripping inside code content. */
  pushDiff(header: string, lines: string[]): void {
    if (lines.length === 0) return
    this.base.push('', header, ...lines)
    this.schedule()
  }

  pushSubagent(line: string): void {
    this.base.push('', line)
    this.schedule()
  }

  pushWorkflow(line: string): void {
    this.base.push('', line)
    this.schedule()
  }

  pushError(text: unknown): void {
    // Collapse newlines like appendNotice — the same E5108 hazard.
    this.base.push('', `⚠ ${String(text).replace(/\s+/g, ' ').trim()}`)
    this.schedule()
  }

  /** Extract plain text from a message (content blocks or raw text). */
  static messageText(message: ChatMessage | undefined): string {
    const content = message?.content
    if (Array.isArray(content)) {
      return content
        .filter((b): b is Extract<MessageContent, { type: 'text' }> => b?.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
        .map((b) => b.text)
        .join('\n')
    }
    if (typeof message?.text === 'string') return message.text
    return ''
  }

  /** Display labels for a message's image blocks (durable attachment refs). */
  static messageImages(message: ChatMessage | undefined): string[] {
    const content = message?.content
    if (!Array.isArray(content)) return []
    return content
      .filter((b): b is Extract<MessageContent, { type: 'image' }> => b?.type === 'image' && (b as { attachment?: ImageAttachmentRef }).attachment !== undefined)
      .map((b) => imageLabel(b.attachment))
  }

  /** Extract reasoning (thinking) text from a message's content blocks. */
  static messageReasoning(message: ChatMessage | undefined): string {
    const content = message?.content
    if (!Array.isArray(content)) return ''
    return content
      .filter((b): b is Extract<MessageContent, { type: 'reasoning' }> => b?.type === 'reasoning' && typeof (b as { text?: unknown }).text === 'string')
      .map((b) => b.text)
      .join('\n')
  }

  /** Close the open thinking block. The compact chat line is TRANSIENT — it
   *  lives only in the activity region while thinking, so nothing is pushed
   *  to the chat base (details are in the panel). Fallback without a panel:
   *  keep the line in chat so there is some record; with `inlineReasoning`
   *  (read-only replays like the subagent view) the full thinking text is
   *  inlined as a dim block instead. */
  commitReasoning(): void {
    if (this.reasoningTail === '') return
    const elapsedMs = this.reasoningStartedAt !== null
      ? (this.eventTime || Date.now()) - this.reasoningStartedAt
      : null
    if (this.reasoningBuf !== null) {
      this.panelLines.push(
        '·· thinking',
        ...this.reasoningTail.split('\n'),
        `── thinking end${elapsedMs !== null ? ` · ${(elapsedMs / 1000).toFixed(1)}s` : ''} ──`,
      )
      this.panelVersion++
    } else {
      this.base.push('')
      this.base.push(`·· thinking${elapsedMs !== null ? ` · ${(elapsedMs / 1000).toFixed(1)}s` : ''}`)
      if (this.inlineReasoning) this.base.push(...this.reasoningTail.split('\n'))
    }
    this.reasoningTail = ''
    this.reasoningStartedAt = null
  }

  /**
   * Structured tool results (web_search hits, grep/glob matches, …): a JSON
   * array of objects itemizes into compact rows instead of one truncated
   * blob — the terminal's counterpart of the web's per-tool cards. Returns
   * null when the text is not a usable JSON array.
   */
  static structuredHits(text: string): string[] | null {
    if (!text || (!text.trimStart().startsWith('[') && !text.trimStart().startsWith('{'))) return null
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { return null }
    const items = Array.isArray(parsed)
      ? parsed
      : (parsed as { results?: unknown; hits?: unknown } | null)?.results ?? (parsed as { results?: unknown; hits?: unknown } | null)?.hits
    if (!Array.isArray(items) || items.length === 0) return null
    const rows: string[] = []
    for (const it of items.slice(0, 8)) {
      if (typeof it !== 'object' || it === null) { rows.push(FeedRenderer.truncate(it)); continue }
      const o = it as { title?: unknown; url?: unknown; snippet?: unknown; path?: unknown; name?: unknown }
      const title = String(o.title ?? o.name ?? o.path ?? '').replace(/\s+/g, ' ').trim()
      const url = String(o.url ?? '').trim()
      const snippet = String(o.snippet ?? '').replace(/\s+/g, ' ').trim()
      const parts = [title, url, snippet].filter((x) => x !== '')
      if (parts.length === 0) { rows.push(FeedRenderer.truncate(it)); continue }
      rows.push(FeedRenderer.truncate(parts.join(' · '), 100))
    }
    return rows.length > 0 ? rows : null
  }

  /** One-line preview of raw model JSON arguments. */
  static argsPreview(argumentsText: string | undefined): string {
    if (typeof argumentsText !== 'string' || argumentsText.trim() === '') return '{}'
    try {
      const parsed = JSON.parse(argumentsText)
      return JSON.stringify(parsed).slice(0, 60) + (JSON.stringify(parsed).length > 60 ? '…' : '')
    } catch {
      return argumentsText.replace(/\s+/g, ' ').slice(0, 60)
    }
  }

  static truncate(text: unknown, max = 80): string {
    const oneLine = String(text).replace(/\s+/g, ' ').trim()
    return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine
  }

  applyEvent(event: SessionEvent, { history = false }: { history?: boolean } = {}): void {
    this.eventTime = event.time ?? this.eventTime
    switch (event.type) {
      case 'user/message': {
        // Harness variants: data IS the message, or data.message wraps it.
        const data = event.data as { message?: ChatMessage } | ChatMessage | undefined
        const msg = (data as { message?: ChatMessage } | undefined)?.message ??
          (data as ChatMessage | undefined)
        const text = FeedRenderer.messageText(msg)
        const images = FeedRenderer.messageImages(msg)
        if (text || images.length > 0) this.pushUser(text, images)
        break
      }
      case 'assistant/message': {
        // data = { turn, step, message }; the full message replaces the
        // streamed tail (assistant/chunk deltas covered it already).
        const message = event.data?.message
        // Providers that never streamed reasoning deltas still carry the
        // thinking text in the final message — show it once.
        if (this.reasoningTail === '' && !this.reasoningStartedAt) {
          const reasoning = FeedRenderer.messageReasoning(message)
          if (reasoning) {
            this.reasoningTail = reasoning
            this.reasoningStartedAt = this.eventTime
          }
        }
        this.commitReasoning()
        this.tail = FeedRenderer.messageText(message)
        this.schedule()
        break
      }
      case 'assistant/chunk': {
        const chunk = event.data?.chunk
        if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
          // The model is THINKING: full text goes to the reasoning panel,
          // the chat shows only a compact progress line. Streaming deltas
          // must NOT bump panelVersion — it tracks COMMITTED panel structure;
          // the live tail is synced by the streaming-only fast path.
          if (this.reasoningStartedAt === null) {
            this.reasoningStartedAt = this.eventTime
          }
          this.reasoningTail += chunk.text
          this.schedule()
        } else if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          if (this.reasoningTail !== '') this.commitReasoning()
          this.tail += chunk.text
          this.schedule()
        } else if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
          // A turn that dies (missing credential, gateway, …) must be visible.
          this.commitReasoning()
          this.commitTail()
          const msg = chunk.reason.failure?.message
            ?? chunk.reason.error?.message
            ?? JSON.stringify(chunk.reason)
          this.pushError(msg)
        }
        break
      }
      case 'tool/call': {
        this.commitReasoning()
        const data = event.data
        if (data === undefined) break
        const { callId, name, arguments: args } = data
        this.calls.set(callId ?? '', { name: name ?? 'tool', startedAt: this.eventTime })
        const callLine = `🔧 ${name ?? 'tool'}(${FeedRenderer.argsPreview(args)})`
        if (this.reasoningBuf !== null) {
          this.panelLines.push('', callLine)
          this.panelVersion++
        } else {
          this.pushTool(callLine)
        }
        this.toolActivity = { name: name ?? 'tool', startedAt: this.eventTime }
        this.schedule()
        break
      }
      case 'tool/result': {
        const data = event.data
        if (data === undefined) break
        const source = data.message?.source
        const call = source?.callId ? this.calls.get(source.callId) : undefined
        const name = call?.name ?? 'tool'
        const elapsed = call ? Math.max(0, (this.eventTime ?? Date.now()) - (call.startedAt ?? this.eventTime)) : null
        const failed = data.error !== undefined && data.error !== null
        const resultText = FeedRenderer.messageText(data.message)
        const structured = failed ? null : FeedRenderer.structuredHits(resultText)
        const preview = FeedRenderer.truncate(resultText)
        const elapsedText = elapsed === null ? '' : ` · ${formatElapsed(elapsed)}`
        const previewPart = !this.dense && structured === null && preview ? ` · ${preview}` : ''
        let line: string
        if (failed) {
          const err = data.error
          line = `✗ ${name}${elapsedText} · ${err?.code ?? err?.name ?? 'failed'}${previewPart}`
        } else {
          line = `✓ ${name}${elapsedText}${previewPart}`
        }
        const outLines = structured === null || this.dense ? [line] : [line, ...structured.map((h) => `  · ${h}`)]
        for (const l of outLines) {
          if (this.reasoningBuf !== null) {
            this.panelLines.push(l)
            this.panelVersion++
          } else {
            this.pushTool(l)
          }
        }
        this.toolActivity = null
        this.schedule()
        break
      }
      case 'turn/start':
        this.base.push('', '── turn ──')
        this.turnStartedAt = Date.now()
        this.turnMarkerBase = this.base.length
        if (!history && this.reasoningBuf !== null) {
          // The panel is a per-turn activity log (live turns only).
          this.panelLines = []
          this.panelFlushed = 0
          this.panelVersion++
        }
        this.toolActivity = null
        this.schedule()
        break
      case 'turn/end':
        this.commitReasoning()
        this.commitTail()
        this.base.push('── turn end ──')
        this.turnStartedAt = null
        this.turnMarkerBase = null
        this.schedule()
        break
      case 'todo/write': {
        // Standing todo list (todo_write): the terminal counterpart of the
        // web's TodoDock strip — a compact block at its flow position.
        const todos = event.data?.todos ?? []
        if (todos.length === 0) break
        const count = (st: string) => todos.filter((t) => t.status === st).length
        const done = count('completed')
        const doing = count('in_progress')
        const pending = count('pending')
        this.base.push('', `${t('📋 待办')} ${todos.length} ${t('项')} · ${done} ${t('完成')} · ${doing} ${t('进行中')} · ${pending} ${t('待办')}`)
        for (const t of todos) {
          const mark = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '…' : '·'
          this.base.push(`  ${mark} ${t.content}`)
        }
        this.schedule()
        break
      }
      case 'compaction/start':
        this.base.push('', t('⋯ 正在压缩上下文…'))
        this.schedule()
        break
      case 'compaction/summary': {
        // Checkpoint row (web: one collapsed disclosure): replaced-item and
        // estimated-token counts, summary block folded underneath. dsh
        // 0.1.1-rc.2 carries `summary` as ContentBlock[]; older hosts used a
        // plain string — accept both.
        const d = event.data
        const rows = d?.shadowedSeqs?.length
        const tokens = d?.shadowedTokenCount
        this.base.push('', `${t('⋯ 上下文压缩')} · ${rows ?? '?'} ${t('条历史')}${typeof tokens === 'number' ? ` · ≈${formatTokens(tokens)} tokens` : ''}`)
        const raw = d?.summary
        if (typeof raw === 'string' && raw !== '') {
          this.base.push(`  ${t('摘要')}：`)
          for (const line of raw.split('\n').slice(0, 12)) this.base.push(`    ${line}`)
        } else if (Array.isArray(raw) && raw.length > 0) {
          this.base.push(`  ${t('摘要')}：`)
          for (const block of raw.slice(0, 12)) {
            const b = block as { type?: string; text?: string }
            const text = typeof b?.text === 'string' ? b.text : (b?.type !== undefined ? `[${b.type}]` : '')
            for (const line of text.split('\n')) this.base.push(`    ${line}`)
          }
        }
        this.schedule()
        break
      }
      case 'compaction/end':
        break
      case 'llm/retry': {
        // Muted retry status row (web keeps ONE row per chain; the buffer
        // model is append-only, so each attempt lands its own row).
        const d = event.data
        const delayText = typeof d?.delayMs === 'number' ? formatElapsed(d.delayMs) : '?'
        const fail = d?.failure?.message ?? d?.failure?.code
        const cap = d?.mode === 'always' ? '∞' : (d?.maxRetries !== undefined ? `/${d.maxRetries}` : '')
        this.base.push('', `${t('↻ 重试 #')}${d?.retry ?? '?'}${cap} · ${delayText} ${t('后重试')}${fail ? ` · ${FeedRenderer.truncate(fail)}` : ''}`)
        this.schedule()
        break
      }
      case 'llm/retry-started':
        this.base.push('', `${t('↻ 重试 #')}${event.data?.retry ?? '?'} ${t('已发起')}`)
        this.schedule()
        break
      case 'tool-workflow/run-start':
        this.pushWorkflow(`◈ workflow ${FeedRenderer.truncate(String(event.data?.name ?? event.data?.runId ?? ''), 60)}`)
        break
      case 'tool-workflow/agent-start': {
        const d = event.data
        this.pushSubagent(`  ◇ #${d?.seq ?? '?'} ${d?.label ?? 'subagent'}${d?.phase ? ` · ${d.phase}` : ''}`)
        break
      }
      case 'tool-workflow/agent-end': {
        const d = event.data
        this.pushSubagent(`  ◇ #${d?.seq ?? '?'} · ${d?.outcome ?? 'settled'}`)
        break
      }
      case 'tool-workflow/run-end':
        this.pushWorkflow(`◈ workflow · ${event.data?.stopReason ?? 'ended'}`)
        break
      default:
        break
    }
  }

  // -- subagent / workflow cards (host events routed by the runner) ---------

  subagentStart(info: { runId?: string; provider?: string; id?: string }): void {
    const now = Date.now()
    this.subagents.set(info.runId ?? '?', { provider: info.provider ?? '?', startedAt: now })
    this.pushSubagent(`◇ subagent ${info.provider ?? '?'} · ${FeedRenderer.truncate(String(info.id ?? ''), 16)}`)
  }

  subagentEnd(info: { runId?: string; provider?: string; id?: string; stopReason?: string }): void {
    const run = info.runId ? this.subagents.get(info.runId) : undefined
    const elapsed = run ? Date.now() - run.startedAt : null
    this.subagents.delete(info.runId ?? '')
    this.pushSubagent(`◇ subagent ${info.provider ?? '?'} · ${info.stopReason ?? 'settled'}${elapsed === null ? '' : ` · ${formatElapsed(elapsed)}`}`)
  }

  workflowStart(info: { id?: string; meta?: { name?: string } }): void {
    this.pushWorkflow(`◈ workflow ${FeedRenderer.truncate(String(info.meta?.name ?? info.id ?? ''), 60)}`)
  }

  workflowPhase(_info: unknown, title: string): void {
    this.pushWorkflow(`◈ ─ ${title}`)
  }

  workflowEnd(_info: unknown, result: { stopReason?: string; error?: string }): void {
    const err = result?.error
    this.pushWorkflow(`◈ workflow · ${result?.stopReason ?? 'ended'}${err ? ` · ${err}` : ''}`)
  }

  /** Move the streaming tail into committed base lines. */
  commitTail(): void {
    if (this.tail === '') return
    if (this.base.length > 0 && this.base[this.base.length - 1] !== '') this.base.push('')
    this.base.push(...this.tail.split('\n'))
    this.tail = ''
  }

  // -- markup ----------------------------------------------------------------

  /**
   * Parse one raw line into buffer text + inline highlight spans.
   * Fences (```) toggle whole-line code highlighting. With `quoteAware`
   * (assistant lines only — user lines keep their own `> ` prefix), markdown
   * blockquotes strip the prefix and get the dim-italic quote group.
   * `#{1,6} ` headings keep their text and get the heading group.
   */
  static parseLine(raw: string, fenceOpen: boolean, quoteAware = false): ParsedLine {
    if (FENCE_RE.test(raw)) {
      return { text: raw, spans: [], code: true, fenceToggled: true }
    }
    if (fenceOpen) {
      return { text: raw, spans: [], code: true, fenceToggled: false }
    }
    let line = raw
    let group: string | undefined
    if (quoteAware && QUOTE_RE.test(line)) {
      line = line.replace(QUOTE_RE, '')
      group = 'DshTuiQuote'
    } else if (HEADING_RE.test(line)) {
      line = line.replace(HEADING_RE, '')
      group = 'DshTuiHeading'
    }
    const spans: Span[] = []
    let text = ''
    let cursor = 0
    for (const m of line.matchAll(INLINE_RE)) {
      text += line.slice(cursor, m.index)
      const token = m[0]
      if (token.startsWith('**')) {
        const inner = token.slice(2, -2)
        spans.push({ s: utf8Len(text), e: utf8Len(text) + utf8Len(inner), group: 'DshTuiBold' })
        text += inner
      } else if (token.startsWith('`')) {
        const inner = token.slice(1, -1)
        spans.push({ s: utf8Len(text), e: utf8Len(text) + utf8Len(inner), group: 'DshTuiCode' })
        text += inner
      } else {
        const link = token.match(/^\[([^\]\n]+)\]\(([^)\n]+)\)$/)
        const inner = link?.[1] ?? token
        spans.push({ s: utf8Len(text), e: utf8Len(text) + utf8Len(inner), group: 'DshTuiLink' })
        text += inner
      }
      cursor = (m.index ?? 0) + token.length
    }
    text += line.slice(cursor)
    return { text, spans, code: false, fenceToggled: false, group }
  }

  /** Toggle the whale art and re-render (the /whale command). */
  setWhale(on: boolean): void {
    this.whale = on
    if (!on) this.stopWhaleTicker()
    this.schedule()
  }

  /** Animate the wallpaper: advance one frame and re-render (empty only). */
  private ensureWhaleTicker(): void {
    if (this.whaleTicker !== null) return
    this.whaleTicker = setInterval(() => {
      if (!this.whale) {
        this.stopWhaleTicker()
        return
      }
      this.whaleFrame = (this.whaleFrame + 1) % 4
      // Skip hidden buffers (inactive sessions) — the frame still advances so
      // the animation is fresh whenever the feed becomes visible again.
      if (this.activeChecker()) void this.flush().catch(() => {})
    }, 450)
  }

  private stopWhaleTicker(): void {
    if (this.whaleTicker !== null) {
      clearInterval(this.whaleTicker)
      this.whaleTicker = null
    }
  }

  /** Current window size via the ids provider (fallback 40×100). */
  private async winSize(): Promise<{ h: number; w: number }> {
    try {
      const ids = (await this.idsProvider?.()) as { win?: number } | null
      if (ids !== null && ids !== undefined && typeof ids.win === 'number') {
        const [h, w] = await Promise.all([
          this.nvim.request('nvim_win_get_height', [ids.win]) as Promise<number>,
          this.nvim.request('nvim_win_get_width', [ids.win]) as Promise<number>,
        ])
        return { h, w }
      }
    } catch {}
    return { h: 40, w: 100 }
  }

  schedule(): void {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush().catch((err: unknown) => {
        console.error('[dsh-nvim-tui] render flush failed:', err)
      })
    }, this.flushDelayMs)
  }

  async flush(): Promise<void> {
    if (this.flushing) {
      // A flush is in flight; remember that newer content arrived.
      this.dirty = true
      return
    }
    const tailLines = this.tail === '' ? [] : this.tail.split('\n')
    // The chat shows at most ONE activity line: thinking progress, the
    // running tool, or the silent-turn placeholder. Details live in the panel.
    let activityLines: string[] = []
    if (this.reasoningTail !== '') {
      const elapsed = this.reasoningStartedAt !== null
        ? ((this.eventTime || Date.now()) - this.reasoningStartedAt) / 1000
        : 0
      const header = `·· thinking · ${elapsed.toFixed(1)}s`
      // Read-only inline replays (the subagent view has no reasoning panel)
      // stream the thinking text into the buffer AS it arrives. Previously
      // only the compact header rendered during streaming and the whole block
      // landed in one shot when thinking closed (commitReasoning).
      activityLines = this.reasoningBuf === null && this.inlineReasoning
        ? [header, ...this.reasoningTail.split('\n')]
        : [header]
    } else if (this.toolActivity !== null) {
      const elapsed = ((this.eventTime || Date.now()) - this.toolActivity.startedAt) / 1000
      activityLines = [`🔧 ${this.toolActivity.name} · ${elapsed.toFixed(1)}s`]
    } else {
      const idleMs = this.turnStartedAt !== null &&
        this.base.length === this.turnMarkerBase && this.tail === ''
        ? Date.now() - this.turnStartedAt
        : 0
      if (idleMs >= 800) activityLines = [`·· thinking… ${Math.floor(idleMs / 1000)}s`]
    }
    const raw = [...this.base, ...activityLines, ...tailLines]

    // Parse the full view (cheap string ops) so every flush's buffer content
    // is the stripped text with consistent spans. Markdown tables become
    // bordered, aligned blocks (Claude-TUI style).
    const parsed: Array<{ text: string; spans: Span[]; group?: string | null }> = []
    // Syntax-highlight sources: fenced code (```lang) and diff blocks (lang
    // inferred from the ✎ header path). Rows = final buffer rows (0-based).
    // Diff rows keep their tokens: the row group carries ONLY the background
    // tint (see applyDimPalette), so token colors never fight a row fg.
    const codeBlocks: Array<{ lang: string; row: number; col: number; lines: string[] }> = []
    let fenceOpen = false
    let fenceLang = ''
    let fenceRow = -1
    let fenceCode: string[] = []
    let lastDiffPath = ''
    let diffRegion = false // a ✎ header opened a diff block (styling gate)
    let diffRow = -1
    let diffCode: string[] = []
    let diffHasChange = false // a real +/- line was collected (stripped code
    // rarely starts with +/-, so the code itself cannot be the signal)
    const closeDiffBlock = (): void => {
      if (diffRow >= 0 && diffHasChange) {
        const lang = lastDiffPath.match(/\.([A-Za-z0-9_+-]+)$/)?.[1] ?? ''
        if (lang !== '' && diffCode.length <= 200 &&
          diffCode.reduce((n, l) => n + l.length, 0) <= 20000) {
          codeBlocks.push({ lang, row: diffRow, col: 2, lines: diffCode })
        }
      }
      diffRow = -1
      diffCode = []
      diffHasChange = false
      diffRegion = false
    }
    // streamOpen: the last line may still grow — the answer tail, or the
    // inline reasoning tail in read-only replays (an open table block there
    // must keep its bottom border off until the stream closes).
    const streamOpen = this.tail !== '' ||
      (this.reasoningBuf === null && this.inlineReasoning && this.reasoningTail !== '')
    for (const entry of transformTables(raw, streamOpen)) {
      if (entry.table) {
        parsed.push({ text: entry.text, spans: entry.spans, group: entry.group })
        continue
      }
      // File-change diff lines: verbatim text (file content IS code — no
      // markdown stripping) with a whole-line add/del/tool color group.
      // Diff styling applies ONLY inside a real diff region — one opened by
      // the ✎ header and still active. A stray '- ' bullet or '+ ' line in
      // ordinary content (markdown lists, git log output…) must render as
      // plain text, never as a red/green filled diff row.
      if (diffRegion && (entry.raw.startsWith('+ ') || entry.raw.startsWith('- '))) {
        if (diffRow === -1) diffRow = parsed.length
        diffHasChange = true
        diffCode.push(entry.raw.slice(2))
        parsed.push({ text: entry.raw, spans: [], group: entry.raw.startsWith('+ ') ? 'DshTuiDiffAdd' : 'DshTuiDiffDel' })
        continue
      }
      if (DIFF_HEADER_RE.test(entry.raw)) {
        closeDiffBlock()
        diffRegion = true
        lastDiffPath = DIFF_HEADER_RE.exec(entry.raw)?.[1] ?? ''
        parsed.push({ text: entry.raw, spans: [], group: 'DshTuiTool' })
        continue
      }
      if (diffRegion) {
        if (entry.raw.startsWith('  ')) {
          // Context rows collect into the syntax block too — the block's
          // START must anchor at the FIRST collected row (context before the
          // first +/− line included), or every token lands shifted down by
          // the leading-context count.
          if (diffRow === -1) diffRow = parsed.length
          diffCode.push(entry.raw.slice(2))
        } else {
          closeDiffBlock()
        }
      }
      // Role from the RAW line (markup stripping must not erase the prefix);
      // assistant-only lines are quote-aware (blockquote `> ` → DshTuiQuote).
      const role = ROLE_BY_PREFIX.find(([re]) => re.test(entry.raw))?.[1]
      const p = FeedRenderer.parseLine(entry.raw, fenceOpen, role === undefined)
      if (p.fenceToggled) {
        if (!fenceOpen) {
          fenceLang = /^```(\S*)/.exec(entry.raw)?.[1] ?? ''
          fenceRow = parsed.length + 1 // the code starts on the NEXT row
          fenceCode = []
          // Raw ``` markers never reach the chat: the opening fence renders
          // as a dim language chip, the closing one as a blank row
          // (Claude-style) — the code itself stays a verbatim highlighted
          // block between them.
          parsed.push({ text: fenceLang !== '' ? `▸ ${fenceLang}` : '', spans: [], group: 'DshTuiNotice' })
        } else {
          if (fenceLang !== '' && fenceCode.length > 0 &&
            fenceCode.length <= 200 &&
            fenceCode.reduce((n, l) => n + l.length, 0) <= 20000) {
            codeBlocks.push({ lang: fenceLang, row: fenceRow, col: 0, lines: fenceCode })
          }
          parsed.push({ text: '', spans: [], group: undefined })
        }
        fenceOpen = !fenceOpen
        continue
      }
      if (fenceOpen) {
        fenceCode.push(entry.raw)
      }
      p.group = p.code
        ? 'DshTuiCode'
        : (p.group ?? role ?? 'DshTuiAssistant')
      parsed.push(p)
    }
    closeDiffBlock()
    const lines = parsed.map((p) => p.text)

    // Blue whale pixel art: the empty state is a hero block — big banner +
    // title ABOVE, the animated whale (wink / bubbles / bob cycle) in the
    // MIDDLE, usage hints BELOW — vertically centered as one unit. Once
    // content exists there is NO watermark; the statusline running badge
    // carries the emoji animation instead (its own timer). Each half-block
    // glyph carries a per-span color group (fg/bg pixel pair).
    if (this.whale) {
      const empty = lines.length === 0 || (lines.length === 1 && lines[0] === '')
      if (empty) {
        const { h, w } = await this.winSize()
        const hero = this.welcome?.() ?? {}
        const above = hero.above ?? []
        const below = hero.below ?? []
        const art = whaleRowsIndented(w, whaleFrames()[this.whaleFrame])
        const whaleRows = art ?? []
        const block: Array<{ text: string; spans: Span[]; group?: string }> = []
        for (const l of above) block.push({ text: l.text, spans: [], group: l.group })
        if (above.length > 0 && whaleRows.length > 0) block.push({ text: '', spans: [], group: undefined })
        for (const r of whaleRows) block.push({ text: r.text, spans: r.spans, group: undefined })
        if (below.length > 0 && (above.length > 0 || whaleRows.length > 0)) block.push({ text: '', spans: [], group: undefined })
        for (const l of below) block.push({ text: l.text, spans: [], group: 'DshTuiNotice' })
        // Vertical centering of the whole block (whale sits mid-screen).
        const topPad = Math.max(0, Math.floor((h - block.length) / 2))
        lines.length = 0
        for (let i = 0; i < topPad; i++) {
          lines.push('')
          parsed.push({ text: '', spans: [], group: undefined })
        }
        for (const b of block) {
          lines.push(b.text)
          parsed.push({ text: b.text, spans: b.spans, group: b.group })
        }
        this.ensureWhaleTicker()
      } else {
        this.stopWhaleTicker()
      }
    } else {
      this.stopWhaleTicker()
    }

    // Diff against the last flushed view: tables expand blocks (3 raw lines
    // → 5 bordered lines), so row positions cannot be tracked by base length.
    const lastView = this.lastView ?? []
    // The previous activity rows (·· thinking… / 🔧 running tool) were
    // TRANSIENT — the diff must only consider the COMMITTED prefix. Without
    // this, any content change under them (an echoed user bubble, a notice)
    // rewrites them as real buffer rows and the next tick stacks ANOTHER
    // thinking line into the chat.
    const prevActivity = this.lastActivityCount ?? 0
    const committedEnd = Math.max(0, lastView.length - prevActivity)
    let startRow = 0
    while (startRow < lines.length && startRow < committedEnd &&
      lines[startRow] === lastView[startRow]) {
      startRow++
    }
    this.lastActivityCount = activityLines.length
    // Nothing changed at all? Only the panel may still need a sync (its
    // streaming tail can keep growing while the chat line is unchanged).
    const unchanged = startRow === lines.length && lines.length === lastView.length
    // Exactly ONE changed row at the tail (the streaming answer / the ticking
    // "thinking…" activity line) → rewrite it IN PLACE: no delete+insert row
    // churn and no clear+readd highlight pass, which is what made the line
    // flicker during thinking.
    const inPlaceRow = !unchanged && startRow === lines.length - 1 &&
      lines.length === lastView.length && lines.length > 0
      ? startRow
      : -1
    this.lastView = lines

    this.flushing = (async () => {
      if (this.ns === null) {
        this.ns = await this.nvim.request('nvim_create_namespace', ['dsh-tui-feed']) as number
      }
      if (unchanged) {
        await this.flushReasoningBuffer()
        return
      }
      if (inPlaceRow >= 0) {
        await this.nvim.request('nvim_buf_set_text',
          [this.bufId, inPlaceRow, 0, inPlaceRow, -1, [lines[inPlaceRow]]])
        await this.flushReasoningBuffer()
        // Refresh only this row's highlights (its inline spans may shift as
        // the text grows). One Lua RPC, no row churn.
        const p = parsed[inPlaceRow]
        await this.nvim.lua(`
          local buf, ns, row, group, spans = ...
          vim.api.nvim_buf_clear_namespace(buf, ns, row, row + 1)
          if type(group) == 'string' and group ~= '' then
            local line = vim.api.nvim_buf_get_lines(buf, row, row + 1, false)[1] or ''
            vim.api.nvim_buf_set_extmark(buf, ns, row, 0,
              { end_row = row, end_col = #line, hl_group = group, priority = 4096 })
          end
          for _, sp in ipairs(spans or {}) do
            if type(sp.group) == 'string' then
              vim.api.nvim_buf_set_extmark(buf, ns, row, sp.s,
                { end_row = row, end_col = sp.e, hl_group = sp.group, priority = 4096 })
            end
          end
        `, [this.bufId, this.ns, inPlaceRow, p.group ?? '', p.spans])
        const tokenBlocks = codeBlocks.filter((b) => b.row === inPlaceRow)
        if (tokenBlocks.length > 0) {
          if (this.tokenNs === null) {
            this.tokenNs = await this.nvim.request('nvim_create_namespace', ['dsh-tui-feed-ts']) as number
          }
          await this.nvim.lua(`
            local buf, ns, row, blocks = ...
            vim.api.nvim_buf_clear_namespace(buf, ns, row, row + 1)
            require("dsh_tui").highlight_syntax(buf, ns, blocks)
          `, [this.bufId, this.tokenNs, inPlaceRow, tokenBlocks])
        }
        // The line count did not change — no cursor move, nothing else to do.
        return
      }

      await this.nvim.request('nvim_buf_set_lines', [this.bufId, startRow, -1, false, lines.slice(startRow)])
      await this.flushReasoningBuffer()

      // One Lua RPC for the whole highlight pass over the changed rows.
      // (group: '' not null — msgpack turns null into truthy vim.NIL userdata.)
      // Row groups are EXPLICIT same-row ranges (end_col = line byte length):
      // nvim 0.12's real TUI does NOT draw `hl_eol` marks (zero-width end),
      // which made every chat line render in plain Normal (white) after the
      // in-place update work. nvim_buf_add_highlight ranges extend into the
      // next row and get wiped by the next clear_namespace (range
      // intersection), so same-row ranges are the one geometry that both
      // renders and survives clearing.
      if (startRow < lines.length) {
        const tokenBlocks = codeBlocks.filter((b) => b.row >= startRow)
        const rows = parsed.slice(startRow).map((p) => ({
          group: p.group ?? '',
          spans: p.spans,
        }))
        await this.nvim.lua(`
          local buf, ns, start, rows = ...
          vim.api.nvim_buf_clear_namespace(buf, ns, start, -1)
          for i, r in ipairs(rows) do
            local row = start + i - 1
            if type(r.group) == 'string' and r.group ~= '' then
              local line = vim.api.nvim_buf_get_lines(buf, row, row + 1, false)[1] or ''
              vim.api.nvim_buf_set_extmark(buf, ns, row, 0,
                { end_row = row, end_col = #line, hl_group = r.group, priority = 4096 })
            end
            for _, sp in ipairs(r.spans or {}) do
              if type(sp.group) == 'string' then
                vim.api.nvim_buf_set_extmark(buf, ns, row, sp.s,
                  { end_row = row, end_col = sp.e, hl_group = sp.group, priority = 4096 })
              end
            end
          end
        `, [this.bufId, this.ns, startRow, rows])
        if (tokenBlocks.length > 0) {
          if (this.tokenNs === null) {
            this.tokenNs = await this.nvim.request('nvim_create_namespace', ['dsh-tui-feed-ts']) as number
          }
          await this.nvim.lua(`
            local buf, ns, start, blocks = ...
            vim.api.nvim_buf_clear_namespace(buf, ns, start, -1)
            require("dsh_tui").highlight_syntax(buf, ns, blocks)
          `, [this.bufId, this.tokenNs, startRow, tokenBlocks])
        }
      }

      if (this.activeChecker()) {
        // Fire-and-forget: a wedged cursor RPC must never block the feed.
        void this.moveCursor(lines.length)
      }
    })()
    try {
      await this.flushing
    } finally {
      this.flushing = null
      if (this.dirty) {
        this.dirty = false
        void this.flush()
      } else if (this.reasoningTail !== '' || this.toolActivity !== null ||
        (this.turnStartedAt !== null &&
          this.base.length === this.turnMarkerBase &&
          this.tail === '')) {
        // The turn is silent — keep the "thinking…" placeholder ticking.
        this.ticker = setTimeout(() => {
          this.ticker = null
          this.schedule()
        }, 500)
      }
    }
  }

  /** Sync the activity panel (reasoning + tools) for this session.
   *  A wiped panel buffer (external :bwipe etc.) must never kill the chat
   *  flush — the panel is auxiliary, the transcript is not. */
  async flushReasoningBuffer(): Promise<void> {
    if (this.reasoningBuf === null) return
    try {
      await this.flushReasoningBufferInner()
    } catch {}
  }

  async flushReasoningBufferInner(): Promise<void> {
    const buf = this.reasoningBuf as number
    const ns = this.ns as number
    const streaming = this.reasoningTail === ''
      ? []
      : ['·· thinking', ...this.reasoningTail.split('\n')]
    const full = [...this.panelLines, ...streaming]
    const committed = this.panelLines.length
    // Streaming-only flush: everything committed is already in the buffer and
    // only the live tail grows. Rewrite the tail rows IN PLACE (the last
    // flushed row may still be growing) + append genuinely new rows, then
    // refresh ONLY those rows' dim group marks. Two failure modes fixed here:
    //  - a delta with an embedded newline grows the previous last row AND
    //    appends rows, so appending full.slice(panelFlushed) alone left the
    //    grown row's text stale in the buffer;
    //  - extmark end_cols are frozen once set (the end mark is left-gravity),
    //    so an in-place rewrite must re-apply the group over the FULL new
    //    line — otherwise the freshly streamed tail renders unhighlighted,
    //    i.e. pure white on the theme's Normal instead of dim.
    if (streaming.length > 0 && this.panelFlushed >= committed &&
      this.panelVersion === this.lastPanelVersion) {
      const startRow = this.panelFlushed > 0 ? this.panelFlushed - 1 : 0
      const rows = full.slice(startRow)
      const groups = rows.map((l) =>
        ROLE_BY_PREFIX.find(([re]) => re.test(l))?.[1] ?? 'DshTuiAssistant')
      await this.nvim.lua(`
        local buf, ns, start, rows, groups = ...
        local lineCount = vim.api.nvim_buf_line_count(buf)
        -- Overlapping rows are rewritten in place (no row churn); the rest
        -- are appended. set_lines pads if the panel buffer was re-created.
        local overlap = math.max(0, math.min(#rows, lineCount - start))
        for i = 1, overlap do
          vim.api.nvim_buf_set_text(buf, start + i - 1, 0, start + i - 1, -1, { rows[i] })
        end
        if #rows > overlap then
          local rest = {}
          for i = overlap + 1, #rows do rest[#rest + 1] = rows[i] end
          vim.api.nvim_buf_set_lines(buf, start + overlap, -1, false, rest)
        end
        -- Row-scoped highlight refresh over the FULL new lines. Marks above
        -- 'start' are untouched (clear_namespace intersects by line range).
        vim.api.nvim_buf_clear_namespace(buf, ns, start, -1)
        for i, r in ipairs(rows) do
          local group = groups[i]
          if type(group) == 'string' and group ~= '' then
            vim.api.nvim_buf_set_extmark(buf, ns, start + i - 1, 0,
              { end_row = start + i - 1, end_col = #r, hl_group = group, priority = 4096 })
          end
        end
      `, [buf, ns, startRow, rows, groups])
      this.panelFlushed = full.length
      // Auto-scroll while the panel is open and this session is the active one.
      const view = this.reasoningView()
      if (view?.open && Number.isInteger(view.win) && this.activeChecker() && this.panelFlushed > 0) {
        void this.nvim.request('nvim_win_set_cursor', [view.win, [this.panelFlushed, 0]]).catch(() => {})
      }
      return
    }
    // Structural change (turn boundary, committed block, first write…):
    // rewrite from ONE row before the flushed watermark — the last flushed
    // row may still be growing (streaming continuation) — append-only would
    // freeze truncated fragments.
    const startRow = this.panelFlushed > 0 ? this.panelFlushed - 1 : 0
    if (full.length > this.panelFlushed || startRow === 0 || this.panelVersion !== this.lastPanelVersion) {
      if (full.length >= startRow || startRow === 0) {
        await this.nvim.request('nvim_buf_set_lines', [buf, startRow, -1, false,
          full.slice(startRow)])
        this.panelFlushed = full.length
        this.lastPanelVersion = this.panelVersion
      }
      // Dim headers/footers in the panel (one Lua RPC).
      const rows = full.slice(startRow).map((l) => ({
        group: ROLE_BY_PREFIX.find(([re]) => re.test(l))?.[1] ?? 'DshTuiAssistant',
        spans: [],
      }))
      await this.nvim.lua(`
        local buf, ns, start, rows = ...
        vim.api.nvim_buf_clear_namespace(buf, ns, start, -1)
        for i, r in ipairs(rows) do
          if type(r.group) == 'string' and r.group ~= '' then
            local row = start + i - 1
            local line = vim.api.nvim_buf_get_lines(buf, row, row + 1, false)[1] or ''
            vim.api.nvim_buf_set_extmark(buf, ns, row, 0,
              { end_row = row, end_col = #line, hl_group = r.group, priority = 4096 })
          end
        end
      `, [buf, ns, startRow, rows])
    }
    // Auto-scroll while the panel is open and this session is the active one.
    const view = this.reasoningView()
    if (view?.open && Number.isInteger(view.win) && this.activeChecker() && this.panelFlushed > 0) {
      void this.nvim.request('nvim_win_set_cursor', [view.win, [this.panelFlushed, 0]]).catch(() => {})
    }
  }

  async moveCursor(lineCount: number): Promise<void> {
    try {
      await this.nvim.request('nvim_win_set_cursor', [this.winId, [lineCount, 0]])
    } catch {
      // The Lua side may have re-claimed its layout (window ids changed);
      // refresh ids once and retry.
      if (this.idsProvider) {
        try {
          const ids = await this.idsProvider() as { chatWin?: number } | null | undefined
          if (ids?.chatWin) {
            this.winId = ids.chatWin
            await this.nvim.request('nvim_win_set_cursor', [this.winId, [lineCount, 0]])
          }
        } catch {}
      }
    }
  }
}
