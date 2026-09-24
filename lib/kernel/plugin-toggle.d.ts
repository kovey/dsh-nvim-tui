/**
 * Enable/disable a profile plugin by editing its `cordis.patch.yml`.
 *
 * WHY THIS IS THE HONEST SHAPE OF "ENABLE/DISABLE": the Web plugin page can
 * toggle a plugin because it owns a settings store. This plugin does not — the
 * profile's patch file IS the switch, and it is a human-authored YAML document.
 * So this rewrites exactly one line (commenting the entry's `- id:` marker) and
 * nothing else; the edit is reviewable with `git diff`-level precision, and the
 * next boot applies it.
 *
 * SAFETY RULES (each one exists because breaking them silently corrupts a user's
 * profile):
 *   · never guess WHICH profile — the caller must have identified it;
 *   · only ever touch a line that parses as `- id: <entry>` with the expected
 *     indentation, so a string that merely contains the id cannot be hit;
 *   · back up before writing, and leave the previous backup alone if the new
 *     write fails;
 *   · report "already in that state" instead of writing a no-op diff.
 *
 * @module dsh-nvim-tui/kernel/plugin-toggle
 */
/** Comment marker prepended to a disabled entry's `- id:` line. Chosen so the
 *  line stays valid YAML (a comment) and a human sees why it is off. */
export declare const DISABLED_PREFIX = "#disabled# ";
export interface PatchEdit {
    kind: 'changed' | 'unchanged';
    /** The rewritten document. Equal to the input for `unchanged`. */
    text: string;
    /** 1-based line number that was (or would be) touched. */
    line: number;
    /** The entry id as it appears in the file. */
    id: string;
}
/**
 * Comment out (disable) or restore (enable) one plugin entry.
 *
 * Pure: it computes the new document and reports what it did, so the decision
 * is testable without touching a real profile.
 */
export declare const togglePluginEntry: (text: string, id: string, enabled: boolean) => PatchEdit;
