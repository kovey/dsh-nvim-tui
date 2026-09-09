/**
 * Terminal-mode hygiene for the runner's own tty: a previous instance that
 * crashed or was force-killed mid-exit (or an older build) can leave the
 * terminal in kitty-keyboard-protocol / alternate-screen / mouse-tracking /
 * focus-reporting state. nvim's tui then negotiates against a lying
 * terminal: keys arrive as raw "…;…u" sequences typed INTO the input box
 * and the TUI frame breaks. Reset the common modes before the child claims
 * the terminal — nvim re-enables exactly what it needs afterwards.
 *
 * @module dsh-nvim-tui/kernel/term
 */
import { spawnSync } from 'node:child_process'

/** Discard any bytes still queued in the tty INPUT (a crashed nvim leaves
 *  its unconsumed terminal-query responses behind — the next nvim reads
 *  them as keystrokes and misbehaves). tcflush(TCIFLUSH) via python3:
 *  Node exposes no equivalent. Best-effort; non-tty stdin skips. */
export function flushTtyInput(): void {
  if (process.stdin.isTTY !== true) return
  try {
    spawnSync('python3', ['-c', 'import termios,sys; termios.tcflush(sys.stdin.fileno(), termios.TCIFLUSH)'],
      { stdio: 'inherit' })
  } catch { /* a missing python3 only means the queue stays — nvim tolerates most */ }
}

/** Disable the terminal modes a killed nvim may have left enabled.
 *  Harmless when the terminal is already clean (idempotent disables). */
export function resetTerminalModes(): void {
  if (process.stdout.isTTY !== true) return
  try {
    process.stdout.write(
      '\x1b[?1049l' + // leave alternate screen (restore main screen)
      '\x1b[<u' + // kitty keyboard protocol OFF (the input-garbage root cause)
      '\x1b[>4;0m' + // modifyOtherKeys OFF
      '\x1b[?2004l' + // bracketed paste OFF
      '\x1b[?1004l' + // focus events OFF
      '\x1b[?1002l' + // button mouse tracking OFF
      '\x1b[?1003l' + // any-motion mouse tracking OFF
      '\x1b[?1006l' + // SGR mouse mode OFF
      '\x1b[?25h' + // cursor visible
      '\x1b[0m' + // SGR reset
      '\x1b[?1l', // application cursor keys OFF (DECCKM)
    )
  } catch { /* the write is best-effort; a dead tty must not hurt boot */ }
}
