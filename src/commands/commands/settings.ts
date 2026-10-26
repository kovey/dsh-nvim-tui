/** dsh_tui command: /settings — one command per file (self-registering,
 *  wired by the commands module index). */
import { existsSync, writeFileSync } from 'node:fs'
import { t, tf } from '../../kernel/i18n.js'
import { apiKeyConfigured, keyRefForProvider, credentialsPath } from '../../kernel/apikey.js'
import { promptLine } from '../../kernel/prompt.js'
import type { SettingsService } from '../../kernel/types.js'
import type { App } from '../../kernel/app.js'


/** Type one setting value. Mirrors `/settings set`: booleans, null, numbers
 *  and JSON literals are typed; everything else is a plain string. Exported so
 *  the rule is asserted without touching a settings document. */
export const parseSettingValue = (raw: string): unknown => {
  const text = raw.trim()
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  if (text.startsWith('{') || text.startsWith('[') || text.startsWith('"')) {
    try { return JSON.parse(text) } catch { return raw }
  }
  return raw
}

/** Prompt-and-write one top-level field of a settings namespace. Complex
 *  nested values stay on `/settings edit`; this covers the common knobs
 *  (default model, provider, booleans, numbers) without a raw YAML hop. */
const editSettingField = async (app: App, settings: SettingsService, nsArg: string): Promise<void> => {
  const descriptors = settings.describe?.({ redactSecrets: true }) ?? []
  if (descriptors.length === 0) {
    app.notice(t('没有可编辑的设置命名空间'))
    return
  }
  const pickNs = async (): Promise<(typeof descriptors)[number] | undefined> => {
    if (nsArg !== '') return descriptors.find((d) => d.ns === nsArg)
    const picked = await app.openPicker(t('设置命名空间'), descriptors.map((d) => ({
      label: `${String(d.ns ?? '(unnamed)')}${typeof d.revision === 'number' ? ` · rev ${String(d.revision)}` : ''}`,
      value: String(d.ns ?? ''),
    })))
    if (picked === null) return undefined
    return descriptors.find((d) => String(d.ns ?? '') === picked)
  }
  const desc = await pickNs()
  if (desc === undefined) {
    if (nsArg !== '') app.notice(tf('找不到设置命名空间: {0}', [nsArg]))
    return
  }
  const ns = String(desc.ns ?? '')
  if (typeof settings.update !== 'function') {
    app.notice(t('该设置存储不可写（settings.update 缺失）'))
    return
  }
  const value = desc.value !== null && typeof desc.value === 'object' ? desc.value as Record<string, unknown> : {}
  const fields = Object.keys(value)
  if (fields.length === 0) {
    app.notice(tf('{0} 没有可直接编辑的字段（用 /settings edit 编辑 YAML）', [ns]))
    return
  }
  const secretRoots = new Set((desc.secrets ?? [])
    .map((s) => (Array.isArray(s.path) && typeof s.path[0] === 'string' ? s.path[0] : undefined))
    .filter((x): x is string => x !== undefined))
  const field = await app.openPicker(tf('{0} · 选择字段', [ns]), fields.map((key) => ({
    label: `${secretRoots.has(key) ? '🔒' : '·'} ${key} = ${previewSetting(value[key])}`,
    value: key,
  })))
  if (field === null) return
  if (secretRoots.has(field)) {
    app.notice(t('敏感字段不回显也不在这里写入；请用 /settings edit 打开配置文件，或 /account login'))
    return
  }
  const current = value[field]
  const text = await promptLine(app, tf('{0}.{1}（当前: {2}）', [ns, field, previewSetting(current)]), typeof current === 'string' ? current : JSON.stringify(current ?? null))
  if (text === null) return
  try {
    await settings.update(ns, { [field]: parseSettingValue(text) }, typeof desc.revision === 'number' ? desc.revision : undefined)
    app.notice(tf('已更新 {0}.{1}', [ns, field]))
  } catch (err) {
    app.notice(tf('设置更新失败: {0}', [(err as Error).message]))
  }
}

const previewSetting = (value: unknown): string => {
  if (typeof value === 'string') return value === '' ? '（空）' : value
  if (value === undefined) return '（未设置）'
  try { return JSON.stringify(value) } catch { return String(value) }
}

/** /settings [form|edit|set …] — overview; `form` edits a top-level field
 *  with a picker + prompt; `edit` opens the raw settings document. */

export const settingsCommand = async (app: App, a: string | undefined) => {
  const settings = app.svc('settings')
  if (settings === undefined) {
    app.notice(t('settings 服务未装配'))
    return
  }
  try {
    const setArg = (a ?? '').trim()
    if (setArg === 'form' || setArg.startsWith('form ')) {
      await editSettingField(app, settings, setArg.slice(4).trim())
      return
    }
    if (setArg === 'key' || setArg === 'keys') {
      const path = credentialsPath()
      if (!existsSync(path)) writeFileSync(path, 'refs:\n', { mode: 0o600 })
      await app.luaCall('require("dsh_tui").open_file_tab(...)', [path]).catch(() => {})
      app.notice(tf('凭证文件: {0}（refs: <ENV_NAME>: <key>，保存后热载；/settings 概览可看状态）', [path]))
      return
    }
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
      const value = parseSettingValue(raw)
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
    lines.push('', t('常用修改: /settings form 选命名空间改字段；/settings set <key.path> <value> 即时写入；i/o 打开配置文件；/account 登录账号'))
    void app.luaCall('require("dsh_tui").show_lines_float(...)', [t('设置'), lines, typeof docPath === 'string' ? docPath : null]).catch(() => {})
  } catch (err) {
    app.notice(tf('settings 失败: {0}', [(err as Error).message]))
  }
}

export function installSettingsCommand(app: App): void {
  app.registerCommands([{
    name: '/settings',
    desc: t('设置总览 / 表单编辑 / 原始 YAML'),
    usage: t('[form [ns] | edit | key | set <ns> <key.path> <value>]'),
    group: t('系统'),
    args: [
      { kind: 'oneof', values: ['form', 'edit', 'key'], hint: t('form=交互改字段；edit=settings 文档；key=凭证文件') },
      { kind: 'free', label: '[ns]', hint: t('form 可指定命名空间') },
    ],
    fn: (a?: string) => settingsCommand(app, a),
  }])
}
