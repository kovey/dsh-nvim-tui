import type { SessionEvent } from './types.js';
import type { App } from './app.js';
export declare function makeSessionEventHandler(app: App, headlessDump: () => Promise<void>): (owner: {
    id: string;
}, event: SessionEvent) => void;
