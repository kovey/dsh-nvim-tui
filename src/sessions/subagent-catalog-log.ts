/** Parent-log `subagent/catalog` fallback for the /subagents directory.
 *
 *  rc.1's `subagents.listChildren` may answer with an EMPTY catalog (or fail)
 *  even though the parent Session's own log records every direct child as a
 *  `subagent/catalog` event, and a persisted child header is not always
 *  available either. This module reads that log and returns the children it
 *  names (label/mode/childCreatedAt included).
 *
 *  Kept out of subagent-list.ts so the listing module does not grow a second
 *  responsibility (its standards `maxFileLines` ratchet stays honest).
 *
 *  A FORKED session (`/fork`, `/branch`) carries the source session's log as
 *  its fork-inherited prefix, so those copied catalog events must not be listed
 *  for the fork: only events at/after `inheritedEventCount` are its own.
 *
 *  Event payload (`@deepseek-ai/dsh-subagent/catalog`, versions 0..3):
 *  `{ childId, childCreatedAt, version, mode, label?, name? }`. The event kind
 *  is not a member of this bundle's narrowed `SessionEvent` union, so the log
 *  is read structurally.
 */
import type { App } from '../kernel/app.js'

/** One direct child named by the parent's own log. */
export interface CatalogLogRow {
  id: string
  label?: string | undefined
  name?: string | undefined
  mode?: string | undefined
  createdAt?: number | undefined
}

/** Structural view of the TUI's live-session record (only the log handle). */
interface ParentHandle {
  agent?: { session?: unknown }
}
interface ParentRec {
  handle?: ParentHandle
}

/** Structural view of one session-log event (`seq` is the log position). */
type LogEvent = { type?: unknown; data?: unknown; seq?: unknown }

/** Non-empty string field of a payload (labels/names are optional). */
const textOf = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** The parent's live Session: the TUI's own session map first, the host's agent
 *  registry second. A settled/closed parent yields `undefined`. */
const parentSession = (app: App, parentId: string): unknown => {
  const sessions = app.slices.sessions as unknown as { live?: Map<string, ParentRec> }
  const rec = sessions.live?.get?.(parentId)
  if (rec?.handle !== undefined) return rec.handle.agent?.session
  const registry = app.liveSessions as unknown as { get?: (id: string) => unknown } | undefined
  return registry?.get?.(parentId)
}

/** Number of leading events this live session inherited from its fork parent.
 *  `Session.inheritedEventCount` is 0 for a root session (and absent on hosts
 *  that never seeded a fork), so nothing is filtered there. */
const inheritedCut = (session: unknown): number => {
  const raw = (session as { inheritedEventCount?: unknown } | null | undefined)?.inheritedEventCount
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0
}

/** Keep only the child-owned events of one session log. /fork and /branch copy
 *  the parent's log VERBATIM into the child's log and record the copied length
 *  as `inheritedEventCount`, so the inherited prefix still carries the SOURCE
 *  session's `subagent/catalog` events — listing them would put the parent's
 *  children into the fork's /subagents, and TTL cleanup would then record those
 *  ids as cleaned under the fork's id. Child-owned events start at the cut
 *  (the same boundary `Session.ownEvents()` uses); an event without a numeric
 *  `seq` (legacy/structural host) cannot be placed before the cut and is kept. */
const ownLogEvents = (events: LogEvent[], cut: number): LogEvent[] =>
  events.filter((e) => typeof e.seq !== 'number' || e.seq >= cut)

/** The parent's own log. A settled/closed parent (or a host without the
 *  transcript reader) yields no rows — never a throw, because /subagents must
 *  always get an answer. */
const parentLogEvents = (app: App, parentId: string): LogEvent[] => {
  const session = parentSession(app, parentId)
  if (session === undefined || session === null) return []
  const reader = app.slices.trans as unknown as { sessionEvents?: (s: unknown) => unknown } | undefined
  if (typeof reader?.sessionEvents !== 'function') return []
  try {
    const events = reader.sessionEvents(session)
    if (!Array.isArray(events)) return []
    const cut = inheritedCut(session)
    return cut === 0 ? (events as LogEvent[]) : ownLogEvents(events as LogEvent[], cut)
  } catch {
    return []
  }
}

/** Map one catalog payload, or `undefined` when it is not a direct-child fact:
 *  diagnostics are a DIFFERENT event kind (`subagent/catalog-diagnostic`) and a
 *  payload that only carries a `reason` says why a child is missing, so neither
 *  ever becomes a directory row. Versions 0..3 all carry childId/
 *  childCreatedAt/mode. */
const rowOf = (data: unknown): CatalogLogRow | undefined => {
  if (typeof data !== 'object' || data === null) return undefined
  const d = data as Record<string, unknown>
  if (d['reason'] !== undefined) return undefined
  const id = d['childId']
  if (typeof id !== 'string' || id === '') return undefined
  const createdAt = d['childCreatedAt']
  return {
    id,
    label: textOf(d['label']),
    name: textOf(d['name']),
    mode: textOf(d['mode']),
    createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : undefined,
  }
}

/** Direct children named by one parent's own `subagent/catalog` events, in
 *  first-recorded order. A later catalog version for the same child supersedes
 *  the earlier payload (dedupe by child id). Cleaned/hidden filtering stays
 *  with the caller: it needs the running-subagent registry. */
export const catalogLogRows = (app: App, parentId: string): CatalogLogRow[] => {
  const byId = new Map<string, CatalogLogRow>()
  for (const e of parentLogEvents(app, parentId)) {
    if (e?.type !== 'subagent/catalog') continue
    const row = rowOf(e.data)
    if (row !== undefined) byId.set(row.id, row)
  }
  return [...byId.values()]
}
