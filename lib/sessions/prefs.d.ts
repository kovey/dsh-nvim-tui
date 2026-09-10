import type { App } from '../kernel/app.js';
/** Path of the resume-pointer JSON (also holds UI preferences). */
export declare const statePathOf: () => string;
/** Read the whole state object (null when absent/unreadable). */
export declare const readStateRaw: () => Record<string, unknown> | null;
/** Merge one UI preference into the state file (other fields are preserved). */
export declare const saveUiPref: (app: App, key: string, value: unknown) => void;
/** Read one UI preference. */
export declare const uiPref: <T>(app: App, key: string) => T | undefined;
