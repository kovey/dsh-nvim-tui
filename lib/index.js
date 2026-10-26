import { setLocale } from './kernel/i18n.js';
import { parseTuiArgs, TUI_HELP } from './kernel/cli.js';
import { BUILD_VERSION } from './kernel/app.js';
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
import { captureHostStartupStderr } from './kernel/host-stderr.js';
// Module-scope side effect, NOT inside apply(): measured in a real PTY, the
// host's activation warning reaches the terminal only AFTER this module is
// evaluated (it comes from the reload dsh triggers by rewriting cordis.yml),
// so importing this file is early enough. Installing it in apply() was also
// fine, but module scope is the earliest point we control.
//
// Without this the raw bytes land on the input/statusline row — see
// kernel/host-stderr.ts for the fd-level evidence.
captureHostStartupStderr();
/** Version + build stamp shown in the boot banner (proof of which code runs). */
export { BUILD_VERSION, BUILD_STAMP } from './kernel/app.js';
export const name = 'dsh-nvim-tui';
export { EXT_API_VERSION, EXT_HANDLER_TIMEOUT_MS, matchSessionEventFilter } from './ext-api/index.js';
/**
 * Mount the Neovim TUI runner over dsh-base.
 */
export function apply(ctx, config = {}) {
    // App arguments: dsh hands the profile its own slice via `cmdlineArgs`; the
    // TUI profile does not mount dsh-cmdline, so fall back to argv after the
    // launcher's `--profile` prefix. Help/version exit before spawning nvim.
    const cmdline = ctx.get('cmdlineArgs');
    const fromCmdline = Array.isArray(cmdline?.args);
    const cli = parseTuiArgs(fromCmdline ? cmdline?.args ?? [] : process.argv.slice(2), fromCmdline);
    const exit = (code) => {
        const appExit = ctx.get('appExit');
        if (typeof appExit === 'function')
            appExit(code);
        else
            process.exit(code);
    };
    if (cli.help) {
        process.stdout.write(TUI_HELP);
        exit(0);
        return;
    }
    if (cli.version) {
        process.stdout.write(`dsh-nvim-tui ${BUILD_VERSION}\n`);
        exit(0);
        return;
    }
    if (cli.unknown.length > 0) {
        process.stderr.write(`dsh-nvim-tui: unknown argument(s): ${cli.unknown.join(' ')}\n${TUI_HELP}`);
        exit(2);
        return;
    }
    const effective = { ...config };
    if (cli.resumeId !== undefined)
        effective.resumeSessionId = cli.resumeId;
    if (cli.resumeLatest === true)
        effective.resumeLatest = true;
    if (cli.model !== undefined)
        effective['startupModel'] = cli.model;
    if (cli.permission !== undefined)
        effective['startupPermission'] = cli.permission;
    // dsh 0.1.5 removed the `sessions` service: the live-session store is the
    // agents registry itself (createApp builds the store-shaped adapter over
    // `agents.get/list` → `Agent.session`). Inject only what 0.1.5 provides —
    // and never assign onto the cordis context: property assignment carries
    // service-registration semantics and deadlocks inside inject.
    ctx.inject(['agents', 'agentDefaultModel'], (rt) => {
        const runtimeCtx = rt;
        const localeInit = String(config['locale'] ?? process.env['DSH_NVIM_TUI_LOCALE'] ?? 'zh');
        setLocale(localeInit === 'en' ? 'en' : 'zh');
        const app = createApp(ctx, runtimeCtx, effective);
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
