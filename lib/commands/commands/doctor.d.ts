import type { App } from '../../kernel/app.js';
/** /doctor — terminal capability report. */
export declare const doctorCommand: (app: App) => Promise<void>;
export declare function installDoctorCommand(app: App): void;
