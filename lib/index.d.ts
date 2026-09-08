/**
 * dsh-nvim-tui runner entry — the COMPOSITION ROOT.
 *
 * index.ts only composes: it builds the shared App (app.ts), installs each
 * behavior module (statusline / sessions / subagents / transcript / commands
 * / market-install), then boots. No behavior lives here — the analogue of
 * nvim/lua/dsh_tui/init.lua's facade over the lua modules.
 *
 * Module map:
 *   app.ts            shared state + services (nvim/lua/dsh_tui/state.lua)
 *   statusline.ts     statusline rendering, glance segments, whale animation
 *   sessions.ts       session lifecycle + session commands (/sessions, /new,
 *                     /fork, /workspace, /archive, /rename, /layout)
 *   subagents.ts      subagent directory + transcript view + chat window
 *   transcript.ts     transcript repair/export/trajectory/rewind/queue
 *   commands.ts       messaging + generic slash commands
 *   market-install.ts plugin market + install progress UI
 *   deps.ts           dependency health check + one-click assembly (/deps)
 *   rpc.ts            nvim-notification registry (owners register, boot looks up)
 *   host-events.ts    harness host-event registry (same pattern)
 *   session-events.ts session/event pipeline (feed routing + per-type hooks)
 *   lifecycle.ts      exit diagnostics + teardown + quit (injected before any await)
 *   headless.ts       headless e2e dump watchdog + prompt kick
 *   boot.ts           run-phase composition root: spawn/connect + the wiring
 *                     loops + the boot sequence — no behavior branches
 *
 * Flow: spawn nvim (built-in TUI renders the terminal) → connect the socket →
 * hand nvim its channel id → create the initial session+agent → stream
 * `session/event` per session into its chat buffer → forward nvim keystrokes
 * (rpcnotify) to the active session's agent.
 *
 * Test mode (`config.headless: true` or `DSH_NVIM_TUI_HEADLESS=1`): nvim runs
 * with `--headless` (no TTY needed) and the runner dumps the active chat
 * buffer to `DSH_NVIM_TUI_DUMP` after the first completed turn (or the
 * watchdog), then exits.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { RunnerConfig } from './kernel/types.js';
/** Version + build stamp shown in the boot banner (proof of which code runs). */
export { BUILD_VERSION, BUILD_STAMP } from './kernel/app.js';
export declare const name = "dsh-nvim-tui";
export type { RunnerConfig } from './kernel/types.js';
export type { TuiExtApi, ExtNvimLayer, ExtSessionEventFilter, ExtEventName, ExtUiLayer, ExtCardOpts, ExtCardHandle, ExtFloatOpts, ExtFloatResult, ExtPickerOpts, ExtCommandSpec, ExtPanelOpts, ExtPanelHandles, ExtLuaLayer, ExtRegionOpts, ExtRegionHandles, } from './ext-api.js';
export { EXT_API_VERSION, EXT_HANDLER_TIMEOUT_MS, matchSessionEventFilter } from './ext-api.js';
/**
 * Mount the Neovim TUI runner over dsh-base.
 */
export declare function apply(ctx: Context, config?: RunnerConfig): void;
