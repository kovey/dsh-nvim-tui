/**
 * Keep the host's own stderr writes off the terminal while the TUI owns it.
 *
 * MEASURED PROBLEM. `dsh` holds the terminal directly (`pid 99090: fd0/1/2 →
 * /dev/ttysNNN`) and writes its post-activation diagnostic — "dsh: warning: N
 * entries did not activate" — with a plain `process.stderr.write`. Our TUI draws
 * on that same terminal, so the raw bytes land wherever the cursor happens to be
 * (observed: appended to the statusline/input row) and the user sees the warning
 * "inside the input box" with the cursor pushed onto the status line.
 *
 * WHY THE TIMING WORKS. The warning arrives AFTER this module is evaluated (it
 * is emitted by the reload that dsh's own `cordis.yml` rewrite triggers), so
 * installing the takeover at module scope is early enough. That was verified in
 * a real PTY: the transcript carries no bare warning while the host's own stderr
 * (redirected to a file) still does.
 *
 * The state is parked on `globalThis` so it survives the plugin module being
 * re-imported by that same reload: a fresh module instance must not wrap its own
 * wrapper, and release must be able to restore the ORIGINAL writer.
 *
 * Text is not discarded — {@link releaseHostStartupStderr} hands it back for the
 * caller to replay into the chat feed. `DSH_NVIM_TUI_HOST_STDERR=raw` opts out
 * (for reporting a bug in this interception itself).
 *
 * @module dsh-nvim-tui/kernel/host-stderr
 */
/** Parked on globalThis so a module reload reuses the installed writer. */
const GLOBAL_KEY = '__dshNvimTuiHostStderr';
const sinkOf = () => globalThis[GLOBAL_KEY];
/**
 * Take over `process.stderr.write`. Idempotent and reload-safe: a second call
 * (including from a re-evaluated module) is a no-op while a sink exists.
 */
export const captureHostStartupStderr = () => {
    if (sinkOf() !== undefined)
        return;
    if (process.env['DSH_NVIM_TUI_HOST_STDERR'] === 'raw')
        return;
    const original = process.stderr.write.bind(process.stderr);
    const sink = { captured: [], original, patched: null };
    const patched = ((chunk, ...rest) => {
        sink.captured.push(typeof chunk === 'string' ? chunk : String(chunk));
        // Report success so callers keep their flow, but do not put the bytes on the
        // terminal we are drawing on.
        const cb = rest.find((r) => typeof r === 'function');
        if (cb !== undefined)
            queueMicrotask(cb);
        return true;
    });
    sink.patched = patched;
    globalThis[GLOBAL_KEY] = sink;
    process.stderr.write = patched;
};
/**
 * Read and clear the captured text WITHOUT giving the writer back.
 *
 * This is the drain to use at runtime. Releasing the writer first would open a
 * race: the host's config reload can emit its next line between "restore the raw
 * writer" and "re-arm the capture", and that line would land on the terminal —
 * measured as 2 leaks in 3 runs before this was split out.
 */
export const drainHostStderr = () => {
    const sink = sinkOf();
    if (sink === undefined)
        return '';
    const text = sink.captured.join('');
    sink.captured = [];
    return text;
};
/**
 * Strip terminal control bytes and stray progress characters from captured host
 * output so it is safe to render as chat text.
 *
 * The host interleaves its own spinner updates with real lines (measured:
 * `…layer disabled o o o l dsh: warning: …`), and a raw escape sequence in a
 * notice would corrupt the feed instead of being displayed.
 */
export const cleanHostStderrText = (text) => text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI … final byte
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '') // OSC
    .replace(/\r\n?/g, '\n') // CR / CRLF -> LF
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '') // other C0 + DEL
    .replace(/(?:\s*\b[o0l]\b){2,}/g, ' ') // spinner runs
    .replace(/[ \t]+\n/g, '\n');
/**
 * Stop swallowing entirely and return the remaining text.
 *
 * Only restores the writer when WE are still the installed one, so a writer
 * installed after us by the host (or another plugin) is left alone. Prefer
 * {@link drainHostStderr} at runtime — see the race note there.
 */
export const releaseHostStartupStderr = () => {
    const sink = sinkOf();
    if (sink === undefined)
        return '';
    if (sink.patched !== null && process.stderr.write === sink.patched) {
        process.stderr.write = sink.original;
    }
    const text = sink.captured.join('');
    sink.captured = [];
    return text;
};
/** Test seam: text captured so far, without draining. */
export const peekHostStartupStderr = () => sinkOf()?.captured.join('') ?? '';
