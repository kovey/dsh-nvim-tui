/** Fallback used when the host synthesizes a header-less session. */
export const SESSION_FORMAT_FALLBACK = 4;
/** One canonical header line, projected from the host header. */
export const sessionLogHeaderLine = (header, fallback) => {
    const version = typeof header?.version === 'number' ? header.version : SESSION_FORMAT_FALLBACK;
    const id = typeof header?.id === 'string' && header.id !== '' ? header.id : fallback.id;
    const createdAt = typeof header?.createdAt === 'number' ? header.createdAt : fallback.createdAt;
    const line = {
        type: 'session',
        version,
        id,
        createdAt,
        isSeeded: header?.isSeeded === true,
        delegationDepth: typeof header?.delegationDepth === 'number' ? header.delegationDepth : 0,
    };
    if (typeof header?.cwd === 'string' && header.cwd !== '')
        line['cwd'] = header.cwd;
    if (typeof header?.parentSession === 'string' && header.parentSession !== '')
        line['parentSession'] = header.parentSession;
    if (typeof header?.origin === 'string' && header.origin !== '')
        line['origin'] = header.origin;
    if (typeof header?.agentPreset === 'string' && header.agentPreset !== '')
        line['agentPreset'] = header.agentPreset;
    return line;
};
/** Canonical JSONL text: header line, one line per event, trailing newline. */
export const serializeSessionLog = (header, events, fallback) => {
    const lines = [JSON.stringify(sessionLogHeaderLine(header, fallback))];
    for (const event of events)
        lines.push(JSON.stringify(event));
    return lines.join('\n') + '\n';
};
/** The committed events of one live session (alpha.4+ snapshot, older array). */
export const sessionEventsOf = (session) => {
    if (typeof session.snapshotEvents === 'function')
        return session.snapshotEvents();
    return Array.isArray(session.events) ? session.events : [];
};
