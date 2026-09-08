import type { MessageContent, SaveImageAttachment } from '../kernel/types.js';
import type { App, ModelRef, SessionRec } from '../kernel/app.js';
/**
 * Send a user message with optional image attachments.
 * `images` entries are SaveImageAttachment-shaped (`{data, mediaType, name}`)
 * — read from a local file (/image) or parsed from pasted data URLs. They
 * are durably committed through the harness `attachments` service so the
 * message content carries only stable image refs; the LLM adapter resolves
 * them into data URLs at request time.
 * agent.followup() ENQUEUES a next-turn message and wakes the driver: a
 * running turn is never interrupted — the input is processed as a later
 * turn of the same drain.
 */
export declare const followup: (app: App, rec: SessionRec, text: string, images?: Array<SaveImageAttachment | Extract<MessageContent, {
    type: 'image';
}> | string>) => Promise<void>;
/**
 * Queue one human prompt to a continuable child through the official
 * symbol-keyed host prompt queue (Symbol.for('dsh.subagent.queuePrompt')).
 * The dsh-subagent service exposes NO public followup method — this face
 * is the host-only queue: (parent, childId, content, source, signal) →
 * inbox MessageId. Running children admit it as their next turn after the
 * current one converges; settled children cold-resume.
 */
export declare const queueSubagentPrompt: (app: App, parentAgent: unknown, childId: string, text: string) => Promise<void>;
export declare const send: (app: App, text: string) => void;
/** <C-v> handler: queue the macOS clipboard image for the next submit. */
export declare const pasteClipboardImage: (app: App) => void;
/** /stop — abort the active turn (agent.cancel with a user cause). */
export declare const stopCommand: (app: App) => void;
/** Directory picker promise (Lua navigable float → 'dsh-dir-selected'). */
export declare const openDirPicker: (app: App, startPath: string) => Promise<string | null>;
/** Format an @-mention: quote paths containing whitespace. */
export declare const formatMention: (path: string) => string;
/** Local fs candidates (fallback when the fileReferences service is
 *  absent): immediate children of the query's dir matching its prefix. */
export declare const localFileCandidates: (cwd: string, query: string) => Promise<Array<{
    path: string;
    mention: string;
}>>;
/** @-completion query from the input line (dsh-at-query notify).
 *  Files first, then @session references (the official client's unified
 *  `@file`/`@session` source, in the same deterministic order). */
export declare const atQuery: (app: App, query: string, start?: number) => Promise<void>;
export declare const onInput: (app: App, text: string) => void;
export declare const applyModelSelection: (app: App, next: ModelRef['current']) => Promise<void>;
export declare const onCommand: (app: App, line: string) => void;
export declare const TUI_COMMAND_WHITELIST: Set<string>;
/** Register the agent-side tui_command routing tool (whitelisted UI/safe
 *  commands only — quit/fork/rewind/archive and destructive actions stay
 *  out of reach). */
export declare function registerTool(app: App): void;
/** nvim notifications this module owns (dispatched by boot via rpc.ts). */
export declare function registerNotifications(): void;
/** host events this module owns (wired by boot via host-events.ts). */
export declare function registerHostEventHandlers(): void;
/** Boot-phase drain (moved out of boot): input that arrived before the
 *  first agent was ready. */
export declare function drainPendingInput(app: App): void;
