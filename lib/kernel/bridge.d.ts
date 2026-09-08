import { spawn } from 'node:child_process';
import { NeovimClient } from 'neovim';
export interface SpawnedNvim {
    child: ReturnType<typeof spawn>;
    sockPath: string;
    dir: string;
}
/**
 * Spawn nvim as the terminal UI shell.
 *
 * Deliberately NOT `--embed`: that implies headless and hands grid rendering
 * back to us. We launch nvim normally so its built-in TUI renders the
 * terminal, and talk to it over a `--listen` socket.
 *
 * By default the user's own nvim config and plugins ARE loaded (their
 * colorscheme/statusline/plugins apply). `loadUserConfig: false` switches to
 * `-u NONE`. The dsh_tui UI is mounted on VimEnter (after user config), then
 * claims the window layout. `isolateXdg: true` points XDG dirs at a private
 * temp dir (sandbox/CI/headless tests — incidentally also isolates the user
 * config, since XDG_CONFIG_HOME moves).
 */
export declare function spawnNvim({ extraArgs, onExit, loadUserConfig, isolateXdg, }?: {
    extraArgs?: string[];
    onExit?: (code: number | null, signal: string | null) => void;
    loadUserConfig?: boolean;
    isolateXdg?: boolean;
}): Promise<SpawnedNvim>;
/**
 * Connect to the nvim socket, retrying while nvim boots.
 *
 * The `neovim` package's `attach({socket})` is unusable for us: it returns a
 * client synchronously and never handles the socket 'error' event, so a
 * not-yet-listening socket crashes the process with an unhandled ENOENT.
 * We create the socket ourselves (with an error handler), hand it to
 * `attach({reader, writer})`, and await `nvim.channelId` for API readiness.
 */
export declare function connectNvim(sockPath: string, { timeoutMs }?: {
    timeoutMs?: number;
}): Promise<NeovimClient>;
