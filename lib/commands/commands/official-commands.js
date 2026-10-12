/** dsh_tui command: /commands — one command per file (self-registering,
 *  wired by the commands module index). */
import { t, tf } from '../../kernel/i18n.js';
/**
 * Normalise the registry listing into display rows.
 *
 * Pure, and the collision rule lives here so it is asserted directly: `shadowed`
 * is computed against the TUI's OWN names, not the other way round.
 */
export const officialRows = (listed, ownNames) => [...listed]
    .map((d) => {
    const bare = d.name.replace(/^\//, '');
    const hint = d.input?.hint;
    return {
        name: bare,
        description: d.description,
        ...(hint === undefined || hint === '' ? {} : { hint }),
        shadowed: ownNames.has('/' + bare),
    };
})
    .sort((a, b) => a.name.localeCompare(b.name));
/** Run one official command and render its result into the chat feed. */
const runOfficial = async (app, agent, line) => {
    const cmds = app.svc('commands');
    if (cmds === undefined) {
        app.notice(t('官方命令注册表未装配（dsh-commands 服务不存在）'));
        return;
    }
    // `execute` returns undefined on an ADMISSION MISS (unknown name / bad syntax)
    // — that is not a failure, it means the registry declined the line.
    const exec = await cmds.execute(agent, line, [], new AbortController().signal);
    if (exec === undefined) {
        app.notice(tf('命令未被执行（注册表拒绝该输入）: /{0}', [line]));
        return;
    }
    const { kind, text } = exec.result;
    if (kind === 'error') {
        app.notice(tf('命令失败: {0}', [text]));
        return;
    }
    app.notice(text !== undefined && text !== '' ? text : tf('/{0} 已执行', [line]));
};
/** `/commands [名称]` — list the official registry, or run one of its commands. */
export const officialCommandsCommand = async (app, a) => {
    const rec = app.slices.sessions.activeId === null
        ? undefined
        : app.slices.sessions.live.get(app.slices.sessions.activeId);
    if (!rec) {
        app.notice(t('无活跃会话'));
        return;
    }
    const cmds = app.svc('commands');
    if (cmds === undefined || typeof cmds.list !== 'function') {
        app.notice(t('官方命令注册表未装配（dsh-commands 服务不存在 —— 检查 dsh-base 是否在 bundles 里）'));
        return;
    }
    const wanted = (a ?? '').trim().replace(/^\//, '');
    if (wanted !== '') {
        // An explicit name runs directly. The NAME MUST NOT start with a slash here:
        // the registry parses the line itself.
        await runOfficial(app, rec.handle.agent, wanted);
        return;
    }
    const own = new Set(app.commandSpecs.map((s) => s.name));
    let listed;
    try {
        listed = cmds.list(rec.handle.agent);
    }
    catch (err) {
        app.notice(tf('读取官方命令失败: {0}', [err.message]));
        return;
    }
    const rows = officialRows(listed, own);
    if (rows.length === 0) {
        app.notice(t('官方注册表里没有命令（没有插件注册过）'));
        return;
    }
    const shadowed = rows.filter((r) => r.shadowed).length;
    const lines = [
        tf('{0} 条官方命令{1}', [
            String(rows.length),
            shadowed > 0 ? tf('（{0} 条与 TUI 同名，TUI 优先）', [String(shadowed)]) : '',
        ]),
        '',
        ...rows.map((r) => `${r.shadowed ? '·' : '＋'} /${r.name}${r.hint ? ' ' + r.hint : ''} — ${r.description}`),
    ];
    const sel = await app.openPicker(t('官方命令注册表（Enter 执行所选项）'), [
        { label: t('↩ 关闭'), value: 'act:close' },
        ...rows.map((r) => ({
            label: `${r.shadowed ? '·' : '＋'} /${r.name} — ${r.description}`,
            value: `run:${r.name}`,
        })),
    ]);
    if (sel === null || sel === 'act:close') {
        await app.luaCall('require("dsh_tui").show_lines_float(...)', [t('官方命令'), lines]).catch(() => { });
        return;
    }
    if (sel.startsWith('run:'))
        await runOfficial(app, rec.handle.agent, sel.slice(4));
};
export function installOfficialCommandsCommand(app) {
    app.registerCommands([
        {
            name: '/commands',
            desc: t('官方命令注册表（插件注册的命令）'),
            usage: t('[名称]'),
            group: t('信息'),
            args: [{ kind: 'free', label: '[名称]', hint: t('不填则列出官方注册表') }],
            fn: (a) => officialCommandsCommand(app, a),
        },
    ]);
}
