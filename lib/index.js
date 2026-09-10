import { setLocale } from './kernel/i18n.js';
import { createApp } from './kernel/app.js';
import { installExtApi } from './ext-api/index.js';
import { installStatusline } from './statusline/index.js';
import { installSessions } from './sessions/index.js';
import { installSubagents } from './subagents/index.js';
import { installTranscript } from './transcript/index.js';
import { installCommands } from './commands/index.js';
import { installMarketInstall } from './market/index.js';
import { installDeps } from './deps/index.js';
import { boot, installRuntime } from './boot/boot.js';
/** Version + build stamp shown in the boot banner (proof of which code runs). */
export { BUILD_VERSION, BUILD_STAMP } from './kernel/app.js';
export const name = 'dsh-nvim-tui';
export { EXT_API_VERSION, EXT_HANDLER_TIMEOUT_MS, matchSessionEventFilter } from './ext-api/index.js';
/**
 * Mount the Neovim TUI runner over dsh-base.
 */
export function apply(ctx, config = {}) {
    // dsh 0.1.5 removed the `sessions` service: the live-session store is the
    // agents registry itself (createApp builds the store-shaped adapter over
    // `agents.get/list` → `Agent.session`). Inject only what 0.1.5 provides —
    // and never assign onto the cordis context: property assignment carries
    // service-registration semantics and deadlocks inside inject.
    ctx.inject(['agents', 'agentDefaultModel'], (rt) => {
        const runtimeCtx = rt;
        const localeInit = String(config.locale ?? process.env.DSH_NVIM_TUI_LOCALE ?? 'zh');
        setLocale(localeInit === 'en' ? 'en' : 'zh');
        const app = createApp(ctx, runtimeCtx, config);
        installRuntime(app); // runtime defaults first: installs push hostDisposers
        installExtApi(app);
        installStatusline(app);
        installSessions(app);
        installSubagents(app);
        installTranscript(app);
        installCommands(app);
        installMarketInstall(app);
        installDeps(app, app.slices.agent);
        // Publish the extension surface: other dsh plugins consume it via
        // `ctx.get('nvim-tui')` (the name freezes on first release). The
        // service value lives as long as this runner — it is NOT disposed here.
        ctx.provide('nvim-tui', app.slices.ext.extApi);
        app.slices.runtime.boot = () => boot(app);
        void app.slices.runtime.boot();
    });
}
