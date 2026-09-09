/**
 * First-launch onboarding: when no API key is configured for the active
 * provider, the first boot renders a one-shot guide block into the chat
 * (how to store the key: env export / the credentials file refs section /
 * the official Models page) and marks the guide as shown. Later boots with
 * the key still missing get a compact one-line reminder instead — the guide
 * never nags twice.
 *
 * @module dsh-nvim-tui/boot/onboarding
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { t } from '../kernel/i18n.js'
import { apiKeyConfigured, keyRefForProvider, credentialsPath } from '../kernel/apikey.js'
import type { App } from '../kernel/app.js'

/** One-shot marker: DSH_HOME/nvim-tui-onboarded.json (env override for tests). */
const onboardFile = (): string =>
  process.env.DSH_NVIM_TUI_ONBOARD_FILE ??
  join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'nvim-tui-onboarded.json')

const onboarded = (): boolean => {
  try {
    const parsed = JSON.parse(readFileSync(onboardFile(), 'utf8')) as { onboardedAt?: unknown } | null
    return parsed !== null && typeof parsed === 'object' &&
      typeof parsed.onboardedAt === 'string'
  } catch {
    return false
  }
}

const markOnboarded = (): void => {
  try {
    writeFileSync(onboardFile(), JSON.stringify({ onboardedAt: new Date().toISOString() }))
  } catch { /* a failed marker only means the guide may show once more */ }
}

/** Boot-time onboarding check: full guide once, compact reminder after. */
export async function maybeOnboard(app: App): Promise<void> {
  if (app.slices.runtime.disposed) return
  const rec = app.slices.sessions.activeId === null
    ? undefined
    : app.slices.sessions.live.get(app.slices.sessions.activeId)
  if (rec === undefined) return
  const provider = rec.provider ?? app.slices.agent.currentSelection().provider
  if (await apiKeyConfigured(app, provider)) return
  const ref = keyRefForProvider(provider)
  const credPath = credentialsPath()
  if (onboarded()) {
    app.notice(`🔑 ${t('未检测到 API key')}（${ref}）——/settings ${t('查看配置指引')}`)
    return
  }
  rec.feed.pushBlock('assistant', [
    t('🔑 首次启动引导：未检测到 API key'),
    `${t('provider 路由')} ${provider} ${t('需要凭证引用')} ${ref}`,
    '',
    t('任选一种方式配置（配置后直接发送消息即可生效，无需重启）：'),
    `  1. ${t('环境变量')}: export ${ref}=<${t('你的key')}>（${t('建议写入 shell 配置文件')}）`,
    `  2. ${t('凭证文件')}: ${credPath} ${t('写入')}`,
    '       refs:',
    `         ${ref}: <${t('你的key')}>`,
    `  3. ${t('官方 Models 页面（web）也可写入凭证库')}`,
    '',
    `/settings ${t('查看设置概览与凭证状态')} · /settings edit ${t('打开 settings 文档')}`,
  ].join('\n'))
  app.notice(`🔑 ${t('未检测到 API key')}（${ref}）——/settings ${t('查看配置指引')}`)
  markOnboarded()
}
