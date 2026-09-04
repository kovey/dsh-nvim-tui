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
/** TUI lifecycle / user-intent events. */
export type ExtEventName = 'tui:ready' | 'tui:active-session' | 'tui:input' | 'tui:teardown';
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
}
/** Install the extension API onto the App (runs before boot; index.ts then
 *  publishes the built surface through the cordis registry). */
export declare function installExtApi(app: App): void;
