import type { App } from '../../kernel/app.js';
/** /yolo [on|off] — approval policy ask/never. */
export declare const yoloCommand: (app: App, a: string | undefined) => void;
export declare function installYoloCommand(app: App): void;
