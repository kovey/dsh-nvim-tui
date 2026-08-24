/**
 * Runner-side i18n: user-facing strings are zh literals in code; `t()` looks
 * them up in the en dictionary. Unknown keys fall back to the zh literal, so
 * partial coverage degrades gracefully. The Lua UI (key hints, float
 * footers) remains Chinese for now — documented limitation.
 *
 * Locale selection: `config.locale` / `DSH_NVIM_TUI_LOCALE` (default `zh`),
 * switchable at runtime via `/locale zh|en`.
 *
 * @module dsh-nvim-tui/i18n
 */
export type Locale = 'zh' | 'en';
export declare function setLocale(locale: Locale): void;
export declare function locale(): Locale;
/** Translate one zh literal; unknown keys return the literal unchanged. */
export declare function t(zh: string): string;
