/**
 * Capture the host's startup stderr so it cannot scribble over the TUI.
 *
 * WHY: dsh writes its post-activation diagnostics ("dsh: warning: N entries did
 * not activate" + one line per entry) with a plain `process.stderr.write` from
 * `dsh-app-boot`. That happens AFTER our nvim has already claimed the terminal
 * (measured: with `2>file` the warning lands in the file and on the terminal,
 * i.e. the fd is the tty we are drawing on), so the text is painted across
 * `laststatus`/input row and the cursor ends up sitting on the status line
 * instead of in the input row.
 *
 * Clearing the screen at mount time does NOT help — the bytes arrive later.
 * The only reliable place to stop them is before they reach the tty, which is
 * why this module swaps `process.stderr.write` while the plugin loads.
 *
 * The text is NOT discarded: it is buffered and handed to the caller, which
 * replays it into the chat feed (and the host still writes its own
 * `startup-*.log`, so a failure before nvim existed is never hidden).
 *
 * @module dsh-nvim-tui/kernel/host-stderr
 */
/**
 * Take over `process.stderr.write` for the host startup window.
 *
 * Idempotent: a second call while a capture is active is a no-op (the original
 * writer is still the one we wrapped). `DSH_NVIM_TUI_HOST_STDERR=raw` opts out
 * and leaves stderr alone — the escape hatch for reporting a bug in this
 * interception itself.
 */
export declare const captureHostStartupStderr: () => void;
/**
 * Stop capturing and return what was swallowed (joined text, or '' when there
 * was nothing). Safe to call when no capture is active.
 */
export declare const releaseHostStartupStderr: () => string;
/** Test seam: text captured so far without releasing the capture. */
export declare const peekHostStartupStderr: () => string;
