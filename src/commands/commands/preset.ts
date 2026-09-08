/** dsh_tui command: /preset — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'


/** /preset [id] — agent presets (标准/PTC/极简/创造 + user roots).
 *  Mirrors the official `agentPresets.select` flow (dsh-host-apiproxy):
 *  a session's composition is fixed once any turn has run, so switching
 *  afterwards is a caller error (agent-preset-locked). On a blank
 *  session the switch must re-link the live agent (recompose) AND record
 *  `agent-preset/selected` in the session log — the log event alone does
 *  not move the running agent. */
export const presetCommand = async (app: App, a: string | undefined) => {
  const presets = app.svc('agentPresets')
  if (!presets?.list || typeof presets.recompose !== 'function') {
    app.notice(t('agent-presets 服务未装配（在 profile patch 中加入该行）'))
    return
  }
  try {
    if (!a) {
      for (const p of await presets.list()) app.notice(`${p.id} · ${p.name ?? ''}`)
      return
    }
    const rec = app.slices.sessions.activeId === null ? undefined : app.slices.sessions.live.get(app.slices.sessions.activeId)
    const agent = rec?.handle.agent
    if (!agent) {
      app.notice(t('没有活动会话，无法切换预设'))
      return
    }
    // Official blank rule (sessionBlank in dsh-host-apiproxy): blank =
    // no `turn/start` event yet. Standalone events like /plan and /goal
    // keep a session blank; any started turn locks the preset, because
    // the history was produced under the old composition's tools.
    if (app.slices.trans.sessionEvents(agent.session).some((e) => e.type === 'turn/start')) {
      app.notice(t('预设已锁定: 会话已开始，官方规则下预设只能在空白会话切换（请新开会话后再试）'))
      return
    }
    const applied = await presets.recompose(agent.ctx, a)
    agent.session.append('agent-preset/selected', { agentPreset: applied.id })
    app.notice(`已切换预设: ${applied.id}`)
  } catch (err) {
    app.notice(`preset 失败: ${(err as Error).message}`)
  }
}

export function installPresetCommand(app: App): void {
  app.registerCommands([{ name: '/preset', desc: t('agent 预设（仅空白会话可切换）'), usage: t('[id]'), group: t('模型'), fn: (a) => presetCommand(app, a) }])
}
