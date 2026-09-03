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
                app.exitDiag('nvim-exit', `code=${code}`, `signal=${signal}`, `disposed=${app.disposed}`);
                if (!app.disposed)
                    void app.quit(0);
            },
        });
        app.child = spawned.child;
        // nvim now owns the terminal; keep our own process silent so DSH
        // logging cannot corrupt the TUI.
        const silent = () => { };
        console.log = silent;
        console.warn = silent;
        console.error = silent;
        app.nvim = await connectNvim(spawned.sockPath);
        const channelId = await app.nvim.channelId;
        app.channelIdValue = channelId;
        await app.luaCall('require("dsh_tui").attach(...)', [channelId]);
        // Slash-command catalog for the completion menu (name + description);
        // nvim shows it as soon as the input starts with '/'.
        await app.luaCall('require("dsh_tui").set_commands(...)', [app.commandCatalog()]).catch(() => { });
        void app.refreshCommandCatalog();
        // Theme overrides from the runner config (profile cordis.patch.yml).
        if (app.config.theme !== undefined && app.config.theme !== null && typeof app.config.theme === 'object') {
            await app.luaCall('require("dsh_tui").apply_theme(...)', [app.config.theme]).catch(() => { });
        }
        app.nvim.on('disconnect', () => void app.quit(0));
        app.nvim.on('notification', async (method, args) => {
            if (app.disposed)
                return;
            if (method === 'dsh-input') {
                try {
                    app.onInput(String(args?.[0] ?? ''));
                }
                catch (err) {
                    app.notice(`⚠ 输入处理失败: ${err.message}`);
                }
            }
            else if (method === 'dsh-command') {
                try {
                    app.onCommand(String(args?.[0] ?? ''));
                }
                catch (err) {
                    app.notice(`⚠ 命令失败: ${err.message}`);
                }
            }
            else if (method === 'dsh-abort') {
                // <C-c> in the input box: same path as /stop.
                app.stopCommand();
            }
            else if (method === 'dsh-session-select')
                void app.guard('切换会话', app.selectSession)(String(args?.[0] ?? ''));
            else if (method === 'dsh-session-new')
                void app.guard('新建会话', app.createSession)();
            else if (method === 'dsh-reasoning-toggled') {
                app.reasoningOpen = args?.[0] === true;
                if (app.reasoningOpen) {
                    const ids = await app.luaCall('return require("dsh_tui").ids()', []).catch(() => null);
                    app.reasoningWinId = ids?.reasoningWin ?? null;
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
                    const sid = app.approvalReq?.agent?.session?.id;
                    if (sid !== undefined) {
                        const rec = app.sessions.get(sid);
                        if (rec) {
                            try {
                                rec.handle.agent.session.append('approval/policy', { policy: 'never' });
                                rec.policy = 'never';
                                app.updateStatusline();
                                rec.feed.appendNotice('已切换自动审批模式（never）：不再弹窗询问，需要审批的操作将自动拒绝（/yolo off 恢复逐项询问）');
                            }
                            catch { /* policy switch is best-effort */ }
                        }
                    }
                    app.approvalSettle?.('allowed-once');
                }
                else {
                    app.approvalSettle?.(raw === 'y' ? 'allowed-once' : 'rejected');
                }
                app.approvalSettle = null;
                app.approvalReq = null;
            }
            else if (method === 'dsh-questions-answered') {
                const answers = args?.[0] ?? [];
                app.questionsResolve?.resolve({ answers });
                app.questionsResolve = null;
            }
            else if (method === 'dsh-questions-cancelled') {
                const reject = app.questionsResolve;
                app.questionsResolve = null;
                reject?.reject(new Error('cancelled by user'));
            }
            else if (method === 'dsh-picker-selected') {
                app.pickerSettle?.(args?.[0]);
                app.pickerSettle = null;
            }
            else if (method === 'dsh-picker-cancelled') {
                app.pickerSettle?.(null);
                app.pickerSettle = null;
            }
            else if (method === 'dsh-subagent-view-closed') {
                app.subagentView = null;
            }
            else if (method === 'dsh-subagent-chat-closed') {
                app.subagentChat = null;
            }
            else if (method === 'dsh-subagent-send') {
                try {
                    app.sendToSubagent(String(args?.[0] ?? ''));
                }
                catch (err) {
                    app.notice(`⚠ 子代理发送失败: ${err.message}`);
                }
            }
            else if (method === 'dsh-dir-selected') {
                const picked = args?.[0];
                app.dirSettle?.(picked ?? null);
                app.dirSettle = null;
            }
            else if (method === 'dsh-at-query') {
                const query = args?.[0]?.query ?? '';
                void app.guard('文件引用补全', app.atQuery)(String(query));
            }
            else if (method === 'dsh-quit')
                void app.quit(0);
            else if (method === 'dsh-paste-image')
                app.pasteClipboardImage();
        });
        // Session elapsed / stats tick slowly while idle (the spinner interval
        // already covers the running state at 180ms).
        app.idleRefreshTimer = setInterval(() => {
            if (!app.disposed)
                app.updateStatusline();
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
        app.feedDisposer = app.runtimeCtx.on('session/event', (owner, event) => {
            if (app.disposed)
                return;
            // Open subagent CHAT window: route the child's live events into its
            // feed (reasoning/text/tools keep streaming in place). The harness's
            // replay of our own optimistic user echo is skipped (FIFO dedupe).
            if (app.subagentChat !== null && owner.id === app.subagentChat.childId) {
                if (event.type === 'tool/call' && typeof event.data?.name === 'string') {
                    const p = producedPathFromCall(event.data.name, event.data.arguments);
                    if (p !== null && typeof event.data.callId === 'string' && event.data.callId !== '') {
                        const cid = event.data.callId;
                        void app.readFileSnapshot(p).then((before) => {
                            app.pendingFileSnaps.set(cid, { display: p, before });
                        });
                    }
                }
                if (event.type === 'user/message') {
                    const q = app.pendingEchoes.get(owner.id);
                    if (q !== undefined && q.length > 0) {
                        const data = event.data;
                        const msg = data?.message ??
                            data;
                        if (FeedRenderer.messageText(msg) === q[0]) {
                            q.shift();
                            app.pendingEchoes.set(owner.id, q);
                            return; // already rendered optimistically — no double bubble
                        }
                    }
                }
                app.subagentChat.feed.applyEvent(event);
                app.maybePushFileDiff(app.subagentChat.feed, event);
                return;
            }
            // Open subagent transcript view: route the child's live events into
            // its read-only feed (reasoning/text/tools keep streaming in place).
            if (app.subagentView !== null && owner.id === app.subagentView.childId) {
                if (event.type === 'tool/call' && typeof event.data?.name === 'string') {
                    const p = producedPathFromCall(event.data.name, event.data.arguments);
                    if (p !== null && typeof event.data.callId === 'string' && event.data.callId !== '') {
                        const cid = event.data.callId;
                        void app.readFileSnapshot(p).then((before) => {
                            app.pendingFileSnaps.set(cid, { display: p, before });
                        });
                    }
                }
                app.subagentView.feed.applyEvent(event);
                app.maybePushFileDiff(app.subagentView.feed, event);
                return;
            }
            // Child→parent modification sync (alpha.4): the child's file-change
            // diffs render LIVE into the parent's chat as subagent-labeled ✎
            // cards — the parent shares the workspace, so the child's edits are
            // the parent's edits (the harness forwards no child transcript, but
            // this runner sees every child session event).
            const childLink = app.childParent.get(owner.id);
            if (childLink !== undefined) {
                if (event.type === 'tool/call' && typeof event.data?.name === 'string') {
                    const p = producedPathFromCall(event.data.name, event.data.arguments);
                    if (p !== null && typeof event.data.callId === 'string' && event.data.callId !== '') {
                        const cid = event.data.callId;
                        void app.readFileSnapshot(p).then((before) => {
                            app.pendingFileSnaps.set(cid, { display: p, before });
                        });
                    }
                }
                if (event.type === 'tool/result') {
                    const prec = app.sessions.get(childLink.parentId);
                    if (prec !== undefined) {
                        app.maybePushFileDiff(prec.feed, event, `${t('子代理')} ${childLink.label} `);
                    }
                }
                return;
            }
            const rec = app.sessions.get(owner.id);
            if (!rec)
                return;
            // Skip the host's user/message when this exact text was already
            // rendered optimistically at submit time (no double bubble).
            let echoed = false;
            if (event.type === 'user/message') {
                const q = app.pendingEchoes.get(owner.id);
                if (q !== undefined && q.length > 0) {
                    const data = event.data;
                    const msg = data?.message ??
                        data;
                    if (FeedRenderer.messageText(msg) === q[0]) {
                        q.shift();
                        app.pendingEchoes.set(owner.id, q);
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
                        void app.readFileSnapshot(p).then((before) => {
                            app.pendingFileSnaps.set(cid, { display: p, before });
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
                app.pendingFileSnaps.clear();
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
                        if (app.disposed || !app.sessions.has(rec.id))
                            return;
                        let healed = 0;
                        for (const [callId, call] of orphaned) {
                            try {
                                app.synthesizeToolResult(rec, callId, call.seq >= 0 ? call.seq : undefined, call.turn, call.step);
                                healed++;
                            }
                            catch { }
                        }
                        if (healed > 0 && owner.id === app.activeId) {
                            app.notice(prepareCrash
                                ? t(`⚠ 工具调度器崩溃（profile 里存在第二份 @deepseek-ai/dsh-tools 拷贝）——已补写 ${healed} 个悬空工具结果，本会话可继续使用；根治：在 profile 目录执行 pnpm why @deepseek-ai/dsh-tools 后 pnpm dedupe（或将 dsh-nvim-tui 升级到 0.2.8+）`)
                                : t(`⚠ 回合结束时仍有 ${healed} 个工具调用未产生结果——已补写错误结果，会话历史已修复`));
                        }
                    }, 0);
                }
                if (owner.id === app.activeId && app.bellOn) {
                    void app.luaCall('require("dsh_tui").bell()', []).catch(() => { });
                }
            }
            if (event.type === 'session/title' && typeof event.data?.title === 'string') {
                rec.title = event.data.title;
                app.refreshList();
                if (owner.id === app.activeId) {
                    app.updateStatusline();
                    app.updateTitle();
                }
                return;
            }
            // A user message that still carries an image block means it bypassed
            // the vision bridge (or predates it) — it permanently poisons the
            // session history: every later turn re-sends it and the text-only
            // adapter rejects the whole request. Warn once and point at /rewind.
            if (event.type === 'user/message' &&
                Array.isArray(event.data?.message?.content) &&
                event.data.message.content.some((b) => b?.type === 'image')) {
                if (!rec.imagePoisonWarned) {
                    rec.imagePoisonWarned = true;
                    if (owner.id === app.activeId) {
                        app.notice(t('⚠ 检测到未走识图桥的带图消息（历史污染：后续每轮都会失败）。用 /rewind 回退到该消息之前即可修复'));
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
                if (owner.id === app.activeId) {
                    app.updateStatusline();
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
                if (owner.id === app.activeId)
                    app.updateStatusline();
            }
            if (!echoed) {
                app.foldEvent(rec, event);
                rec.feed.applyEvent(event);
                app.maybePushFileDiff(rec.feed, event);
            }
            // Headless e2e: first completed turn of the initial session ends the test.
            if (app.headless && event.type === 'turn/end' && owner.id === app.activeId) {
                rec.feed.commitTail();
                void rec.feed.flush().then(() => dumpAndQuit());
            }
        });
        // Host events: agent lifecycle status → statusline, subagent/workflow
        // cards → the owning session's feed.
        app.hostDisposers.push(app.runtimeCtx.on('agent/status', (payload) => {
            if (app.disposed)
                return;
            const { agent, status } = payload ?? {};
            const rec = app.sessions.get(agent?.session?.id);
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
            if (rec.id === app.activeId) {
                app.ensureSpinner();
                app.updateStatusline();
            }
        }));
        app.hostDisposers.push(app.runtimeCtx.on('subagent/start', (info) => {
            if (app.disposed)
                return;
            const parent = app.feedForSubagent(info);
            parent?.feed.subagentStart(info);
            const key = info?.id ?? info?.runId;
            if (parent && key) {
                const label = `${info?.provider ?? 'subagent'} ${FeedRenderer.truncate(String(info?.id ?? ''), 8)}`;
                app.runningSubagents.set(String(key), {
                    parentId: parent.id,
                    label,
                    startedAt: Date.now(),
                });
                // Durable routing for the child's own session events (tool diffs,
                // late messages) — kept after subagent/end, pruned with the parent.
                app.childParent.set(String(key), { parentId: parent.id, label });
                // Bounded memory: long-running hosts spawn unbounded children;
                // evict the oldest routing entry past the cap.
                if (app.childParent.size > 400) {
                    const oldest = app.childParent.keys().next();
                    if (oldest.done !== true)
                        app.childParent.delete(oldest.value);
                }
                app.ensureSpinner();
                app.updateStatusline();
            }
        }));
        app.hostDisposers.push(app.runtimeCtx.on('subagent/end', (info) => {
            if (app.disposed)
                return;
            app.feedForSubagent(info)?.feed.subagentEnd(info);
            const key = info?.id ?? info?.runId;
            if (key && app.runningSubagents.delete(String(key))) {
                app.ensureSpinner();
                app.updateStatusline();
            }
        }));
        app.hostDisposers.push(app.runtimeCtx.on('workflow/start', (info) => {
            if (app.disposed)
                return;
            const runId = info?.id ?? '?';
            const run = app.workflowRuns.get(runId) ?? { id: runId, name: info?.meta?.name ?? runId, startedAt: Date.now(), phases: [], agents: [], logs: [], running: true, stopReason: undefined };
            run.startedAt = Date.now();
            run.running = true;
            app.workflowRuns.set(runId, run);
            app.activeFeed()?.workflowStart(info);
        }));
        app.hostDisposers.push(app.runtimeCtx.on('workflow/phase', (info, title) => {
            if (app.disposed)
                return;
            const run = app.workflowRuns.get(info?.id);
            if (run) {
                run.phases.push({ title, startedAt: Date.now() });
            }
            app.activeFeed()?.workflowPhase(info, title);
        }));
        app.hostDisposers.push(app.runtimeCtx.on('workflow/log', (info, message) => {
            if (app.disposed)
                return;
            const run = app.workflowRuns.get(info?.id);
            if (run)
                run.logs.push(message);
        }));
        app.hostDisposers.push(app.runtimeCtx.on('workflow/agent-start', (info, agent) => {
            if (app.disposed)
                return;
            const run = app.workflowRuns.get(info?.id);
            if (run)
                run.agents.push({ seq: agent?.seq ?? 0, label: agent?.label ?? '', outcome: undefined });
        }));
        app.hostDisposers.push(app.runtimeCtx.on('workflow/agent-end', (info, agent) => {
            if (app.disposed)
                return;
            const run = app.workflowRuns.get(info?.id);
            if (run) {
                const entry = run.agents.find((e) => e.seq === agent?.seq);
                if (entry)
                    entry.outcome = agent?.outcome ?? 'settled';
            }
        }));
        app.hostDisposers.push(app.runtimeCtx.on('workflow/end', (info, result) => {
            if (app.disposed)
                return;
            const run = app.workflowRuns.get(info?.id);
            if (run) {
                run.running = false;
                run.stopReason = result?.stopReason;
            }
            app.activeFeed()?.workflowEnd(info, result);
        }));
        // Approval requests: show the floating window and decide.
        app.hostDisposers.push(app.runtimeCtx.on('approval/request', (req, next) => {
            if (app.disposed)
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
                    app.approvalSettle = null;
                    app.approvalReq = null;
                    resolve('cancelled');
                };
                req.signal?.addEventListener('abort', onAbort, { once: true });
                app.approvalReq = req;
                app.approvalSettle = (outcome) => {
                    if (settled)
                        return;
                    settled = true;
                    cleanup();
                    app.approvalReq = null;
                    resolve(outcome);
                };
                const rec = app.sessions.get(req.agent?.session?.id);
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
                        app.approvalSettle = null;
                        app.approvalReq = null;
                        resolve('rejected');
                    }
                });
            });
        }));
        // User questions: claim the host's `user-questions/request` waterfall
        // as the interactive answerer (dsh 0.1.2-alpha.2: registerProvider was
        // removed in favor of the scoped cordis waterfall).
        app.hostDisposers.push(app.runtimeCtx.on('user-questions/request', (request, next) => {
            if (app.disposed)
                return next();
            return new Promise((resolve, reject) => {
                app.questionsResolve = { resolve, reject };
                request.signal?.addEventListener('abort', () => {
                    if (app.questionsResolve) {
                        const r = app.questionsResolve;
                        app.questionsResolve = null;
                        r.reject(new Error('cancelled by caller'));
                    }
                }, { once: true });
                void app.luaCall('require("dsh_tui").show_questions(...)', [request.questions ?? []])
                    .catch(() => {
                    if (app.questionsResolve) {
                        const r = app.questionsResolve;
                        app.questionsResolve = null;
                        r.reject(new Error('no UI'));
                    }
                });
            });
        }));
        // History list for resume: only THIS project's project-level sessions.
        // Subagent children are bare-UUID ids (no `session-` prefix) — excluded,
        // as are sessions created in other working directories.
        await app.refreshHistory();
        // Boot: explicit resume id (env/config) wins; otherwise auto-resume the
        // LAST active session of this project (claude --continue behaviour),
        // falling back to the newest persisted one; a fresh session only when
        // there is no history (or resumeLatest is disabled).
        const resumeId = app.config.resumeSessionId ?? process.env.DSH_NVIM_TUI_RESUME;
        const autoResume = app.config.resumeLatest !== false && process.env.DSH_NVIM_TUI_RESUME_LATEST !== '0';
        try {
            if (resumeId) {
                await app.resumeSession(resumeId);
            }
            else if (autoResume && app.historyHeaders.length > 0) {
                const state = app.readState();
                const fromState = state?.sessionId && state.cwd === process.cwd() &&
                    app.historyHeaders.some((h) => h.id === state.sessionId)
                    ? state.sessionId
                    : null;
                const newest = [...app.historyHeaders]
                    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]?.id;
                const target = fromState ?? newest;
                if (target) {
                    await app.resumeSession(target);
                    app.notice(t('已自动恢复上次会话（/new 新建）'));
                }
                else {
                    await app.createSession();
                }
            }
            else {
                await app.createSession();
            }
        }
        catch (err) {
            // A broken history session must never take the whole TUI down:
            // log it, fall back to a fresh session.
            const e = err;
            try {
                appendFileSync(app.errorLogPath, `${new Date().toISOString()} 自动恢复: ${e?.stack ?? String(err)}\n`);
            }
            catch { }
            app.notice(`⚠ 历史会话恢复失败（${e?.message ?? String(err)}），已新建会话`);
            await app.createSession();
        }
        app.refreshList();
        const watchdog = setTimeout(() => {
            if (app.headless)
                dumpAndQuit();
        }, app.watchdogMs);
        const dumpAndQuit = async () => {
            clearTimeout(watchdog);
            if (app.disposed)
                return;
            if (app.headless) {
                try {
                    const feed = app.activeFeed();
                    const lines = await app.nvim.request('nvim_buf_get_lines', [feed.bufId, 0, -1, false]);
                    const listLines = app.sessionEntries.map((s) => `[ ${s.id === app.activeId ? '▸' : ' '} ${s.title || '（无标题）'} · ${s.id} · ${s.kind}`);
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
        if (app.pendingInput.length > 0) {
            const queued = app.pendingInput.splice(0);
            for (const text of queued)
                app.send(text);
        }
        app.exitDiag('boot-complete', `active=${app.activeId}`);
        // Headless e2e: kick one real agent turn with the configured prompt.
        const headlessPrompt = app.config.prompt ?? process.env.DSH_NVIM_TUI_PROMPT;
        if (app.headless && headlessPrompt)
            app.send(headlessPrompt);
    }
    catch (err) {
        // After teardown started, in-flight RPC writes can fail with EPIPE —
        // that is the shutdown race, not a product failure.
        if (app.disposed)
            return;
        app.exitDiag('fatal', err instanceof Error ? (err.stack ?? err.message) : String(err));
        console.error('[dsh-nvim-tui] fatal:', err);
        void app.quit(1);
    }
}
