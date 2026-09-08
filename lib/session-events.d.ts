import type { SessionEvent } from './kernel/types.js';
import type { App } from './kernel/app.js';
export declare function makeSessionEventHandler(app: App, headlessDump: () => Promise<void>): (owner: {
    id: string;
}, event: SessionEvent) => void;
