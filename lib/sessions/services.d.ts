import type { AgentHandle } from '../kernel/types.js';
import type { App, ModelRef } from '../kernel/app.js';
/** Adapt the 0.2.2 Agent.model API to the TUI's existing ModelRef surface.
 *  Existing difficulty/vision code keeps assigning `current`; the setter now
 *  records a durable model/selection instead of mutating a local ref. */
export declare const modelRefFor: (app: App, handle: AgentHandle) => ModelRef;
export declare const attachSession: (app: App, handle: AgentHandle, opts?: {
    background?: boolean;
}) => Promise<string>;
/** Empty-state hero: big DSH·TUI banner + title ABOVE the whale, usage
 *  hints BELOW it (the feed centers the whole block). */
export declare const createSession: (app: App, cwdPath?: string) => Promise<string | undefined>;
export declare const ensureLiveSession: (app: App, id: string) => Promise<string | undefined>;
/** Dispose one live session that is NOT the active view (background-resumed
 *  sessions must not accumulate forever — each holds an agent handle, a feed
 *  and nvim chat/reasoning buffers). */
export declare const disposeLiveSession: (app: App, id: string) => Promise<void>;
export declare const resumeSession: (app: App, id: string) => Promise<string | undefined>;
/** Terminal title: active session title + model (OSC 2 via nvim). */
export declare const switchTo: (app: App, id: string) => Promise<void>;
export declare const selectSession: (app: App, id: string) => Promise<void>;
/** /fork [directive]: child session seeded with the active history;
 *  an optional directive is sent as its first message. */
export declare const forkSession: (app: App, directive: string | undefined) => Promise<string | undefined>;
export declare const welcomeLines: () => {
    above: Array<{
        text: string;
        group?: string;
    }>;
    below: Array<{
        text: string;
        group?: string;
    }>;
};
export declare const updateTitle: (app: App) => void;
