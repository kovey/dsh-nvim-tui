import type { App } from '../../kernel/app.js';
/** /restart — respawn the dsh command and exit this process. The successor
 *  spawn is NOT started here: quit() spawns it AFTER the old nvim fully
 *  released the terminal (alt screen + kitty keyboard protocol cleanup) and
 *  the session logs flushed — spawning it early used to interleave the two
 *  processes' terminal control sequences and the new instance read
 *  kitty-protocol-encoded keys as literal garbage text in the input box. */
export declare const restartCommand: (app: App) => Promise<void>;
export declare function installRestartCommand(app: App): void;
