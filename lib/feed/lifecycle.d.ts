/**
 * FeedRenderer buffer lifecycle: retire, re-bind, and flush-failure recovery.
 *
 * A FeedRenderer writes into an nvim buffer that a session or a subagent float
 * owns. When that buffer is deleted — `close_chat`, `close_subagent_view` /
 * `close_subagent_chat`, or an external `:bwipeout` — a queued 40ms throttle
 * flush or a pending 500ms "thinking…" ticker used to fire afterwards and
 * throw `nvim_buf_set_lines: Invalid buffer id: N` ("render flush failed"
 * spam, the online rc.2 report).
 *
 * The contract implemented here:
 *  - `disposeFeed` retires a feed BEFORE its buffer is deleted: every timer it
 *    owns stops and `schedule`/`flush`/`applyEvent` become no-ops;
 *  - `handleFlushFailure` classifies a failed flush. A vanished buffer is
 *    healed by adopting the CURRENT one from the feed's `idsProvider`
 *    (external wipe, the session/float is still open) or, when there is no
 *    buffer left, the feed retires itself silently — no throw, no log, no
 *    half-written view;
 *  - `isInvalidBufferError` is the ONLY failure class treated that way: every
 *    other RPC error is a real render bug and `handleFlushFailure` rethrows it,
 *    which is what keeps this from being a blanket swallow.
 *
 * The rules live in this module (taking the renderer's public surface as a
 * parameter) so `feed.ts` stays the pure renderer it is: owning the buffer's
 * lifetime is the session/float owner's concern, and a close path only has to
 * call `feed.dispose()`.
 *
 * @module dsh-nvim-tui/feed/lifecycle
 */
/** The renderer surface these helpers touch — PUBLIC members only, declared
 *  structurally so this module never imports `feed.ts` (a type-only import
 *  would still be a dependency edge) and never reaches into private state. */
interface FeedLifecycleHost {
    disposed: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    ticker: ReturnType<typeof setTimeout> | null;
    whaleTicker: ReturnType<typeof setInterval> | null;
    dirty: boolean;
    idsProvider: (() => Promise<unknown>) | null;
    bufId: number;
    winId: number;
    nvim: {
        request(method: string, args: unknown[]): Promise<unknown>;
    };
    lastView: string[];
    lastActivityCount: number;
    cardRanges: Map<string, {
        markId: number;
        startRow: number;
        endRow: number;
    }>;
    schedule(): void;
}
/** The dead-buffer RPC failure: nvim reports `Invalid buffer id: N`, and the
 *  RPC layer may prefix the method (`nvim_buf_set_lines: Invalid buffer id:
 *  30`). Only Error instances are classified — a plain string is not a
 *  failure this module can reason about. */
export declare const isInvalidBufferError: (err: unknown) => boolean;
/** Stop the blue-whale wallpaper ticker (its frame timer keeps flushing). */
export declare const stopWhaleTicker: (feed: FeedLifecycleHost) => void;
/** Retire a feed: stop the throttle timer, the activity ticker and the whale
 *  ticker, and make every buffer entry point a no-op. MUST run BEFORE the
 *  buffer itself is deleted (see the module note). Idempotent, and safe from
 *  any lifecycle path (close_chat, a float swap, the close notification). */
export declare const disposeFeed: (feed: FeedLifecycleHost) => void;
/** Classify a failed flush: a vanished buffer (or an already retired feed) is
 *  handled silently, anything else is rethrown so a real render bug still
 *  reaches the caller. Returns only when the failure was handled. */
export declare const handleFlushFailure: (feed: FeedLifecycleHost, err: unknown) => Promise<void>;
export {};
