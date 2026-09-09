/**
 * dsh-nvim-tui extension API — the PUBLIC TYPE CONTRACT (kernel-owned).
 *
 * The type definitions of the extension surface live here so the kernel
 * (app.ts) can reference them without depending on the ext-api module;
 * ext-api.ts keeps the implementation and re-exports these for
 * compatibility with the original import paths.
 *
 * @module dsh-nvim-tui/kernel/ext-types
 */
import type { SessionEvent } from './types.js';
/** Nvim execution layer. `request` accepts nvim_* API methods only and
 *  `call` is restricted to a READ-ONLY vim.fn whitelist (no execution
 *  primitives); ARBITRARY execution lives behind `lua` / `ex` (declared by
 *  capabilities.unrestrictedExec). Any dsh plugin holding the service can
 *  run arbitrary nvim code through those two — treat ctx.get('nvim-tui')
 *  as equivalent to a shell on the user's machine; only load trusted
 *  plugins. */
export interface ExtNvimLayer {
    /** nvim_* API request (msgpack-RPC). Optional timeout rejects instead of
     *  wedging the caller — nvim keeps executing, so calls must be
     *  idempotence-safe. Non-nvim_* methods reject. */
    request(method: string, args?: unknown[], opts?: {
        timeoutMs?: number;
    }): Promise<unknown>;
    /** vim.fn call — read-only whitelist only (exec primitives reject). */
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
    /** Action hints rendered as a footer row. With onAction, they become
     *  interactive: cursor on the card + 1-9 fires action N, Enter opens
     *  the action picker (both only on the main chat window).
     *  kind: 'plain' (default, immediate) / 'confirm' (picker gate) /
     *  'input' (typed value via the input box; headless degrades to plain).
     *  onAction receives action.value for plain/confirm, the TYPED text
     *  for input. */
    actions?: Array<{
        label: string;
        value: string;
        kind?: 'plain' | 'confirm' | 'input';
        confirmText?: string;
        inputPrompt?: string;
        inputDefault?: string;
    }>;
    /** Interactive activation callback (value = the fired action's value). */
    onAction?: (value: string) => void;
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
/** ui.panel options (the panel column — MULTI-BLOCK: each slot owns one
 *  block; multiple slots stack concurrently). */
export interface ExtPanelOpts {
    /** Claim slot name (Node-side free-form; 'default' when omitted — the
     *  back-compat single-panel slot). Re-claiming the SAME slot replaces
     *  its block. Prefix slot names with your plugin id to avoid collisions
     *  (e.g. 'dsh-git:log'). */
    slot?: string;
    /** Column side (default 'right'). */
    side?: 'right' | 'left';
    width?: number;
    /** Explicit height in rows; omitted = weighted share of the column
     *  budget (other panels' explicit heights win first). */
    height?: number;
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
    /** The claim slot this panel occupies. */
    slot: string;
    /** Release exactly THIS panel (slot + side). */
    release(): Promise<void>;
}
/** ui.region options (the four-edge dock slots — floats only, no splits;
 *  the chat/input layout never changes). Same slot machinery as ui.panel:
 *  one block per slot per side, re-claim replaces. */
export interface ExtRegionOpts {
    /** Claim slot name (Node-side free-form; 'default' when omitted). */
    slot?: string;
    /** Dock side (default 'right'). */
    side?: 'right' | 'left' | 'top' | 'bottom';
    /** right/left: column width; top/bottom: explicit cols — omitted =
     *  weighted share of the dock budget. */
    width?: number;
    /** right/left: explicit rows; omitted = weighted share. */
    height?: number;
    /** top/bottom: rows (default 6). */
    size?: number;
    title?: string;
    /** Hints embedded in the bottom border (nvim >= 0.10). */
    footer?: string;
    /** Initial content lines. */
    lines?: string[];
}
/** Claimed region: write content via api.nvim into `buf`. */
export interface ExtRegionHandles {
    win: number;
    buf: number;
    /** The claim slot this region occupies. */
    slot: string;
    /** Release exactly THIS region (slot + side). */
    release(): Promise<void>;
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
     *  Rejects with the remote error message when the handler fails, and
     *  with a timeout error when it overruns opts.timeoutMs (default
     *  EXT_HANDLER_TIMEOUT_MS). */
    call(extId: string, method: string, args?: unknown[], opts?: {
        timeoutMs?: number;
    }): Promise<unknown>;
    /** Fire an event at a Lua extension (User DshTuiExtEvent +
     *  api.on_ext_event callbacks). */
    emit(extId: string, event: string, payload?: unknown): void;
    /** Answer dsh-ext requests from a nvim extension (vim.rpcrequest).
     *  Every request is answered within opts.timeoutMs (default 30s) — a
     *  slow handler gets a timeout error reply and keeps running in the
     *  background (its late result is discarded). Returns a disposer. */
    on(extId: string, handler: (method: string, args: unknown[]) => unknown | Promise<unknown>, opts?: {
        timeoutMs?: number;
    }): () => void;
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
    /** Claim a panel block (MULTI-BLOCK: one per slot, concurrent stacking).
     *  null when unavailable/headless. */
    panel(opts: ExtPanelOpts): Promise<ExtPanelHandles | null>;
    /** Release the slot's panel blocks claimed via ui.panel (omitted =
     *  the 'default' slot only — back-compat). */
    panelRelease(slot?: string): Promise<void>;
    /** Every Node-side panel/region claim (slot → side → handles). */
    panels(): Array<{
        slot: string;
        side: string;
        win: number;
        buf: number;
    }>;
    /** Claim a dock region (four edges; floats only, the chat/input layout
     *  never changes; multi-block per slot). null when unavailable/headless. */
    region(opts: ExtRegionOpts): Promise<ExtRegionHandles | null>;
    /** Release the slot's region blocks claimed via ui.region (omitted =
     *  the 'default' slot only). */
    regionRelease(slot?: string): Promise<void>;
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
