import { checkAll, installCommand, findProfilePatchPath, dshHome } from '../services.js';
export const depsCommand = async (app, s, a) => {
    const arg = (a ?? '').trim();
    if (arg === 'install') {
        await installCommand(app, s);
        return;
    }
    if (arg !== '') {
        app.notice('用法: /deps（体检报告）· /deps install（一键装配可修复项）');
        return;
    }
    const patchPath = findProfilePatchPath();
    const reports = await checkAll(app, s, patchPath);
    const lines = [
        `依赖体检 · ${reports.length} 项（profile patch: ${patchPath === null ? '未定位（仅报告模式）' : patchPath.replace(dshHome(), '~')}）`,
        '',
    ];
    const byGroup = new Map();
    for (const r of reports) {
        const g = byGroup.get(r.group) ?? [];
        g.push(r);
        byGroup.set(r.group, g);
    }
    let fixable = 0;
    for (const [group, items] of byGroup) {
        lines.push(`── ${group} ──`);
        for (const r of items) {
            const mark = r.status === 'ok' ? '✓' : r.status === 'missing' ? '✗' : '⚠';
            if (r.fixId !== undefined)
                fixable++;
            lines.push(`${mark} ${r.label} — ${r.detail}`);
        }
        lines.push('');
    }
    const missing = reports.filter((r) => r.status === 'missing').length;
    const warned = reports.filter((r) => r.status === 'warn').length;
    lines.push(`小结: ✓ ${reports.length - missing - warned} · ✗ ${missing} · ⚠ ${warned}`);
    if (fixable > 0) {
        lines.push(`可一键装配 ${fixable} 项: /deps install（写入 profile patch，loader 热重载）`);
    }
    await app.luaCall('require("dsh_tui").show_lines_float(...)', ['依赖体检', lines]).catch(() => { });
};
export function installDepsCommand(app, s) {
    app.registerCommands([{ name: '/deps', desc: '依赖体检（缺什么/一键装配）', usage: '[install]', group: '系统', fn: (a) => depsCommand(app, s, a) }]);
}
