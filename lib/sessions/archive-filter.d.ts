/**
 * Archive visibility for the session browser.
 *
 * The browser historically had ONE mode: archived sessions were hidden. dsh
 * 0.2.0's Web/desktop UI gained a three-state filter (hide archived / all /
 * only archived), and this module gives the TUI the same three states.
 *
 * WHY A MODE OVER "just pass the archived set": every filter site asks
 * `archived.has(id)` and skips. "Show all" and "only archived" cannot both be
 * expressed by adding or removing ids from that set — "only archived" must
 * skip the UNARCHIVED. So the set keeps its identity and the PREDICATE flips.
 * Getting this wrong is silent: an "only archived" view that still lists
 * live sessions looks plausible and is useless.
 *
 * @module dsh-nvim-tui/sessions/archive-filter
 */
/** The three states, in the order the UI cycles through them. */
export declare const ARCHIVE_MODES: readonly ['hide', 'all', 'only'];
export type ArchiveMode = (typeof ARCHIVE_MODES)[number];
/**
 * Should a session with this archive state appear under `mode`?
 *
 * `archived` says whether the session IS archived; the return value says whether
 * it is VISIBLE. The two are inverse for `hide`/`only` and unrelated for `all`,
 * which is exactly the distinction the old single-mode code conflated.
 */
export declare const archiveVisible: (archived: boolean, mode: ArchiveMode) => boolean;
/** The next mode in the cycle (the UI's filter row). */
export declare const nextArchiveMode: (mode: ArchiveMode) => ArchiveMode;
/**
 * Parse the `/sessions` argument.
 *
 * `undefined`/empty keeps the historical default (`hide`) so existing muscle
 * memory and scripts are unaffected; an unknown word also falls back to `hide`
 * rather than erroring — a filter typo must not make the browser unusable.
 */
export declare const parseArchiveMode: (arg: string | undefined) => ArchiveMode;
/** Translated label for the filter row / picker title. */
export declare const archiveModeLabel: (mode: ArchiveMode, t: (s: string) => string) => string;
