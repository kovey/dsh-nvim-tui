/**
 * dsh-nvim-tui extension API — the PUBLIC service surface this bundle
 * exports to other dsh plugins via `ctx.provide('nvim-tui', …)`.
 *
 * P0 scope: service mount + readiness lifecycle (ready/teardown), the
 * whitelisted nvim execution layer (request / call / lua / ex), TUI-scoped
 * event subscriptions, and the active-session / input plumbing. UI
 * primitives (card/float/picker/notice/statuslineSegment), the ext RPC bus
 * and Lua-side hooks land in later phases.
 *
 * Fault isolation: every consumer callback is guarded — a throwing
 * subscriber surfaces as a feed notice + error-log line and never breaks
 * the TUI event loop. All nvim calls funnel through the SINGLE shared
 * channel (serialized by design); consumers must not hold it with long
 * blocking work.
 *
 * @module dsh-nvim-tui/ext-api
 */
import type { SessionEvent } from './types.js';
import type { App } from './app.js';
/** Extension API version (semver, independent of the bundle version). */
export declare const EXT_API_VERSION = "0.1.0";
/** Nvim execution layer: the whitelisted raw editor surface. */
export interface ExtNvimLayer {
    /** nvim_* API request (msgpack-RPC). Optional timeout rejects instead of
     *  wedging the caller — nvim keeps executing, so calls must be
     *  idempotence-safe. */
    request(method: string, args?: unknown[], opts?: {
        timeoutMs?: number;
    }): Promise<unknown>;
    /** vim.fn call. */
    call(fn: string, args?: unknown[]): Promise<unknown>;
    /** Arbitrary Lua evaluation (escape hatch; prefer the typed layers). */
    lua(code: string, args?: unknown[]): Promise<unknown>;
    /** vim.cmd execution. */
    ex(cmd: string): Promise<void>;
}
/** Subscription filter for onSessionEvent. */
export interface ExtSessionEventFilter {
    /** Event type(s) of interest; omitted = every type. */
    type?: string | string[];
    /** Restrict to one session; omitted = every session. */
    sessionId?: string;
}
/** Pure filter match (exported for unit tests). */
export declare function matchSessionEventFilter(filter: ExtSessionEventFilter, sessionId: string, eventType: string): boolean;
/** TUI lifecycle / user-intent events. */
export type ExtEventName = 'tui:ready' | 'tui:active-session' | 'tui:input' | 'tui:teardown';
/** ui.card options. */
export interface ExtCardOpts {
    /** Render into this session's feed; omitted = the active session. */
    sessionId?: string;
    /** Extension name shown in the card header. */
    plugin: string;
    title: string;
    body: string;
    /** Action hints rendered as a footer row (informational in v1). */
    actions?: Array<{
        label: string;
        value: string;
    }>;
    /** Auto-dismiss after this many milliseconds. */
    ttlMs?: number;
}
/** Handle for a rendered card (update/dismiss in place). */
export interface ExtCardHandle {
    id: string;
    update(next: {
        title?: string;
        body?: string;
        actions?: Array<{
            label: string;
            value: string;
        }>;
    }): void;
    dismiss(): void;
}
/** ui.float options. */
export interface ExtFloatOpts {
    lines: string[];
    title?: string;
    relative?: 'editor' | 'cursor';
    width?: number;
    height?: number;
    row?: number;
    col?: number;
}
/** Opened float: window/buffer handles (write content via api.nvim). */
export interface ExtFloatResult {
    id: string;
    win: number;
    buf: number;
}
/** ui.picker options. */
export interface ExtPickerOpts {
    title: string;
    items: Array<{
        label: string;
        value: string;
        active?: boolean;
    }>;
}
/** ui.panel options (the right-edge panel slot). */
export interface ExtPanelOpts {
    side?: 'right';
    width?: number;
    title?: string;
    /** Hints embedded in the bottom border (nvim >= 0.10). */
    footer?: string;
    /** Initial content lines. */
    lines?: string[];
}
/** Claimed panel: write content via api.nvim into `buf`. */
export interface ExtPanelHandles {
    win: number;
    buf: number;
}
/** Extension slash command (name WITHOUT the leading '/'). */
export interface ExtCommandSpec {
    name: string;
    desc: string;
    usage?: string;
    group?: string;
    fn: (arg: string) => unknown;
}
/** The ext RPC bus face: drive / answer nvim-side extensions by extId. */
export interface ExtLuaLayer {
    /** Call a method registered by a Lua extension (api.rpc_register).
     *  Rejects with the remote error message when the handler fails. */
    call(extId: string, method: string, args?: unknown[]): Promise<unknown>;
    /** Fire an event at a Lua extension (User DshTuiExtEvent +
     *  api.on_ext_event callbacks). */
    emit(extId: string, event: string, payload?: unknown): void;
    /** Answer dsh-ext requests from a nvim extension (vim.rpcrequest).
     *  Returns a disposer. */
    on(extId: string, handler: (method: string, args: unknown[]) => unknown | Promise<unknown>): () => void;
}
/** Managed UI primitives (headless degrades to no-ops where flagged). */
export interface ExtUiLayer {
    /** Render a plugin card into a session feed. */
    card(opts: ExtCardOpts): ExtCardHandle;
    /** Open a managed floating window (ownership-registered). */
    float(opts: ExtFloatOpts): Promise<ExtFloatResult>;
    /** Close a float opened via ui.float. */
    floatClose(id: string): Promise<void>;
    /** Reuse the TUI picker float; resolves null on cancel. */
    picker(opts: ExtPickerOpts): Promise<string | null>;
    /** Transient notice in the feed (one line). */
    notice(text: unknown): void;
    /** Add/update a statusline segment ('' removes it). */
    statuslineSegment(id: string, text: string, priority?: number): void;
    /** Claim the right-edge panel slot (null when unavailable/headless). */
    panel(opts: ExtPanelOpts): Promise<ExtPanelHandles | null>;
    /** Release the panel slot claimed via ui.panel. */
    panelRelease(): Promise<void>;
}
/** The stable public surface. Consume via `ctx.get('nvim-tui')`. */
export interface TuiExtApi {
    /** Extension API version (semver). */
    version: string;
    /** Resolves when boot completes (nvim connected, first session attached).
     *  Queued calls before that are safe: nvim-layer calls reject until the
     *  channel exists. */
    ready: Promise<void>;
    /** Feature flags (headless degrades UI primitives to no-ops). */
    capabilities(): Record<string, boolean>;
    /** Raw nvim execution layer. */
    nvim: ExtNvimLayer;
    /** TUI lifecycle / intent events. Returns a disposer. */
    on(event: ExtEventName, cb: (payload: unknown) => void): () => void;
    /** Mirrored session/event subscription (live events + history replays).
     *  Returns a disposer. */
    onSessionEvent(filter: ExtSessionEventFilter, cb: (sessionId: string, ev: SessionEvent) => void): () => void;
    /** The active session id (null before boot). */
    getActiveSessionId(): string | null;
    /** Submit text as a chat message to the active session (input-box path). */
    submit(text: string): void;
    /** Fill the input box without submitting. */
    insertInput(text: string): void;
    /** Managed UI primitives. */
    ui: ExtUiLayer;
    /** Register slash commands (name WITHOUT '/') into the completion
     *  catalog + /help. Duplicate names are rejected. Returns a disposer. */
    registerCommands(cmds: ExtCommandSpec[]): () => void;
    /** The ext RPC bus: talk to nvim-side extensions by extId. */
    luaExt: ExtLuaLayer;
}
/** Install the extension API onto the App (runs before boot; index.ts then
 *  publishes the built surface through the cordis registry). */
export declare function installExtApi(app: App): void;
