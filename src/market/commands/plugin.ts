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
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  openProgress, runPluginCliP, classifyPnpmError, firstErrorLine,
  profileDir, readInstalledPlugins,
} from '../progress.js'

/** `$DSH_HOME` (or ~/.dsh) abbreviated to `~` for display. Derived from the same
 *  base the host uses, not from HOME: with DSH_HOME set they differ, and a
 *  blind String.replace would also mangle a path merely CONTAINING it. */
const displayHome = (): string => process.env['DSH_HOME'] ?? join(homedir(), '.dsh')

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
  | { kind: 'update'; spec: string; latest: boolean; ref: string | undefined }
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
  const isUpdate = sub === 'update' || sub === 'upgrade'
  if (!isAdd && !isRemove && !isUpdate) return { kind: 'usage' }
  if (isUpdate) {
    const latest = rest.split(/\s+/).includes('--latest')
    const spec = rest.replace(/(^|\s)--latest(?=\s|$)/g, ' ').trim()
    if (spec === '') return { kind: 'missing-spec', sub }
    if (spec.startsWith('-')) return { kind: 'bad-spec', spec }
    // MEASURED (2026-09-16, isolated profile): `pnpm update --latest` does NOT
    // move a `github:owner/repo#tag` dependency — `--latest` only rewrites npm
    // semver ranges, never a git ref. Re-`add`ing with the new ref is the only
    // thing that advances it. So a git spec WITHOUT a ref has nothing to update
    // to: report it as ref-less and let the caller instruct the user, rather
    // than running a command that silently reports success while changing
    // nothing (which is exactly how the old docs misled people).
    return { kind: 'update', spec, latest, ref: gitSpecRef(spec) }
  }
  if (rest === '') return { kind: 'missing-spec', sub }
  if (rest.startsWith('-')) return { kind: 'bad-spec', spec: rest }
  return isAdd ? { kind: 'add', spec: rest } : { kind: 'remove', spec: rest }
}

/** The `#ref` of a git dependency spec, or undefined when there is none.
 *  `undefined` means "no target to move to" for an update.
 *
 *  Accepts both the explicit forms (`github:`, `git+…`, `https://…`) and the
 *  `owner/repo#ref` shorthand users actually type — pnpm normalizes that to
 *  `github:owner/repo#ref` in the manifest, so the shorthand must not be missed
 *  (missing it made `/plugin update owner/repo#v1` look ref-less). */
export const gitSpecRef = (spec: string): string | undefined => {
  const prefixed = /^(github:|git\+|git:|https?:\/\/)/.test(spec)
  // Bare shorthand: exactly `owner/repo` before the `#` (no scheme, one slash).
  const shorthand = !prefixed && /^[^/\s]+\/[^/\s#]+#/.test(spec)
  if (!prefixed && !shorthand) return undefined
  const hash = spec.lastIndexOf('#')
  if (hash < 0) return undefined
  const ref = spec.slice(hash + 1).trim()
  return ref === '' ? undefined : ref
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
  const dir = profileDir(profileName)
  const home = displayHome()
  const shown = dir.startsWith(home) ? '~' + dir.slice(home.length) : dir
  lines.push('', tf('profile: {0}', [profileName]), `dir: ${shown}`)
  void app.luaCall('require("dsh_tui").show_lines_float(...)', [t('已装插件（该 profile）'), lines]).catch(() => {})
}

const runVerb = async (
  app: App,
  profileName: string,
  verb: 'add' | 'remove' | 'update',
  spec: string,
  opts: { latest?: boolean } = {},
): Promise<void> => {
  const title = verb === 'add' ? tf('安装插件 {0}', [spec]) : verb === 'update' ? tf('更新插件 {0}', [spec]) : tf('卸载插件 {0}', [spec])
  const pg = openProgress(app, title)
  const isGit = verb === 'update' && gitSpecRef(spec) !== undefined
  // `pnpm update` cannot move a git ref (measured), so for a git spec the only
  // working verb is `add` — which rewrites the manifest ref. Routing here keeps
  // one code path while being honest about what actually happens.
  const cliVerb = isGit ? 'add' : verb
  const extra = verb === 'update' && !isGit && opts.latest === true ? ['--latest'] : []
  pg.log(`· dsh plugin --profile ${profileName} ${cliVerb} ${spec}${extra.length > 0 ? ' --latest' : ''}`)
  if (isGit) {
    pg.log(t('· git/tag 依赖：改用 add 重写 ref（update --latest 不会推进 git ref —— 已实测）'))
  } else if (verb === 'update' && opts.latest !== true) {
    pg.log(t('· 未指定 --latest：npm 依赖按 semver 范围更新，不会跨大版本'))
  }
  pg.bar(verb === 'add' ? t('▸ 正在安装…') : verb === 'update' ? t('▸ 正在更新…') : t('▸ 正在卸载…'))
  let r = await runPluginCliP(profileName, [cliVerb, spec, ...extra], pg)
  // One bounded remedy for `add` only — `remove` failing on a flaky cache has
  // nothing to repair, and an unbounded chain is what wedges the float.
  if (r.code !== 0 && cliVerb === 'add') {
    const failure = classifyPnpmError(r.tail)
    const tag = remedyTag(failure.kind)
    if (tag !== undefined) {
      pg.log(tf('⚠ {0} → {1}', [failure.message, tag]))
      const env = failure.kind === 'cache' ? { npm_config_cache: '/tmp/dsh-plugin-cache' } : {}
      r = await runPluginCliP(profileName, [cliVerb, spec], pg, env)
    }
  }
  const ok = r.code === 0
  const detail = ok ? '' : firstErrorLine(r.tail)
  pg.bar(ok
    ? (verb === 'add' ? t('✓ 已安装（重启 dsh 后生效）')
      : verb === 'update' ? t('✓ 已更新（重启 dsh 后生效）')
        : t('✓ 已卸载（重启 dsh 后生效）'))
    : tf('✗ 失败 · {0}', [detail]))
  pg.close(ok ? 1500 : 4000)
  if (ok) {
    app.notice(verb === 'add'
      ? tf('插件 {0} 已安装到 profile {1}（重启 dsh 后生效）', [spec, profileName])
      : verb === 'update'
        ? tf('插件 {0} 已更新（profile {1}，重启 dsh 后生效）', [spec, profileName])
        : tf('插件 {0} 已从 profile {1} 卸载（重启 dsh 后生效）', [spec, profileName]))
  } else {
    app.notice(tf('{0} 失败: {1}', [
      verb === 'add' ? t('安装') : verb === 'update' ? t('更新') : t('卸载'), detail,
    ]))
  }
}

/** /plugin — install/remove/list third-party plugins outside the curated
 *  marketplace catalog. */
export const pluginCommand = async (app: App, a: string | undefined): Promise<void> => {
  const parsed = parsePluginArgs(a)

  const usage = (): void => {
    app.notice([
      t('用法: /plugin install <spec>   安装（npm 名 / owner/repo / git URL）'),
      t('用法: /plugin update <spec> [--latest]   更新 npm 依赖（--latest 跨大版本）'),
      t('用法: /plugin update <owner/repo#vX.Y.Z>  更新 git/tag 依赖（必须带新 ref）'),
      t('用法: /plugin remove <spec>    卸载'),
      t('用法: /plugin list             列出该 profile 已装插件'),
      t('插件市场里找不到的插件用这个装/更新；/market 走目录浏览（含 update-all）。'),
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
  if (parsed.kind === 'update') {
    await runVerb(app, profileName, 'update', parsed.spec, { latest: parsed.latest })
    return
  }
  await runVerb(app, profileName, parsed.kind === 'add' ? 'add' : 'remove', parsed.spec)
}

export function installPluginCommand(app: App): void {
  app.registerCommands([{
    name: '/plugin',
    desc: t('插件安装/更新/卸载（市场目录之外）'),
    usage: t('[install|update|remove <spec> [--latest] | list]'),
    group: t('信息'),
    fn: (a?: string) => pluginCommand(app, a),
  }])
}
