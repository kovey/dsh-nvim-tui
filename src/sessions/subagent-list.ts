/** rc.2-aware subagent directory listing for the sessions domain.
 *
 *  Kept out of sessions/index so the already-large lifecycle module does not
 *  grow a second responsibility (and the standards ratchet stays honest).
 *  The non-recursive `listChildren` is the backbone: rc.1's `listDescendants`
 *  recursively observes every descendant session and never settles while a
 *  child's query is not ready, so it may only ever be a BOUNDED enrichment
 *  (name/path/depth). The parent's own `subagent/catalog` log records come
 *  next — an rc.1 host may answer with an EMPTY catalog even though the log
 *  names every direct child — and the persisted-header scan stays the last
 *  fallback.
 */
import { persistedHeader } from '../kernel/app.js'
import { catalogLogRows } from './subagent-catalog-log.js'
import { readCleanedIds } from '../kernel/subagent-clean.js'
import type { App } from '../kernel/app.js'
import type { SubagentListEntry } from '../kernel/agent-extra-types.js'

/** Deadline for ONE host catalog call. Two calls at worst (direct + the rc.2
 *  enrichment) keep /subagents at ~3s even when the host never answers. */
const CATALOG_TIMEOUT_MS = 1500

export interface SubagentChild {
  id: string
  label: string
  name?: string | undefined
  path?: string | undefined
  depth?: number | undefined
  running: boolean
  mode: string | undefined
  createdAt?: number | undefined
}

/** Persisted-session header fields the directory needs. */
interface Header {
  createdAt?: number
  origin?: string
  parentSession?: string
}

type HeaderMap = Map<string, Header>

/** What one catalog face needs to turn host rows into directory rows. */
interface ListingContext {
  hidden: Set<string>
  createdAtOf: (id: string) => number | undefined
}

/** One catalog attempt. `failed` is deliberately not the same as "no rows":
 *  only a failed call may fall through to the next fallback face, while an
 *  empty answer means there is nothing deeper for a recursive walk to reach. */
interface CatalogAttempt {
  failed: boolean
  /** The host returned at least one row (diagnostic rows included). */
  answered: boolean
  rows?: SubagentChild[] | undefined
}

/** Is one child session actually driving a turn right now? The host's listing
 *  `activity` field only reports residency, so prefer the TUI's subagent event
 *  registry and fall back to the live agent's own status. */
const childRunning = (app: App, id: string): boolean => {
  if (app.slices.sessions.runningSubagents.has(id)) return true
  try {
    const agent = (app.runtimeCtx.agents as { get?: (i: string) => { status?: unknown } | undefined }).get?.(id)
    return agent?.status === 'running'
  } catch {
    return false
  }
}

/** Modes rc.1's catalog reports for a direct child (`SubagentCatalogEntry`'s
 *  own union). A row without a `kind` still says what it is by carrying one. */
const CHILD_MODES: ReadonlySet<string> = new Set(['one-shot', 'external', 'continuable', 'unknown'])

/** Is one catalog row a directory child? rc.2's recursive catalog tags every
 *  row with `kind`, but rc.1's NON-recursive `listChildren` returns the raw
 *  `{ id, createdAt, mode, label? }` catalog rows with NO `kind` at all —
 *  requiring `kind === 'child'` silently dropped every rc.1 row, so the
 *  directory could only ever come from the persisted-header fallback.
 *  Diagnostics are never children: rc.2 tags them, and an untagged row that
 *  carries no catalog `mode` is not a live child either. `mode: 'unknown'` IS a
 *  real direct child (the host merely could not read its descriptor), so it
 *  stays listed — viewable, never offered "continue". */
const isChildRow = (e: SubagentListEntry | null | undefined): e is SubagentListEntry => {
  if (e === null || e === undefined) return false
  if (e.kind === 'diagnostic') return false
  if (e.kind === 'child') return true
  return typeof e.id === 'string' && e.id !== '' && typeof e.mode === 'string' && CHILD_MODES.has(e.mode)
}

const childOf = (
  app: App,
  e: SubagentListEntry,
  hidden: Set<string>,
  createdAtOf: (id: string) => number | undefined,
): SubagentChild | undefined => {
  if (!isChildRow(e) || hidden.has(e.id)) return undefined
  return {
    id: e.id,
    label: e.label ?? e.path ?? e.name ?? e.id.slice(0, 8),
    name: e.name,
    path: e.path,
    depth: e.depth,
    running: childRunning(app, e.id),
    mode: e.mode,
    // rc.1's direct rows carry their own createdAt; rc.2's recursive rows drop
    // it, so the persisted header stays the fallback. The TTL cleanup and the
    // age label both read this field.
    createdAt: e.createdAt ?? createdAtOf(e.id),
  }
}

const fromCatalog = (
  app: App,
  entries: SubagentListEntry[],
  hidden: Set<string>,
  createdAtOf: (id: string) => number | undefined,
): SubagentChild[] | undefined => {
  const children = entries
    .map((e) => childOf(app, e, hidden, createdAtOf))
    .filter((c): c is SubagentChild => c !== undefined)
    .filter((c) => c.running || !hidden.has(c.id))
  // "The host answered with child rows" (even if every one of them was cleaned
  // away) is what decides between an empty directory and the next fallback face
  // — an rc.1 row counts here exactly like a kind-tagged rc.2 row.
  return children.length > 0 || entries.some(isChildRow) ? children : undefined
}

/** Run one host catalog call under a hard deadline. `AbortSignal.timeout`
 *  asks a cooperative host to stop; the race releases a caller that never
 *  settles at all (rc.1's recursive observe). The race fires a beat later so
 *  the abort — and the host's own rejection — is observed first. */
const bounded = async <T>(load: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), CATALOG_TIMEOUT_MS + 10)
  })
  try {
    return await Promise.race([load(AbortSignal.timeout(CATALOG_TIMEOUT_MS)), deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Run one catalog face: bounded, and mapped to directory rows. A timeout or
 *  a host error becomes `failed` — never a thrown rejection, because
 *  /subagents must always get an answer. */
const attemptCatalog = async (
  app: App,
  ctx: ListingContext,
  load: (signal: AbortSignal) => Promise<SubagentListEntry[]>,
): Promise<CatalogAttempt> => {
  try {
    const entries = await bounded(load)
    if (entries === undefined) return { failed: true, answered: false }
    return { failed: false, answered: entries.length > 0, rows: fromCatalog(app, entries, ctx.hidden, ctx.createdAtOf) }
  } catch {
    return { failed: true, answered: false }
  }
}

/** Persisted headers by id (best-effort: a missing/old persistence face is an
 *  empty map, and the directory still lists live subagents). */
const persistedHeaders = async (app: App): Promise<HeaderMap> => {
  const map: HeaderMap = new Map()
  const persistence = app.svc('sessionPersistence')
  if (typeof persistence?.list !== 'function') return map
  try {
    for (const h of await persistence.list()) {
      const hh = persistedHeader(h as { header?: unknown; id?: string } | null)
      if (hh?.id !== undefined) map.set(hh.id, hh as Header)
    }
  } catch {}
  return map
}

/** Last resort: rebuild the direct directory from persisted headers (rc.1
 *  hosts without any catalog face, or every catalog call failed). */
const scanHeaders = (
  app: App,
  parentId: string,
  histMap: HeaderMap,
  ctx: ListingContext,
): SubagentChild[] => {
  const seen = new Set<string>()
  const children: SubagentChild[] = []
  const add = (id: string, label: string | undefined, running: boolean, mode: string | undefined) => {
    if (seen.has(id) || (!running && ctx.hidden.has(id))) return
    seen.add(id)
    children.push({ id, label: label ?? id.slice(0, 8), running, mode, createdAt: ctx.createdAtOf(id) })
  }
  for (const s of app.liveSessions.list?.() ?? []) {
    if (s?.header?.parentSession === parentId && s.header.origin === 'subagent') {
      add(s.id, undefined, true, undefined)
    }
  }
  for (const [id, h] of histMap) {
    if (h?.parentSession === parentId && h.origin === 'subagent') {
      add(id, undefined, false, undefined)
    }
  }
  return children
}

/** Last resort beside the header scan: the parent's own log records every
 *  direct child as a `subagent/catalog` event, so /subagents still lists rows
 *  when the host catalog answers EMPTY/fails and no header has survived (rc.1
 *  may answer `[]`). The log rows carry label/mode/childCreatedAt; cleaned ids
 *  stay hidden unless the child is still running (AC-001, AC-002). */
const fromParentLog = (app: App, parentId: string, ctx: ListingContext): SubagentChild[] => {
  const rows: SubagentChild[] = []
  for (const r of catalogLogRows(app, parentId)) {
    const row: SubagentChild = {
      id: r.id,
      label: r.label ?? r.name ?? r.id.slice(0, 8),
      name: r.name,
      running: childRunning(app, r.id),
      mode: r.mode,
      createdAt: r.createdAt ?? ctx.createdAtOf(r.id),
    }
    if (!row.running && ctx.hidden.has(r.id)) continue
    rows.push(row)
  }
  return rows
}

/** Merge header-derived rows after the log rows: the log row keeps its
 *  label/mode/createdAt, the header only adds children the log missed. */
const mergeRows = (primary: SubagentChild[], extra: SubagentChild[]): SubagentChild[] => {
  const seen = new Set(primary.map((c) => c.id))
  return [...primary, ...extra.filter((c) => !seen.has(c.id))]
}

export const listSubagentChildren = async (app: App, parentId: string): Promise<SubagentChild[]> => {
  const histMap = await persistedHeaders(app)
  const ctx: ListingContext = {
    hidden: new Set(readCleanedIds()[parentId] ?? []),
    createdAtOf: (id) => histMap.get(id)?.createdAt,
  }
  const host = app.svc('subagents')
  // rc.1: the direct, NON-recursive directory is asked first — it cannot walk
  // into an unready child session, so /subagents answers even when the host's
  // recursive catalog never settles (AC-001, AC-003).
  const direct: CatalogAttempt = typeof host?.listChildren === 'function'
    ? await attemptCatalog(app, ctx, (signal) => host.listChildren!(parentId, signal))
    : { failed: true, answered: false }
  let hostRows = direct.rows
  // rc.2: the recursive catalog is an ENRICHMENT of the direct rows (it adds
  // name/path/depth for nested teams). It is only worth a deadline when there
  // are rows to enrich — or when the direct face failed, where it is the only
  // catalog left. An empty direct answer means nothing deeper exists (AC-002).
  if ((direct.failed || direct.answered) && typeof host?.listDescendants === 'function') {
    const deep = await attemptCatalog(app, ctx, (signal) => host.listDescendants!(parentId, signal))
    if (deep.rows !== undefined) hostRows = deep.rows
  }
  // A host that answered with rows is authoritative: the parent-log scan must
  // never duplicate or override it (AC-002).
  if (hostRows !== undefined && hostRows.length > 0) return hostRows
  // Host catalog empty/failed AND the persisted header may carry nothing: the
  // parent's own session log still names every direct child (AC-001).
  const fromLog = fromParentLog(app, parentId, ctx)
  const fromHeader = scanHeaders(app, parentId, histMap, ctx)
  return fromLog.length === 0 ? fromHeader : mergeRows(fromLog, fromHeader)
}
