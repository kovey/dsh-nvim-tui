/** dsh_tui command: /plugin — direct `dsh plugin` access for packages the
 *  curated marketplace catalog does not list (niche/private/self-hosted
 *  plugins, or a spec you already know).
 *
 *  `/market` is catalog-driven: it can only offer what the registry lists.
 *  This command bypasses the catalog and hands the spec straight to the
 *  official CLI, so any npm name / `owner/repo` / git URL the CLI accepts
 *  works. The marketplace keeps its curated browsing path.
 *
 *  @module dsh-nvim-tui/market/commands/plugin */
import type { App } from '../../kernel/app.js'
import { t, tf } from '../../kernel/i18n.js'
import { runningProfileName } from '../../kernel/profile.js'
import {
  openProgress, runPluginCliP, classifyPnpmError, firstErrorLine,
  profileDir, readInstalledPlugins,
} from '../progress.js'

/** Target profile = the one this process booted with. NEVER guess
 *  `nvim-tui`: installing into another profile would silently do nothing
 *  for the running one (same rule as /market). */
const targetProfile = (app: App): string | undefined => {
  const name = runningProfileName(app) ?? String(app.config['marketProfile'] ?? '')
  return name === '' ? undefined : name
}

/** Parsed `/plugin` argument. Pure — exported for the smoke regression. */
export type PluginSub =
  | { kind: 'usage' }
  | { kind: 'list' }
  | { kind: 'add'; spec: string }
  | { kind: 'remove'; spec: string }
  | { kind: 'missing-spec'; sub: string }
  | { kind: 'bad-spec'; spec: string }

/** Split `/plugin` arguments into a subcommand + spec.
 *
 *  Accepts the same verbs the official CLI does (`add`/`remove`, with
 *  `install`/`uninstall`/`rm`/`ls` as familiar aliases). The spec may itself
 *  contain spaces (a local path) and is passed to the CLI verbatim, so a
 *  leading `-` is rejected here: it would be parsed as a CLI flag. */
export const parsePluginArgs = (a: string | undefined): PluginSub => {
  const raw = (a ?? '').trim()
  if (raw === '') return { kind: 'usage' }
  const sp = raw.indexOf(' ')
  const sub = (sp < 0 ? raw : raw.slice(0, sp)).toLowerCase()
  const rest = sp < 0 ? '' : raw.slice(sp + 1).trim()
  if (sub === 'help') return { kind: 'usage' }
  if (sub === 'list' || sub === 'ls') return { kind: 'list' }
  const isAdd = sub === 'install' || sub === 'add'
  const isRemove = sub === 'remove' || sub === 'uninstall' || sub === 'rm'
  if (!isAdd && !isRemove) return { kind: 'usage' }
  if (rest === '') return { kind: 'missing-spec', sub }
  if (rest.startsWith('-')) return { kind: 'bad-spec', spec: rest }
  return isAdd ? { kind: 'add', spec: rest } : { kind: 'remove', spec: rest }
}

/** One bounded remedy for a failed add, mirroring the remedy the class maps
 *  to. Returns the log tag when a retry is worth attempting. */
const remedyTag = (kind: string): string | undefined => {
  if (kind === 'cache') return t('换用全新 npm cache 重试')
  if (kind === 'lockfile') return t('锁文件冲突，重试')
  if (kind === 'network') return t('网络抖动，重试')
  return undefined
}

const listInstalled = (app: App, profileName: string): void => {
  const installed = readInstalledPlugins(profileName)
  const names = [...installed.deps.keys()].sort()
  const lines: string[] = ['']
  if (names.length === 0) {
    lines.push(t('（该 profile 还没有第三方插件）'))
  } else {
    for (const n of names) {
      const v = installed.versions.get(n)
      lines.push(`· ${n}${v === undefined || v === '' ? '' : ` @ ${v}`}`)
    }
  }
  lines.push('', tf('profile: {0}', [profileName]), `dir: ${profileDir(profileName).replace(process.env['HOME'] ?? '', '~')}`)
  void app.luaCall('require("dsh_tui").show_lines_float(...)', [t('已装插件（该 profile）'), lines]).catch(() => {})
}

const runVerb = async (app: App, profileName: string, verb: 'add' | 'remove', spec: string): Promise<void> => {
  const title = verb === 'add' ? tf('安装插件 {0}', [spec]) : tf('卸载插件 {0}', [spec])
  const pg = openProgress(app, title)
  pg.log(`· dsh plugin --profile ${profileName} ${verb} ${spec}`)
  pg.bar(verb === 'add' ? t('▸ 正在安装…') : t('▸ 正在卸载…'))
  let r = await runPluginCliP(profileName, [verb, spec], pg)
  // One bounded remedy for `add` only — `remove` failing on a flaky cache has
  // nothing to repair, and an unbounded chain is what wedges the float.
  if (r.code !== 0 && verb === 'add') {
    const failure = classifyPnpmError(r.tail)
    const tag = remedyTag(failure.kind)
    if (tag !== undefined) {
      pg.log(tf('⚠ {0} → {1}', [failure.message, tag]))
      const env = failure.kind === 'cache' ? { npm_config_cache: '/tmp/dsh-plugin-cache' } : {}
      r = await runPluginCliP(profileName, [verb, spec], pg, env)
    }
  }
  const ok = r.code === 0
  const detail = ok ? '' : firstErrorLine(r.tail)
  pg.bar(ok
    ? (verb === 'add' ? t('✓ 已安装（重启 dsh 后生效）') : t('✓ 已卸载（重启 dsh 后生效）'))
    : tf('✗ 失败 · {0}', [detail]))
  pg.close(ok ? 1500 : 4000)
  if (ok) {
    app.notice(verb === 'add'
      ? tf('插件 {0} 已安装到 profile {1}（重启 dsh 后生效）', [spec, profileName])
      : tf('插件 {0} 已从 profile {1} 卸载（重启 dsh 后生效）', [spec, profileName]))
  } else {
    app.notice(tf('{0} 失败: {1}', [verb === 'add' ? t('安装') : t('卸载'), detail]))
  }
}

/** /plugin — install/remove/list third-party plugins outside the curated
 *  marketplace catalog. */
export const pluginCommand = async (app: App, a: string | undefined): Promise<void> => {
  const parsed = parsePluginArgs(a)

  const usage = (): void => {
    app.notice([
      t('用法: /plugin install <spec>   安装（npm 名 / owner/repo / git URL）'),
      t('用法: /plugin remove <spec>    卸载'),
      t('用法: /plugin list             列出该 profile 已装插件'),
      t('插件市场里找不到的插件用这个装；/market 走目录浏览。'),
    ].join('\n'))
  }

  if (parsed.kind === 'usage') { usage(); return }
  if (parsed.kind === 'missing-spec') {
    app.notice(tf('缺少包名: /plugin {0} <spec>', [parsed.sub]))
    return
  }
  if (parsed.kind === 'bad-spec') {
    app.notice(tf('无效的包名（不能以 - 开头）: {0}', [parsed.spec]))
    return
  }

  const profileName = targetProfile(app)
  if (profileName === undefined) {
    app.notice(t('无法确定当前运行的 profile（请用 dsh --profile <name> 启动；/plugin 需要知道目标 profile）'))
    return
  }

  if (parsed.kind === 'list') { listInstalled(app, profileName); return }
  await runVerb(app, profileName, parsed.kind === 'add' ? 'add' : 'remove', parsed.spec)
}

export function installPluginCommand(app: App): void {
  app.registerCommands([{
    name: '/plugin',
    desc: t('插件安装/卸载（市场目录之外）'),
    usage: t('[install|remove <spec> | list]'),
    group: t('信息'),
    fn: (a?: string) => pluginCommand(app, a),
  }])
}
