/** dsh_tui deps module SERVICES: the health-check machinery (shared by
 *  the /deps command and the install path). */
import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runningProfileName } from '../kernel/profile.js'
import { findVisionModel } from '../kernel/vision.js'
import type { App, AppSlices } from '../kernel/app.js'
import { t, tf } from '../kernel/i18n.js'
/** One assembly row: package identity + the exact YAML appended to the patch. */
interface RowTemplate {
  pkg: string
  /** Relative file inside the package proving it exists in the install. */
  file: string
  yaml: string
}

const ROW_TEMPLATES: Record<string, RowTemplate> = {
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
}

type DepStatus = 'ok' | 'warn' | 'missing'

export interface DepReport {
  id: string
  label: string
  /** Display group label (translated at render time). */
  group: string
  status: DepStatus
  detail: string
  /** RowTemplate key: the item can be assembled with /deps install. */
  fixId?: string | undefined
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export const dshHome = () => process.env['DSH_HOME'] ?? join(homedir(), '.dsh')

/** The profile patch path: the RUNNING profile's cordis.patch.yml.
 *  The running profile always bundles dsh-nvim-tui (the TUI is mounted
 *  through it), so a loader/argv resolution is authoritative; the directory
 *  scan runs ONLY when the running profile cannot be resolved at all. */
export function findProfilePatchPath(app: App): string | null {
  const profilesDir = join(dshHome(), 'profiles')
  const running = runningProfileName(app)
  if (running !== undefined) {
    // Authoritative: the RUNNING profile. A missing file is fine — the write
    // path creates it. Falling back to a directory scan here made `/deps
    // install` able to write into a DIFFERENT profile when the running one
    // had no patch yet.
    return join(profilesDir, running, 'cordis.patch.yml')
  }
  try {
    for (const name of readdirSync(profilesDir)) {
      const pkgPath = join(profilesDir, name, 'package.json')
      if (!existsSync(pkgPath)) continue
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          dsh?: { profile?: { bundles?: string[] } }
        }
        if ((pkg.dsh?.profile?.bundles ?? []).includes('dsh-nvim-tui')) {
          return join(profilesDir, name, 'cordis.patch.yml')
        }
      } catch {}
    }
  } catch {}
  return null
}

/** Structural row ids already present in the patch file (comments ignored). */
export function readPatchRowIds(path: string): Set<string> {
  const ids = new Set<string>()
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const t = line.trim()
      if (t.startsWith('#')) continue
      const m = t.match(/^-\s+id:\s*['"]?([\w-]+)/)
      if (m?.[1] !== undefined) ids.add(m[1])
    }
  } catch {}
  return ids
}

/** A loader entry by row id (for config checks like the search override). */
function loaderEntryConfig<T = Record<string, unknown>>(app: App, id: string): T | undefined {
  try {
    const loader = app.runtimeCtx.get('loader') as unknown as {
      entries?: () => Array<{ options?: { id?: string; config?: unknown } }>
    }
    for (const e of loader?.entries?.() ?? []) {
      if (e.options?.id === id) return e.options.config as T
    }
  } catch {}
  return undefined
}

/** Does the package exist inside the dsh install (hoisted or nested pnpm)?
 *  The install root derives from the dsh bin path; tests override it via
 *  `DSH_NVIM_TUI_INSTALL_ROOT`. */
/** Locate the dsh install root by walking UP from this bundle until an
 *  ancestor owns node_modules/ — robust for npm-global
 *  (…/lib/node_modules) and pnpm layouts alike (counting dirname layers
 *  broke on npm-global: bin.js sits four levels deeper than the root). */
/** Directory of the running dsh PACKAGE (`…/node_modules/@deepseek-ai/dsh`).
 *  Host plugins live in ITS node_modules — the profile's own node_modules
 *  only holds profile-level packages, so resolving against the profile made
 *  `packageExists` false for every host plugin and `/deps install` a no-op. */
const findDshPackageDir = (): string | undefined => {
  // Both starts can be reached through a symlink: argv[1] is often a
  // `node_modules/.bin/dsh` shim, and the plugin itself is normally linked
  // into the profile. Walking up from the UNRESOLVED path never reaches the
  // real package, so probe both the as-given and the realpath form.
  const seeds = [process.argv[1], fileURLToPath(import.meta.url)]
  const starts: string[] = []
  for (const seed of seeds) {
    if (typeof seed !== 'string' || seed === '') continue
    starts.push(seed)
    try {
      const real = realpathSync(seed)
      if (real !== seed) starts.push(real)
    } catch {}
  }
  for (const start of starts) {
    let dir = dirname(start)
    for (let i = 0; i < 12; i++) {
      const pj = join(dir, 'package.json')
      if (existsSync(pj)) {
        try {
          const name = (JSON.parse(readFileSync(pj, 'utf8')) as { name?: unknown }).name
          if (name === '@deepseek-ai/dsh') return dir
        } catch {}
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return undefined
}

const findInstallRoot = (): string | undefined => {
  let dir = dirname(fileURLToPath(import.meta.url)) // lib/deps
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'node_modules'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/** Directories whose `<dir>/node_modules` can hold the dsh packages, most
 *  authoritative first.
 *
 *  `dshDir` itself is first-class: the dsh package keeps its plugins under its
 *  OWN `node_modules` (`<dshDir>/node_modules/@deepseek-ai/<pkg>`) and that path
 *  is the real one for an npm-global install. Taking `dirname(dirname(dshDir))`
 *  instead lands on `…/lib/node_modules`, i.e. it yields the nonsense
 *  `…/lib/node_modules/node_modules/…` and never matches — which is why the
 *  probe only started working once the profile store happened to be present.
 *
 *  Then `<…/lib/node_modules>` (a flat/hoisted layout), the shared profile store
 *  `$DSH_HOME/profiles` (reachable from DSH_HOME alone, so it does not depend on
 *  the launch spelling), and finally the package root as a last resort. */
export const installRootCandidates = (dshDir: string | undefined): string[] => [
  process.env['DSH_NVIM_TUI_INSTALL_ROOT'],
  dshDir, // dsh's own store: <dshDir>/node_modules/…
  dshDir === undefined ? undefined : dirname(dirname(dshDir)), // …/lib/node_modules
  join(dshHome(), 'profiles'), // shared store: $DSH_HOME/profiles/node_modules
  findInstallRoot(), // the profile/pkg root (last resort)
].filter((r, i, a): r is string => typeof r === 'string' && r !== '' && a.indexOf(r) === i)

export function packageExists(pkg: string, file: string): boolean {
  try {
    const pkgName = pkg.startsWith('@') ? pkg.split('/').slice(0, 2).join('/') : pkg.split('/')[0]
    const rel = pkgName + '/' + file
    for (const root of installRootCandidates(findDshPackageDir())) {
      for (const candidate of [
        join(root, 'node_modules', rel),
        join(root, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', rel),
      ]) {
        if (existsSync(candidate)) return true
      }
    }
    return false
  } catch {
    return false
  }
}

/** True when at least one install root could be determined at all. When this
 *  is false the probe has NOT established that a package is absent — it only
 *  failed to find a place to look, which is a different (and actionable)
 *  condition. Callers must not report it as "package not installed". */
export function installRootResolved(): boolean {
  try {
    return installRootCandidates(findDshPackageDir()).length > 0
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------

const svcOk = (app: App, key: string): boolean => app.runtimeCtx.get(key) !== undefined

/** Service keys the host-plugin checks watch (readiness poll after assembly). */
const HOST_SVC_KEYS: Record<string, string> = {
  'agent-presets': 'agentPresets',
  'cordis-host-runner': 'dynamicCordisRunner',
  'file-reference': 'fileReferences',
  workspace: 'workspaceRegistry',
  'plugin-inventory': 'pluginInventory',
  'message-feedback': 'messageFeedback',
  'session-reference': 'sessionReferenceResolver',
  'session-stats': 'sessionStats',
  'code-runtime': 'codeRuntime',
  'subagent-model-selection-settings': 'subagentModelSelection',
}

/** Is a just-assembled fix live yet (HMR re-composed the loader rows)? */
function fixLive(app: App, fixId: string): boolean {
  if (fixId === 'search-override') {
    const cfg = loaderEntryConfig<{ openAt?: string }>(app, 'session-query-sqlite')
    return cfg?.openAt !== undefined && cfg.openAt !== 'never'
  }
  const key = HOST_SVC_KEYS[fixId]
  return key === undefined || svcOk(app, key)
}

/** Poll the just-written rows until live (HMR) or the deadline passes.
 *  Returns the ids that are still not live. */
async function waitFixLive(app: App, fixIds: string[], timeoutMs: number): Promise<string[]> {
  let pending = fixIds.filter((id) => !fixLive(app, id))
  const deadline = Date.now() + timeoutMs
  while (pending.length > 0 && Date.now() < deadline) {
    await app.sleep(700)
    pending = pending.filter((id) => !fixLive(app, id))
  }
  return pending
}

export async function checkAll(app: App, s: AppSlices['agent'], patchPath: string | null): Promise<DepReport[]> {
  const patchIds = patchPath === null ? new Set<string>() : readPatchRowIds(patchPath)
  const reports: DepReport[] = []

  const host = (id: string, label: string, detail: string, key?: string) => {
    const ok = key === undefined
      ? patchIds.has(id) || svcOk(app, id)
      : svcOk(app, key)
    const present = patchIds.has(id)
    reports.push({
      id, label, group: t('主机插件'),
      status: ok ? 'ok' : 'missing',
      detail: ok ? detail : (present ? `${detail}（已装配但服务未就绪，重启后重试 /deps）` : `未装配 — 影响: ${detail}`),
      fixId: ok ? undefined : id,
    })
  }

  host('agent-presets', 'agent-presets', '/preset agent 预设', 'agentPresets')
  host('cordis-host-runner', 'cordis-host-runner', 'cordis 预设（/preset ptc）', 'dynamicCordisRunner')
  host('file-reference', 'file-reference', '@ 文件引用补全', 'fileReferences')
  host('workspace', 'workspace', '/workspace 工作区与 /archive 归档', 'workspaceRegistry')
  host('plugin-inventory', 'plugin-inventory', '/plugins 插件清单', 'pluginInventory')
  host('message-feedback', 'message-feedback', '/fb 消息反馈', 'messageFeedback')
  host('session-reference', 'session-reference', '💬 跨会话引用补全', 'sessionReferenceResolver')
  host('session-stats', 'session-stats', '状态栏 TTFT / tok/s', 'sessionStats')
  host('code-runtime', 'code-runtime', '/preset ptc 的 run_code', 'codeRuntime')
  host('subagent-model-selection-settings', 'subagent-model-selection-settings', '子代理独立模型设置', 'subagentModelSelection')

  // -- 配置生效性 -----------------------------------------------------------
  const searchCfg = loaderEntryConfig<{ openAt?: string }>(app, 'session-query-sqlite')
  const searchOn = searchCfg?.openAt !== undefined && searchCfg.openAt !== 'never'
  reports.push({
    id: 'search', label: '/search 全文搜索索引', group: '配置生效性',
    status: searchOn ? 'ok' : 'warn',
    detail: searchOn ? `openAt=${searchCfg!.openAt}，索引持久化于 DSH_HOME` : 'session-query-sqlite 配置为 :memory: + never（库从不建立，搜索恒空）',
    fixId: searchOn ? undefined : 'search-override',
  })

  // 官方识图模型：目录中存在声明 image 模态的模型（0.1.5 默认目录里的
  // deepseek-flash / deepseek-v4-flash-vision-exp，或自定义目录中任意声明
  // image 的模型）时，图片消息会自动切换该模型处理。
  let visionModel: string | undefined
  try {
    const sel = s.currentSelection()
    visionModel = await findVisionModel(app, sel.provider)
  } catch {}
  reports.push({
    id: 'vision-model', label: '官方识图模型', group: '配置生效性',
    status: visionModel === undefined ? 'warn' : 'ok',
    detail: visionModel === undefined
      ? '目录中没有声明 image 模态的模型 — 影响: 图片消息无法发送（settings.yaml 的 llm-deepseek.models 加入 deepseek-flash 或 deepseek-v4-flash-vision-exp 并声明 inputModalities: [text, image]）'
      : `已就绪: ${visionModel}（图片消息自动切换，回合结束切回）`,
  })

  const feishuEntry = loaderEntryConfig(app, 'feishu')
  const creds = existsSync(join(dshHome(), 'feishu-app.json')) ||
    existsSync(join(process.cwd(), '.dsh', 'feishu-app.json'))
  reports.push({
    id: 'feishu', label: 'feishu 飞书集成', group: '配置生效性',
    status: feishuEntry === undefined ? 'warn' : (creds ? 'ok' : 'warn'),
    detail: feishuEntry === undefined
      ? '未装配 — 影响: 飞书消息/卡片（手动: 加入 profile bundles）'
      : (creds ? '插件已装配，凭据已找到' : '插件已装配，但 feishu-app.json 凭据缺失（飞书功能本会话禁用）'),
  })

  // -- 系统命令 -------------------------------------------------------------
  // `stdio: 'ignore'` made pnpm.stdout always null → the version was blank.
  // Capture stdout, keep the probe bounded (2s; it is synchronous and blocks
  // the whole runner while it waits).
  const pnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8', timeout: 2000 })
  const pnpmVersion = String(pnpm.stdout ?? '').trim()
  reports.push({
    id: 'pnpm', label: 'pnpm', group: '系统命令',
    status: pnpm.status === 0 ? 'ok' : 'warn',
    detail: pnpm.status === 0
      ? `pnpm ${pnpmVersion !== '' ? pnpmVersion : '(版本未知)'}（/market 安装器可用）`
      : '未找到 pnpm — 影响: /market 安装插件（npm i -g pnpm 或 corepack enable）',
  })

  return reports
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

export const installCommand = async (app: App, s: AppSlices['agent']): Promise<void> => {
  const patchPath = findProfilePatchPath(app)
  if (patchPath === null) {
    app.notice(t('未定位 profile 的 cordis.patch.yml（DSH_HOME/profiles 下没有包含 dsh-nvim-tui bundle 的 profile），无法自动装配'))
    return
  }
  const reports = (await checkAll(app, s, patchPath)).filter((r) => r.fixId !== undefined)
  if (reports.length === 0) {
    app.notice(t('没有可一键装配的缺失项（/deps 查看完整报告）'))
    return
  }
  const sel = await app.openPicker(t('一键装配（选择要写入 profile patch 的行）'), [
    { label: `全部缺失项（${reports.length} 项）`, value: 'all' },
    ...reports.map((r) => ({ label: `${r.status === 'missing' ? '✗' : '⚠'} ${r.label}`, value: r.id })),
  ])
  if (sel === null) return
  const targets = sel === 'all' ? reports : reports.filter((r) => r.id === sel)
  const ids = readPatchRowIds(patchPath)
  // Rows the RUNNING loader already carries (any layer): appending a second
  // row with the same id makes the host loader fail the whole composition.
  try {
    const loader = app.runtimeCtx.get('loader') as unknown as { entries?: () => Array<{ id?: string }> } | undefined
    for (const e of loader?.entries?.() ?? []) if (typeof e?.id === 'string') ids.add(e.id)
  } catch {}
  const appended: string[] = []
  const skipped: string[] = []
  const assembledIds: string[] = []
  const insertBlocks: string[] = []
  const topBlocks: string[] = []
  for (const r of targets) {
    const fixId = r.fixId as string
    const tpl = ROW_TEMPLATES[fixId]
    if (tpl === undefined) continue
    const rowId = fixId === 'search-override' ? 'session-query-sqlite' : fixId
    if (ids.has(rowId)) { skipped.push(r.label); continue }
    if (!packageExists(tpl.pkg, tpl.file)) {
      // "Could not locate the install" is NOT "the package is missing": the
      // old wording told users to upgrade dsh even when the package was
      // present and only the root probe failed, which hid the whole feature.
      app.notice(
        installRootResolved()
          ? tf('跳过 {0}: 包 {1} 不在当前 dsh 安装中（升级 dsh 后重试）', [r.label, tpl.pkg])
          : tf('跳过 {0}: 无法定位 dsh 安装根，未能确认包 {1} 是否存在（重启 dsh 后重试）', [r.label, tpl.pkg]),
      )
      continue
    }
    appended.push(r.label)
    assembledIds.push(fixId)
    ids.add(rowId)
    if (fixId === 'search-override') topBlocks.push(tpl.yaml)
    else insertBlocks.push(tpl.yaml)
  }
  if (appended.length === 0) {
    app.notice(skipped.length > 0 ? t('所选行均已存在于 patch 中，无需写入') : t('没有可写入的行'))
    return
  }
  try {
    let block = ''
    if (insertBlocks.length > 0) {
      block += '\n# [dsh-nvim-tui /deps] 自动装配行\n- insert:\n' + insertBlocks.join('\n') + '\n'
    }
    if (topBlocks.length > 0) {
      block += '\n# [dsh-nvim-tui /deps] 自动装配（覆盖型）\n' + topBlocks.join('\n') + '\n'
    }
    appendFileSync(patchPath, block)
    app.notice(tf('已装配 {0} 项（写入 {1}，loader 热重载中…）', [appended.length, patchPath.replace(dshHome(), '~')]))
    if (skipped.length > 0) app.notice(tf('跳过已存在的行: {0}', [skipped.join('、')]))
    // 一步到位：等 HMR 把新行组合进来；等不到就自动重启（重启后服务必然就绪）。
    const pending = await waitFixLive(app, assembledIds, 6000)
    if (pending.length === 0) {
      app.notice(tf('✓ 装配完成 · {0} 项服务已全部就绪（免重启）', [appended.length]))
    } else {
      app.notice(tf('装配已写入，但 {0} 项服务需重启生效 — 正在自动重启 dsh…', [pending.length]))
      app.slices.runtime.setRestartPending(true)
      setTimeout(() => void app.quit(0), 300)
    }
  } catch (err) {
    app.notice(tf('装配失败: {0}', [(err as Error).message]))
  }
}
