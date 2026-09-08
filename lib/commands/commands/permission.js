/** dsh_tui command: /permission — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js';
/** /permission [name] — switch the session's permission preset (the
 *  official dsh-permission-presets service: sandbox mode + approval
 *  policy pair; the profile's patch must mount the `permission` row). */
export const permissionCommand = async (app, a) => {
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec) {
        app.notice(t('无活跃会话'));
        return;
    }
    const permission = app.svc('permissionPresets');
    if (permission === undefined || typeof permission.set !== 'function') {
        app.notice(t('permission-presets 服务未装配（profile patch 加入 dsh-permission-presets 行）'));
        return;
    }
    try {
        const names = [...permission.names];
        if (!a) {
            const current = permission.current(rec.handle.agent.session);
            for (const name of names) {
                const opt = permission.optionOf(name);
                app.notice(`${name}${name === current ? ' ✓（当前）' : ''} · ${opt?.name ?? name}${opt?.description ? `) — ${opt.description}` : ''}`);
            }
            return;
        }
        const name = String(a).trim();
        if (!names.includes(name)) {
            app.notice(`未知权限预设 ${name}（可用: ${names.join(' ')})`);
            return;
        }
        const opt = permission.optionOf(name);
        const current = permission.current(rec.handle.agent.session);
        // Danger-full-access switch asks for an explicit confirmation first
        // (official client's modal acknowledgement counterpart).
        const danger = /full|danger/i.test(name) || /全|危险/.test(opt?.name ?? '');
        if (danger && name !== current) {
            const ok = await app.openPicker(t('危险权限确认'), [
                { label: '确认切换到全访问（危险操作需谨慎）', value: 'yes' },
                { label: '取消', value: 'no' },
            ]);
            if (ok !== 'yes') {
                app.notice(t('已取消权限切换'));
                return;
            }
        }
        permission.set(rec.handle.agent.session, name);
        app.notice(`权限预设: ${name}`);
        app.slices.ui.updateStatusline();
    }
    catch (err) {
        app.notice(`permission 失败: ${err.message}`);
    }
};
export function installPermissionCommand(app) {
    app.registerCommands([{ name: '/permission', desc: t('权限预设（沙箱+审批组合）'), usage: t('[name]'), group: t('审批'), fn: (a) => permissionCommand(app, a) }]);
}
