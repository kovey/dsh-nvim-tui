/**
 * Narrow `sessionController` adapter for the TUI profile.
 *
 * `dsh-schedule` is written for the web/API composition: it injects the full
 * `sessionController` service and uses exactly one method, `resolveAgent(id)`,
 * when a reminder fires. The TUI profile has no web controller (and pulling in
 * `dsh-api-session-controller` would drag in the API gateway, client
 * connection and file-upload stack), so the row stays permanently
 * `pending (waiting for service: sessionController)`.
 *
 * This adapter supplies the one method the scheduler needs. It resolves a live
 * session directly, and otherwise resumes through the TUI's existing
 * background-resume path (which also installs model selection and the todo
 * guard) WITHOUT switching the visible chat. It is intentionally narrow:
 * other composition code that wants the real controller must not be mounted
 * alongside it in the same profile.
 *
 * @module dsh-nvim-tui/session-controller
 */
import { ensureLiveSession } from './services.js';
/** Install the adapter unless a real controller already owns the name. */
export const installSessionController = (app, ctx) => {
    if (ctx.get('sessionController') !== undefined)
        return;
    const controller = {
        async resolveAgent(sessionId) {
            const live = app.slices.sessions.live.get(sessionId);
            if (live !== undefined)
                return { agent: live.handle.agent };
            try {
                const sid = await ensureLiveSession(app, sessionId);
                const rec = sid === undefined ? undefined : app.slices.sessions.live.get(sid);
                if (rec === undefined)
                    return { error: new Error(`session ${sessionId} not found`) };
                return { agent: rec.handle.agent };
            }
            catch (err) {
                return { error: err instanceof Error ? err : new Error(String(err)) };
            }
        },
    };
    ctx.provide('sessionController', controller);
};
