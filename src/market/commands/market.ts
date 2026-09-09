/** dsh_tui command: /market — one command per file. */
import { locale, t } from '../../kernel/i18n.js'
import { renameSync } from 'node:fs'
import { join } from 'node:path'
import type { App } from '../../kernel/app.js'
import type { MarketEntry } from '../progress.js'
import {
  fetchCatalog, readCatalog, writeCatalog, isFresh, searchCatalog,
  readInstalledPlugins, runningProfileName, installSpec, openUrl,
  openProgress, runPluginCliP, installWithRepair, resolveNpmSpec, readRepoPackage,
  patchPath, readPatch, readDisabledIds, setDisabledRows, writePatch,
  isNpmName, latestVersion, depMatchesEntry,
  profileDir, classifyPnpmError, firstErrorLine,
} from '../progress.js'

export const marketCommand = async (app: App, a: string | undefined): Promise<void> => {
  const arg = (a ?? '').trim()
  const profileName = runningProfileName() ?? String(app.config.marketProfile ?? 'nvim-tui')
  const registryBase = typeof app.config.marketRegistryBase === 'string' && app.config.marketRegistryBase !== ''
    ? app.config.marketRegistryBase
    : undefined
  const ttl = typeof app.config.marketCacheTtlMs === 'number' ? app.config.marketCacheTtlMs : undefined
  if (arg === 'refresh') {
    app.notice(t('正在同步插件市场目录…'))
    try {
      const catalog = await fetchCatalog({ base: registryBase })
      writeCatalog(catalog)
      app.notice(`${catalog.entries.length} ${t('个插件已更新（按 GitHub 星标倒序）')}`)
    } catch (err) {
      app.notice(`市场同步失败: ${(err as Error).message}（仍可用本地缓存）`)
    }
    return
  }
  if (arg === 'update-all') {
    const pg = openProgress(app, '更新全部插件')
    void (async () => {
      pg.log('· dsh plugin update（可能需要一两分钟）…')
      pg.bar('▸ 更新全部依赖…')
      const r = await runPluginCliP(profileName, ['update'], pg)
      pg.bar(r.code === 0 ? '✓ 全部插件已更新（重启 dsh 后生效）' : `✗ 更新失败 · ${firstErrorLine(r.tail)}`)
      pg.close(1500)
      app.notice(r.code === 0 ? t('全部插件已更新（重启 dsh 后生效）') : `update-all 失败: ${firstErrorLine(r.tail)}`)
    })()
    return
  }
  let catalog = readCatalog()
  if (!isFresh(catalog, ttl)) {
    app.notice(t('正在同步插件市场目录…（首次需要数秒）'))
    try {
      catalog = await fetchCatalog({ base: registryBase })
      writeCatalog(catalog)
    } catch (err) {
      app.notice(`市场同步失败: ${(err as Error).message}${catalog !== null ? t('（用本地缓存）') : ''}`)
      if (catalog === null) return
    }
  }
  if (catalog === null || catalog.entries.length === 0) {
    app.notice(t('（市场目录为空，/market refresh 重试）'))
    return
  }
  const installed = readInstalledPlugins(profileName)
  const patchText = readPatch(patchPath(profileName))
  const disabledIds = readDisabledIds(patchText)
  const loader = app.svc('loader')
  const loaderEntries = typeof loader?.entries === 'function' ? loader.entries().filter((e) => !e.options?.group) : []
  const entries = arg === '' ? catalog.entries.slice(0, 120) : searchCatalog(catalog.entries, arg).slice(0, 120)
  if (entries.length === 0) {
    app.notice(`没有匹配「${arg}」的插件`)
    return
  }
  // Installed-dep matching + update checks (only for installed rows;
  // npm registry lookups are cached 5 min in-memory).
  const updates = new Map<string, string>() // depKey -> latest
  const matchFor = (e: MarketEntry): string | undefined => {
    for (const depKey of installed.deps.keys()) {
      if (depMatchesEntry(depKey, e)) return depKey
    }
    return undefined
  }
  await Promise.all([...new Set(
    entries.map(matchFor).filter((k): k is string => k !== undefined),
  )].slice(0, 10).map(async (depKey) => {
    if (!isNpmName(depKey)) return
    const current = installed.versions.get(depKey)
    const latest = await latestVersion(depKey)
    if (latest !== undefined && current !== undefined && latest !== current) updates.set(depKey, latest)
  }))
  const rows = entries.map((e: MarketEntry) => {
    const depKey = matchFor(e)
    const isInstalled = depKey !== undefined
    const matching = loaderEntries.filter((le) => le.options?.name === depKey || depMatchesEntry(le.options?.name ?? '', e))
    const allDisabled = matching.length > 0 && matching.every((le) => le.disabled === true || disabledIds.has(le.id))
    const mark = isInstalled ? (allDisabled ? ' ⊘' : ' ✓') : ''
    const up = depKey !== undefined && updates.has(depKey) ? ' ↑' : ''
    const desc = (locale() === 'en' ? e.descEn : e.descZh) || e.descEn || ''
    return {
      label: `★${e.stars}${mark}${up} · ${e.name} · ${desc.replace(/\s+/g, ' ').slice(0, 32)}`,
      value: e.name,
    }
  })
  const sel = await app.openPicker(`插件市场（★ 倒序 · ${profileName}）`, rows)
  if (sel === null) return
  const entry = entries.find((e) => e.name === sel)
  if (entry === undefined) return
  const depKey = matchFor(entry)
  const isInstalled = depKey !== undefined
  const matching = loaderEntries.filter((le) => le.options?.name === depKey || depMatchesEntry(le.options?.name ?? '', entry))
  const togglable = matching.filter((le) => le.id !== 'nvim-tui-runner' && le.options?.name !== 'dsh-nvim-tui')
  const anyEnabled = matching.some((le) => le.disabled !== true && !disabledIds.has(le.id))
  const desc = (locale() === 'en' ? entry.descEn : entry.descZh) || entry.descEn || ''
  const actions: Array<{ label: string; value: string }> = []
  if (!isInstalled) {
    actions.push({ label: `安装到 ${profileName} profile`, value: 'install' })
  } else {
    actions.push({ label: t('更新到最新'), value: 'update' })
    if (togglable.length > 0) {
      actions.push({ label: anyEnabled ? '停用（热切换，HMR 免重启）' : '启用（热切换，HMR 免重启）', value: 'toggle' })
    }
    actions.push({ label: t('卸载（二次确认）'), value: 'uninstall' })
  }
  actions.push({ label: t('打开 GitHub 页面'), value: 'open' }, { label: t('取消'), value: 'cancel' })
  const act = await app.openPicker(`${entry.name}${desc !== '' ? ` · ${desc.slice(0, 40)}` : ''}`, actions)
  if (act === null || act === 'cancel') return
  if (act === 'open') {
    openUrl(entry.url)
    app.notice(`已在浏览器打开 ${entry.url}`)
    return
  }
  if (act === 'toggle') {
    if (togglable.length === 0) {
      app.notice('该插件没有可热切换的 loader 条目')
      return
    }
    // The action is the FLIP: enabled now → this toggle disables it.
    const target = anyEnabled
    const toggles = togglable.map((le) => ({ id: le.id, disabled: target }))
    const next = setDisabledRows(patchText, toggles)
    writePatch(patchPath(profileName), next)
    app.notice(`${entry.name} 已${target ? '停用' : '启用'}（写入 cordis.patch.yml · HMR 约 1s 内重新组合）`)
    return
  }
  if (act === 'uninstall') {
    // entry.name is the catalog's owner/repo — the SELF is identified by
    // the loader entry's dependency name (options.name), not the repo key.
    // Check the UNFILTERED matching set: togglable has already excluded the
    // self rows, so searching there made this guard permanently false
    // (pre-review) and allowed `dsh plugin remove dsh-nvim-tui` to unload
    // the running TUI.
    const isSelf = matching.some((le) => le.options?.name === 'dsh-nvim-tui')
    if (isSelf) {
      app.notice('不能卸载正在运行的 TUI 插件自身')
      return
    }
    const ok = await app.openPicker(t('确认卸载'), [
      { label: `确认卸载 ${entry.name}（重启 dsh 后生效）`, value: 'yes' },
      { label: t('取消'), value: 'no' },
    ])
    if (ok !== 'yes') return
  }
  const verb = act === 'install' ? 'add' : act === 'update' ? 'update' : 'remove'
  const label = verb === 'add' ? '安装' : verb === 'update' ? '更新' : '卸载'
  const pg = openProgress(app, `${label} ${entry.name}`)
  try {
    if (verb === 'add') {
      // ① Resolve the best source up front (npm publish preferred: a
      // source-only repo installs as metadata-only under pnpm ≥10 and
      // breaks the next boot — the dsh-context incident).
      pg.log('① 解析安装源…')
      pg.bar('▸ 解析安装源…')
      let spec = installSpec(entry)
      if (entry.tarball === undefined) {
        const npmSpec = await resolveNpmSpec(entry)
        if (npmSpec !== undefined) {
          spec = npmSpec
          pg.log(`· 使用 npm 发布版: ${npmSpec}`)
        } else {
          const info = await readRepoPackage(entry.url)
          pg.log(info?.hasPrepare === true
            ? '· npm 无发布版 → 源码包（带 prepare 构建脚本）'
            : '· npm 无发布版 → 先装源码包，装完自动校验入口文件')
        }
      }
      // ② Install with diagnosis + automatic remedies (retry / source
      // swap / lock backup / cache reset), all streamed into the float.
      pg.log('② 安装依赖…')
      await installWithRepair(app, entry, profileName, spec, pg)
      pg.close(1500)
      app.notice(`${entry.name} 安装流程结束（结果见进度窗；多数插件重启 dsh 后生效）`)
      return
    }
    // update / uninstall: run once, then one bounded remedy chain.
    const spec = depKey ?? entry.name
    pg.log(`· dsh plugin ${verb} ${spec}`)
    pg.bar(`▸ ${label} ${entry.name}…`)
    let r = await runPluginCliP(profileName, [verb, spec], pg)
    if (r.code !== 0) {
      const f = classifyPnpmError(r.tail)
      pg.log(`· 诊断: ${f.message}`)
      if (f.kind === 'network') {
        pg.bar('↻ 网络错误 · 2s 后自动重试…')
        await app.sleep(2000)
        r = await runPluginCliP(profileName, [verb, spec], pg)
      } else if (f.kind === 'lockfile') {
        const lock = join(profileDir(profileName), 'pnpm-lock.yaml')
        try {
          renameSync(lock, `${lock}.bak-${Date.now()}`)
          pg.log('· 已备份 pnpm-lock.yaml')
        } catch { pg.log('· 锁文件不存在，无需备份') }
        pg.bar('↻ 锁文件冲突 · 备份后重试…')
        r = await runPluginCliP(profileName, [verb, spec], pg)
      } else if (f.kind === 'cache') {
        pg.bar('↻ 缓存/权限问题 · 改用临时缓存重试…')
        r = await runPluginCliP(profileName, [verb, spec], pg, { npm_config_cache: '/tmp/dsh-pnpm-cache' })
      }
    }
    pg.bar(r.code === 0
      ? `✓ ${label}完成（重启 dsh 后生效）`
      : `✗ ${label}失败 · ${firstErrorLine(r.tail)}`)
    pg.close(1500)
    app.notice(`${entry.name} ${r.code === 0 ? (verb === 'remove' ? t('已卸载') : t('更新完成')) : label + t('失败')}（结果见进度窗）`)
  } catch (err) {
    pg.log(`✗ 异常: ${(err as Error).message}`)
    pg.bar('✗ 流程异常终止（详情见日志）')
    pg.close(2000)
    app.notice(`${entry.name} ${label}流程异常: ${(err as Error).message}`)
  }
}


export function installMarketCommand(app: App): void {
  app.registerCommands([{ name: '/market', desc: '插件市场（GitHub ★ 倒序 · 安装/更新/卸载）', usage: '[关键词 | refresh]', group: '信息', fn: (a) => marketCommand(app, a) }])
}
