import type { App } from '../../kernel/app.js';
/** /image [<path>] [prompt] — attach an image and send. No path on macOS
 *  reads the clipboard image via pbpaste (PNG bytes). `/image clear`
 *  drops the <C-v> pending queue. */
export declare const imageCommand: (app: App, a: string | undefined) => void;
export declare function installImageCommand(app: App): void;
