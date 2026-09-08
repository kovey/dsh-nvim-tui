import type { App } from '../../kernel/app.js';
/** /compact — manually compact the session context via the compaction
 *  engine; null result means there was nothing worth compacting. */
export declare const compactCommand: (app: App) => Promise<void>;
export declare function installCompactCommand(app: App): void;
