/**
 * App-level command-line parsing for the TUI profile.
 *
 * dsh hands every app its own argument slice (`ctx.cmdlineArgs`); without this
 * parser those arguments were silently ignored, including the
 * `dsh --profile tui --resume <id>` spelling documented by dsh itself. The
 * parser is pure so the flag grammar is asserted without booting nvim.
 *
 * Supported flags deliberately stay small: resume/continue, startup model and
 * permission preset, plus help/version. Unknown flags fail loudly instead of
 * being dropped — a typo must not quietly start a different session.
 *
 * @module dsh-nvim-tui/cli
 */
/** Strip the launcher's own prefix when `cmdlineArgs` is unavailable.
 *  Launcher grammar: `dsh --profile <name> <app args…>`, `dsh <name> …`, or
 *  `--profile=<name>`. The bare `dsh --help` belongs to the launcher, so it
 *  yields no app arguments. */
export const appArgv = (argv, fromCmdline) => {
    if (fromCmdline)
        return argv.slice();
    const args = argv.slice();
    const p = args.findIndex((a) => a === '--profile' || a.startsWith('--profile='));
    if (p >= 0) {
        const token = args[p];
        return token.includes('=') ? args.slice(p + 1) : args.slice(p + 2);
    }
    if (args[0] !== undefined && args[0] !== '' && !args[0].startsWith('-'))
        return args.slice(1);
    return [];
};
/** Parse the app arguments. Unknown/missing values are reported, never dropped. */
export const parseTuiArgs = (argv, fromCmdline = false) => {
    const args = appArgv(argv, fromCmdline);
    const out = { help: false, version: false, unknown: [] };
    const valueOf = (i, flag) => {
        const v = args[i + 1];
        if (v === undefined || v.startsWith('-')) {
            out.unknown.push(flag);
            return undefined;
        }
        return v;
    };
    for (let i = 0; i < args.length; i += 1) {
        const a = args[i];
        if (a === undefined)
            continue;
        if (a === '--help' || a === '-h') {
            out.help = true;
            continue;
        }
        if (a === '--version' || a === '-v') {
            out.version = true;
            continue;
        }
        if (a === '--continue' || a === '-c') {
            out.resumeLatest = true;
            continue;
        }
        if (a === '--resume' || a.startsWith('--resume=')) {
            const v = a.includes('=') ? a.slice('--resume='.length) : valueOf(i, '--resume');
            if (!a.includes('=') && v !== undefined)
                i += 1;
            if (v !== undefined && v !== '')
                out.resumeId = v;
            continue;
        }
        if (a === '--model' || a.startsWith('--model=')) {
            const v = a.includes('=') ? a.slice('--model='.length) : valueOf(i, '--model');
            if (!a.includes('=') && v !== undefined)
                i += 1;
            if (v !== undefined && v !== '')
                out.model = v;
            continue;
        }
        if (a === '--permission' || a.startsWith('--permission=')) {
            const v = a.includes('=') ? a.slice('--permission='.length) : valueOf(i, '--permission');
            if (!a.includes('=') && v !== undefined)
                i += 1;
            if (v !== undefined && v !== '')
                out.permission = v;
            continue;
        }
        out.unknown.push(a);
    }
    return out;
};
/** Help text for `--help` (stdout, launcher-compatible). */
export const TUI_HELP = `dsh --profile <tui|nvim-tui> [options]
  --resume <session-id>   resume a specific session (explicit id wins)
  --continue, -c          resume the last active session (default)
  --model <provider/model>  switch the model after the session attaches
  --permission <name>     apply a permission preset after attaching
  --help, -h              show this help
  --version, -v           print the TUI version
`;
