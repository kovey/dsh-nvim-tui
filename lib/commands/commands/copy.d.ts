import type { App } from '../../kernel/app.js';
import type { SessionEvent } from '../../kernel/types.js';
export type CopyMode = 'history' | 'last' | 'raw';
export declare const parseCopyMode: (arg: string | undefined) => CopyMode | undefined;
/** Last assistant text in the committed event log. */
export declare const lastAssistantText: (events: readonly SessionEvent[]) => string;
export declare const copyCommand: (app: App, a?: string) => Promise<void>;
export declare function installCopyCommand(app: App): void;
