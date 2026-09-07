/**
 * dsh_tui boot module: nvim spawn + socket connect, the notification loop
 * (input / commands / pickers / approvals / questions), session-event and
 * host-event wiring (statusline, subagent/workflow/goal cards), the boot
 * sequence (history resume + headless prompt), the headless dump watchdog
 * and graceful exit.
 *
 * Runs LAST: index.ts installs every behavior module first, then calls
 * `boot(app)`.
 *
 * @module dsh-nvim-tui/boot
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawnNvim, connectNvim } from './bridge.js';
import { FeedRenderer } from './feed.js';
import { EXT_API_VERSION } from './ext-api.js';
import { t } from './i18n.js';
export async function boot(app) {
    try {
        const spawned = await spawnNvim({
            extraArgs: app.headless ? ['--headless'] : [],
            isolateXdg: app.headless, // sandbox/CI: private XDG dirs for the child
            loadUserConfig: app.config.loadUserConfig !== false &&
                process.env.DSH_NVIM_TUI_LOAD_USER_CONFIG !== '0',
            onExit: (code, signal) => {
                // A child exit we initiated (teardown/:qa!) must not re-trigger
                // quit(); only a spontaneous nvim death closes the UI.
                app.exitDiag('nvim-exit', `code=${code}`, `signal=${signal}`, `disposed=${app.slices.runtime.disposed}`);
                if (!app.slices.runtime.disposed)
                    void app.quit(0);
            },
        });
        app.slices.runtime.child = spawned.child;
        // nvim now owns the terminal; keep our own process silent so DSH
        // logging cannot corrupt the TUI.
        const silent = () => { };
        console.log = silent;
        console.warn = silent;
        console.error = silent;
        app.slices.runtime.nvim = await connectNvim(spawned.sockPath);
        const channelId = await app.slices.runtime.nvim.channelId;
        app.slices.runtime.channelIdValue = channelId;
        await app.luaCall('require("dsh_tui").attach(...)', [channelId]);
        // Extension handshake: agree on the API major version (a mismatch
        // surfaces as a boot notice).
        void app.luaCall('require("dsh_tui.api").handshake(...)', [EXT_API_VERSION])
            .then((res) => {
            const r = res;
            if (r !== null && r !== undefined && typeof r === 'object' && r.ok === false) {
                app.notice(`⚠ ${String(r.error ?? '扩展接口握手失败')}`);
            }
        })
            .catch((err) => app.notice(`⚠ 扩展接口握手失败: ${err.message}`));
        // Slash-command catalog for the completion menu (name + description);
        // nvim shows it as soon as the input starts with '/'.
        await app.luaCall('require("dsh_tui").set_commands(...)', [app.slices.agent.commandCatalog()]).catch(() => { });
        void app.slices.agent.refreshCommandCatalog();
        // Theme overrides from the runner config (profile cordis.patch.yml).
        if (app.config.theme !== undefined && app.config.theme !== null && typeof app.config.theme === 'object') {
            await app.luaCall('require("dsh_tui").apply_theme(...)', [app.config.theme]).catch(() => { });
        }
        app.slices.runtime.nvim.on('disconnect', () => void app.quit(0));
        // dsh-ext bus: nvim plugins issue vim.rpcrequest(channel, 'dsh-ext', …)
        // and the runner answers from the extId dispatch table (luaExt.on).
        // EVERY request gets a BOUNDED response: vim.rpcrequest blocks nvim
        // uninterruptibly (and cannot be cancelled from Lua), so a hung handler
        // freezes the UI forever — the runner races the handler against its
        // timeout and answers an error when it overruns. Late handler results
        // are discarded (answered flag guards the single-send channel).
        // NOTE: nvim DOES process events while blocked in rpcrequest, so
        // handlers may safely make nested nvim calls (verified empirically).
        app.slices.runtime.nvim.on('request', (method, args, resp) => {
            void (async () => {
                let answered = false;
                const reply = (r) => {
                    if (answered)
                        return;
                    answered = true;
                    try {
                        resp.send(r);
                    }
                    catch { /* peer went away mid-handler: nothing to answer */ }
                };
                if (method !== 'dsh-ext') {
                    reply({ ok: false, error: `unsupported request: ${method}` });
                    return;
                }
                const payload = (args?.[0] ?? {});
                const extId = typeof payload.id === 'string' ? payload.id : '';
                const m = typeof payload.method === 'string' ? payload.method : '';
                const entry = extId === '' ? undefined : app.slices.ext.extNodeHandlers.get(extId);
                if (entry === undefined) {
                    reply({ ok: false, error: `no ext handler: ${extId}.${m || '?'}` });
                    return;
                }
                const deadline = setTimeout(() => {
                    reply({ ok: false, error: `ext handler timeout: ${extId}.${m} (${entry.timeoutMs}ms)` });
                }, entry.timeoutMs);
                try {
                    const value = await entry.handler(m, Array.isArray(payload.args) ? payload.args : []);
                    clearTimeout(deadline);
                    reply({ ok: true, value });
                }
                catch (err) {
                    clearTimeout(deadline);
                    reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
                }
            })();
        });
        app.slices.runtime.nvim.on('notification', async (method, args) => {
            if (app.slices.runtime.disposed)
                return;
            if (method === 'dsh-input') {
                const raw = String(args?.[0] ?? '');
                // Card INPUT actions claim the next input: it belongs to the card,
                // not the agent (interception sits BEFORE the tui:input broadcast,
                // so ext subscribers never see card inputs as chat input).
                if (app.slices.ext.pendingCardInput !== null) {
                    const pending = app.slices.ext.pendingCardInput;
                    app.slices.ext.pendingCardInput = null;
                    const text = raw.trim();
                    if (text === '') {
                        app.notice('已取消卡片输入');
                        return;
                    }
                    const feed = app.slices.ui.activeFeed();
                    const r = feed === undefined ? null : feed.resolveCardAction(pending.mark, pending.actionIdx);
                    if (r === null || r.action === undefined) {
                        app.notice('⚠ 卡片已失效，输入已取消');
                        return;
                    }
                    try {
                        feed.fireCardAction(r.cardId, text);
                    }
                    catch (err) {
                        app.notice(`⚠ 卡片操作失败: ${err.message}`);
                    }
                    return;
                }
                app.slices.ext.extFire('tui:input', { text: raw });
                try {
                    app.slices.agent.onInput(raw);
                }
                catch (err) {
                    app.notice(`⚠ 输入处理失败: ${err.message}`);
                }
            }
            else if (method === 'dsh-command') {
                try {
                    app.slices.agent.onCommand(String(args?.[0] ?? ''));
                }
                catch (err) {
                    app.notice(`⚠ 命令失败: ${err.message}`);
                }
            }
            else if (method === 'dsh-abort') {
                // <C-c> in the input box: same path as /stop.
                app.slices.agent.stopCommand();
            }
            else if (method === 'dsh-session-select')
                void app.guard('切换会话', app.slices.sessions.selectSession)(String(args?.[0] ?? ''));
            else if (method === 'dsh-session-new')
                void app.guard('新建会话', app.slices.sessions.createSession)();
            else if (method === 'dsh-reasoning-toggled') {
                app.slices.runtime.reasoningOpen = args?.[0] === true;
                if (app.slices.runtime.reasoningOpen) {
                    const ids = await app.luaCall('return require("dsh_tui").ids()', []).catch(() => null);
                    app.slices.runtime.reasoningWinId = ids?.reasoningWin ?? null;
                }
            }
            else if (method === 'dsh-approval-decided') {
                const raw = String(args?.[0] ?? 'n');
                if (raw === 'always') {
                    // dsh has no allow-always grant (one-shot vocabulary only), so
                    // "always" switches the session to AUTOMATIC mode: approval
                    // policy 'never' — stop prompting, auto-decide from now on
                    // (the harness fails closed: such requests are auto-rejected).
                    // This request is the last one decided interactively.
                    const sid = app.slices.agent.approvalReq?.agent?.session?.id;
                    if (sid !== undefined) {
                        const rec = app.slices.sessions.live.get(sid);
                        if (rec) {
                            try {
                                rec.handle.agent.session.append('approval/policy', { policy: 'never' });
                                rec.policy = 'never';
                                app.slices.ui.updateStatusline();
                                rec.feed.appendNotice('已切换自动审批模式（never）：不再弹窗询问，需要审批的操作将自动拒绝（/yolo off 恢复逐项询问）');
                            }
                            catch { /* policy switch is best-effort */ }
                        }
                    }
                    app.slices.agent.approvalSettle?.('allowed-once');
                }
                else {
                    app.slices.agent.approvalSettle?.(raw === 'y' ? 'allowed-once' : 'rejected');
                }
                app.slices.agent.approvalSettle = null;
                app.slices.agent.approvalReq = null;
            }
            else if (method === 'dsh-questions-answered') {
                const answers = args?.[0] ?? [];
                app.slices.agent.questionsResolve?.resolve({ answers });
                app.slices.agent.questionsResolve = null;
            }
            else if (method === 'dsh-questions-cancelled') {
                const reject = app.slices.agent.questionsResolve;
                app.slices.agent.questionsResolve = null;
                reject?.reject(new Error('cancelled by user'));
            }
            else if (method === 'dsh-picker-selected') {
                app.slices.agent.pickerSettle?.(args?.[0]);
                app.slices.agent.pickerSettle = null;
            }
            else if (method === 'dsh-picker-cancelled') {
                app.slices.agent.pickerSettle?.(null);
                app.slices.agent.pickerSettle = null;
            }
            else if (method === 'dsh-subagent-view-closed') {
                app.slices.agent.subagentView = null;
            }
            else if (method === 'dsh-subagent-chat-closed') {
                app.slices.agent.subagentChat = null;
            }
            else if (method === 'dsh-subagent-send') {
                try {
                    app.slices.agent.sendToSubagent(String(args?.[0] ?? ''));
                }
                catch (err) {
                    app.notice(`⚠ 子代理发送失败: ${err.message}`);
                }
            }
            else if (method === 'dsh-dir-selected') {
                const picked = args?.[0];
                app.slices.agent.dirSettle?.(picked ?? null);
                app.slices.agent.dirSettle = null;
            }
            else if (method === 'dsh-at-query') {
                const query = String(args?.[0]?.query ?? '');
                const start = Number(args?.[0]?.start ?? 0);
                void app.guard('文件引用补全', app.slices.agent.atQuery)(query, start);
            }
            else if (method === 'dsh-quit')
                void app.quit(0);
            else if (method === 'dsh-paste-image')
                app.slices.agent.pasteClipboardImage();
            else if (method === 'dsh-ext-register') {
                // A Lua-side extension registered (api.register): mirror its
                // session-event subscription so the Node side knows what to route.
                const spec = (args?.[0] ?? {});
                const id = typeof spec.id === 'string' ? spec.id : '';
                if (id === '')
                    return;
                const raw = Array.isArray(spec.events) ? spec.events.filter((e) => typeof e === 'string') : undefined;
                const wantsAll = raw === undefined || raw.length === 0 || raw.includes('all');
                app.slices.ext.extLuaSubs.set(id, wantsAll ? 'all' : new Set(raw));
            }
            else if (method === 'dsh-ext-unregister') {
                const id = typeof args?.[0] === 'string' ? args[0] : '';
                if (id !== '')
                    app.slices.ext.extLuaSubs.delete(id);
            }
            else if (method === 'dsh-ext-notice') {
                // Lua-side extensions surface transient notices through the runner.
                const text = String(args?.[0]?.text ?? args?.[0] ?? '');
                if (text !== '')
                    app.notice(text);
            }
            else if (method === 'dsh-ext-card-activate') {
                // Interactive ext card: the chat keymap resolved the card mark under
                // the cursor (active session feed). action null → open the action
                // picker; a number → dispatch that action (plain fires immediately,
                // confirm gates behind a picker, input claims the next dsh-input).
                const payload = (args?.[0] ?? {});
                const mark = Number(payload.mark);
                if (!Number.isInteger(mark))
                    return;
                const feed = app.slices.ui.activeFeed();
                if (feed === undefined)
                    return;
                const dispatch = (feed2, idx) => {
                    // Any new card activation supersedes a pending input-mode prompt
                    // (the input branch below re-arms it when needed).
                    app.slices.ext.pendingCardInput = null;
                    const r = feed2.resolveCardAction(mark, idx);
                    if (r === null || r.action === undefined) {
                        app.notice('⚠ 卡片已失效');
                        return;
                    }
                    const act = r.action;
                    const kind = act.kind ?? 'plain';
                    try {
                        if (kind === 'confirm') {
                            // headless degrades to plain (no TTY to confirm on).
                            if (app.headless) {
                                feed2.fireCardAction(r.cardId, act.value);
                                return;
                            }
                            void app.openPicker(String(act.confirmText ?? `确认执行「${act.label}」？`), [
                                { label: '确认', value: 'yes' },
                                { label: '取消', value: 'no' },
                            ]).then((sel) => {
                                if (sel === 'yes') {
                                    try {
                                        feed2.fireCardAction(r.cardId, act.value);
                                    }
                                    catch (err) {
                                        app.notice(`⚠ 卡片操作失败: ${err.message}`);
                                    }
                                }
                            });
                            return;
                        }
                        if (kind === 'input') {
                            // headless degrades to plain (no input box to type into).
                            if (app.headless) {
                                feed2.fireCardAction(r.cardId, act.value);
                                return;
                            }
                            const prompt = String(act.inputPrompt ?? `输入「${act.label}」的参数`);
                            app.slices.ext.pendingCardInput = { mark, actionIdx: idx, prompt };
                            if (typeof act.inputDefault === 'string' && act.inputDefault !== '') {
                                void app.luaCall('require("dsh_tui").fill_input(...)', [act.inputDefault]).catch(() => { });
                            }
                            app.notice(`✎ ${prompt}（Enter 提交 · 空输入取消）`);
                            return;
                        }
                        feed2.fireCardAction(r.cardId, act.value);
                    }
                    catch (err) {
                        app.notice(`⚠ 卡片操作失败: ${err.message}`);
                    }
                };
                try {
                    const action = typeof payload.action === 'number' ? payload.action : null;
                    const res = feed.activateCard(mark, action);
                    if (res === null)
                        return;
                    if (Array.isArray(res)) {
                        if (res.length === 0)
                            return;
                        // Kind badges: confirm ⚠ / input ✎ — the picker shows what
                        // happens BEFORE anything fires.
                        const items = res.map((a) => ({
                            label: (a.kind === 'confirm' ? '⚠ ' : a.kind === 'input' ? '✎ ' : '') + a.label,
                            value: a.value,
                        }));
                        void app.openPicker('卡片操作', items).then((value) => {
                            if (value === null)
                                return;
                            const idx = res.findIndex((i) => i.value === value) + 1;
                            if (idx > 0)
                                dispatch(feed, idx);
                        });
                        return;
                    }
                    // Direct 1-9: the dispatcher handles the kind.
                    dispatch(feed, action);
                }
                catch (err) {
                    app.notice(`⚠ 卡片操作失败: ${err.message}`);
                }
            }
        });
        // Session elapsed / stats tick slowly while idle (the spinner interval
        // already covers the running state at 180ms).
        app.slices.runtime.idleRefreshTimer = setInterval(() => {
            if (!app.slices.runtime.disposed) {
                app.slices.ui.refreshBgJobs();
                app.slices.ui.ensureSpinner();
                app.slices.ui.updateStatusline();
            }
        }, 30000);
        // Event dispatch: each session's transcript goes to its own feed.
        // File-change diffs: snapshot mutation targets BEFORE the tool runs so
        // the ✓ result line can render an accurate +/− block (a write against
        // its real old version, not an all-green wall).
        /** Produced-file heuristic for /deliverables: mutation tools whose args
         *  carry a follow-along path (official render intents: diff / edit). */
        const producedPathFromCall = (name, argsText) => {
            if (!['fs', 'write', 'edit', 'replace', 'append', 'str_replace_editor', 'patch'].includes(name))
                return null;
            let args;
            try {
                args = JSON.parse(argsText ?? '{}');
            }
            catch {
                return null;
            }
            if (name === 'str_replace_editor' && args?.command !== 'insert')
                return null;
            const p = args?.file_path ?? args?.path;
            return typeof p === 'string' && p !== '' ? p : null;
        };
        app.slices.runtime.feedDisposer = app.runtimeCtx.on('session/event', (owner, event) => {
            if (app.slices.runtime.disposed)
                return;
            // Extension mirror: opt-in session-event subscribers (Node-side
            // onSessionEvent; the Lua-side routing lands with P3).
            app.slices.ext.extDispatchSessionEvent(owner.id, event);
            // Open subagent CHAT window: route the child's live events into its
            // feed (reasoning/text/tools keep streaming in place). The harness's
            // replay of our own optimistic user echo is skipped (FIFO dedupe).
            if (app.slices.agent.subagentChat !== null && owner.id === app.slices.agent.subagentChat.childId) {
                if (event.type === 'tool/call' && typeof event.data?.name === 'string') {
                    const p = producedPathFromCall(event.data.name, event.data.arguments);
                    if (p !== null && typeof event.data.callId === 'string' && event.data.callId !== '') {
                        const cid = event.data.callId;
                        void app.slices.ui.readFileSnapshot(p).then((before) => {
                            app.slices.ui.pendingFileSnaps.set(cid, { display: p, before });
                        });
                    }
                }
                if (event.type === 'user/message') {
                    const q = app.slices.ui.pendingEchoes.get(owner.id);
                    if (q !== undefined && q.length > 0) {
                        const data = event.data;
                        const msg = data?.message ??
                            data;
                        if (FeedRenderer.messageText(msg) === q[0]) {
                            q.shift();
                            app.slices.ui.pendingEchoes.set(owner.id, q);
                            return; // already rendered optimistically — no double bubble
                        }
                    }
                }
                app.slices.agent.subagentChat.feed.applyEvent(event);
                app.slices.ui.maybePushFileDiff(app.slices.agent.subagentChat.feed, event);
                return;
            }
            // Open subagent transcript view: route the child's live events into
            // its read-only feed (reasoning/text/tools keep streaming in place).
            if (app.slices.agent.subagentView !== null && owner.id === app.slices.agent.subagentView.childId) {
                if (event.type === 'tool/call' && typeof event.data?.name === 'string') {
                    const p = producedPathFromCall(event.data.name, event.data.arguments);
                    if (p !== null && typeof event.data.callId === 'string' && event.data.callId !== '') {
                        const cid = event.data.callId;
                        void app.slices.ui.readFileSnapshot(p).then((before) => {
                            app.slices.ui.pendingFileSnaps.set(cid, { display: p, before });
                        });
                    }
                }
                app.slices.agent.subagentView.feed.applyEvent(event);
                app.slices.ui.maybePushFileDiff(app.slices.agent.subagentView.feed, event);
                return;
            }
            // Child→parent modification sync (alpha.4): the child's file-change
            // diffs render LIVE into the parent's chat as subagent-labeled ✎
            // cards — the parent shares the workspace, so the child's edits are
            // the parent's edits (the harness forwards no child transcript, but
            // this runner sees every child session event).
            const childLink = app.slices.sessions.childParent.get(owner.id);
            if (childLink !== undefined) {
                if (event.type === 'tool/call' && typeof event.data?.name === 'string') {
                    const p = producedPathFromCall(event.data.name, event.data.arguments);
                    if (p !== null && typeof event.data.callId === 'string' && event.data.callId !== '') {
                        const cid = event.data.callId;
                        void app.slices.ui.readFileSnapshot(p).then((before) => {
                            app.slices.ui.pendingFileSnaps.set(cid, { display: p, before });
                        });
                    }
                }
                if (event.type === 'tool/result') {
                    const prec = app.slices.sessions.live.get(childLink.parentId);
                    if (prec !== undefined) {
                        app.slices.ui.maybePushFileDiff(prec.feed, event, `${t('子代理')} ${childLink.label} `);
                    }
                }
                return;
            }
            const rec = app.slices.sessions.live.get(owner.id);
            if (!rec)
                return;
            // Skip the host's user/message when this exact text was already
            // rendered optimistically at submit time (no double bubble).
            let echoed = false;
            if (event.type === 'user/message') {
                const q = app.slices.ui.pendingEchoes.get(owner.id);
                if (q !== undefined && q.length > 0) {
                    const data = event.data;
                    const msg = data?.message ??
                        data;
                    if (FeedRenderer.messageText(msg) === q[0]) {
                        q.shift();
                        app.slices.ui.pendingEchoes.set(owner.id, q);
                        echoed = true;
                    }
                }
            }
            // Deliverables: files the current turn produced, derived from
            // mutation tools' follow-along args (official client uses the tools'
            // render-intent locations; the tool/result payload does not carry
            // them, so this is a name+args heuristic over the same set).
            if (event.type === 'turn/start') {
                rec.deliverables = { turn: event.data?.turn, paths: [] };
                rec.pendingToolCalls.clear();
                rec.lastTurnStartAt = Date.now();
            }
            else if (event.type === 'tool/call' && event.data?.name !== undefined) {
                const p = producedPathFromCall(event.data.name, event.data.arguments);
                if (p !== null) {
                    if (!(rec.deliverables?.paths ?? []).includes(p)) {
                        rec.deliverables = rec.deliverables ?? { turn: undefined, paths: [] };
                        rec.deliverables.paths.push(p);
                    }
                    if (typeof event.data.callId === 'string' && event.data.callId !== '') {
                        const cid = event.data.callId;
                        void app.slices.ui.readFileSnapshot(p).then((before) => {
                            app.slices.ui.pendingFileSnaps.set(cid, { display: p, before });
                        });
                    }
                }
            }
            // Live orphan tracking for the duplicate-dsh-tools scheduler crash:
            // every tool/call parks here until its tool/result arrives; any call
            // still parked when turn/end lands has been orphaned by the crash.
            if (event.type === 'tool/call' && typeof event.data?.callId === 'string') {
                rec.pendingToolCalls.set(event.data.callId, {
                    seq: event.seq ?? -1,
                    turn: event.data?.turn,
                    step: event.data?.step,
                });
            }
            else if (event.type === 'tool/result' && typeof event.data?.message?.source?.callId === 'string') {
                rec.pendingToolCalls.delete(event.data.message.source.callId);
            }
            // Turn finished on the ACTIVE session → terminal bell (toggle /bell).
            if (event.type === 'turn/end') {
                app.slices.ui.pendingFileSnaps.clear();
                if (rec.pendingToolCalls.size > 0) {
                    // The turn ended while tool calls were still pending: the tool
                    // scheduler crashed after committing tool/call events and no
                    // result will ever arrive. Synthesize error results so the next
                    // request is not rejected by "insufficient tool messages".
                    // Deferred: session.append cannot reenter while the turn/end
                    // event's own publication boundary is still open.
                    const orphaned = [...rec.pendingToolCalls.entries()];
                    rec.pendingToolCalls.clear();
                    const reason = event.data?.reason;
                    const prepareCrash = typeof reason?.error?.message === 'string' &&
                        reason.error.message.includes("reading 'prepare'");
                    setTimeout(() => {
                        if (app.slices.runtime.disposed || !app.slices.sessions.live.has(rec.id))
                            return;
                        let healed = 0;
                        for (const [callId, call] of orphaned) {
                            try {
                                app.slices.trans.synthesizeToolResult(rec, callId, call.seq >= 0 ? call.seq : undefined, call.turn, call.step);
                                healed++;
                            }
                            catch { }
                        }
                        if (healed > 0 && owner.id === app.slices.sessions.activeId) {
                            app.notice(prepareCrash
                                ? t(`⚠ 工具调度器崩溃（profile 里存在第二份 @deepseek-ai/dsh-tools 拷贝）——已补写 ${healed} 个悬空工具结果，本会话可继续使用；根治：在 profile 目录执行 pnpm why @deepseek-ai/dsh-tools 后 pnpm dedupe（或将 dsh-nvim-tui 升级到 0.2.8+）`)
                                : t(`⚠ 回合结束时仍有 ${healed} 个工具调用未产生结果——已补写错误结果，会话历史已修复`));
                        }
                    }, 0);
                }
                if (owner.id === app.slices.sessions.activeId && app.slices.agent.bellOn) {
                    void app.luaCall('require("dsh_tui").bell()', []).catch(() => { });
                }
                // 识图临时切换恢复：图片回合（在切换之后启动的回合）结束 → 切回
                // 原模型。排在图片回合之后入队的普通回合不受影响（switchAt 判定）。
                if (rec.visionTmp !== null && (rec.lastTurnStartAt ?? 0) > rec.visionTmp.switchAt) {
                    const prev = rec.visionTmp.prev;
                    rec.visionTmp = null;
                    rec.modelRef.current = prev;
                    rec.model = prev.model;
                    if (owner.id === app.slices.sessions.activeId) {
                        app.notice(`已切回模型 ${prev.provider}/${prev.model}`);
                        app.slices.ui.updateStatusline();
                    }
                }
            }
            if (event.type === 'session/title' && typeof event.data?.title === 'string') {
                rec.title = event.data.title;
                app.slices.sessions.refreshList();
                if (owner.id === app.slices.sessions.activeId) {
                    app.slices.ui.updateStatusline();
                    app.slices.sessions.updateTitle();
                }
                return;
            }
            // A user message that still carries an image block predates the
            // official vision-model routing (or the catalog had no vision model):
            // every later turn re-sends it, and a text-only model rejects the
            // whole request. Warn once and point at /rewind.
            if (event.type === 'user/message' &&
                Array.isArray(event.data?.message?.content) &&
                event.data.message.content.some((b) => b?.type === 'image')) {
                if (!rec.imagePoisonWarned) {
                    rec.imagePoisonWarned = true;
                    if (owner.id === app.slices.sessions.activeId) {
                        app.notice(t('⚠ 检测到历史带图消息（text-only 模型回放会失败）。用 /rewind 回退到该消息之前，或确认目录中已声明官方识图模型即可修复'));
                    }
                }
            }
            // Track the last assistant message id (message feedback target) and
            // fold plan/goal state for the statusline.
            if (event.type === 'assistant/message' && typeof event.data?.message?.id === 'string') {
                rec.lastAssistantMessageId = event.data.message.id;
            }
            else if (event.type === 'plan/mode') {
                rec.planActive = event.data?.active === true;
                if (owner.id === app.slices.sessions.activeId) {
                    app.slices.ui.updateStatusline();
                    app.notice(`计划模式已${rec.planActive ? '开启' : '关闭'}`);
                }
            }
            else if (event.type === 'goal/change') {
                // `data.goal` is the durable GoalSnapshot; `roundsStarted` rides as
                // a sibling of the snapshot, so fold it back in for the statusline.
                const goal = event.data?.goal ?? null;
                if (goal === null) {
                    rec.goal = null;
                }
                else {
                    const roundsStarted = event.data?.roundsStarted;
                    rec.goal = roundsStarted === undefined ? goal : { ...goal, roundsStarted };
                }
                if (owner.id === app.slices.sessions.activeId)
                    app.slices.ui.updateStatusline();
            }
            if (!echoed) {
                app.slices.ui.foldEvent(rec, event);
                rec.feed.applyEvent(event);
                app.slices.ui.maybePushFileDiff(rec.feed, event);
            }
            // Headless e2e: first completed turn of the initial session ends the test.
            if (app.headless && event.type === 'turn/end' && owner.id === app.slices.sessions.activeId) {
                rec.feed.commitTail();
                void rec.feed.flush().then(() => dumpAndQuit());
            }
        });
        // Host events: agent lifecycle status → statusline, subagent/workflow
        // cards → the owning session's feed.
        app.slices.runtime.hostDisposers.push(app.runtimeCtx.on('agent/status', (payload) => {
            if (app.slices.runtime.disposed)
                return;
            const { agent, status } = payload ?? {};
            const rec = app.slices.sessions.live.get(agent?.session?.id);
            if (!rec)
                return;
            if (status === 'running') {
                rec.status = '● running';
                rec.runningSince = Date.now();
            }
            else {
                rec.status = '○ idle';
                rec.runningSince = null;
            }
            if (rec.id === app.slices.sessions.activeId) {
                app.slices.ui.ensureSpinner();
                app.slices.ui.updateStatusline();
            }
        }));
        app.slices.runtime.hostDisposers.push(app.runtimeCtx.on('subagent/start', (info) => {
            if (app.slices.runtime.disposed)
                return;
            const parent = app.slices.ui.feedForSubagent(info);
            parent?.feed.subagentStart(info);
            const key = info?.id ?? info?.runId;
            if (parent && key) {
                const label = `${info?.provider ?? 'subagent'} ${FeedRenderer.truncate(String(info?.id ?? ''), 8)}`;
                app.slices.sessions.runningSubagents.set(String(key), {
                    parentId: parent.id,
                    label,
                    startedAt: Date.now(),
                });
                // Durable routing for the child's own session events (tool diffs,
                // late messages) — kept after subagent/end, pruned with the parent.
                app.slices.sessions.childParent.set(String(key), { parentId: parent.id, label });
                // Bounded memory: long-running hosts spawn unbounded children;
                // evict the oldest routing entry past the cap.
                if (app.slices.sessions.childParent.size > 400) {
                    const oldest = app.slices.sessions.childParent.keys().next();
                    if (oldest.done !== true)
                        app.slices.sessions.childParent.delete(oldest.value);
                }
                app.slices.ui.ensureSpinner();
                app.slices.ui.updateStatusline();
            }
        }));
        app.slices.runtime.hostDisposers.push(app.runtimeCtx.on('subagent/end', (info) => {
            if (app.slices.runtime.disposed)
                return;
            app.slices.ui.feedForSubagent(info)?.feed.subagentEnd(info);
            const key = info?.id ?? info?.runId;
            if (key && app.slices.sessions.runningSubagents.delete(String(key))) {
                app.slices.ui.ensureSpinner();
                app.slices.ui.updateStatusline();
            }
        }));
        app.slices.runtime.hostDisposers.push(app.runtimeCtx.on('workflow/start', (info) => {
            if (app.slices.runtime.disposed)
                return;
            const runId = info?.id ?? '?';
            const run = app.slices.trans.workflowRuns.get(runId) ?? { id: runId, name: info?.meta?.name ?? runId, startedAt: Date.now(), phases: [], agents: [], logs: [], running: true, stopReason: undefined };
            run.startedAt = Date.now();
            run.running = true;
            app.slices.trans.workflowRuns.set(runId, run);
            app.slices.ui.activeFeed()?.workflowStart(info);
        }));
        app.slices.runtime.hostDisposers.push(app.runtimeCtx.on('workflow/phase', (info, title) => {
            if (app.slices.runtime.disposed)
                return;
            const run = app.slices.trans.workflowRuns.get(info?.id);
            if (run) {
                run.phases.push({ title, startedAt: Date.now() });
            }
            app.slices.ui.activeFeed()?.workflowPhase(info, title);
        }));
        app.slices.runtime.hostDisposers.push(app.runtimeCtx.on('workflow/log', (info, message) => {
            if (app.slices.runtime.disposed)
                return;
            const run = app.slices.trans.workflowRuns.get(info?.id);
            if (run)
                run.logs.push(message);
        }));
        app.slices.runtime.hostDisposers.push(app.runtimeCtx.on('workflow/agent-start', (info, agent) => {
            if (app.slices.runtime.disposed)
                return;
            const run = app.slices.trans.workflowRuns.get(info?.id);
            if (run)
                run.agents.push({ seq: agent?.seq ?? 0, label: agent?.label ?? '', outcome: undefined });
        }));
        app.slices.runtime.hostDisposers.push(app.runtimeCtx.on('workflow/agent-end', (info, agent) => {
            if (app.slices.runtime.disposed)
                return;
            const run = app.slices.trans.workflowRuns.get(info?.id);
            if (run) {
                const entry = run.agents.find((e) => e.seq === agent?.seq);
                if (entry)
                    entry.outcome = agent?.outcome ?? 'settled';
            }
        }));
        app.slices.runtime.hostDisposers.push(app.runtimeCtx.on('workflow/end', (info, result) => {
            if (app.slices.runtime.disposed)
                return;
            const run = app.slices.trans.workflowRuns.get(info?.id);
            if (run) {
                run.running = false;
                run.stopReason = result?.stopReason;
            }
            app.slices.ui.activeFeed()?.workflowEnd(info, result);
        }));
        // Approval requests: show the floating window and decide.
        app.slices.runtime.hostDisposers.push(app.runtimeCtx.on('approval/request', (req, next) => {
            if (app.slices.runtime.disposed)
                return next();
            return new Promise((resolve) => {
                let settled = false;
                const cleanup = () => {
                    req.signal?.removeEventListener('abort', onAbort);
                };
                const onAbort = () => {
                    if (settled)
                        return;
                    settled = true;
                    cleanup();
                    app.slices.agent.approvalSettle = null;
                    app.slices.agent.approvalReq = null;
                    resolve('cancelled');
                };
                req.signal?.addEventListener('abort', onAbort, { once: true });
                app.slices.agent.approvalReq = req;
                app.slices.agent.approvalSettle = (outcome) => {
                    if (settled)
                        return;
                    settled = true;
                    cleanup();
                    app.slices.agent.approvalReq = null;
                    resolve(outcome);
                };
                const rec = app.slices.sessions.live.get(req.agent?.session?.id);
                rec?.feed.appendNotice(`⚠ 审批请求: ${req.toolName ?? '?'}${req.reason ? ` — ${req.reason}` : ''}`);
                // Approvals always ring — attention is required, bell toggle or not.
                void app.luaCall('require("dsh_tui").bell()', []).catch(() => { });
                void app.luaCall('require("dsh_tui").show_approval(...)', [{
                        toolName: req.toolName ?? '',
                        reason: req.reason ?? '',
                    }]).catch(() => {
                    if (!settled) {
                        settled = true;
                        cleanup();
                        app.slices.agent.approvalSettle = null;
                        app.slices.agent.approvalReq = null;
                        resolve('rejected');
                    }
                });
            });
        }));
        // User questions: claim the host's `user-questions/request` waterfall
        // as the interactive answerer (dsh 0.1.2-alpha.2: registerProvider was
        // removed in favor of the scoped cordis waterfall).
        app.slices.runtime.hostDisposers.push(app.runtimeCtx.on('user-questions/request', (request, next) => {
            if (app.slices.runtime.disposed)
                return next();
            return new Promise((resolve, reject) => {
                app.slices.agent.questionsResolve = { resolve, reject };
                request.signal?.addEventListener('abort', () => {
                    if (app.slices.agent.questionsResolve) {
                        const r = app.slices.agent.questionsResolve;
                        app.slices.agent.questionsResolve = null;
                        r.reject(new Error('cancelled by caller'));
                    }
                }, { once: true });
                void app.luaCall('require("dsh_tui").show_questions(...)', [request.questions ?? []])
                    .catch(() => {
                    if (app.slices.agent.questionsResolve) {
                        const r = app.slices.agent.questionsResolve;
                        app.slices.agent.questionsResolve = null;
                        r.reject(new Error('no UI'));
                    }
                });
            });
        }));
        // History list for resume: only THIS project's project-level sessions.
        // Subagent children are bare-UUID ids (no `session-` prefix) — excluded,
        // as are sessions created in other working directories.
        await app.slices.sessions.refreshHistory();
        // Boot: explicit resume id (env/config) wins; otherwise auto-resume the
        // LAST active session of this project (claude --continue behaviour),
        // falling back to the newest persisted one; a fresh session only when
        // there is no history (or resumeLatest is disabled).
        // Opening an OLD-version session can throw (legacy/incompatible log):
        // that must NOT take the whole process down — log the failure, open a
        // fresh session instead, and tell the user in the chat window that the
        // restore failed.
        const resumeId = app.config.resumeSessionId ?? process.env.DSH_NVIM_TUI_RESUME;
        const autoResume = app.config.resumeLatest !== false && process.env.DSH_NVIM_TUI_RESUME_LATEST !== '0';
        const resumeOrFresh = async (targetId) => {
            try {
                await app.slices.sessions.resumeSession(targetId);
                return true;
            }
            catch (err) {
                const message = err instanceof Error ? (err.message || String(err)) : String(err);
                try {
                    appendFileSync(app.errorLogPath, `${new Date().toISOString()} ${t('恢复会话失败')} ${targetId}: ${message}\n`);
                }
                catch { }
                // Fall back to a fresh session — the UI stays up; the failure is
                // shown in the new session's chat window instead of killing dsh.
                await app.slices.sessions.createSession();
                app.notice(`⚠ ${t('恢复会话失败')} ${targetId}${message ? ` — ${message}` : ''}（${t('已新建会话')}）`);
                return false;
            }
        };
        if (resumeId) {
            await resumeOrFresh(resumeId);
        }
        else if (autoResume && app.slices.sessions.historyHeaders.length > 0) {
            const state = app.slices.sessions.readState();
            const fromState = state?.sessionId && state.cwd === process.cwd() &&
                app.slices.sessions.historyHeaders.some((h) => h.id === state.sessionId)
                ? state.sessionId
                : null;
            const newest = [...app.slices.sessions.historyHeaders]
                .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]?.id;
            const target = fromState ?? newest;
            if (target) {
                if (await resumeOrFresh(target))
                    app.notice(t('已自动恢复上次会话（/new 新建）'));
            }
            else {
                await app.slices.sessions.createSession();
            }
        }
        else {
            await app.slices.sessions.createSession();
        }
        app.slices.sessions.refreshList();
        const watchdog = setTimeout(() => {
            if (app.headless)
                dumpAndQuit();
        }, app.watchdogMs);
        const dumpAndQuit = async () => {
            clearTimeout(watchdog);
            if (app.slices.runtime.disposed)
                return;
            if (app.headless) {
                try {
                    const feed = app.slices.ui.activeFeed();
                    const lines = await app.slices.runtime.nvim.request('nvim_buf_get_lines', [feed.bufId, 0, -1, false]);
                    const listLines = app.slices.sessions.sessionEntries.map((s) => `[ ${s.id === app.slices.sessions.activeId ? '▸' : ' '} ${s.title || '（无标题）'} · ${s.id} · ${s.kind}`);
                    writeFileSync(app.dumpPath, `# dsh-nvim-tui e2e dump (${new Date().toISOString()})\n` +
                        '## session list\n' +
                        listLines.join('\n') + '\n' +
                        '## active chat\n' +
                        lines.map((l) => `| ${l}`).join('\n') + '\n');
                }
                catch (err) {
                    writeFileSync(app.dumpPath, `# dump failed: ${err.message}\n`);
                }
            }
            await app.quit(0);
        };
        // Drain input that arrived before the first agent was ready.
        if (app.slices.agent.pendingInput.length > 0) {
            const queued = app.slices.agent.pendingInput.splice(0);
            for (const text of queued)
                app.slices.agent.send(text);
        }
        app.exitDiag('boot-complete', `active=${app.slices.sessions.activeId}`);
        // Extension surface: resolve readiness, notify Node subscribers, and
        // fire the nvim-side User DshTuiReady autocmd.
        app.slices.ext.extReadyResolve?.();
        app.slices.ext.extReadyResolve = null;
        app.slices.ext.extFire('tui:ready', { active: app.slices.sessions.activeId });
        void app.luaCall('require("dsh_tui.api").emit(...)', ['Ready', { active: app.slices.sessions.activeId }]).catch(() => { });
        // Headless e2e: kick one real agent turn with the configured prompt.
        const headlessPrompt = app.config.prompt ?? process.env.DSH_NVIM_TUI_PROMPT;
        if (app.headless && headlessPrompt)
            app.slices.agent.send(headlessPrompt);
    }
    catch (err) {
        // After teardown started, in-flight RPC writes can fail with EPIPE —
        // that is the shutdown race, not a product failure.
        if (app.slices.runtime.disposed)
            return;
        app.exitDiag('fatal', err instanceof Error ? (err.stack ?? err.message) : String(err));
        console.error('[dsh-nvim-tui] fatal:', err);
        void app.quit(1);
    }
}
