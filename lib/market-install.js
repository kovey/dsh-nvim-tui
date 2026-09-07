/**
 * dsh_tui plugin-market module: the live progress float driver, the `dsh
 * plugin …` CLI runner with the install diagnosis/repair chains, and the
 * /market command (catalog browser, install / update / uninstall / toggle).
 *
 * @module dsh-nvim-tui/market-install
 */
import { spawn } from 'node:child_process';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { locale, t } from './i18n.js';
import { fetchCatalog, readCatalog, writeCatalog, isFresh, searchCatalog, readInstalledPlugins, runningProfileName, installSpec, openUrl, installedMainMissing, resolveNpmSpec, readRepoPackage, patchPath, readPatch, readDisabledIds, setDisabledRows, writePatch, isNpmName, latestVersion, depMatchesEntry, profileDir, classifyPnpmError, firstErrorLine, repoRoot, } from './market.js';
/** /market [关键词 | refresh] — plugin marketplace: curated
 *  awesome-dsh-plugin catalog sorted by GitHub stars (desc), with
 *  install / update / uninstall through the official `dsh plugin` CLI. */
/** Live progress float driver: streams log lines + a bottom bar into the
 *  nvim progress window so long pnpm runs never look stuck. */
const openProgress = (app, title) => {
    let lines = ['正在启动…'];
    let bar = '▸ 准备中';
    let lastPush = 0;
    void app.luaCall('require("dsh_tui").show_progress(...)', [title, lines]).catch(() => { });
    const push = () => {
        const now = Date.now();
        if (now - lastPush < 120)
            return;
        lastPush = now;
        void app.luaCall('require("dsh_tui").progress_update(...)', [lines.slice(-60), bar]).catch(() => { });
    };
    push();
    return {
        log: (l) => {
            lines.push(l);
            if (lines.length > 80)
                lines.splice(0, lines.length - 80);
            push();
        },
        bar: (b) => { bar = b; push(); },
        close: (delayMs = 0) => {
            setTimeout(() => { void app.luaCall('require("dsh_tui").close_progress()', []).catch(() => { }); }, delayMs);
        },
    };
};
/** Spawn `dsh plugin …`, streaming its output into the progress float. */
const runPluginCliP = (profileName, args, pg, envExtra = {}) => new Promise((resolve) => {
    const child = spawn('dsh', ['plugin', '--profile', profileName, ...args], {
        env: { ...process.env, ...envExtra },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const bump = (chunk) => {
        out = (out + chunk).slice(-4000);
        const tail = out.trim().split('\n');
        const last = tail[tail.length - 1];
        if (last !== undefined && last !== '')
            pg.log(last);
    };
    child.stdout.on('data', (d) => bump(d.toString()));
    child.stderr.on('data', (d) => bump(d.toString()));
    child.on('error', (e) => { pg.log('无法启动 dsh CLI: ' + e.message); resolve({ code: null, tail: out }); });
    child.on('exit', (code) => resolve({ code, tail: out }));
});
/** Post-install verification + the entry-file auto-repair chain (the
 *  dsh-context incident): a source-only repo installs without its main
 *  entry → swap to the npm publish / release tarball automatically. */
const verifyOrRepairMain = async (entry, profileName, spec, pg, runs) => {
    const missing = installedMainMissing(profileName, spec);
    if (missing === null) {
        pg.log('✓ 入口文件校验通过');
        return true;
    }
    pg.log(`⚠ 缺少入口文件（${missing}）→ 自动寻找可用的预构建包…`);
    const candidates = [];
    const npmSpec = await resolveNpmSpec(entry);
    if (npmSpec !== undefined)
        candidates.push({ spec: npmSpec, label: 'npm 发布版' });
    if (entry.tarball !== undefined)
        candidates.push({ spec: entry.tarball, label: 'GitHub Release tarball' });
    for (const c of candidates) {
        if (runs.has(c.spec) || c.spec === spec)
            continue;
        pg.log(`· 换用 ${c.label}: ${c.spec}`);
        pg.bar(`↻ 自动修复：改用 ${c.label}…`);
        await runPluginCliP(profileName, ['remove', missing], pg);
        const r = await runPluginCliP(profileName, ['add', c.spec], pg);
        runs.add(c.spec);
        if (r.code === 0 && installedMainMissing(profileName, c.spec) === null) {
            pg.bar('✓ 已自动修复（入口文件校验通过）');
            return true;
        }
        pg.log(`✗ ${c.label} 安装后仍未通过校验`);
    }
    pg.bar('⚠ 已安装但入口缺失（建议反馈给插件作者）');
    return false;
};
/** Install with automatic diagnosis + remedy chains (bounded attempt
 *  budget, every remedy is logged into the progress float). */
const installWithRepair = async (app, entry, profileName, initialSpec, pg) => {
    const runs = new Set();
    let spec = initialSpec;
    const run = async (s, tag, env) => {
        if (runs.size >= 4)
            return { code: -1, tail: '尝试次数已达上限' };
        pg.log(`· dsh plugin add ${s}${tag !== '' ? `（${tag}）` : ''}`);
        runs.add(s);
        const r = await runPluginCliP(profileName, ['add', s], pg, env);
        pg.log(r.code === 0 ? '✓ 命令成功' : `✗ 退出码 ${r.code ?? '?'} · ${firstErrorLine(r.tail)}`);
        return r;
    };
    let r = await run(spec, '初始安装');
    if (r.code === 0) {
        await verifyOrRepairMain(entry, profileName, spec, pg, runs);
        return;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
        const f = classifyPnpmError(r.tail);
        pg.log(`· 诊断: ${f.message}`);
        if (f.kind === 'network') {
            pg.bar('↻ 网络错误 · 2s 后自动重试…');
            await app.sleep(2000);
            r = await run(spec, '网络重试');
        }
        else if (f.kind === 'cache') {
            pg.bar('↻ 缓存/权限问题 · 改用临时缓存重试…');
            r = await run(spec, '临时 npm 缓存', { npm_config_cache: '/tmp/dsh-pnpm-cache' });
        }
        else if (f.kind === 'lockfile') {
            const lock = join(profileDir(profileName), 'pnpm-lock.yaml');
            try {
                renameSync(lock, `${lock}.bak-${Date.now()}`);
                pg.log('· 已备份 pnpm-lock.yaml');
            }
            catch {
                pg.log('· 锁文件不存在，无需备份');
            }
            pg.bar('↻ 锁文件冲突 · 备份后重试…');
            r = await run(spec, '锁文件修复重试');
        }
        else if (f.kind === 'notfound') {
            const alt = (await resolveNpmSpec(entry)) ?? (entry.tarball !== undefined ? entry.tarball : repoRoot(entry.url));
            if (alt !== spec && !runs.has(alt)) {
                pg.bar('↻ 该版本不存在 · 自动换源…');
                spec = alt;
                r = await run(alt, '自动换源');
            }
            else {
                pg.bar('✗ 找不到可用安装源（npm/源码/Release 均不可用）');
                return;
            }
        }
        else if (f.kind === 'git') {
            const npmSpec = await resolveNpmSpec(entry);
            if (npmSpec !== undefined && !runs.has(npmSpec)) {
                pg.bar('↻ 仓库不可访问 · 改用 npm 发布版…');
                spec = npmSpec;
                r = await run(npmSpec, 'npm 发布版修复');
            }
            else {
                pg.bar('✗ 仓库不可访问且 npm 无发布版（请检查网络或反馈作者）');
                return;
            }
        }
        else {
            if (attempt === 0) {
                pg.bar('↻ 未知错误 · 重试一次…');
                r = await run(spec, '重试');
            }
            else {
                pg.bar(`✗ 安装失败（已自动尝试 ${runs.size} 次，详情见上方日志）`);
                return;
            }
        }
        if (r.code === 0) {
            await verifyOrRepairMain(entry, profileName, spec, pg, runs);
            return;
        }
    }
    pg.bar(`✗ 安装失败（已自动尝试 ${runs.size} 次，详情见上方日志）`);
};
/** /market [关键词 | refresh | update-all] — plugin marketplace: curated
 *  awesome-dsh-plugin catalog sorted by GitHub stars (desc); install /
 *  update / uninstall via the official `dsh plugin` CLI; hot
 *  enable/disable through the profile patch layer (HMR, no restart). */
const marketCommand = async (app, a) => {
    const arg = (a ?? '').trim();
    const profileName = runningProfileName() ?? String(app.config.marketProfile ?? 'nvim-tui');
    const registryBase = typeof app.config.marketRegistryBase === 'string' && app.config.marketRegistryBase !== ''
        ? app.config.marketRegistryBase
        : undefined;
    const ttl = typeof app.config.marketCacheTtlMs === 'number' ? app.config.marketCacheTtlMs : undefined;
    if (arg === 'refresh') {
        app.notice(t('正在同步插件市场目录…'));
        try {
            const catalog = await fetchCatalog({ base: registryBase });
            writeCatalog(catalog);
            app.notice(`${catalog.entries.length} ${t('个插件已更新（按 GitHub 星标倒序）')}`);
        }
        catch (err) {
            app.notice(`市场同步失败: ${err.message}（仍可用本地缓存）`);
        }
        return;
    }
    if (arg === 'update-all') {
        const pg = openProgress(app, '更新全部插件');
        void (async () => {
            pg.log('· dsh plugin update（可能需要一两分钟）…');
            pg.bar('▸ 更新全部依赖…');
            const r = await runPluginCliP(profileName, ['update'], pg);
            pg.bar(r.code === 0 ? '✓ 全部插件已更新（重启 dsh 后生效）' : `✗ 更新失败 · ${firstErrorLine(r.tail)}`);
            pg.close(1500);
            app.notice(r.code === 0 ? t('全部插件已更新（重启 dsh 后生效）') : `update-all 失败: ${firstErrorLine(r.tail)}`);
        })();
        return;
    }
    let catalog = readCatalog();
    if (!isFresh(catalog, ttl)) {
        app.notice(t('正在同步插件市场目录…（首次需要数秒）'));
        try {
            catalog = await fetchCatalog({ base: registryBase });
            writeCatalog(catalog);
        }
        catch (err) {
            app.notice(`市场同步失败: ${err.message}${catalog !== null ? t('（用本地缓存）') : ''}`);
            if (catalog === null)
                return;
        }
    }
    if (catalog === null || catalog.entries.length === 0) {
        app.notice(t('（市场目录为空，/market refresh 重试）'));
        return;
    }
    const installed = readInstalledPlugins(profileName);
    const patchText = readPatch(patchPath(profileName));
    const disabledIds = readDisabledIds(patchText);
    const loader = app.svc('loader');
    const loaderEntries = typeof loader?.entries === 'function' ? loader.entries().filter((e) => !e.options?.group) : [];
    const entries = arg === '' ? catalog.entries.slice(0, 120) : searchCatalog(catalog.entries, arg).slice(0, 120);
    if (entries.length === 0) {
        app.notice(`没有匹配「${arg}」的插件`);
        return;
    }
    // Installed-dep matching + update checks (only for installed rows;
    // npm registry lookups are cached 5 min in-memory).
    const updates = new Map(); // depKey -> latest
    const matchFor = (e) => {
        for (const depKey of installed.deps.keys()) {
            if (depMatchesEntry(depKey, e))
                return depKey;
        }
        return undefined;
    };
    await Promise.all([...new Set(entries.map(matchFor).filter((k) => k !== undefined))].slice(0, 10).map(async (depKey) => {
        if (!isNpmName(depKey))
            return;
        const current = installed.versions.get(depKey);
        const latest = await latestVersion(depKey);
        if (latest !== undefined && current !== undefined && latest !== current)
            updates.set(depKey, latest);
    }));
    const rows = entries.map((e) => {
        const depKey = matchFor(e);
        const isInstalled = depKey !== undefined;
        const matching = loaderEntries.filter((le) => le.options?.name === depKey || depMatchesEntry(le.options?.name ?? '', e));
        const allDisabled = matching.length > 0 && matching.every((le) => le.disabled === true || disabledIds.has(le.id));
        const mark = isInstalled ? (allDisabled ? ' ⊘' : ' ✓') : '';
        const up = depKey !== undefined && updates.has(depKey) ? ' ↑' : '';
        const desc = (locale() === 'en' ? e.descEn : e.descZh) || e.descEn || '';
        return {
            label: `★${e.stars}${mark}${up} · ${e.name} · ${desc.replace(/\s+/g, ' ').slice(0, 32)}`,
            value: e.name,
        };
    });
    const sel = await app.openPicker(`插件市场（★ 倒序 · ${profileName}）`, rows);
    if (sel === null)
        return;
    const entry = entries.find((e) => e.name === sel);
    if (entry === undefined)
        return;
    const depKey = matchFor(entry);
    const isInstalled = depKey !== undefined;
    const matching = loaderEntries.filter((le) => le.options?.name === depKey || depMatchesEntry(le.options?.name ?? '', entry));
    const togglable = matching.filter((le) => le.id !== 'nvim-tui-runner' && le.options?.name !== 'dsh-nvim-tui');
    const anyEnabled = matching.some((le) => le.disabled !== true && !disabledIds.has(le.id));
    const desc = (locale() === 'en' ? entry.descEn : entry.descZh) || entry.descEn || '';
    const actions = [];
    if (!isInstalled) {
        actions.push({ label: `安装到 ${profileName} profile`, value: 'install' });
    }
    else {
        actions.push({ label: t('更新到最新'), value: 'update' });
        if (togglable.length > 0) {
            actions.push({ label: anyEnabled ? '停用（热切换，HMR 免重启）' : '启用（热切换，HMR 免重启）', value: 'toggle' });
        }
        actions.push({ label: t('卸载（二次确认）'), value: 'uninstall' });
    }
    actions.push({ label: t('打开 GitHub 页面'), value: 'open' }, { label: t('取消'), value: 'cancel' });
    const act = await app.openPicker(`${entry.name}${desc !== '' ? ` · ${desc.slice(0, 40)}` : ''}`, actions);
    if (act === null || act === 'cancel')
        return;
    if (act === 'open') {
        openUrl(entry.url);
        app.notice(`已在浏览器打开 ${entry.url}`);
        return;
    }
    if (act === 'toggle') {
        if (togglable.length === 0) {
            app.notice('该插件没有可热切换的 loader 条目');
            return;
        }
        // The action is the FLIP: enabled now → this toggle disables it.
        const target = anyEnabled;
        const toggles = togglable.map((le) => ({ id: le.id, disabled: target }));
        const next = setDisabledRows(patchText, toggles);
        writePatch(patchPath(profileName), next);
        app.notice(`${entry.name} 已${target ? '停用' : '启用'}（写入 cordis.patch.yml · HMR 约 1s 内重新组合）`);
        return;
    }
    if (act === 'uninstall') {
        if (entry.name === 'dsh-nvim-tui') {
            app.notice('不能卸载正在运行的 TUI 插件自身');
            return;
        }
        const ok = await app.openPicker(t('确认卸载'), [
            { label: `确认卸载 ${entry.name}（重启 dsh 后生效）`, value: 'yes' },
            { label: t('取消'), value: 'no' },
        ]);
        if (ok !== 'yes')
            return;
    }
    const verb = act === 'install' ? 'add' : act === 'update' ? 'update' : 'remove';
    const label = verb === 'add' ? '安装' : verb === 'update' ? '更新' : '卸载';
    const pg = openProgress(app, `${label} ${entry.name}`);
    try {
        if (verb === 'add') {
            // ① Resolve the best source up front (npm publish preferred: a
            // source-only repo installs as metadata-only under pnpm ≥10 and
            // breaks the next boot — the dsh-context incident).
            pg.log('① 解析安装源…');
            pg.bar('▸ 解析安装源…');
            let spec = installSpec(entry);
            if (entry.tarball === undefined) {
                const npmSpec = await resolveNpmSpec(entry);
                if (npmSpec !== undefined) {
                    spec = npmSpec;
                    pg.log(`· 使用 npm 发布版: ${npmSpec}`);
                }
                else {
                    const info = await readRepoPackage(entry.url);
                    pg.log(info?.hasPrepare === true
                        ? '· npm 无发布版 → 源码包（带 prepare 构建脚本）'
                        : '· npm 无发布版 → 先装源码包，装完自动校验入口文件');
                }
            }
            // ② Install with diagnosis + automatic remedies (retry / source
            // swap / lock backup / cache reset), all streamed into the float.
            pg.log('② 安装依赖…');
            await installWithRepair(app, entry, profileName, spec, pg);
            pg.close(1500);
            app.notice(`${entry.name} 安装流程结束（结果见进度窗；多数插件重启 dsh 后生效）`);
            return;
        }
        // update / uninstall: run once, then one bounded remedy chain.
        const spec = depKey ?? entry.name;
        pg.log(`· dsh plugin ${verb} ${spec}`);
        pg.bar(`▸ ${label} ${entry.name}…`);
        let r = await runPluginCliP(profileName, [verb, spec], pg);
        if (r.code !== 0) {
            const f = classifyPnpmError(r.tail);
            pg.log(`· 诊断: ${f.message}`);
            if (f.kind === 'network') {
                pg.bar('↻ 网络错误 · 2s 后自动重试…');
                await app.sleep(2000);
                r = await runPluginCliP(profileName, [verb, spec], pg);
            }
            else if (f.kind === 'lockfile') {
                const lock = join(profileDir(profileName), 'pnpm-lock.yaml');
                try {
                    renameSync(lock, `${lock}.bak-${Date.now()}`);
                    pg.log('· 已备份 pnpm-lock.yaml');
                }
                catch {
                    pg.log('· 锁文件不存在，无需备份');
                }
                pg.bar('↻ 锁文件冲突 · 备份后重试…');
                r = await runPluginCliP(profileName, [verb, spec], pg);
            }
            else if (f.kind === 'cache') {
                pg.bar('↻ 缓存/权限问题 · 改用临时缓存重试…');
                r = await runPluginCliP(profileName, [verb, spec], pg, { npm_config_cache: '/tmp/dsh-pnpm-cache' });
            }
        }
        pg.bar(r.code === 0
            ? `✓ ${label}完成（重启 dsh 后生效）`
            : `✗ ${label}失败 · ${firstErrorLine(r.tail)}`);
        pg.close(1500);
        app.notice(`${entry.name} ${r.code === 0 ? (verb === 'remove' ? t('已卸载') : t('更新完成')) : label + t('失败')}（结果见进度窗）`);
    }
    catch (err) {
        pg.log(`✗ 异常: ${err.message}`);
        pg.bar('✗ 流程异常终止（详情见日志）');
        pg.close(2000);
        app.notice(`${entry.name} ${label}流程异常: ${err.message}`);
    }
};
/** Fill the market-install module's command registry. */
export function installMarketInstall(app) {
    const specs = [
        { name: '/market', desc: '插件市场（GitHub ★ 倒序 · 安装/更新/卸载）', usage: '[关键词 | refresh]', group: '信息', fn: (a) => marketCommand(app, a) },
    ];
    app.registerCommands(specs);
}
