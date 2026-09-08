import type { App } from '../../kernel/app.js';
/** /locale [zh|en] — switch runner UI language (official client's
 *  locale preference; Lua-side hints stay Chinese for now). */
export declare const localeCommand: (app: App, a: string | undefined) => void;
export declare function installLocaleCommand(app: App): void;
