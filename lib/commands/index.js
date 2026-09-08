const W = (d) => d;
import { followup, send, pasteClipboardImage, stopCommand, openDirPicker, atQuery, applyModelSelection, onInput, onCommand, queueSubagentPrompt, registerTool, registerNotifications, registerHostEventHandlers, } from './core.js';
import { helpCommand } from './commands/help.js';
import { restartCommand } from './commands/restart.js';
import { pickModel } from './commands/model.js';
import { installExitCommand } from './commands/exit.js';
import { installQuitCommand } from './commands/quit.js';
import { installRestartCommand } from './commands/restart.js';
import { installHelpCommand } from './commands/help.js';
import { installPanelCommand } from './commands/panel.js';
import { installStopCommand } from './commands/stop.js';
import { installSteerCommand } from './commands/steer.js';
import { installModelCommand } from './commands/model.js';
import { installEffortCommand } from './commands/effort.js';
import { installPresetCommand } from './commands/preset.js';
import { installYoloCommand } from './commands/yolo.js';
import { installThemeCommand } from './commands/theme.js';
import { installConfigCommand } from './commands/config.js';
import { installStatusCommand } from './commands/status.js';
import { installContextCommand } from './commands/context.js';
import { installModelsCommand } from './commands/models.js';
import { installDoctorCommand } from './commands/doctor.js';
import { installRememberCommand } from './commands/remember.js';
import { installMemoryCommand } from './commands/memory.js';
import { installImageCommand } from './commands/image.js';
import { installCompactCommand } from './commands/compact.js';
import { installGoalCommand } from './commands/goal.js';
import { installTodoCommand } from './commands/todo.js';
import { installPlanCommand } from './commands/plan.js';
import { installSearchCommand } from './commands/search.js';
import { installTasksCommand } from './commands/tasks.js';
import { installSkillsCommand } from './commands/skills.js';
import { installMcpCommand } from './commands/mcp.js';
import { installPluginsCommand } from './commands/plugins.js';
import { installLocaleCommand } from './commands/locale.js';
import { installFbCommand } from './commands/fb.js';
import { installWorkflowCommand } from './commands/workflow.js';
import { installPermissionCommand } from './commands/permission.js';
import { installAttachCommand } from './commands/attach.js';
import { installDirCommand } from './commands/dir.js';
import { installLinesCommand } from './commands/lines.js';
import { installHistoryCommand } from './commands/history.js';
import { installDeliverablesCommand } from './commands/deliverables.js';
import { installSettingsCommand } from './commands/settings.js';
import { installBellCommand } from './commands/bell.js';
/** Fill the commands module's App slots and register its commands. */
export { drainPendingInput } from './core.js';
/** Fill the commands module's App slots and register its commands. */
export function installCommands(app) {
    // -- agent domain ops (cross-domain consumers mutate agent state ONLY
    //    through these; owner keeps the writable view) --
    const A = W(app.slices.agent);
    A.setApproval = (entry, settle) => { A.approvalReq = entry; A.approvalSettle = settle; };
    // ---- queue-aware approval/questions (parent + subagents can ask
    //   CONCURRENTLY — a second request must queue, never overwrite the
    //   first settle) ----
    const showApprovalFloat = (req) => {
        if (app.slices.runtime.disposed)
            return;
        void app.luaCall('require("dsh_tui").show_approval(...)', [{
                toolName: req.toolName ?? '',
                reason: req.reason ?? '',
            }]).catch(() => {
            // Float failed to open for THIS head: settle it rejected and move on.
            if (A.approvalReq === req)
                A.settleApproval('rejected');
        });
    };
    const advanceApproval = () => {
        while (A.approvalQueue.length > 0) {
            const next = A.approvalQueue.shift();
            if (next.cancelled === true)
                continue;
            A.approvalReq = next.req;
            A.approvalSettle = next.settle;
            showApprovalFloat(next.req);
            return;
        }
    };
    A.settleApproval = (outcome) => {
        const fn = A.approvalSettle;
        A.approvalSettle = null;
        A.approvalReq = null;
        fn?.(outcome);
        advanceApproval();
    };
    A.enqueueApproval = (e) => {
        if (A.approvalReq === null && A.approvalQueue.length === 0) {
            A.approvalReq = e.req;
            A.approvalSettle = e.settle;
            showApprovalFloat(e.req);
        }
        else {
            A.approvalQueue.push(e);
        }
    };
    A.abortApproval = (e) => {
        e.cancelled = true;
        e.settle('cancelled');
        if (A.approvalReq === e.req) {
            A.approvalReq = null;
            A.approvalSettle = null;
            advanceApproval();
        }
    };
    A.drainApprovals = (outcome) => {
        A.approvalSettle?.(outcome);
        A.approvalSettle = null;
        A.approvalReq = null;
        for (const e of A.approvalQueue)
            e.settle(outcome);
        A.approvalQueue.length = 0;
    };
    A.setPickerSettle = (fn) => { A.pickerSettle = fn; };
    A.settlePicker = (value) => { const fn = A.pickerSettle; A.pickerSettle = null; fn?.(value); };
    A.setQuestions = (r) => { A.questionsResolve = r; };
    const showQuestionsFloat = (e) => {
        if (app.slices.runtime.disposed)
            return;
        void app.luaCall('require("dsh_tui").show_questions(...)', [e.questions]).catch(() => {
            if (A.questionsResolve?.resolve === e.resolve) {
                A.questionsResolve = null;
                e.reject(new Error('no UI'));
                advanceQuestions();
            }
        });
    };
    const advanceQuestions = () => {
        while (A.questionsQueue.length > 0) {
            const next = A.questionsQueue.shift();
            if (next.cancelled === true)
                continue;
            A.questionsResolve = { resolve: next.resolve, reject: next.reject };
            showQuestionsFloat(next);
            return;
        }
    };
    A.settleQuestions = (answers) => {
        const r = A.questionsResolve;
        A.questionsResolve = null;
        r?.resolve({ answers });
        advanceQuestions();
    };
    A.rejectQuestions = () => {
        const r = A.questionsResolve;
        A.questionsResolve = null;
        r?.reject(new Error('UI torn down'));
        advanceQuestions();
    };
    A.enqueueQuestions = (e) => {
        if (A.questionsResolve === null && A.questionsQueue.length === 0) {
            A.questionsResolve = { resolve: e.resolve, reject: e.reject };
            showQuestionsFloat(e);
        }
        else {
            A.questionsQueue.push(e);
        }
    };
    A.abortQuestions = (e) => {
        e.cancelled = true;
        e.reject(new Error('cancelled by caller'));
        if (A.questionsResolve?.resolve === e.resolve) {
            A.questionsResolve = null;
            advanceQuestions();
        }
    };
    A.drainQuestions = () => {
        A.questionsResolve?.reject(new Error('UI torn down'));
        A.questionsResolve = null;
        for (const e of A.questionsQueue)
            e.reject(new Error('UI torn down'));
        A.questionsQueue.length = 0;
    };
    A.setDirSettle = (fn) => { A.dirSettle = fn; };
    A.resolveDirPicker = (picked) => { const fn = A.dirSettle; A.dirSettle = null; fn?.(picked); };
    A.setPendingRename = (v) => { A.pendingRename = v; };
    A.setLivePopup = (v) => { A.livePopup = v; };
    A.setPendingQueueEdit = (v) => { A.pendingQueueEdit = v; };
    A.clearPendings = () => {
        A.pendingRename = null;
        A.pendingQueueEdit = null;
        A.pendingImages = [];
        A.pendingSubagentFollowup = null;
    };
    Object.assign(app.slices.agent, {
        approvalQueue: [],
        questionsQueue: [],
        followup: async () => { },
        queueSubagentPrompt: async () => { },
        send: () => { },
        pasteClipboardImage: () => { },
        applyModelSelection: async () => { },
        pickModel: async () => { },
        stopCommand: () => { },
        onInput: () => { },
        onCommand: () => { },
        helpCommand: async () => { },
        restartCommand: () => { },
        openDirPicker: async () => null,
        atQuery: async () => { },
        currentSelection: () => app.runtimeCtx.agentDefaultModel.currentSelection(),
        pendingInput: [],
        pendingImages: [],
        pendingRename: null,
        pendingQueueEdit: null,
        approvalSettle: null,
        approvalReq: null,
        questionsResolve: null,
        pickerSettle: null,
        dirSettle: null,
        bellOn: true,
    });
    // -- core services this module owns (moved out of createApp, I1) --
    // -- core services this module owns (moved out of createApp, I1) --
    app.slices.agent.followup = (rec, text, images) => followup(app, rec, text, images);
    app.slices.agent.queueSubagentPrompt = (parentAgent, childId, text) => queueSubagentPrompt(app, parentAgent, childId, text);
    app.slices.agent.send = (text) => send(app, text);
    app.slices.agent.pasteClipboardImage = () => pasteClipboardImage(app);
    app.slices.agent.stopCommand = () => stopCommand(app);
    app.slices.agent.openDirPicker = (startPath) => openDirPicker(app, startPath);
    app.slices.agent.atQuery = (query) => atQuery(app, query);
    app.slices.agent.applyModelSelection = (next) => applyModelSelection(app, next);
    app.slices.agent.pickModel = (arg) => pickModel(app, arg);
    app.slices.agent.onInput = (text) => onInput(app, text);
    app.slices.agent.onCommand = (line) => onCommand(app, line);
    app.slices.agent.helpCommand = () => helpCommand(app);
    app.slices.agent.restartCommand = () => restartCommand(app);
    // -- the 40 slash commands, one file each (self-registering) --
    installExitCommand(app);
    installQuitCommand(app);
    installRestartCommand(app);
    installHelpCommand(app);
    installPanelCommand(app);
    installStopCommand(app);
    installSteerCommand(app);
    installModelCommand(app);
    installEffortCommand(app);
    installPresetCommand(app);
    installYoloCommand(app);
    installThemeCommand(app);
    installConfigCommand(app);
    installStatusCommand(app);
    installContextCommand(app);
    installModelsCommand(app);
    installDoctorCommand(app);
    installRememberCommand(app);
    installMemoryCommand(app);
    installImageCommand(app);
    installCompactCommand(app);
    installGoalCommand(app);
    installTodoCommand(app);
    installPlanCommand(app);
    installSearchCommand(app);
    installTasksCommand(app);
    installSkillsCommand(app);
    installMcpCommand(app);
    installPluginsCommand(app);
    installLocaleCommand(app);
    installFbCommand(app);
    installWorkflowCommand(app);
    installPermissionCommand(app);
    installAttachCommand(app);
    installDirCommand(app);
    installLinesCommand(app);
    installHistoryCommand(app);
    installDeliverablesCommand(app);
    installSettingsCommand(app);
    installBellCommand(app);
    registerTool(app);
    registerNotifications();
    registerHostEventHandlers();
}
