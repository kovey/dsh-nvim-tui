/** dsh_tui command: /skills — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js';
/** /skills [name] — skill catalog; picker → detail float (show_skill). */
export const skillsCommand = async (app, a) => {
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec) {
        app.notice(t('无活跃会话'));
        return;
    }
    const skills = app.svc('skills');
    if (skills === undefined) {
        app.notice(t('skills 服务未装配'));
        return;
    }
    const arg = (a ?? '').trim();
    try {
        const showSkill = async (name) => {
            const def = await skills.get(name, { scope: rec.handle.agent });
            if (def === undefined) {
                app.notice(`未知技能 ${name}`);
                return;
            }
            await app.luaCall('require("dsh_tui").show_skill(...)', [{
                    name: def.name,
                    description: def.description ?? '',
                    whenToUse: def.whenToUse ?? '',
                    content: def.content ?? '',
                }]).catch(() => { });
        };
        if (arg !== '') {
            await showSkill(arg);
            return;
        }
        const list = await skills.list({ scope: rec.handle.agent });
        if (list.length === 0) {
            app.notice(t('（没有可用技能）'));
            return;
        }
        const sel = await app.openPicker(t('技能（选择查看详情）'), list.map((s) => ({ label: `${s.name} — ${String(s.description ?? '').slice(0, 44)}`, value: s.name })));
        if (sel === null)
            return;
        await showSkill(sel);
    }
    catch (err) {
        app.notice(`skills 失败: ${err.message}`);
    }
};
export function installSkillsCommand(app) {
    app.registerCommands([{ name: '/skills', desc: t('技能浏览'), usage: t('[技能名]'), group: t('会话'), fn: (a) => skillsCommand(app, a) }]);
}
