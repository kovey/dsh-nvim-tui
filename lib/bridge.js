import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attach } from 'neovim';
const here = dirname(fileURLToPath(import.meta.url));
/** Bundle root: one level up from lib/. */
export const bundleRoot = join(here, '..');
/** Directory added to nvim's runtimepath (contains lua/dsh_tui/). */
export const nvimRtpDir = join(bundleRoot, 'nvim');
/** Absolute path of the dsh_tui Lua module entry. */
export const dshTuiModulePath = join(nvimRtpDir, 'lua', 'dsh_tui', 'init.lua');
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
export async function spawnNvim({ extraArgs = [], onExit, loadUserConfig = true, isolateXdg = false, } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-nvim-tui-'));
    const sockPath = join(dir, 'nvim.sock');
    // A scratch file as the startup argument: nvim opens it INSTEAD of the
    // intro screen (which flashes [No Name] before the TUI mounts), and
    // dashboard plugins that skip when a file was given stay dormant too.
    const scratchPath = join(dir, 'scratch');
    await writeFile(scratchPath, '');
    const args = [
        ...(loadUserConfig ? [] : ['-u', 'NONE', '-i', 'NONE']),
        '--listen', sockPath,
        '--cmd', 'set shortmess+=I',
        // The terminal tab/title would otherwise flash the startup buffer name
        // ([No Name] / scratch) before the runner pushes 'dsh': pin it now.
        '--cmd', 'set title titlestring=dsh iconstring=dsh',
        '--cmd', `set rtp^=${nvimRtpDir}`,
        // No chrome flash during startup: tabline/statusline are off from the
        // very first frame, and OptionSet snaps any later `set …` (user config /
        // bufferline / statusline plugins) straight back — before a single frame
        // can draw them. NOTE: winbar is NOT snapped here — `:set winbar=` would
        // blank the CURRENT window's winbar, which after the TUI layout is the
        // input window's own frame top edge; the Lua enforcement re-asserts it
        // instead.
        '--cmd', 'set showtabline=0 laststatus=2 tabline= winbar=',
        '--cmd', 'autocmd OptionSet showtabline,laststatus,tabline ++nested set showtabline=0 laststatus=2 tabline=',
        // Register dsh_tui in package.preload (dofile on an absolute path) so
        // require() works even when the user's config rebuilds runtimepath or
        // vim.loader's cache_loader never scanned our rtp entry (lazy.nvim etc.).
        // package.preload is consulted before every other loader, and
        // package.loaded caches the result — the VimEnter autocmd and the Node
        // side both get the same module instance.
        '--cmd', `lua package.preload['dsh_tui'] = function() return dofile(${JSON.stringify(dshTuiModulePath)}) end`,
        // Mount the TUI layout at UIEnter — BEFORE the user's config runs — so the
        // very first drawn frame is already our chat+input layout, not nvim's
        // startup screen with its [No Name] placeholder (the visible "flash").
        // VimEnter re-asserts for configs/plugins that reshape things later.
        '--cmd', "lua vim.api.nvim_create_autocmd('UIEnter', { once = true, callback = function() pcall(require, 'dsh_tui'); require('dsh_tui').start() end })",
        '--cmd', "lua vim.api.nvim_create_autocmd('VimEnter', { once = true, callback = function() pcall(require, 'dsh_tui'); require('dsh_tui').start() end })",
        scratchPath,
        ...extraArgs,
    ];
    const child = spawn('nvim', args, {
        stdio: 'inherit',
        env: isolateXdg
            ? {
                ...process.env,
                XDG_STATE_HOME: dir,
                XDG_CACHE_HOME: dir,
                XDG_CONFIG_HOME: dir,
            }
            : process.env,
    });
    child.on('error', (err) => {
        // spawn itself failed (nvim missing, etc.) — surface it loudly.
        console.error('[dsh-nvim-tui] failed to spawn nvim:', err.message);
        onExit?.(-1, null);
    });
    child.on('exit', (code, signal) => onExit?.(code, signal));
    return { child, sockPath, dir };
}
/**
 * Connect to the nvim socket, retrying while nvim boots.
 *
 * The `neovim` package's `attach({socket})` is unusable for us: it returns a
 * client synchronously and never handles the socket 'error' event, so a
 * not-yet-listening socket crashes the process with an unhandled ENOENT.
 * We create the socket ourselves (with an error handler), hand it to
 * `attach({reader, writer})`, and await `nvim.channelId` for API readiness.
 */
export async function connectNvim(sockPath, { timeoutMs = 10000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
        const socket = net.createConnection(sockPath);
        const outcome = await new Promise((resolve) => {
            socket.once('connect', () => resolve('connected'));
            socket.once('error', (err) => {
                lastErr = err;
                resolve('retry');
            });
        });
        if (outcome === 'retry') {
            socket.destroy();
            await sleep(100);
            continue;
        }
        const nvim = attach({ reader: socket, writer: socket });
        try {
            await nvim.channelId; // resolves once nvim_get_api_info answered
            return nvim;
        }
        catch (err) {
            lastErr = err;
            socket.destroy();
            await sleep(100);
        }
    }
    throw new Error(`[dsh-nvim-tui] nvim socket connect timeout: ${sockPath}` +
        (lastErr ? ` (${lastErr.message})` : ''));
}
