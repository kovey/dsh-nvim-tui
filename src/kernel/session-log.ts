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
import type { HarnessSession, SessionEvent } from './types.js'

/** Minimal header shape accepted from `session.header`. */
export interface SessionHeaderLike {
  version?: unknown
  id?: unknown
  createdAt?: unknown
  cwd?: unknown
  parentSession?: unknown
  isSeeded?: unknown
  origin?: unknown
  delegationDepth?: unknown
  agentPreset?: unknown
  [key: string]: unknown
}

/** Fallback used when the host synthesizes a header-less session. */
export const SESSION_FORMAT_FALLBACK = 4

/** One canonical header line, projected from the host header. */
export const sessionLogHeaderLine = (
  header: SessionHeaderLike | undefined,
  fallback: { id: string; createdAt: number },
): Record<string, unknown> => {
  const version = typeof header?.version === 'number' ? header.version : SESSION_FORMAT_FALLBACK
  const id = typeof header?.id === 'string' && header.id !== '' ? header.id : fallback.id
  const createdAt = typeof header?.createdAt === 'number' ? header.createdAt : fallback.createdAt
  const line: Record<string, unknown> = {
    type: 'session',
    version,
    id,
    createdAt,
    isSeeded: header?.isSeeded === true,
    delegationDepth: typeof header?.delegationDepth === 'number' ? header.delegationDepth : 0,
  }
  if (typeof header?.cwd === 'string' && header.cwd !== '') line['cwd'] = header.cwd
  if (typeof header?.parentSession === 'string' && header.parentSession !== '') line['parentSession'] = header.parentSession
  if (typeof header?.origin === 'string' && header.origin !== '') line['origin'] = header.origin
  if (typeof header?.agentPreset === 'string' && header.agentPreset !== '') line['agentPreset'] = header.agentPreset
  return line
}

/** Canonical JSONL text: header line, one line per event, trailing newline. */
export const serializeSessionLog = (
  header: SessionHeaderLike | undefined,
  events: readonly SessionEvent[],
  fallback: { id: string; createdAt: number },
): string => {
  const lines = [JSON.stringify(sessionLogHeaderLine(header, fallback))]
  for (const event of events) lines.push(JSON.stringify(event))
  return lines.join('\n') + '\n'
}

/** The committed events of one live session (alpha.4+ snapshot, older array). */
export const sessionEventsOf = (session: HarnessSession): readonly SessionEvent[] => {
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  return Array.isArray(session.events) ? session.events : []
}
