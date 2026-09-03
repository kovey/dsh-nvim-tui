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
 *   boot.ts           nvim spawn, notification loop, host event wiring
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
import type { Context } from '@deepseek-ai/cordis'
import { setLocale } from './i18n.js'
import { createApp } from './app.js'
import { installStatusline } from './statusline.js'
import { installSessions } from './sessions.js'
import { installSubagents } from './subagents.js'
import { installTranscript } from './transcript.js'
import { installCommands } from './commands.js'
import { installMarketInstall } from './market-install.js'
import { installDeps } from './deps.js'
import { boot } from './boot.js'
import type { RuntimeCtx, RunnerConfig } from './types.js'

/** Version + build stamp shown in the boot banner (proof of which code runs). */
export { BUILD_VERSION, BUILD_STAMP } from './app.js'

export const name = 'dsh-nvim-tui'

export type { RunnerConfig } from './types.js'

/**
 * Mount the Neovim TUI runner over dsh-base.
 */
export function apply(ctx: Context, config: RunnerConfig = {}): void {
  ctx.inject(['agents', 'agentDefaultModel', 'sessions'], (rt) => {
    const runtimeCtx = rt as unknown as RuntimeCtx
    const localeInit = String(config.locale ?? process.env.DSH_NVIM_TUI_LOCALE ?? 'zh')
    setLocale(localeInit === 'en' ? 'en' : 'zh')

    const app = createApp(ctx, runtimeCtx, config)
    installStatusline(app)
    installSessions(app)
    installSubagents(app)
    installTranscript(app)
    installCommands(app)
    installMarketInstall(app)
    installDeps(app)
    app.boot = () => boot(app)
    void app.boot()
  })
}
