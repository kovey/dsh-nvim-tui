import type { App } from '../../kernel/app.js';
/** /help — every command in a sessions-style popup, grouped like the
 *  old chat listing and sorted alphabetically within each group; Enter
 *  fills the picked command into the input box (the command completion
 *  menu's Enter logic: type args, a second Enter executes). */
export declare const helpCommand: (app: App) => Promise<void>;
export declare function installHelpCommand(app: App): void;
