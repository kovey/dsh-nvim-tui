/**
 * Text clipboard helper for `/copy`.
 *
 * The TUI runs on macOS/Linux/Windows terminals; there is no single portable
 * clipboard API in Node. Try the platform's usual command in order and report
 * the exact failure instead of pretending the copy worked.
 *
 * @module dsh-nvim-tui/clipboard
 */
import { spawnSync } from 'node:child_process'

export interface ClipboardResult {
  ok: boolean
  command?: string
  error?: string
}

/** Candidate argv lists, in preference order, for one platform. */
export const clipboardCommands = (platform: string = process.platform): string[][] => {
  if (platform === 'darwin') return [['pbcopy']]
  if (platform === 'win32') return [['clip']]
  return [
    ['wl-copy'],
    ['xclip', '-selection', 'clipboard'],
    ['xsel', '--clipboard', '--input'],
  ]
}

/** Copy `text` verbatim through the first working platform command. */
export const writeClipboardText = (text: string, platform: string = process.platform): ClipboardResult => {
  const failures: string[] = []
  for (const argv of clipboardCommands(platform)) {
    try {
      const result = spawnSync(argv[0] as string, argv.slice(1), {
        input: text,
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      })
      if (result.error === undefined && result.status === 0) {
        return { ok: true, command: argv.join(' ') }
      }
      failures.push(`${argv[0]}: ${result.error?.message ?? `exit ${String(result.status)}`}`)
    } catch (err) {
      failures.push(`${argv[0]}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { ok: false, error: failures.join(' · ') || 'no clipboard command available' }
}
