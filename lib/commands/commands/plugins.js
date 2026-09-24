/** dsh_tui command: /plugins — one command per file (self-registering,
 *  wired by the commands module index). */
import { copyFileSync, existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { t, tf } from '../../kernel/i18n.js';
import { togglePluginEntry } from '../../kernel/plugin-toggle.js';
/** /plugins — read-only host loader inventory (official Plugins
 *  settings tab counterpart), rendered in a scrollable float like
 *  /sessions and the other listing commands. */
export const pluginsCommand = async (app) => {
    const inv = app.svc('pluginInventory');
    if (typeof inv?.list !== 'function') {
        app.notice(t('plugin-inventory 服务未装配（dsh-host-plugin-inventory）'));
        return;
    }
    // dsh 0.1.2-alpha.2: list() 改为 async，返回 Promise<PluginInventorySnapshot>。
    const snapshot = await inv.list();
    const entries = snapshot.entries ?? [];
    const lines = [''];
    if (entries.length === 0) {
        lines.push(t('（loader 没有插件条目）'));
    }
    else {
        for (const e of entries) {
            lines.push(`${e.enabled ? '●' : '○'} ${e.entryId} · ${e.moduleName} · ${e.fiberPhase}`);
        }
    }
    void app.luaCall('require("dsh_tui").show_lines_float(...)', [t('插件清单（只读）'), lines]).catch(() => { });
};
/**
 * `/plugins toggle` — enable/disable a plugin listed in THIS profile's
 * `cordis.patch.yml`.
 *
 * The toggle edits one line of that file (see kernel/plugin-toggle.ts for the
 * safety rules). It is deliberately limited to entries the profile actually
 * declares: a plugin shipped by `dsh-base` has no patch line to flip, and
 * pretending otherwise would either write nothing or write to an unrelated
 * profile.
 *
 * The running profile is identified by SYMLINK, not by name — the process does
 * not receive its profile name, but a development profile links this plugin to
 * its own worktree, which is a positive, verifiable signal. Ambiguity (0 or >1
 * candidates) refuses rather than guessing, because the failure mode is editing
 * the wrong profile.
 */
const PROFILE_LINK_GUARD = (profilesDir) => {
    const self = realpathSync(process.cwd());
    let names;
    try {
        names = readdirSync(profilesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    }
    catch {
        return undefined;
    }
    const hits = [];
    for (const name of names) {
        const link = join(profilesDir, name, 'node_modules', 'dsh-nvim-tui');
        try {
            if (realpathSync(link) === self)
                hits.push(name);
        }
        catch {
            /* the plugin is not installed in that profile */
        }
    }
    return hits.length === 1 ? hits[0] : undefined;
};
const toggleCommand = async (app) => {
    const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh');
    const profilesDir = join(home, 'profiles');
    const profile = PROFILE_LINK_GUARD(profilesDir);
    if (profile === undefined) {
        app.notice(t('无法确定当前 profile（该 profile 未把本插件 link 到工作区）—— 请直接编辑 profile 的 cordis.patch.yml'));
        return;
    }
    const patchPath = join(profilesDir, profile, 'cordis.patch.yml');
    if (!existsSync(patchPath)) {
        app.notice(tf('{0} 没有 cordis.patch.yml', [profile]));
        return;
    }
    let text;
    try {
        text = readFileSync(patchPath, 'utf8');
    }
    catch (err) {
        app.notice(tf('读取失败: {0}', [err.message]));
        return;
    }
    // Only entries the profile itself declares can be toggled.
    const declared = new Set([...text.matchAll(/^\s*(?:#disabled#\s*)?-\s*id:\s*(\S+)\s*$/gm)].map((m) => (m[1] ?? '').replace(/['"]/g, '')));
    const inv = app.svc('pluginInventory');
    if (typeof inv?.list !== 'function') {
        app.notice(t('plugin-inventory 服务未装配（dsh-host-plugin-inventory）'));
        return;
    }
    const snapshot = await inv.list();
    const candidates = (snapshot.entries ?? []).filter((e) => declared.has(e.entryId));
    if (candidates.length === 0) {
        app.notice(t('该 profile 的 patch 没有可启停的插件条目'));
        return;
    }
    const sel = await app.openPicker(t('启停插件（Enter 切换该条目）'), candidates.map((e) => ({
        label: `${e.enabled ? '●' : '○'} ${e.entryId}`,
        value: e.entryId,
        ...(e.enabled ? {} : {}),
    })));
    if (sel === null)
        return;
    const entry = candidates.find((e) => e.entryId === sel);
    if (entry === undefined)
        return;
    const edit = togglePluginEntry(text, sel, !entry.enabled);
    if (edit.kind === 'unchanged') {
        app.notice(tf('{0} 已经是目标状态（未改动）', [sel]));
        return;
    }
    // Back up first; a failed backup aborts rather than risking the original.
    const backup = `${patchPath}.bak`;
    try {
        copyFileSync(patchPath, backup);
        writeFileSync(patchPath, edit.text, 'utf8');
    }
    catch (err) {
        app.notice(tf('写入失败（未改动）: {0}', [err.message]));
        return;
    }
    app.notice(tf('{0} 已{1}（第 {2} 行）—— 重启 dsh 生效；备份在 cordis.patch.yml.bak', [
        sel,
        entry.enabled ? t('停用') : t('启用'),
        String(edit.line),
    ]));
};
export function installPluginsCommand(app) {
    app.registerCommands([
        { name: '/plugins', desc: t('宿主插件清单（只读）'), usage: t('插件清单'), group: t('信息'), fn: () => pluginsCommand(app) },
        { name: '/plugins:set', desc: t('启停 profile patch 里的插件条目'), usage: t('启停插件'), group: t('信息'), fn: () => toggleCommand(app) },
    ]);
}
