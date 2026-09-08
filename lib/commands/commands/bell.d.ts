import type { App } from '../../kernel/app.js';
/** /bell [on|off] — terminal bell on turn end (approvals always ring). */
export declare const bellCommand: (app: App, a: string | undefined) => void;
export declare function installBellCommand(app: App): void;
