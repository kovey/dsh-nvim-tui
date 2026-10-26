import { type App } from '../../kernel/app.js';
/** `/export [md|log] [path]` — rendered Markdown (default) or the canonical
 *  JSONL session log (header + every committed event). The raw log preserves
 *  tool arguments/results, image references and log-only events that the chat
 *  buffer never renders — the file support/replay actually needs. */
export declare const exportCommand: (app: App, a?: string) => Promise<void>;
/** /rewind — pick a user-message boundary, truncate the session after
 *  it, and rebuild the chat from the remaining events. */
export declare function installExportCommand(app: App): void;
