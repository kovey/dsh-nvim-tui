/**
 * dsh_tui deps module: dependency health check + one-click assembly.
 *
 * `/deps` reports every harness/third-party dependency the TUI's commands
 * consume, grouped with a ✓/✗/⚠ status. `/deps install` writes the missing
 * host-plugin rows into the profile's cordis.patch.yml (idempotent — row ids
 * already present are skipped) and the loader's user-patch watcher hot-reloads
 * the composition.
 *
 * @module dsh-nvim-tui/deps
 */
import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
/** Patch-row templates, keyed by the loader row id (or a special fix id). */
const ROW_TEMPLATES = {
    'agent-presets': {
        pkg: '@deepseek-ai/dsh-agent-presets', file: 'package.json',
        yaml: "    - id: agent-presets\n      name: '@deepseek-ai/dsh-agent-presets'\n      config:\n        default: standard",
    },
    'cordis-host-runner': {
        pkg: '@deepseek-ai/dsh-cordis-host-runner', file: 'package.json',
        yaml: "    - id: cordis-host-runner\n      name: '@deepseek-ai/dsh-cordis-host-runner'",
    },
    'file-reference': {
        pkg: '@deepseek-ai/dsh-file-reference-local', file: 'package.json',
        yaml: "    - id: file-reference\n      name: '@deepseek-ai/dsh-file-reference-local'",
    },
    workspace: {
        pkg: '@deepseek-ai/dsh-workspace', file: 'package.json',
        yaml: "    - id: workspace\n      name: '@deepseek-ai/dsh-workspace'",
    },
    'plugin-inventory': {
        pkg: '@deepseek-ai/dsh-host-plugin-inventory', file: 'package.json',
        yaml: "    - id: plugin-inventory\n      name: '@deepseek-ai/dsh-host-plugin-inventory'",
    },
    'message-feedback': {
        pkg: '@deepseek-ai/dsh-message-feedback', file: 'package.json',
        yaml: "    - id: message-feedback\n      name: '@deepseek-ai/dsh-message-feedback'\n      config:\n        maxNoteBytes: 8192",
    },
    'session-reference': {
        pkg: '@deepseek-ai/dsh-session-reference', file: 'package.json',
        yaml: "    - id: session-reference\n      name: '@deepseek-ai/dsh-session-reference'",
    },
    'session-stats': {
        pkg: '@deepseek-ai/dsh-session-stats', file: 'package.json',
        yaml: "    - id: session-stats\n      name: '@deepseek-ai/dsh-session-stats'",
    },
    'code-runtime': {
        pkg: '@deepseek-ai/dsh-code-runtime-worker-thread', file: 'package.json',
        yaml: "    - id: code-runtime\n      name: '@deepseek-ai/dsh-code-runtime-worker-thread'",
    },
    'subagent-model-selection-settings': {
        pkg: '@deepseek-ai/dsh-tool-subagent', file: 'lib/model-selection-settings.js',
        yaml: "    - id: subagent-model-selection-settings\n      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'",
    },
    'search-override': {
        pkg: '@deepseek-ai/dsh-session-query-sqlite', file: 'package.json',
        yaml: "- id: session-query-sqlite\n  config:\n    path: !!js dshHomePath('session-query.db')\n    openAt: first-search",
    },
};
// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const dshHome = () => process.env.DSH_HOME ?? join(homedir(), '.dsh');
/** The profile patch path: profile whose bundles include dsh-nvim-tui. */
function findProfilePatchPath() {
    const profilesDir = join(dshHome(), 'profiles');
    try {
        for (const name of readdirSync(profilesDir)) {
            const pkgPath = join(profilesDir, name, 'package.json');
            if (!existsSync(pkgPath))
                continue;
            try {
                const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
                if ((pkg.dsh?.profile?.bundles ?? []).includes('dsh-nvim-tui')) {
                    return join(profilesDir, name, 'cordis.patch.yml');
                }
            }
            catch { }
        }
    }
    catch { }
    return null;
}
/** Structural row ids already present in the patch file (comments ignored). */
export function readPatchRowIds(path) {
    const ids = new Set();
    try {
        for (const line of readFileSync(path, 'utf8').split('\n')) {
            const t = line.trim();
            if (t.startsWith('#'))
                continue;
            const m = t.match(/^-\s+id:\s*['"]?([\w-]+)/);
            if (m)
                ids.add(m[1]);
        }
    }
    catch { }
    return ids;
}
/** A loader entry by row id (for config checks like the search override). */
function loaderEntryConfig(app, id) {
    try {
        const loader = app.runtimeCtx.get('loader');
        for (const e of loader?.entries?.() ?? []) {
            if (e.options?.id === id)
                return e.options.config;
        }
    }
    catch { }
    return undefined;
}
/** Does the package exist inside the dsh install (hoisted or nested pnpm)?
 *  The install root derives from the dsh bin path; tests override it via
 *  `DSH_NVIM_TUI_INSTALL_ROOT`. */
export function packageExists(pkg, file) {
    try {
        const installRoot = process.env.DSH_NVIM_TUI_INSTALL_ROOT ??
            dirname(dirname(dirname(dirname(realpathSync(process.argv[1] ?? '')))));
        const pkgName = pkg.startsWith('@') ? pkg.split('/').slice(0, 2).join('/') : pkg.split('/')[0];
        const rel = pkgName + '/' + file;
        const candidates = [
            join(installRoot, 'node_modules', rel),
            join(installRoot, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', rel),
        ];
        return candidates.some((c) => existsSync(c));
    }
    catch {
        return false;
    }
}
// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------
const svcOk = (app, key) => app.runtimeCtx.get(key) !== undefined;
async function checkAll(app, patchPath) {
    const patchIds = patchPath === null ? new Set() : readPatchRowIds(patchPath);
    const reports = [];
    const host = (id, label, detail, key) => {
        const ok = key === undefined
            ? patchIds.has(id) || svcOk(app, id)
            : svcOk(app, key);
        const present = patchIds.has(id);
        reports.push({
            id, label, group: '主机插件',
            status: ok ? 'ok' : 'missing',
            detail: ok ? detail : (present ? `${detail}（已装配但服务未就绪，重启后重试 /deps）` : `未装配 — 影响: ${detail}`),
            fixId: ok ? undefined : id,
        });
    };
    host('agent-presets', 'agent-presets', '/preset agent 预设', 'agentPresets');
    host('cordis-host-runner', 'cordis-host-runner', 'cordis 预设（/preset ptc）', 'dynamicCordisRunner');
    host('file-reference', 'file-reference', '@ 文件引用补全', 'fileReferences');
    host('workspace', 'workspace', '/workspace 工作区与 /archive 归档', 'workspaceRegistry');
    host('plugin-inventory', 'plugin-inventory', '/plugins 插件清单', 'pluginInventory');
    host('message-feedback', 'message-feedback', '/fb 消息反馈', 'messageFeedback');
    host('session-reference', 'session-reference', '💬 跨会话引用补全', 'sessionReferenceResolver');
    host('session-stats', 'session-stats', '状态栏 TTFT / tok/s');
    host('code-runtime', 'code-runtime', '/preset ptc 的 run_code', 'codeRuntime');
    host('subagent-model-selection-settings', 'subagent-model-selection-settings', '子代理独立模型设置', 'subagentModelSelection');
    // -- 配置生效性 -----------------------------------------------------------
    const searchCfg = loaderEntryConfig(app, 'session-query-sqlite');
    const searchOn = searchCfg?.openAt !== undefined && searchCfg.openAt !== 'never';
    reports.push({
        id: 'search', label: '/search 全文搜索索引', group: '配置生效性',
        status: searchOn ? 'ok' : 'warn',
        detail: searchOn ? `openAt=${searchCfg.openAt}，索引持久化于 DSH_HOME` : 'session-query-sqlite 配置为 :memory: + never（库从不建立，搜索恒空）',
        fixId: searchOn ? undefined : 'search-override',
    });
    // 官方识图模型：目录中存在声明 image 模态的模型（如
    // deepseek-v4-flash-vision-exp）时，图片消息会自动切换该模型处理。
    let visionModel;
    try {
        const sel = app.currentSelection();
        const llm = app.runtimeCtx.get('llm');
        for (const id of ['deepseek-v4-flash-vision-exp', 'deepseek-vl2', 'deepseek-vl']) {
            const info = await llm?.resolveModelInfo?.(sel.provider, id);
            if (info?.inputModalities?.includes('image') === true) {
                visionModel = id;
                break;
            }
        }
    }
    catch { }
    reports.push({
        id: 'vision-model', label: '官方识图模型', group: '配置生效性',
        status: visionModel === undefined ? 'warn' : 'ok',
        detail: visionModel === undefined
            ? '目录中没有声明 image 模态的模型 — 影响: 图片消息无法发送（settings.yaml 的 llm-deepseek.models 加入 deepseek-v4-flash-vision-exp 并声明 inputModalities: [text, image]）'
            : `已就绪: ${visionModel}（图片消息自动切换，回合结束切回）`,
    });
    const feishuEntry = loaderEntryConfig(app, 'feishu');
    const creds = existsSync(join(dshHome(), 'feishu-app.json')) ||
        existsSync(join(process.cwd(), '.dsh', 'feishu-app.json'));
    reports.push({
        id: 'feishu', label: 'feishu 飞书集成', group: '配置生效性',
        status: feishuEntry === undefined ? 'warn' : (creds ? 'ok' : 'warn'),
        detail: feishuEntry === undefined
            ? '未装配 — 影响: 飞书消息/卡片（手动: 加入 profile bundles）'
            : (creds ? '插件已装配，凭据已找到' : '插件已装配，但 feishu-app.json 凭据缺失（飞书功能本会话禁用）'),
    });
    // -- 系统命令 -------------------------------------------------------------
    const pnpm = spawnSync('pnpm', ['--version'], { stdio: 'ignore', timeout: 5000 });
    reports.push({
        id: 'pnpm', label: 'pnpm', group: '系统命令',
        status: pnpm.status === 0 ? 'ok' : 'warn',
        detail: pnpm.status === 0
            ? `pnpm ${String(pnpm.stdout ?? '').trim()}（/market 安装器可用）`
            : '未找到 pnpm — 影响: /market 安装插件（npm i -g pnpm 或 corepack enable）',
    });
    return reports;
}
// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------
const depsCommand = async (app, a) => {
    const arg = (a ?? '').trim();
    if (arg === 'install') {
        await installCommand(app);
        return;
    }
    if (arg !== '') {
        app.notice('用法: /deps（体检报告）· /deps install（一键装配可修复项）');
        return;
    }
    const patchPath = findProfilePatchPath();
    const reports = await checkAll(app, patchPath);
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
const installCommand = async (app) => {
    const patchPath = findProfilePatchPath();
    if (patchPath === null) {
        app.notice('未定位 profile 的 cordis.patch.yml（DSH_HOME/profiles 下没有包含 dsh-nvim-tui bundle 的 profile），无法自动装配');
        return;
    }
    const reports = (await checkAll(app, patchPath)).filter((r) => r.fixId !== undefined);
    if (reports.length === 0) {
        app.notice('没有可一键装配的缺失项（/deps 查看完整报告）');
        return;
    }
    const sel = await app.openPicker('一键装配（选择要写入 profile patch 的行）', [
        { label: `全部缺失项（${reports.length} 项）`, value: 'all' },
        ...reports.map((r) => ({ label: `${r.status === 'missing' ? '✗' : '⚠'} ${r.label}`, value: r.id })),
    ]);
    if (sel === null)
        return;
    const targets = sel === 'all' ? reports : reports.filter((r) => r.id === sel);
    const ids = readPatchRowIds(patchPath);
    const appended = [];
    const skipped = [];
    const insertBlocks = [];
    const topBlocks = [];
    for (const r of targets) {
        const fixId = r.fixId;
        const tpl = ROW_TEMPLATES[fixId];
        if (tpl === undefined)
            continue;
        const rowId = fixId === 'search-override' ? 'session-query-sqlite' : fixId;
        if (ids.has(rowId)) {
            skipped.push(r.label);
            continue;
        }
        if (!packageExists(tpl.pkg, tpl.file)) {
            app.notice(`跳过 ${r.label}: 包 ${tpl.pkg} 不在当前 dsh 安装中（升级 dsh 后重试）`);
            continue;
        }
        appended.push(r.label);
        ids.add(rowId);
        if (fixId === 'search-override')
            topBlocks.push(tpl.yaml);
        else
            insertBlocks.push(tpl.yaml);
    }
    if (appended.length === 0) {
        app.notice(skipped.length > 0 ? '所选行均已存在于 patch 中，无需写入' : '没有可写入的行');
        return;
    }
    try {
        let block = '';
        if (insertBlocks.length > 0) {
            block += '\n# [nvim-tui /deps] 自动装配行\n- insert:\n' + insertBlocks.join('\n') + '\n';
        }
        if (topBlocks.length > 0) {
            block += '\n# [nvim-tui /deps] 自动装配（覆盖型）\n' + topBlocks.join('\n') + '\n';
        }
        appendFileSync(patchPath, block);
        app.notice(`已装配 ${appended.length} 项（写入 ${patchPath.replace(dshHome(), '~')}，loader 热重载中；若服务未立即就绪请重启 dsh）`);
        if (skipped.length > 0)
            app.notice(`跳过已存在的行: ${skipped.join('、')}`);
    }
    catch (err) {
        app.notice(`装配失败: ${err.message}`);
    }
};
export function installDeps(app) {
    const specs = [
        { name: '/deps', desc: '依赖体检（缺什么/一键装配）', usage: '[install]', group: '系统', fn: (a) => depsCommand(app, a) },
    ];
    app.registerCommands(specs);
}
