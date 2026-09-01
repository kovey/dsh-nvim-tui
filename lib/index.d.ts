import type { Context } from '@deepseek-ai/cordis';
/** Version + build stamp shown in the boot banner (proof of which code runs). */
export declare const BUILD_VERSION = "0.2.11";
export declare const BUILD_STAMP: string;
export declare const name = "dsh-nvim-tui";
/**
 * Mount the Neovim TUI runner over dsh-base.
 *
 * Flow: spawn nvim (built-in TUI renders the terminal) → connect the socket →
 * hand nvim its channel id → create the initial session+agent → stream
 * `session/event` per session into its chat buffer → forward nvim keystrokes
 * (rpcnotify) to the active session's agent.
 *
 * Sessions: one live record per owned agent ({handle, feed, title}). The
 * session list shows live sessions + persisted history; selecting a history
 * entry resumes it via `agents.resume` and replays its events into the chat.
 *
 * Test mode (`config.headless: true` or `DSH_NVIM_TUI_HEADLESS=1`): nvim runs
 * with `--headless` (no TTY needed) and the runner dumps the active chat
 * buffer to `DSH_NVIM_TUI_DUMP` after the first completed turn (or the
 * watchdog), then exits.
 */
export interface RunnerConfig {
    headless?: boolean;
    watchdogMs?: number;
    dumpPath?: string;
    theme?: Record<string, unknown> | null;
    loadUserConfig?: boolean;
    resumeSessionId?: string;
    resumeLatest?: boolean;
    prompt?: string;
    [key: string]: unknown;
}
export declare function apply(ctx: Context, config?: RunnerConfig): void;
