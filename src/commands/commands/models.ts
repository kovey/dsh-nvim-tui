/** dsh_tui command: /models — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js'
import { applyModelSelection } from '../core.js'
import type { LlmService } from '../../kernel/types.js'
import type { App } from '../../kernel/app.js'

/** Model ids configured for one provider — read from the settings section
 *  (`llm-<provider>.models`, the same catalog the vision-model switch and
 *  /settings overview use). Best-effort: returns [] when the section is
 *  absent or the schema is unrecognized. */
const configuredModels = (app: App, providerId: string, settingsNs?: string): string[] => {
  const settings = app.svc('settings')
  if (typeof settings?.describe !== 'function') return []
  const wanted = new Set<string>([`llm-${providerId}.models`])
  if (settingsNs !== undefined && settingsNs !== '') wanted.add(settingsNs)
  try {
    for (const d of settings.describe()) {
      if (d.ns === undefined || !wanted.has(d.ns)) continue
      const extract = (v: unknown): string[] => {
        if (Array.isArray(v)) {
          return v.map((m) => String((m as { id?: unknown } | undefined)?.id ?? (m as unknown) ?? ''))
            .filter((x) => x !== '' && x !== 'undefined')
        }
        const arr = (v as { models?: Array<{ id?: unknown } | string> } | undefined)?.models
        if (Array.isArray(arr)) {
          return arr.map((m) => String(typeof m === 'string' ? m : m?.id ?? '')).filter((x) => x !== '')
        }
        return []
      }
      const ids = extract(d.value)
      if (ids.length > 0) return ids
    }
  } catch { /* catalog read is best-effort */ }
  return []
}

/** /models — provider/model catalog popup (sessions-style browse + act):
 *  current selection, live providers with their configured models
 *  (Enter switches), and not-yet-assembled providers pointing at their
 *  settings section. */
export const modelsCommand = async (app: App): Promise<void> => {
  const sel = app.slices.agent.currentSelection()
  const llm = app.runtimeCtx.get('llm') as LlmService | undefined
  if (llm === undefined) {
    app.notice(t('（llm 服务未装配）'))
    return
  }
  const live = llm.listProviders?.() ?? []
  const configurable = llm.listConfigurableProviders?.() ?? []
  if (live.length === 0 && configurable.length === 0) {
    app.notice(t('（没有已注册的 provider；用 /settings 查看模型配置）'))
    return
  }
  const rows: Array<{ label: string; value: string; active?: boolean }> = [{
    label: `▸ 当前模型: ${sel.provider}/${sel.model}${sel.reasoningEffort ? ` ◎${sel.reasoningEffort}` : ''}`,
    value: 'act:current',
    active: true,
  }]
  const liveIds = new Set<string>()
  for (const p of live) {
    const id = String(p.id ?? p.provider ?? '?')
    liveIds.add(id)
    const models = configuredModels(app, id)
    if (models.length > 0) {
      rows.push({ label: `● ${id} · ${String(p.name ?? '')}`, value: `prov:${id}` })
      for (const m of models) {
        const isCur = sel.provider === id && sel.model === m
        rows.push({
          label: `    ${isCur ? '▸ ' : ' '}${m}${isCur ? '（当前）' : ''}`,
          value: `switch:${JSON.stringify({ provider: id, model: m })}`,
        })
      }
    } else {
      rows.push({ label: `● ${id} · ${String(p.name ?? '')}（用 /model ${id}/<模型名> 切换）`, value: `prov:${id}` })
    }
  }
  for (const p of configurable) {
    const pid = String(p.provider ?? '?')
    if (liveIds.has(pid)) continue
    rows.push({
      label: `○ ${pid} · ${String(p.displayName ?? '')} · 未装配（配置段 ${String(p.settingsNs ?? '?')}）`,
      value: `prov:${pid}`,
    })
  }
  const picked = await app.openPicker(t('模型目录（Enter 切换 · 复用 /model 语义）'), rows)
  if (picked === null) return
  if (picked === 'act:current') {
    app.notice(t('已是当前模型'))
    return
  }
  if (picked.startsWith('switch:')) {
    try {
      await applyModelSelection(app, { ...JSON.parse(picked.slice(7)), reasoningEffort: sel.reasoningEffort })
    } catch (err) {
      app.notice(`模型切换失败: ${(err as Error).message}`)
    }
    return
  }
  // prov:<id>: informational rows (unconfigured / non-enumerable providers).
  app.notice(t('该 provider 未装配或模型目录不可枚举（settings.yaml 配置后 /restart）'))
}

export function installModelsCommand(app: App): void {
  app.registerCommands([{ name: '/models', desc: t('模型/供应商目录'), usage: t('模型目录'), group: t('模型'), fn: () => modelsCommand(app) }])
}
