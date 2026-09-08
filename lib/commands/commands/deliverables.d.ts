import type { App } from '../../kernel/app.js';
/** /deliverables — files this session's current turn produced (mutation
 *  tools' follow-along paths, derived from tool/call arguments). */
export declare const deliverablesCommand: (app: App) => Promise<void>;
export declare function installDeliverablesCommand(app: App): void;
