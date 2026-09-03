/**
 * dsh_tui transcript module: session event log access + the "insufficient
 * tool messages" orphan-repair chain, plus the transcript commands (/export
 * /trajectory /rewind /queue).
 *
 * @module dsh-nvim-tui/transcript
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { FeedRenderer } from './feed.js';
import { t } from './i18n.js';
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
const trajectoryCommand = (app) => {
    const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId);
    if (!rec) {
        app.notice(t('无活跃会话'));
        return;
    }
    const events = sessionEvents(rec.handle.agent.session);
    const turnStart = [...events].reverse().find((e) => e.type === 'turn/start');
    if (turnStart === undefined) {
        app.notice(t('本会话还没有回合'));
        return;
    }
    const turn = turnStart.data?.turn;
    const lines = [`回合 #${turn ?? '?'} 步骤轨迹`, ''];
    let step = 0;
    let toolCount = 0;
    for (const e of events) {
        const data = e.data;
        if (e.type === 'turn/start') {
            step = data?.turn === turn ? (data?.step ?? 0) : step;
            continue;
        }
        if (data === undefined || data.turn !== turn)
            continue;
        if (e.type === 'assistant/message') {
            const text = FeedRenderer.messageText(data.message).replace(/\s+/g, ' ').slice(0, 90);
            lines.push(`步骤 ${data.step ?? '?'} · ${text || '（无文本）'}`);
        }
        else if (e.type === 'tool/call') {
            lines.push(`  🔧 ${data.name}(${FeedRenderer.argsPreview(data.arguments)})`);
            toolCount++;
        }
        else if (e.type === 'tool/result') {
            const err = data.error !== undefined && data.error !== null ? ' ✗' : ' ✓';
            lines.push(`    ${err}`);
        }
    }
    lines.push('', `工具调用 ${toolCount} 次`);
    void app.luaCall('require("dsh_tui").show_lines_float(...)', ['步骤轨迹', lines]).catch(() => { });
};
/** /export — write the rendered transcript to a markdown file. */
const exportCommand = async (app) => {
    const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId);
    if (!rec)
        return;
    try {
        const lines = await app.nvim.request('nvim_buf_get_lines', [rec.feed.bufId, 0, -1, false]);
        const path = join(process.cwd(), `dsh-export-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
        writeFileSync(path, `# ${rec.title ?? rec.id}\n\n` + lines.join('\n') + '\n');
        app.notice(`已导出: ${path}`);
    }
    catch (err) {
        app.notice(`导出失败: ${err.message}`);
    }
};
/** /rewind — pick a user-message boundary, truncate the session after
 *  it, and rebuild the chat from the remaining events. */
const rewindCommand = async (app, a) => {
    const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId);
    if (!rec) {
        app.notice(t('无活跃会话'));
        return;
    }
    const session = app.runtimeCtx.sessions.get(rec.id);
    if (session === undefined || typeof session.truncate !== 'function') {
        app.notice(t('会话截断不可用：宿主 dsh-session 不支持 truncate（可用 /fork 派生替代）'));
        return;
    }
    const arg = (a ?? '').trim();
    const boundaries = [];
    for (const e of sessionEvents(session)) {
        if (e.type === 'user/message') {
            const um = e.data;
            const umsg = um?.message ?? um;
            const text = Array.isArray(umsg?.content)
                ? umsg.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ')
                : (umsg?.text ?? '');
            boundaries.push({ seq: e.seq, text: String(text).replace(/\s+/g, ' ').slice(0, 48) });
        }
    }
    if (boundaries.length === 0) {
        app.notice(t('（没有可回退的用户消息）'));
        return;
    }
    const recent = boundaries.slice(-8);
    let target;
    if (arg !== '' && /^\d+$/.test(arg)) {
        const n = Math.min(Number(arg), boundaries.length);
        target = boundaries[boundaries.length - n];
    }
    else {
        const sel = await app.openPicker(t('回退到哪条消息之后（截断其后内容）'), recent.map((b) => ({ label: `#${b.seq} ${b.text}`, value: String(b.seq) })));
        if (sel === null)
            return;
        target = boundaries.find((b) => String(b.seq) === sel);
    }
    if (target === undefined) {
        app.notice(t('未找到目标边界'));
        return;
    }
    try {
        const persistence = app.svc('sessionPersistence');
        if (persistence !== undefined && typeof persistence.truncateStored === 'function') {
            await persistence.truncateStored(rec.id, target.seq);
        }
        session.truncate(target.seq);
        // Rebuild the chat from the truncated events (the harness truncates
        // in place and emits no events).
        rec.feed.clear();
        for (const e of sessionEvents(session)) {
            app.foldEvent(rec, e);
            rec.feed.applyEvent(e, { history: true });
            app.maybePushFileDiff(rec.feed, e);
        }
        void rec.feed.flush();
        app.notice(`已回退到 #${target.seq}（其后内容已截断）`);
    }
    catch (err) {
        app.notice(`回退失败: ${err.message}`);
    }
};
/** /queue — pending-message queue (official QueueDock counterpart):
 *  view queued turns and next-step input, edit / remove rows, clear all. */
const queueCommand = async (app) => {
    const rec = app.activeId === null ? undefined : app.sessions.get(app.activeId);
    if (!rec) {
        app.notice(t('无活跃会话'));
        return;
    }
    const inbox = rec.handle.agent.inbox;
    const nextTurn = (inbox?.nextTurn ?? []);
    const nextStep = (inbox?.nextStep ?? []);
    if (nextTurn.length === 0 && nextStep.length === 0) {
        app.notice(t('（没有排队中的消息）'));
        return;
    }
    const rows = [];
    const add = (list, msgs, prefix) => {
        for (const m of msgs) {
            const id = m.id;
            const text = FeedRenderer.messageText(m);
            rows.push({
                label: `${prefix}${FeedRenderer.truncate(text.replace(/\s+/g, ' '), 60)}`,
                value: JSON.stringify({ list, id: String(id ?? '') }),
            });
        }
    };
    if (nextTurn.length > 0)
        rows.push({ label: `── 排队回合 ${nextTurn.length} 条`, value: 'none' });
    add('nextTurn', nextTurn, '  ');
    if (nextStep.length > 0)
        rows.push({ label: `── 下一步输入 ${nextStep.length} 条`, value: 'none' });
    add('nextStep', nextStep, '  ');
    rows.push({ label: '🗑 清空全部排队', value: 'clear' });
    const sel = await app.openPicker(t('消息队列'), rows);
    if (sel === null || sel === 'none')
        return;
    if (sel === 'clear') {
        if (typeof inbox?.clear !== 'function') {
            app.notice(t('inbox 不可用'));
            return;
        }
        try {
            inbox.clear();
            app.notice(t('已清空排队消息'));
        }
        catch (err) {
            app.notice(`清空失败: ${err.message}`);
        }
        return;
    }
    let picked;
    try {
        picked = JSON.parse(sel);
    }
    catch { }
    if (picked === undefined)
        return;
    const act = await app.openPicker(t('队列操作'), [
        { label: '删除该条', value: 'del' },
        { label: '编辑该条（下一条输入作为新内容）', value: 'edit' },
    ]);
    if (act === 'del') {
        if (typeof inbox?.remove !== 'function') {
            app.notice(t('inbox 不可用'));
            return;
        }
        try {
            const ok = inbox.remove(picked.id);
            app.notice(ok === true ? '已从队列移除' : '该消息已被处理');
        }
        catch (err) {
            app.notice(`移除失败: ${err.message}`);
        }
    }
    else if (act === 'edit') {
        app.pendingQueueEdit = { list: picked.list, messageId: picked.id };
        app.notice(t('下一条输入将替换该排队消息'));
    }
};
/** Fill the transcript module's App slots and register its commands. */
export function installTranscript(app) {
    app.sessionEvents = (session) => sessionEvents(session);
    app.synthesizeToolResult = (rec, callId, seq, turn, step) => synthesizeToolResult(rec, callId, seq, turn, step);
    app.surfaceReplace = (session, type, seq, data) => surfaceReplace(session, type, seq, data);
    app.repairOrphanToolCalls = (rec) => repairOrphanToolCalls(rec);
    const specs = [
        { name: '/trajectory', desc: t('回合步骤轨迹'), usage: t(''), group: t('信息'), fn: () => trajectoryCommand(app) },
        { name: '/export', desc: t('导出转录 md'), usage: t('导出转录'), group: t('信息'), fn: () => exportCommand(app) },
        { name: '/rewind', desc: t('回退到某条消息'), usage: t('[第N条]'), group: t('会话'), fn: (a) => rewindCommand(app, a) },
        { name: '/queue', desc: t('消息队列（编辑/删除/清空）'), usage: t('消息队列'), group: t('会话'), fn: () => queueCommand(app) },
    ];
    app.registerCommands(specs);
}
