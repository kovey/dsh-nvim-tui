/**
 * UI preferences persisted next to the resume pointer
 * (`~/.dsh/dsh-nvim-tui-state.json`): currently `/density`'s compact-card
 * flag. Kept in its own module so both the sessions installer and the feed
 * attach path can use it without a circular import.
 *
 * @module dsh-nvim-tui/sessions/prefs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** Path of the resume-pointer JSON (also holds UI preferences). */
export const statePathOf = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-nvim-tui-state.json');
/** Read the whole state object (null when absent/unreadable). */
export const readStateRaw = () => {
    try {
        return JSON.parse(readFileSync(statePathOf(), 'utf8'));
    }
    catch {
        return null;
    }
};
/** Merge one UI preference into the state file (other fields are preserved). */
export const saveUiPref = (app, key, value) => {
    try {
        const current = readStateRaw() ?? {};
        writeFileSync(statePathOf(), JSON.stringify({
            ...current,
            ui: { ...current.ui, [key]: value },
        }));
    }
    catch (err) {
        app.exitDiag('save-ui-pref-failed', err.message);
    }
};
/** Read one UI preference. */
export const uiPref = (app, key) => {
    const current = readStateRaw();
    void app;
    return current?.ui?.[key];
};
