/** dsh_tui command: /settings — one command per file (self-registering,
 *  wired by the commands module index). */
import { t, tf } from '../../kernel/i18n.js'
import { apiKeyConfigured, keyRefForProvider, credentialsPath } from '../../kernel/apikey.js'
import type { App } from '../../kernel/app.js'


/** /settings [edit] — settings overview; `edit` opens settings.yaml in
 *  a new nvim tab (the official document is hot-reloaded). */
export const settingsCommand = async (app: App, a: string | undefined) => {
  const settings = app.svc('settings')
  if (settings === undefined) {
    app.notice(t('settings 服务未装配'))
    return
  }
  try {
    const setArg = (a ?? '').trim()
    if (setArg.startsWith('set ')) {
      // /settings set <ns> <key.path> <value> — the namespace is a
      // registered settings section (see the overview); typed value
      // (true/false, number, JSON, else string), nested path into the patch.
      const rest = setArg.slice(4).trim()
      const m = rest.match(/^(\S+)\s+(\S+)\s+([\s\S]+)$/)
      if (m === null) {
        app.notice(t('用法: /settings set <ns> <key.path> <value>（ns 见概览，如 agent-default-model）'))
        return
      }
      const [, ns, keyPath, rawValue] = m
      if (ns === undefined || keyPath === undefined || rawValue === undefined) {
        app.notice(t('用法: /settings set <ns> <key.path> <value>（ns 见概览，如 agent-default-model）'))
        return
      }
      const path = keyPath.split('.').filter((seg) => seg !== '')
      if (path.length === 0) {
        app.notice(t('用法: /settings set <ns> <key.path> <value>（ns 见概览，如 agent-default-model）'))
        return
      }
      const raw = rawValue.trim()
      let value: unknown = raw
      if (raw === 'true') value = true
      else if (raw === 'false') value = false
      else if (raw === 'null') value = null
      else if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw)
      else { try { value = JSON.parse(raw) } catch {} }
      const patch: Record<string, unknown> = {}
      let node = patch
      for (let i = 0; i < path.length - 1; i++) {
        const seg = path[i] as string
        node = node[seg] = (node[seg] as Record<string, unknown> | undefined) ?? {}
      }
      node[path[path.length - 1] as string] = value
      try {
        if (typeof settings.update !== 'function') throw new Error(t('update 不可用'))
        await settings.update(ns, patch)
        // Never echo secret-looking values: the transcript is persisted and
        // visible in the chat buffer (api keys, tokens, credentials paths).
        const SECRET_RE = /(api[-_]?key|secret|token|password|credential|authorization|bearer)/i
        const shown = SECRET_RE.test(`${ns}.${keyPath}`) || SECRET_RE.test(raw)
          ? '••••（已隐藏）'
          : JSON.stringify(value)
        app.notice(tf('已更新设置 {0}.{1} = {2}', [ns, keyPath, shown]))
      } catch (err) {
        app.notice(tf('设置更新失败: {0}', [(err as Error).message]))
      }
      return
    }
    if (setArg === 'edit') {
      const path = await settings.prepareDocument?.()
      if (typeof path !== 'string' || path === '') {
        app.notice(t('settings 文档不可编辑（非文件存储）'))
        return
      }
      await app.luaCall('require("dsh_tui").open_file_tab(...)', [path]).catch(() => {})
      app.notice(tf('已在 nvim 新标签页打开 settings 文档: {0}（保存后热重载）', [path]))
      return
    }
    // Official SettingsDescriptor shape: { ns, schema, value, revision,
    // base?, user?, applies, secrets? } — one descriptor per namespace.
    // The overview renders each namespace's resolved value (redacted,
    // pretty-printed) with user-overridden top-level keys starred.
    const desc = (settings.describe?.({ redactSecrets: true }) ?? []) as Array<{
      ns?: unknown; value?: unknown; user?: unknown; revision?: number; applies?: unknown
    }>
    const docPath = await settings.prepareDocument?.().catch(() => undefined)
    // API-key credential section: presence check mirrors the llm adapters
    // (credentials seam → ambient env), never prints the value.
    const keyProvider = app.slices.agent.currentSelection().provider
    const keyRef = keyRefForProvider(keyProvider)
    const keyOk = await apiKeyConfigured(app, keyProvider)
    const lines = [
      '🔑 API key 凭证',
      `${t('provider 路由')}: ${keyProvider} → ${t('凭证引用')} ${keyRef}`,
      `${t('状态')}: ${keyOk ? '✓' : '⚠'} ${keyOk ? t('已配置') : t('未配置')}`,
      `${t('凭证文件')}: ${credentialsPath()}（refs: ${keyRef}: <key>）`,
      `${t('环境变量')}: export ${keyRef}=<key> · ${t('官方 Models 页面（web）也可写入凭证库')}`,
      '',
      'settings 文档: ' + (settings.documentPath ?? docPath ?? '（非文件）') + ' · 可写: ' + (settings.writable ? '是' : '否'), '',
    ]
    let total = 0
    for (const d of desc) {
      lines.push(`▸ ${String(d.ns ?? '(unnamed)')}${d.applies !== undefined ? ` · ${String(d.applies)}` : ''}${d.revision !== undefined ? ` · rev ${d.revision}` : ''}`)
      const userKeys = d.user !== null && typeof d.user === 'object' ? Object.keys(d.user as Record<string, unknown>) : []
      const valueText = JSON.stringify(d.value, null, 2) ?? String(d.value ?? '')
      for (const line of valueText.split('\n')) {
        if (total++ > 60) break
        const key = line.match(/^\s*"([^"]+)"/)?.[1]
        const starred = key !== undefined && userKeys.includes(key) ? '* ' : '  '
        lines.push(`${starred}${line}`)
      }
      if (total > 60) break
    }
    lines.push('', t('常用修改: i/o 在此打开配置文件编辑（保存后热重载）；/settings set <key.path> <value> 即时写入；/model /effort /theme /permission 即时生效'))
    void app.luaCall('require("dsh_tui").show_lines_float(...)', [t('设置'), lines, typeof docPath === 'string' ? docPath : null]).catch(() => {})
  } catch (err) {
    app.notice(tf('settings 失败: {0}', [(err as Error).message]))
  }
}

export function installSettingsCommand(app: App): void {
  app.registerCommands([{ name: '/settings', desc: t('设置总览/编辑'), usage: t('[edit]'), group: t('系统'), fn: (a) => settingsCommand(app, a) }])
}
