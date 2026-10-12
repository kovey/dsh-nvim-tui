/** dsh_tui command: /commands — one command per file (self-registering,
 *  wired by the commands module index). */
import { t, tf } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'
import type { CommandsService } from '../../kernel/types.js'

/**
 * `/commands` — the OFFICIAL command registry, as seen from the TUI.
 *
 * WHY THIS EXISTS: plugins register slash commands through the official
 * `ctx.commands` API (`@deepseek-ai/dsh-commands`, wired by `dsh-base`). Those
 * commands are invisible to this plugin unless something bridges them — the TUI
 * keeps its own registry for its ~60 interface commands and never looked at the
 * official one. This command is that bridge's discovery side.
 *
 * The two registries are COMPLEMENTARY, not alternatives: the official registry
 * carries in-session commands (a handful) and cannot express the TUI's pickers
 * and floats, while the TUI's registry is the interface itself. So official
 * commands are offered ALONGSIDE ours, and on a name collision OURS WINS — a
 * plugin must not be able to hijack `/sessions`.
 */

/** One official descriptor, normalised for display. */
export interface OfficialCommand {
  name: string
  description: string
  hint?: string
  /** True when the TUI has its own command of the same name (ours wins). */
  shadowed: boolean
}

/**
 * Normalise the registry listing into display rows.
 *
 * Pure, and the collision rule lives here so it is asserted directly: `shadowed`
 * is computed against the TUI's OWN names, not the other way round.
 */
export const officialRows = (
  listed: ReadonlyArray<{ name: string; description: string; input?: { hint?: string } | undefined }>,
  ownNames: ReadonlySet<string>,
): OfficialCommand[] =>
  [...listed]
    .map((d) => {
      const bare = d.name.replace(/^\//, '')
      const hint = d.input?.hint
      return {
        name: bare,
        description: d.description,
        ...(hint === undefined || hint === '' ? {} : { hint }),
        shadowed: ownNames.has('/' + bare),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))

/**
 * Run one OFFICIAL command and report its outcome.
 *
 * Exported because the dispatcher (`commands/core.ts`) needs it too: discovery
 * alone was useless — `/commands` could LIST a plugin command while typing it
 * still said "unknown command", because the submit path only ever consulted the
 * TUI's own registry.
 *
 * The line MUST carry its leading slash: the registry parses the line itself
 * (`parseCommand(line)`), so a bare name is an admission miss. That miss is not
 * a failure and is reported as what it is.
 *
 * @returns true when the official registry ACCEPTED the line (executed it),
 *   false when it declined or the service is absent — the caller decides what
 *   to say, so this never invents an error of its own.
 */
export const runOfficialCommand = async (app: App, agent: unknown, line: string): Promise<boolean> => {
  const cmds = app.svc('commands')
  if (cmds === undefined || typeof cmds.execute !== 'function') return false
  const withSlash = line.startsWith('/') ? line : '/' + line
  let exec: Awaited<ReturnType<CommandsService['execute']>>
  try {
    exec = await cmds.execute(agent, withSlash, [], new AbortController().signal)
  } catch (err) {
    app.notice(tf('命令失败: {0}', [(err as Error).message]))
    return true
  }
  if (exec === undefined) return false
  const { kind, text } = exec.result
  if (kind === 'error') {
    app.notice(tf('命令失败: {0}', [text]))
    return true
  }
  app.notice(text !== undefined && text !== '' ? text : tf('{0} 已执行', [withSlash]))
  return true
}

/** `/commands [名称]` — list the official registry, or run one of its commands. */
export const officialCommandsCommand = async (app: App, a: string | undefined) => {
  const rec = app.slices.sessions.activeId === null
    ? undefined
    : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (!rec) {
    app.notice(t('无活跃会话'))
    return
  }
  const cmds = app.svc('commands')
  if (cmds === undefined || typeof cmds.list !== 'function') {
    app.notice(t('官方命令注册表未装配（dsh-commands 服务不存在 —— 检查 dsh-base 是否在 bundles 里）'))
    return
  }
  const wanted = (a ?? '').trim().replace(/^\//, '')
  if (wanted !== '') {
    // An explicit name runs directly. The NAME MUST NOT start with a slash here:
    // the registry parses the line itself.
    await runOfficialCommand(app, rec.handle.agent, wanted)
    return
  }
  const own = new Set(app.commandSpecs.map((s) => s.name))
  let listed: ReadonlyArray<{ name: string; description: string; input?: { hint?: string } | undefined }>
  try {
    listed = cmds.list(rec.handle.agent)
  } catch (err) {
    app.notice(tf('读取官方命令失败: {0}', [(err as Error).message]))
    return
  }
  const rows = officialRows(listed, own)
  if (rows.length === 0) {
    app.notice(t('官方注册表里没有命令（没有插件注册过）'))
    return
  }
  const shadowed = rows.filter((r) => r.shadowed).length
  const lines = [
    tf('{0} 条官方命令{1}', [
      String(rows.length),
      shadowed > 0 ? tf('（{0} 条与 TUI 同名，TUI 优先）', [String(shadowed)]) : '',
    ]),
    '',
    ...rows.map((r) => `${r.shadowed ? '·' : '＋'} /${r.name}${r.hint ? ' ' + r.hint : ''} — ${r.description}`),
  ]
  const sel = await app.openPicker(t('官方命令注册表（Enter 执行所选项）'), [
    { label: t('↩ 关闭'), value: 'act:close' },
    ...rows.map((r) => ({
      label: `${r.shadowed ? '·' : '＋'} /${r.name} — ${r.description}`,
      value: `run:${r.name}`,
    })),
  ])
  if (sel === null || sel === 'act:close') {
    await app.luaCall('require("dsh_tui").show_lines_float(...)', [t('官方命令'), lines]).catch(() => {})
    return
  }
  if (sel.startsWith('run:')) await runOfficialCommand(app, rec.handle.agent, sel.slice(4))
}

export function installOfficialCommandsCommand(app: App): void {
  app.registerCommands([
    {
      name: '/commands',
      desc: t('官方命令注册表（插件注册的命令）'),
      usage: t('[名称]'),
      group: t('信息'),
      args: [{ kind: 'free', label: '[名称]', hint: t('不填则列出官方注册表') }],
      fn: (a?: string) => officialCommandsCommand(app, a),
    },
  ])
}
