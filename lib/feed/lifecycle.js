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
/** The dead-buffer RPC failure: nvim reports `Invalid buffer id: N`, and the
 *  RPC layer may prefix the method (`nvim_buf_set_lines: Invalid buffer id:
 *  30`). Only Error instances are classified — a plain string is not a
 *  failure this module can reason about. */
export const isInvalidBufferError = (err) => err instanceof Error && /Invalid buffer id/.test(err.message);
/** Stop the blue-whale wallpaper ticker (its frame timer keeps flushing). */
export const stopWhaleTicker = (feed) => {
    if (feed.whaleTicker === null)
        return;
    clearInterval(feed.whaleTicker);
    feed.whaleTicker = null;
};
/** Retire a feed: stop the throttle timer, the activity ticker and the whale
 *  ticker, and make every buffer entry point a no-op. MUST run BEFORE the
 *  buffer itself is deleted (see the module note). Idempotent, and safe from
 *  any lifecycle path (close_chat, a float swap, the close notification). */
export const disposeFeed = (feed) => {
    if (feed.disposed)
        return;
    feed.disposed = true;
    if (feed.timer !== null) {
        clearTimeout(feed.timer);
        feed.timer = null;
    }
    if (feed.ticker !== null) {
        clearTimeout(feed.ticker);
        feed.ticker = null;
    }
    stopWhaleTicker(feed);
    // A queued follow-up flush must not resurrect a retired feed.
    feed.dirty = false;
};
/** Re-adopt the CURRENT buffer after the one this feed was writing into
 *  vanished. Ids come from the provider the constructor took: sessions expose
 *  `chatBuf`/`chatWin`, subagent floats expose `buf`/`win`. Returns false when
 *  there is no live buffer to adopt (the caller then retires the feed). */
const rebindBuffer = async (feed) => {
    if (feed.idsProvider === null)
        return false;
    let ids;
    try {
        ids = (await feed.idsProvider());
    }
    catch {
        return false;
    }
    if (ids === null || ids === undefined || typeof ids !== 'object')
        return false;
    const buf = [ids.chatBuf, ids.buf].find((cand) => typeof cand === 'number' && Number.isInteger(cand));
    if (buf === undefined)
        return false;
    // A stale provider may hand back the DEAD id (the Lua registry keeps it
    // until close_chat drops the entry): only a VALID buffer is adopted,
    // otherwise this would loop on the same invalid id forever.
    try {
        const valid = await feed.nvim.request('nvim_buf_is_valid', [buf]);
        if (valid !== true)
            return false;
    }
    catch {
        return false;
    }
    feed.bufId = buf;
    const win = [ids.chatWin, ids.win].find((cand) => typeof cand === 'number' && Number.isInteger(cand));
    if (win !== undefined)
        feed.winId = win;
    // The new buffer holds none of the rows `lastView` claims: repaint in full
    // on the next flush.
    feed.lastView = [];
    feed.lastActivityCount = 0;
    // Extmark ids belonged to the dead buffer — the next flush re-creates them
    // (a delete in the new buffer fails harmlessly, so drop the map).
    feed.cardRanges.clear();
    feed.schedule();
    return true;
};
/** Classify a failed flush: a vanished buffer (or an already retired feed) is
 *  handled silently, anything else is rethrown so a real render bug still
 *  reaches the caller. Returns only when the failure was handled. */
export const handleFlushFailure = async (feed, err) => {
    // A retired feed's buffer is gone by design — stay silent.
    if (feed.disposed)
        return;
    if (!isInvalidBufferError(err))
        throw err;
    if (await rebindBuffer(feed))
        return;
    disposeFeed(feed);
};
