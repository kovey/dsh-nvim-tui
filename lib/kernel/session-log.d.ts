/**
 * Canonical session-log serialization for `/export log`.
 *
 * Mirrors the host's `@deepseek-ai/dsh-session-log-export` JSONL shape: one
 * header line (`{"type":"session",…}`) followed by one line per validated
 * event. Keeping the shape identical means an exported log can be handed to
 * the same tooling that reads a persisted `session.jsonl`; inventing a private
 * wrapper would make the file useless for support and replay.
 *
 * The header is deliberately projected field-by-field (not spread) so a newer
 * host's host-only fields cannot leak into a portable log.
 *
 * @module dsh-nvim-tui/session-log
 */
import type { HarnessSession, SessionEvent } from './types.js';
/** Minimal header shape accepted from `session.header`. */
export interface SessionHeaderLike {
    version?: unknown;
    id?: unknown;
    createdAt?: unknown;
    cwd?: unknown;
    parentSession?: unknown;
    isSeeded?: unknown;
    origin?: unknown;
    delegationDepth?: unknown;
    agentPreset?: unknown;
    [key: string]: unknown;
}
/** Fallback used when the host synthesizes a header-less session. */
export declare const SESSION_FORMAT_FALLBACK = 4;
/** One canonical header line, projected from the host header. */
export declare const sessionLogHeaderLine: (header: SessionHeaderLike | undefined, fallback: {
    id: string;
    createdAt: number;
}) => Record<string, unknown>;
/** Canonical JSONL text: header line, one line per event, trailing newline. */
export declare const serializeSessionLog: (header: SessionHeaderLike | undefined, events: readonly SessionEvent[], fallback: {
    id: string;
    createdAt: number;
}) => string;
/** The committed events of one live session (alpha.4+ snapshot, older array). */
export declare const sessionEventsOf: (session: HarnessSession) => readonly SessionEvent[];
