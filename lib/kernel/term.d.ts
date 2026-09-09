/** Discard any bytes still queued in the tty INPUT (a crashed nvim leaves
 *  its unconsumed terminal-query responses behind — the next nvim reads
 *  them as keystrokes and misbehaves). tcflush(TCIFLUSH) via python3:
 *  Node exposes no equivalent. Best-effort; non-tty stdin skips. */
export declare function flushTtyInput(): void;
/** Disable the terminal modes a killed nvim may have left enabled.
 *  Harmless when the terminal is already clean (idempotent disables). */
export declare function resetTerminalModes(): void;
