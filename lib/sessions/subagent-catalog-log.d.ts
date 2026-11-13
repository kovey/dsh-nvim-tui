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
import type { App } from '../kernel/app.js';
/** One direct child named by the parent's own log. */
export interface CatalogLogRow {
    id: string;
    label?: string | undefined;
    name?: string | undefined;
    mode?: string | undefined;
    createdAt?: number | undefined;
}
/** Direct children named by one parent's own `subagent/catalog` events, in
 *  first-recorded order. A later catalog version for the same child supersedes
 *  the earlier payload (dedupe by child id). Cleaned/hidden filtering stays
 *  with the caller: it needs the running-subagent registry. */
export declare const catalogLogRows: (app: App, parentId: string) => CatalogLogRow[];
