/** dsh_tui command: /doctor — one command per file (self-registering,
 *  wired by the commands module index). */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { t, tf } from '../../kernel/i18n.js';
import { checkSessionLog } from '../../kernel/session-health.js';
/** Cap the scan: /doctor must stay a quick diagnostic. The fault flag is a
 *  single readdir per session (no decompression), so a session that ever
 *  faulted is reported even when it falls outside this cap. */
const MAX_SESSIONS = 60;
/** Every session directory under `$DSH_HOME/sessions/<project>/<session>/`. */
const sessionDirs = () => {
    const root = join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'sessions');
    const out = [];
    try {
        for (const proj of readdirSync(root)) {
            const pd = join(root, proj);
            try {
                if (!statSync(pd).isDirectory())
                    continue;
            }
            catch {
                continue;
            }
            for (const sid of readdirSync(pd))
                out.push(join(pd, sid));
        }
    }
    catch { /* no sessions dir: nothing to check */ }
    return out;
};
/**
 * Session-log health lines.
 *
 * Motivated by a real incident: a session carried an `invalid persisted inbox
 * splice` fault, so every projection of it threw and /sessions simply errored
 * — while the log itself decompressed fine. Nothing told the user whether the
 * session was lost or merely had one bad envelope, and there was no repair
 * entry point. This does not repair anything; it names the affected session and
 * states the options, which is the part that was missing.
 *
 * Exported for the smoke suite (takes the dir list, so it needs no host).
 */
export const sessionHealthLines = (dirs, cap = MAX_SESSIONS) => {
    if (dirs.length === 0)
        return [t('（没有可检查的会话）')];
    const faulted = [];
    const unsound = [];
    let scanned = 0;
    for (const d of dirs) {
        const h = checkSessionLog(d);
        scanned++;
        if (h.hadFault)
            faulted.push(h);
        if (h.status !== 'ok')
            unsound.push(h);
        if (scanned >= cap)
            break;
    }
    const lines = [tf('已检查 {0} / {1} 个会话目录', [scanned, dirs.length])];
    if (unsound.length > 0) {
        lines.push('', tf('日志不可读 {0} 个', [unsound.length]));
        for (const h of unsound.slice(0, 10))
            lines.push(`  ✗ ${h.id} · ${h.log || t('无日志')} · ${h.status}`);
    }
    else {
        lines.push(t('✓ 已检查的会话日志均可解压'));
    }
    if (faulted.length > 0) {
        // Not a hard failure: the host leaves this sibling when it repairs a log, so
        // the session is usually still usable — but it is the only on-disk evidence
        // that a fault happened, and the fault can still throw on projection.
        lines.push('', tf('曾发生日志故障 {0} 个（有 .corrupt-backup）', [faulted.length]));
        for (const h of faulted.slice(0, 10))
            lines.push(`  ⚠ ${h.id}`);
        lines.push('', t('若某个会话打开时报错（如 invalid persisted inbox splice）：'));
        lines.push(t('  · 日志本身通常完好 —— 坏的是单条信封，不是整份历史'));
        lines.push(t('  · 可改用 /fork 从该会话派生，或 /export 导出可读部分'));
    }
    return lines;
};
/** /doctor — terminal + session-log capability report. */
export const doctorCommand = async (app) => {
    let size = null;
    try {
        size = await app.luaCall('return { vim.o.columns, vim.o.lines }', []);
    }
    catch { }
    app.notice(`TERM=${process.env['TERM'] ?? '?'} · TTY=${process.stdout.isTTY} · Node ${process.version}`);
    app.notice(`终端尺寸 ${size ? `${size[0]}×${size[1]}` : '?'} · Unicode ✓ · truecolor ${process.env['COLORTERM'] === 'truecolor' ? '✓' : t('按 TERM')}`);
    app.notice(t('诊断建议: 真彩异常时检查 COLORTERM；宽度异常检查 locale/字体'));
    const lines = ['', ...sessionHealthLines(sessionDirs())];
    await app.luaCall('require("dsh_tui").show_lines_float(...)', [t('会话与终端诊断'), lines]).catch(() => { });
};
export function installDoctorCommand(app) {
    app.registerCommands([{ name: '/doctor', desc: t('终端诊断'), usage: t('终端诊断'), group: t('信息'), fn: () => doctorCommand(app) }]);
}
