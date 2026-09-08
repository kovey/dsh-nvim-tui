import type { App } from '../../kernel/app.js';
/** /plan [on|off|status] — plan mode state. */
export declare const planCommand: (app: App, a: string | undefined) => void;
export declare function installPlanCommand(app: App): void;
