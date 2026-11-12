/** rc.2-aware subagent directory listing for the sessions domain.
 *
 *  Kept out of sessions/index so the already-large lifecycle module does not
 *  grow a second responsibility (and the standards ratchet stays honest).
 *  rc.2 exposes only the recursive named catalog; rc.1's direct catalog and
 *  the persisted-header scan remain fallbacks.
 */
import { persistedHeader } from '../kernel/app.js';
import { readCleanedIds } from '../kernel/subagent-clean.js';
/** Is one child session actually driving a turn right now? The host's listing
 *  `activity` field only reports residency, so prefer the TUI's subagent event
 *  registry and fall back to the live agent's own status. */
const childRunning = (app, id) => {
    if (app.slices.sessions.runningSubagents.has(id))
        return true;
    try {
        const agent = app.runtimeCtx.agents.get?.(id);
        return agent?.status === 'running';
    }
    catch {
        return false;
    }
};
const childOf = (app, e, hidden, createdAtOf) => {
    if (e.kind !== 'child' || hidden.has(e.id))
        return undefined;
    return {
        id: e.id,
        label: e.label ?? e.path ?? e.name ?? e.id.slice(0, 8),
        name: e.name,
        path: e.path,
        depth: e.depth,
        running: childRunning(app, e.id),
        mode: e.mode,
        createdAt: createdAtOf(e.id),
    };
};
const fromCatalog = (app, entries, hidden, createdAtOf) => {
    const children = entries
        .map((e) => childOf(app, e, hidden, createdAtOf))
        .filter((c) => c !== undefined)
        .filter((c) => c.running || !hidden.has(c.id));
    return children.length > 0 || entries.some((e) => e?.kind === 'child') ? children : undefined;
};
export const listSubagentChildren = async (app, parentId) => {
    const persistence = app.svc('sessionPersistence');
    const histMap = new Map();
    if (typeof persistence?.list === 'function') {
        try {
            for (const h of await persistence.list()) {
                const hh = persistedHeader(h);
                if (hh?.id !== undefined)
                    histMap.set(hh.id, hh);
            }
        }
        catch { }
    }
    const hidden = new Set(readCleanedIds()[parentId] ?? []);
    const createdAtOf = (id) => histMap.get(id)?.createdAt;
    const subagentsSvc = app.svc('subagents');
    const catalogOf = async (load) => {
        try {
            return fromCatalog(app, await load(), hidden, createdAtOf);
        }
        catch {
            return undefined;
        }
    };
    // rc.2: recursive catalog with names/paths/depths. It is the only listing
    // face that preserves named multi-level teams.
    if (typeof subagentsSvc?.listDescendants === 'function') {
        const children = await catalogOf(() => subagentsSvc.listDescendants(parentId));
        if (children !== undefined)
            return children;
    }
    if (typeof subagentsSvc?.listChildren === 'function') {
        const children = await catalogOf(() => subagentsSvc.listChildren(parentId));
        if (children !== undefined)
            return children;
    }
    const seen = new Set();
    const children = [];
    const add = (id, label, running, mode) => {
        if (seen.has(id) || (!running && hidden.has(id)))
            return;
        seen.add(id);
        children.push({ id, label: label ?? id.slice(0, 8), running, mode, createdAt: createdAtOf(id) });
    };
    for (const s of app.liveSessions.list?.() ?? []) {
        if (s?.header?.parentSession === parentId && s.header.origin === 'subagent') {
            add(s.id, undefined, true, undefined);
        }
    }
    for (const [id, h] of histMap) {
        if (h?.parentSession === parentId && h.origin === 'subagent') {
            add(id, undefined, false, undefined);
        }
    }
    return children;
};
