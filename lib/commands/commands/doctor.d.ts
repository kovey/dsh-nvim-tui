import type { App } from '../../kernel/app.js';
/**
 * Session-log health lines.
 *
 * Motivated by a real incident: a session carried an `invalid persisted inbox
 * splice` fault, so every projection of it threw and /sessions simply errored
 * — while the log itself decompressed fine. Nothing told the user whether the
 * session was lost or merely had one bad envelope, and there was no repair
 * entry point. This does not repair anything; it names the affected session and
 * states the options, which is the part that was missing.
 *
 * Exported for the smoke suite (takes the dir list, so it needs no host).
 */
export declare const sessionHealthLines: (dirs: readonly string[], cap?: number) => string[];
/** /doctor — terminal + session-log capability report. */
export declare const doctorCommand: (app: App) => Promise<void>;
export declare function installDoctorCommand(app: App): void;
