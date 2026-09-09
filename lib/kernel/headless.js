/**
 * Headless e2e plumbing: the dump watchdog, the dump-and-quit routine and
 * the prompt kick. Installed up-front in boot so the session/event wiring
 * can reference `dumpAndQuit` before the first event can arrive (it used to
 * be declared AFTER the wiring — a TDZ landmine).
 *
 * @module dsh-nvim-tui/headless
 */
import { writeFileSync } from 'node:fs';
export function installHeadless(app) {
    let watchdog = null;
    const dumpAndQuit = async () => {
        if (watchdog !== null)
            clearTimeout(watchdog);
        if (app.slices.runtime.disposed)
            return;
        if (app.headless) {
            try {
                const feed = app.slices.ui.activeFeed();
                const lines = await app.slices.runtime.nvim.request('nvim_buf_get_lines', [feed.bufId, 0, -1, false]);
                const listLines = app.slices.sessions.sessionEntries.map((s) => `[ ${s.id === app.slices.sessions.activeId ? '▸' : ' '} ${s.title || '（无标题）'} · ${s.id} · ${s.kind}`);
                writeFileSync(app.dumpPath, `# dsh-nvim-tui e2e dump (${new Date().toISOString()})\n` +
                    '## session list\n' +
                    listLines.join('\n') + '\n' +
                    '## active chat\n' +
                    lines.map((l) => `| ${l}`).join('\n') + '\n');
            }
            catch (err) {
                writeFileSync(app.dumpPath, `# dump failed: ${err.message}\n`);
            }
        }
        await app.quit(0);
    };
    const startWatchdog = () => {
        if (!app.headless)
            return;
        watchdog = setTimeout(() => {
            if (app.headless)
                void dumpAndQuit();
        }, app.watchdogMs);
    };
    // The watchdog outlives its boot on a runner-row reload: hand teardown a
    // disposer (same pattern as the host-event disposers) so the old timer
    // never keeps the old app alive past teardown.
    app.slices.runtime.hostDisposers.push(() => {
        if (watchdog !== null)
            clearTimeout(watchdog);
    });
    const kick = () => {
        const headlessPrompt = app.config.prompt ?? process.env.DSH_NVIM_TUI_PROMPT;
        if (app.headless && headlessPrompt)
            app.slices.agent.send(headlessPrompt);
    };
    return { dumpAndQuit, startWatchdog, kick };
}
