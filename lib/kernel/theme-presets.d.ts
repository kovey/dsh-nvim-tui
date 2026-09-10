/**
 * Built-in /theme presets over the dsh_tui highlight groups.
 *
 * Shared by the /theme command and boot (which restores the persisted
 * preference), so it lives in the kernel — the only module both import.
 * A preset only ever ADDS highlight attributes, therefore the applied map
 * always carries EVERY touched group: groups the preset does not style get an
 * empty spec, which the Lua side resets to the default.
 *
 * @module dsh-nvim-tui/kernel/theme-presets
 */
/** Highlight groups any preset may touch (all of them get an explicit spec). */
export declare const THEME_GROUPS: readonly ['DshTuiReasoning', 'DshTuiNotice', 'DshTuiUser', 'DshTuiTool', 'DshTuiError'];
export declare const THEME_PRESETS: Record<string, Record<string, Record<string, unknown>>>;
export declare const THEME_NAMES: string[];
/** Full application map for one preset ({} = reset for unstyled groups). */
export declare const themeMapFor: (name: string) => Record<string, unknown> | null;
