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
export const DISABLED_PREFIX = '#disabled# ';
/** Locate the single `- id: <id>` line of an insert entry. */
const findEntryLine = (lines, id) => {
    const want = id.trim();
    for (let i = 0; i < lines.length; i += 1) {
        const raw = lines[i] ?? '';
        const m = /^(\s*)(#disabled#\s*)?-\s*id:\s*(\S+)\s*$/.exec(raw);
        if (m === null)
            continue;
        if ((m[3] ?? '').replace(/['"]/g, '') !== want)
            continue;
        return i;
    }
    return -1;
};
/**
 * Comment out (disable) or restore (enable) one plugin entry.
 *
 * Pure: it computes the new document and reports what it did, so the decision
 * is testable without touching a real profile.
 */
export const togglePluginEntry = (text, id, enabled) => {
    const lines = text.split('\n');
    const idx = findEntryLine(lines, id);
    if (idx < 0)
        return { kind: 'unchanged', text, line: 0, id };
    const raw = lines[idx] ?? '';
    const m = /^(\s*)(#disabled#\s*)?-\s*id:/.exec(raw);
    const indent = m?.[1] ?? '';
    const currentlyDisabled = m?.[2] !== undefined;
    if (currentlyDisabled === !enabled) {
        return { kind: 'unchanged', text, line: idx + 1, id };
    }
    lines[idx] = enabled
        // Restoring: drop our marker, keep the original indent and text after it.
        ? raw.replace(/^(\s*)#disabled#\s*/, '$1')
        : `${indent}${DISABLED_PREFIX}${raw.slice(indent.length)}`;
    return { kind: 'changed', text: lines.join('\n'), line: idx + 1, id };
};
