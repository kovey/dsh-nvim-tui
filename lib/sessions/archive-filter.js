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
export const ARCHIVE_MODES = ['hide', 'all', 'only'];
/**
 * Should a session with this archive state appear under `mode`?
 *
 * `archived` says whether the session IS archived; the return value says whether
 * it is VISIBLE. The two are inverse for `hide`/`only` and unrelated for `all`,
 * which is exactly the distinction the old single-mode code conflated.
 */
export const archiveVisible = (archived, mode) => {
    if (mode === 'all')
        return true;
    if (mode === 'only')
        return archived;
    return !archived;
};
/** The next mode in the cycle (the UI's filter row). */
export const nextArchiveMode = (mode) => {
    const i = ARCHIVE_MODES.indexOf(mode);
    return ARCHIVE_MODES[(i + 1) % ARCHIVE_MODES.length] ?? 'hide';
};
/**
 * Parse the `/sessions` argument.
 *
 * `undefined`/empty keeps the historical default (`hide`) so existing muscle
 * memory and scripts are unaffected; an unknown word also falls back to `hide`
 * rather than erroring — a filter typo must not make the browser unusable.
 */
export const parseArchiveMode = (arg) => {
    const a = (arg ?? '').trim().toLowerCase();
    if (a === 'all' || a === '全部')
        return 'all';
    if (a === 'only' || a === 'archived' || a === '仅已归档')
        return 'only';
    return 'hide';
};
/** Translated label for the filter row / picker title. */
export const archiveModeLabel = (mode, t) => {
    if (mode === 'all')
        return t('筛选：全部对话');
    if (mode === 'only')
        return t('筛选：仅已归档');
    return t('筛选：隐藏已归档');
};
