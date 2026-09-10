/**
 * dsh_tui kernel module: RUNNING-PROFILE resolution.
 *
 * Ground truth is the Cordis loader's root include entry — its config.path
 * is file://…/profiles/<name>/cordis.yml, i.e. the profile this process
 * actually booted, for ANY launch spelling (`dsh --profile <n>`,
 * `dsh --profile=<n>`, the `web` alias, wrappers). argv parsing is only a
 * fallback for loader-less contexts (tests/headless). Nothing silently
 * assumes a profile name — callers must fail loud when this returns
 * undefined instead of guessing `nvim-tui`.
 *
 * @module dsh-nvim-tui/kernel/profile
 */
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
export function runningProfileName(app) {
    // ① The tree's own root include entry — authoritative.
    try {
        const loader = app.runtimeCtx.get('loader');
        const entry = loader?.resolve?.('include') ??
            loader?.entries?.().find((e) => e.id === 'include' || e.options?.name === 'cordis:include');
        const raw = entry?.options?.config?.path;
        if (typeof raw === 'string' && raw !== '') {
            const p = raw.startsWith('file:') ? fileURLToPath(raw) : raw;
            if (basename(p) === 'cordis.yml' || basename(p) === 'cordis.yaml') {
                const name = basename(dirname(p));
                if (name !== '' && name !== 'profiles' && name !== '.dsh')
                    return name;
            }
        }
    }
    catch { }
    // ② argv fallback (loader not reachable — tests/headless contexts).
    const argv = process.argv;
    const idx = argv.indexOf('--profile');
    if (idx >= 0 && argv[idx + 1] !== undefined && !argv[idx + 1].startsWith('-'))
        return argv[idx + 1];
    const eq = argv.find((a) => a.startsWith('--profile='));
    if (eq !== undefined)
        return eq.slice('--profile='.length);
    return undefined;
}
