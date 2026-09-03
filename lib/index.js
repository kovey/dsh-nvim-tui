import { setLocale } from './i18n.js';
import { createApp } from './app.js';
import { installStatusline } from './statusline.js';
import { installSessions } from './sessions.js';
import { installSubagents } from './subagents.js';
import { installTranscript } from './transcript.js';
import { installCommands } from './commands.js';
import { installMarketInstall } from './market-install.js';
import { boot } from './boot.js';
/** Version + build stamp shown in the boot banner (proof of which code runs). */
export { BUILD_VERSION, BUILD_STAMP } from './app.js';
export const name = 'dsh-nvim-tui';
/**
 * Mount the Neovim TUI runner over dsh-base.
 */
export function apply(ctx, config = {}) {
    ctx.inject(['agents', 'agentDefaultModel', 'sessions'], (rt) => {
        const runtimeCtx = rt;
        const localeInit = String(config.locale ?? process.env.DSH_NVIM_TUI_LOCALE ?? 'zh');
        setLocale(localeInit === 'en' ? 'en' : 'zh');
        const app = createApp(ctx, runtimeCtx, config);
        installStatusline(app);
        installSessions(app);
        installSubagents(app);
        installTranscript(app);
        installCommands(app);
        installMarketInstall(app);
        app.boot = () => boot(app);
        void app.boot();
    });
}
