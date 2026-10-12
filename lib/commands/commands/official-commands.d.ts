import type { App } from '../../kernel/app.js';
/**
 * `/commands` — the OFFICIAL command registry, as seen from the TUI.
 *
 * WHY THIS EXISTS: plugins register slash commands through the official
 * `ctx.commands` API (`@deepseek-ai/dsh-commands`, wired by `dsh-base`). Those
 * commands are invisible to this plugin unless something bridges them — the TUI
 * keeps its own registry for its ~60 interface commands and never looked at the
 * official one. This command is that bridge's discovery side.
 *
 * The two registries are COMPLEMENTARY, not alternatives: the official registry
 * carries in-session commands (a handful) and cannot express the TUI's pickers
 * and floats, while the TUI's registry is the interface itself. So official
 * commands are offered ALONGSIDE ours, and on a name collision OURS WINS — a
 * plugin must not be able to hijack `/sessions`.
 */
/** One official descriptor, normalised for display. */
export interface OfficialCommand {
    name: string;
    description: string;
    hint?: string;
    /** True when the TUI has its own command of the same name (ours wins). */
    shadowed: boolean;
}
/**
 * Normalise the registry listing into display rows.
 *
 * Pure, and the collision rule lives here so it is asserted directly: `shadowed`
 * is computed against the TUI's OWN names, not the other way round.
 */
export declare const officialRows: (listed: ReadonlyArray<{
    name: string;
    description: string;
    input?: {
        hint?: string;
    } | undefined;
}>, ownNames: ReadonlySet<string>) => OfficialCommand[];
/** `/commands [名称]` — list the official registry, or run one of its commands. */
export declare const officialCommandsCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installOfficialCommandsCommand(app: App): void;
