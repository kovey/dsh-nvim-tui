/**
 * dsh_tui transcript module: session event log access + the "insufficient
 * tool messages" orphan-repair chain, plus the transcript commands (/export
 * /trajectory /rewind /queue).
 *
 * @module dsh-nvim-tui/transcript
 */
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { t } from '../kernel/i18n.js';
import { diffTexts, fileDiffsFromMeta } from '../feed/diff.js';
import { registerHostHandler } from '../kernel/host-events.js';
import { installTrajectoryCommand } from './commands/trajectory.js';
import { installExportCommand } from './commands/export.js';
import { installRewindCommand } from './commands/rewind.js';
import { installQueueCommand } from './commands/queue.js';
/**
 * Repair the "insufficient tool messages" session poison.
 *
 * Background: when the profile carries a SECOND physical copy of
 * `@deepseek-ai/dsh-tools` (a plugin dependency hoisted into the
 * profile's node_modules), the loader builds the `tools` service from
 * that copy while dsh-agent-loop imports its scheduler symbol from the
 * harness copy. `ctx.tools[TOOL_RUNTIME_SCHEDULER]` is then undefined and
 * dispatch crashes with "Cannot read properties of undefined (reading
 * 'prepare')" — AFTER the tool/call event was committed. The derived
 * history replays an assistant tool_calls block whose tool messages are
 * missing, and the DeepSeek API rejects every later request with
 * "insufficient tool messages following tool_calls message".
 *
 * The DeepSeek wire format requires each assistant tool_calls block to be
 * IMMEDIATELY followed by its tool messages, in order. So the repair has
 * two modes, chosen per poisoned assistant message by its position in the
 * surface (the model-visible history):
 * - Tail (nothing follows it): append synthetic isError tool results for
 *   the missing calls — they land right after the tool_calls and pair.
 * - Not tail (later messages already exist — e.g. the user kept sending
 *   messages after the crash): appending at the end cannot pair, so
 *   surgically REPLACE the assistant message in place (surface replace),
 *   turning the orphaned tool-call blocks into a text note, and replace
 *   each now-unpaired tool/result surface node with a plain user note.
 *   The latter also neutralizes the misplaced synthetic results an older
 *   append-only repair (v0.2.8) left behind the user messages.
 */
const synthesizeToolResult = (rec, callId, seq, turn, step) => {
    const session = rec.handle.agent.session;
    const message = createToolResultMessage({
        // The log yields a plain string; ToolCallId is a brand over string.
        callId: callId,
        isError: true,
        content: [{
                type: 'text',
                text: 'The tool call crashed inside the Harness after it was recorded, so no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
            }],
    });
    // A call whose tool/call event exists was "started"; one that never got
    // that far (the crash hit an earlier call) is "not started" — mirroring
    // the harness's own interrupted-turn closer codes and provenance rules.
    const started = typeof seq === 'number' && seq >= 0;
    session.append('tool/result', {
        ...(turn !== undefined ? { turn } : {}),
        ...(step !== undefined ? { step } : {}),
        message,
        error: started
            ? { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' }
            : { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' },
    }, {
        surfaceOp: 'append',
        ...(started ? { sourceEventSeqs: [seq] } : {}),
    });
};
/** Replace one existing surface node (identified by its seq) with a new
 *  message-producing event of the given type. */
const surfaceReplace = (session, type, seq, data) => {
    session.append(type, data, {
        surfaceOp: { op: 'replace', start: seq, end: seq },
        sourceEventSeqs: [seq],
    });
};
/** Read a live Session's full event log.
 *  alpha.4 (SessionSeq 品牌化重构) removed the public `session.events`
 *  property — the log is now exposed via `snapshotEvents()`. The fallback
 *  keeps the plugin tolerant of pre-alpha.4 hosts. */
const sessionEvents = (session) => {
    const snap = session.snapshotEvents;
    if (typeof snap === 'function') {
        const got = snap.call(session);
        if (Array.isArray(got))
            return got;
    }
    const legacy = session.events;
    return Array.isArray(legacy) ? legacy : [];
};
/** Walk the model-visible surface and repair every assistant message
 *  whose tool_calls blocks are not immediately followed by their tool
 *  results. Returns the number of repaired assistant messages. */
const repairOrphanToolCalls = (rec) => {
    const session = rec.handle.agent.session;
    const events = sessionEvents(session);
    const nodes = session.surface?.nodes;
    if (!Array.isArray(nodes))
        return 0;
    let repaired = 0;
    for (let i = 0; i < nodes.length; i++) {
        const seqA = nodes[i];
        const ev = events[seqA];
        if (ev?.type !== 'assistant/message')
            continue;
        const original = ev.data?.message;
        const blocks = original?.content ?? [];
        /** Loose read of one content block (the local MessageContent union
         *  does not carry tool-call member fields). */
        const toolCallIdOf = (b) => {
            const anyBlock = b;
            return anyBlock?.type === 'tool-call' && typeof anyBlock.id === 'string' ? anyBlock.id : undefined;
        };
        const toolIds = blocks.map(toolCallIdOf).filter((id) => id !== undefined);
        if (toolIds.length === 0)
            continue;
        // Tail case: nothing follows in the surface, so appended synthetic
        // results land immediately after the tool_calls and pair correctly.
        if (i === nodes.length - 1) {
            const have = new Set();
            for (const e of events) {
                if (e.type === 'tool/result' && typeof e.data?.message?.source?.callId === 'string') {
                    have.add(e.data.message.source.callId);
                }
            }
            for (const id of toolIds) {
                if (have.has(id))
                    continue;
                const call = events.find((e) => e.type === 'tool/call' && e.data?.callId === id);
                try {
                    // turn/step fall back to the assistant message's own (the crash
                    // may have hit before this call's tool/call event was written).
                    synthesizeToolResult(rec, id, call?.seq, call?.data?.turn ?? ev.data?.turn, call?.data?.step ?? ev.data?.step);
                    repaired++;
                }
                catch { }
            }
            continue;
        }
        // Not tail: every tool id must be answered by the immediately
        // following surface node, in order; the first mismatch (a user
        // message in between, a missing/foreign result, …) poisons the rest.
        let kept = 0;
        for (let k = 0; k < toolIds.length && i + 1 + k < nodes.length; k++) {
            const next = events[nodes[i + 1 + k]];
            const cid = next?.type === 'tool/result' ? next.data?.message?.source?.callId : undefined;
            if (cid === toolIds[k])
                kept = k + 1;
            else
                break;
        }
        if (kept === toolIds.length)
            continue; // healthy pairing
        const dropped = toolIds.slice(kept);
        // Replace the assistant message: dropped tool-call blocks become a
        // text note; reasoning/text blocks and healthy tool-calls are kept.
        const rebuilt = blocks.map((b) => {
            if (dropped.includes(toolCallIdOf(b) ?? '')) {
                const anyBlock = b;
                return {
                    type: 'text',
                    text: `[工具调用 ${String(anyBlock?.name ?? '')} 未执行：调度器在派发前崩溃，结果未知。如确有需要请重试；若是可能产生副作用的操作，先核实外部状态再决定。]`,
                };
            }
            return b;
        });
        try {
            surfaceReplace(session, 'assistant/message', seqA, {
                turn: ev.data?.turn,
                step: ev.data?.step,
                message: { ...original, content: rebuilt },
            });
            repaired++;
        }
        catch {
            continue;
        }
        // Neutralize the dropped ids' tool/result surface nodes (including
        // synthetic results an older append-only repair left misplaced) —
        // an unpaired role=tool wire message would 400 on its own.
        for (let j = i + 1; j < nodes.length; j++) {
            const node = events[nodes[j]];
            if (node?.type !== 'tool/result')
                continue;
            const cid = node.data?.message?.source?.callId;
            if (typeof cid !== 'string' || !dropped.includes(cid))
                continue;
            try {
                const note = createUserMessage({
                    source: { kind: 'user' },
                    content: [{ type: 'text', text: '（此前的工具结果随崩溃的工具调用一并移除）' }],
                });
                surfaceReplace(session, 'user/message', nodes[j], note);
            }
            catch { }
        }
    }
    return repaired;
};
/** /trajectory — structured steps of the active session's last turn. */
/** Fill the transcript module's App slots and register its commands. */
export function installTranscript(app) {
    // -- trans + ui.diff domain defaults (I2) --
    Object.assign(app.slices.trans, {
        sessionEvents: () => [],
        synthesizeToolResult: () => { },
        surfaceReplace: () => { },
        repairOrphanToolCalls: () => 0,
        workflowRuns: new Map(),
    });
    Object.assign(app.slices.ui, {
        maybePushFileDiff: () => { },
        readFileSnapshot: async () => null,
        pendingFileSnaps: new Map(),
        renderedDiffCalls: new WeakMap(),
        pendingEchoes: new Map(),
    });
    // -- core services this module owns (moved out of createApp, I1) --
    /** Read a file as a diff snapshot (null when absent/unreadable/binary/
     *  oversized — those cases render no diff block). */
    app.slices.ui.readFileSnapshot = async (p) => {
        try {
            const abs = resolve(p);
            const st = await stat(abs);
            if (!st.isFile() || st.size > 256 * 1024)
                return null;
            const text = await readFile(abs, 'utf8');
            return text.includes('\0') ? null : text;
        }
        catch {
            return null;
        }
    };
    /** tool/result: render ✎ diff blocks into the feed that rendered the
     *  tool line. Primary source = the tool's official presentationMeta
     *  (`meta.diffs = [{ path, oldText, newText }]` — exact, cwd-immune);
     *  falls back to the pre-call file snapshot for flows the meta misses
     *  (creates, deletes). Also runs during history REPLAYS: the persisted
     *  events carry the same meta, so diff blocks survive restarts. */
    app.slices.ui.maybePushFileDiff = (feed, event, labelPrefix = '') => {
        if (event.type !== 'tool/result')
            return;
        const callId = event.data?.message?.source?.callId;
        // One diff render per tool call per feed: replay loops and live event
        // re-emission must never stack the same ✎ block twice.
        const seenCalls = app.slices.ui.renderedDiffCalls.get(feed) ?? new Set();
        const callKey = typeof callId === 'string' ? callId : '';
        if (callKey !== '' && seenCalls.has(callKey))
            return;
        if (callKey !== '')
            seenCalls.add(callKey);
        app.slices.ui.renderedDiffCalls.set(feed, seenCalls);
        const metaDiffs = fileDiffsFromMeta(event.data?.meta);
        if (metaDiffs !== null) {
            if (callKey !== '')
                app.slices.ui.pendingFileSnaps.delete(callKey);
            for (const d of metaDiffs.slice(0, 4)) {
                const block = diffTexts(d.oldText ?? null, d.newText ?? null);
                if (block.stats.added === 0 && block.stats.removed === 0)
                    continue;
                const action = d.oldText === undefined
                    ? t('新增')
                    : d.newText === undefined
                        ? t('删除')
                        : t('修改');
                feed.pushDiff(`✎ ${labelPrefix}${action} ${d.path} (+${block.stats.added} −${block.stats.removed})`, block.lines);
            }
            return;
        }
        if (typeof callId !== 'string' || callId === '')
            return;
        const snap = app.slices.ui.pendingFileSnaps.get(callId);
        if (snap === undefined)
            return;
        app.slices.ui.pendingFileSnaps.delete(callId);
        void app.slices.ui.readFileSnapshot(snap.display).then((after) => {
            if (app.slices.runtime.disposed)
                return;
            const block = diffTexts(snap.before, after);
            if (block.stats.added === 0 && block.stats.removed === 0)
                return;
            const action = snap.before === null ? t('新增') : after === null ? t('删除') : t('修改');
            feed.pushDiff(`✎ ${labelPrefix}${action} ${snap.display} (+${block.stats.added} −${block.stats.removed})`, block.lines);
        });
    };
    app.slices.trans.sessionEvents = (session) => sessionEvents(session);
    app.slices.trans.synthesizeToolResult = (rec, callId, seq, turn, step) => synthesizeToolResult(rec, callId, seq, turn, step);
    app.slices.trans.surfaceReplace = (session, type, seq, data) => surfaceReplace(session, type, seq, data);
    app.slices.trans.repairOrphanToolCalls = (rec) => repairOrphanToolCalls(rec);
    // -- the slash commands, one file each (self-registering) --
    installTrajectoryCommand(app);
    installExportCommand(app);
    installRewindCommand(app);
    installQueueCommand(app);
    // -- host events this module owns (wired by boot via host-events.ts) ----
    // Workflow lifecycle cards → the owning session's feed.
    registerHostHandler('workflow/start', (app, info) => {
        if (app.slices.runtime.disposed)
            return;
        const payload = info;
        const runId = payload?.id ?? '?';
        const run = app.slices.trans.workflowRuns.get(runId) ?? { id: runId, name: payload?.meta?.name ?? runId, startedAt: Date.now(), phases: [], agents: [], logs: [], running: true, stopReason: undefined };
        run.startedAt = Date.now();
        run.running = true;
        app.slices.trans.workflowRuns.set(runId, run);
        app.slices.ui.activeFeed()?.workflowStart(payload);
    });
    registerHostHandler('workflow/phase', (app, info, title) => {
        if (app.slices.runtime.disposed)
            return;
        const payload = info;
        const runId = payload?.id;
        const run = runId === undefined ? undefined : app.slices.trans.workflowRuns.get(runId);
        if (run) {
            run.phases.push({ title: title, startedAt: Date.now() });
        }
        app.slices.ui.activeFeed()?.workflowPhase(payload, title);
    });
    registerHostHandler('workflow/log', (app, info, message) => {
        if (app.slices.runtime.disposed)
            return;
        const payload = info;
        const runId = payload?.id;
        const run = runId === undefined ? undefined : app.slices.trans.workflowRuns.get(runId);
        if (run)
            run.logs.push(message);
    });
    registerHostHandler('workflow/agent-start', (app, info, agent) => {
        if (app.slices.runtime.disposed)
            return;
        const payload = info;
        const entry = agent;
        const runId = payload?.id;
        const run = runId === undefined ? undefined : app.slices.trans.workflowRuns.get(runId);
        if (run)
            run.agents.push({ seq: entry?.seq ?? 0, label: entry?.label ?? '', outcome: undefined });
    });
    registerHostHandler('workflow/agent-end', (app, info, agent) => {
        if (app.slices.runtime.disposed)
            return;
        const payload = info;
        const entry = agent;
        const runId = payload?.id;
        const run = runId === undefined ? undefined : app.slices.trans.workflowRuns.get(runId);
        if (run) {
            const agentEntry = run.agents.find((e) => e.seq === entry?.seq);
            if (agentEntry)
                agentEntry.outcome = entry?.outcome ?? 'settled';
        }
    });
    registerHostHandler('workflow/end', (app, info, result) => {
        if (app.slices.runtime.disposed)
            return;
        const payload = info;
        const outcome = result;
        const runId = payload?.id;
        const run = runId === undefined ? undefined : app.slices.trans.workflowRuns.get(runId);
        if (run) {
            run.running = false;
            run.stopReason = outcome?.stopReason;
        }
        app.slices.ui.activeFeed()?.workflowEnd(payload, outcome ?? {});
    });
}
