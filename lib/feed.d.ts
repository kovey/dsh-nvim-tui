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
import { NeovimClient } from 'neovim';
import type { ChatMessage, SessionEvent } from './types.js';
/** Inline highlight span (byte offsets into the rendered line). */
export interface Span {
    s: number;
    e: number;
    group: string;
}
/** One parsed view row (markup stripped, spans byte-indexed). */
export interface ParsedLine {
    text: string;
    spans: Span[];
    code: boolean;
    fenceToggled: boolean;
    group?: string;
}
export interface FeedOptions {
    flushDelayMs?: number;
    idsProvider?: (() => Promise<unknown>) | null;
    activeChecker?: (() => boolean) | null;
    reasoningBuf?: number | null;
    reasoningView?: (() => {
        open: boolean;
        win: number | null;
    } | null) | null;
    inlineReasoning?: boolean;
    /** Blue whale wallpaper/watermark (default off; the runner enables it). */
    whale?: boolean;
    /** Empty-state welcome block: lines ABOVE the whale (big banner + title)
     *  and lines BELOW it (usage hints); rows may carry a highlight group. */
    welcome?: () => {
        above?: WelcomeLine[];
        below?: WelcomeLine[];
    };
}
export interface WelcomeLine {
    text: string;
    group?: string;
}
interface ToolCallRecord {
    name: string;
    startedAt: number;
}
export declare class FeedRenderer {
    nvim: NeovimClient;
    bufId: number;
    winId: number;
    flushDelayMs: number;
    idsProvider: (() => Promise<unknown>) | null;
    activeChecker: () => boolean;
    reasoningBuf: number | null;
    reasoningView: () => {
        open: boolean;
        win: number | null;
    } | null;
    inlineReasoning: boolean;
    panelLines: string[];
    panelFlushed: number;
    panelVersion: number;
    lastPanelVersion: number;
    toolActivity: {
        name: string;
        startedAt: number;
    } | null;
    base: string[];
    tail: string;
    reasoningTail: string;
    reasoningStartedAt: number | null;
    turnStartedAt: number | null;
    turnMarkerBase: number | null;
    calls: Map<string, ToolCallRecord>;
    subagents: Map<string, {
        provider: string;
        startedAt: number;
    }>;
    timer: ReturnType<typeof setTimeout> | null;
    flushing: Promise<void> | null;
    tokenNs: number | null;
    lastActivityCount: number;
    dirty: boolean;
    ns: number | null;
    lastView: string[];
    dense: boolean;
    whale: boolean;
    welcome: (() => {
        above?: WelcomeLine[];
        below?: WelcomeLine[];
    }) | null;
    whaleFrame: number;
    whaleTicker: ReturnType<typeof setInterval> | null;
    ticker: ReturnType<typeof setTimeout> | null;
    eventTime: number;
    constructor(nvim: NeovimClient, bufId: number, winId: number, { flushDelayMs, idsProvider, activeChecker, reasoningBuf, reasoningView, inlineReasoning, whale, welcome, }?: FeedOptions);
    /** Clear the transcript (the /clear command). */
    clear(): void;
    /** Notice line (runner lifecycle, status). Multi-line text (e.g. an error
     *  message with a stack trace) is collapsed to ONE line: a string with
     *  embedded newlines fed to nvim_buf_set_lines throws E5108 and kills the
     *  whole flush — the /subagents E95 failure notice was invisible this way
     *  and every later render that included it silently failed. */
    appendNotice(text: unknown): void;
    pushBlock(role: string, text: string): void;
    /** User bubble with image attachment labels (📎 lines under the text). */
    pushUser(text: string, imageLabels: string[]): void;
    pushTool(line: string): void;
    /** File-change diff block (✎ header + `+ `/`- `/context lines). ALWAYS
     *  renders in the chat — the panel stays the compact activity log (the
     *  tool ✓ line still routes there when it is open), while the diff is the
     *  content the user wants to read in the conversation. Lines are rendered
     *  verbatim — no markdown stripping inside code content. */
    pushDiff(header: string, lines: string[]): void;
    pushSubagent(line: string): void;
    pushWorkflow(line: string): void;
    pushError(text: unknown): void;
    /** Extract plain text from a message (content blocks or raw text). */
    static messageText(message: ChatMessage | undefined): string;
    /** Display labels for a message's image blocks (durable attachment refs). */
    static messageImages(message: ChatMessage | undefined): string[];
    /** Extract reasoning (thinking) text from a message's content blocks. */
    static messageReasoning(message: ChatMessage | undefined): string;
    /** Close the open thinking block. The compact chat line is TRANSIENT — it
     *  lives only in the activity region while thinking, so nothing is pushed
     *  to the chat base (details are in the panel). Fallback without a panel:
     *  keep the line in chat so there is some record; with `inlineReasoning`
     *  (read-only replays like the subagent view) the full thinking text is
     *  inlined as a dim block instead. */
    commitReasoning(): void;
    /**
     * Structured tool results (web_search hits, grep/glob matches, …): a JSON
     * array of objects itemizes into compact rows instead of one truncated
     * blob — the terminal's counterpart of the web's per-tool cards. Returns
     * null when the text is not a usable JSON array.
     */
    static structuredHits(text: string): string[] | null;
    /** One-line preview of raw model JSON arguments. */
    static argsPreview(argumentsText: string | undefined): string;
    static truncate(text: unknown, max?: number): string;
    applyEvent(event: SessionEvent, { history }?: {
        history?: boolean;
    }): void;
    subagentStart(info: {
        runId?: string;
        provider?: string;
        id?: string;
    }): void;
    subagentEnd(info: {
        runId?: string;
        provider?: string;
        id?: string;
        stopReason?: string;
    }): void;
    workflowStart(info: {
        id?: string;
        meta?: {
            name?: string;
        };
    }): void;
    workflowPhase(_info: unknown, title: string): void;
    workflowEnd(_info: unknown, result: {
        stopReason?: string;
        error?: string;
    }): void;
    /** Move the streaming tail into committed base lines. */
    commitTail(): void;
    /**
     * Parse one raw line into buffer text + inline highlight spans.
     * Fences (```) toggle whole-line code highlighting. With `quoteAware`
     * (assistant lines only — user lines keep their own `> ` prefix), markdown
     * blockquotes strip the prefix and get the dim-italic quote group.
     * `#{1,6} ` headings keep their text and get the heading group.
     */
    static parseLine(raw: string, fenceOpen: boolean, quoteAware?: boolean): ParsedLine;
    /** Toggle the whale art and re-render (the /whale command). */
    setWhale(on: boolean): void;
    /** Animate the wallpaper: advance one frame and re-render (empty only). */
    private ensureWhaleTicker;
    private stopWhaleTicker;
    /** Current window size via the ids provider (fallback 40×100). */
    private winSize;
    schedule(): void;
    flush(): Promise<void>;
    /** Sync the activity panel (reasoning + tools) for this session.
     *  A wiped panel buffer (external :bwipe etc.) must never kill the chat
     *  flush — the panel is auxiliary, the transcript is not. */
    flushReasoningBuffer(): Promise<void>;
    flushReasoningBufferInner(): Promise<void>;
    moveCursor(lineCount: number): Promise<void>;
}
export {};
