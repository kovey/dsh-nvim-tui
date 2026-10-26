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
export interface TuiArgs {
    resumeId?: string;
    /** `--continue` (explicit; resumeLatest already defaults true). */
    resumeLatest?: true;
    /** `provider/model` or bare `model`. */
    model?: string;
    permission?: string;
    help: boolean;
    version: boolean;
    /** Flags the parser did not recognize (including missing values). */
    unknown: string[];
}
/** Strip the launcher's own prefix when `cmdlineArgs` is unavailable.
 *  Launcher grammar: `dsh --profile <name> <app args…>`, `dsh <name> …`, or
 *  `--profile=<name>`. The bare `dsh --help` belongs to the launcher, so it
 *  yields no app arguments. */
export declare const appArgv: (argv: readonly string[], fromCmdline: boolean) => string[];
/** Parse the app arguments. Unknown/missing values are reported, never dropped. */
export declare const parseTuiArgs: (argv: readonly string[], fromCmdline?: boolean) => TuiArgs;
/** Help text for `--help` (stdout, launcher-compatible). */
export declare const TUI_HELP = "dsh --profile <tui|nvim-tui> [options]\n  --resume <session-id>   resume a specific session (explicit id wins)\n  --continue, -c          resume the last active session (default)\n  --model <provider/model>  switch the model after the session attaches\n  --permission <name>     apply a permission preset after attaching\n  --help, -h              show this help\n  --version, -v           print the TUI version\n";
