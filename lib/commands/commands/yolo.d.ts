import type { App } from '../../kernel/app.js';
/** /yolo [on|off] — TUI auto-allow for approval requests.
 *  The host policy stays `ask`; every request still reaches the waterfall and
 *  is audited, but while auto-allow is on it is answered allowed-once without
 *  a float. `off` restores per-item prompting. */
export declare const yoloCommand: (app: App, a: string | undefined) => void;
export declare function installYoloCommand(app: App): void;
