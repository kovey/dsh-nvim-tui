/** dsh_tui command: /account — DeepSeek account status, balance and browser
 *  login/logout. The base composition mounts dsh-deepseek-account-platform, so
 *  a TUI user should not have to open the Web app just to see why
 *  `ACCOUNT_QUOTA` fired or to sign in. */
import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { t, tf, locale } from '../../kernel/i18n.js'
import { BUILD_VERSION } from '../../kernel/app.js'
import type { AccountBalanceLike, AccountClientMetadata, AccountProfileLike, AccountViewLike } from '../../kernel/types.js'
import type { App } from '../../kernel/app.js'

/** Open one browser URL without waiting for it. Returns false when the platform
 *  has no opener; the caller then prints the URL instead of pretending. */
export const openExternal = (url: string): boolean => {
  const argv = process.platform === 'darwin'
    ? ['open', url]
    : process.platform === 'win32'
      ? ['cmd', '/c', 'start', '', url]
      : ['xdg-open', url]
  try {
    const child = execFile(argv[0] as string, argv.slice(1), { timeout: 5000 }, () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

/** Reserve a loopback port for the host's OAuth callback server. */
export const freeLoopbackPort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    const port = address !== null && typeof address === 'object' ? address.port : 0
    server.close(() => {
      if (port > 0) resolve(port)
      else reject(new Error('no loopback port'))
    })
  })
})

const clientMeta = (): AccountClientMetadata => ({
  version: BUILD_VERSION,
  locale: locale(),
  timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
})

const statusText = (view: AccountViewLike | undefined): string => {
  if (view === undefined) return t('未知')
  if (view.status === 'credential-stored') return t('已登录（凭证已存储）')
  if (view.status === 'signed-out') return t('未登录')
  return String(view.status ?? t('未知'))
}

const wallets = (w: AccountBalanceLike | null): string[] => {
  if (w === null || w.status !== 'ready') return []
  const rows: string[] = []
  for (const wallet of [...(w.value ?? []), ...(w.bonusWallets ?? [])]) {
    if (wallet.balance === undefined) continue
    rows.push(`${wallet.currency ?? ''} ${wallet.balance}`.trim())
  }
  return rows
}

const profileText = (p: AccountProfileLike | null): string => {
  if (p === null || p.status !== 'ready') return ''
  const v = p.value ?? {}
  return [v.name, v.contact].filter((x): x is string => typeof x === 'string' && x !== '').join(' · ')
}

export const accountCommand = async (app: App, a: string | undefined) => {
  const svc = app.svc('deepseekAccount')
  if (svc === undefined || typeof svc.getState !== 'function') {
    app.notice(t('account 服务未装配（dsh-base 的 deepseek-account 行未挂载）'))
    return
  }
  const arg = (a ?? '').trim().toLowerCase()
  const client = clientMeta()
  try {
    if (arg === 'login' || arg === 'logout') {
      if (arg === 'logout') {
        if (typeof svc.signOut !== 'function') {
          app.notice(t('该宿主不支持 signOut'))
          return
        }
        const yes = await app.openPicker(t('退出账号'), [
          { label: t('确认退出（保留 API Key）'), value: 'yes' },
          { label: t('取消'), value: 'no' },
        ])
        if (yes !== 'yes') return
        const view = await svc.signOut(client)
        app.notice(tf('已退出账号（{0}）', [statusText(view)]))
        return
      }
      if (typeof svc.startSignIn !== 'function') {
        app.notice(t('该宿主不支持浏览器登录'))
        return
      }
      const port = await freeLoopbackPort()
      const origin = `http://127.0.0.1:${String(port)}`
      const view = await svc.startSignIn(client, origin, 'web')
      const url = view.attempt?.authorizeUrl ?? ''
      if (url !== '') {
        const opened = openExternal(url)
        app.notice(opened ? t('已在浏览器打开登录页，等待授权…') : tf('请手动打开登录页: {0}', [url]))
      } else {
        app.notice(t('宿主没有返回登录地址'))
        return
      }
      const deadline = Date.now() + 180_000
      while (Date.now() < deadline) {
        const state = await svc.getState?.()
        const phase = state?.attempt?.phase ?? ''
        if (phase === 'succeeded') {
          app.notice(t('登录成功'))
          return
        }
        if (phase === 'failed' || phase === 'cancelled' || phase === 'expired') {
          app.notice(tf('登录未完成: {0}', [state?.attempt?.errorCode ?? phase]))
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      app.notice(t('登录超时（可在浏览器完成后重试 /account）'))
      return
    }
    const state = await svc.getState()
    const lines = [tf('账号状态: {0}', [statusText(state)])]
    if (state.status === 'credential-stored') {
      const [profile, balance] = await Promise.all([
        svc.getProfile?.(client).catch(() => null) ?? Promise.resolve(null),
        svc.getBalance?.(client).catch(() => null) ?? Promise.resolve(null),
      ])
      const who = profileText(profile)
      if (who !== '') lines.push(tf('账号: {0}', [who]))
      const ws = wallets(balance)
      if (ws.length > 0) lines.push(tf('余额: {0}', [ws.join(' · ')]))
      else if (balance !== null) lines.push(t('余额: 查询失败或没有钱包信息'))
    }
    const links = state.links ?? {}
    if (typeof links.usageUrl === 'string' && links.usageUrl !== '') lines.push(tf('用量: {0}', [links.usageUrl]))
    if (typeof links.topUpUrl === 'string' && links.topUpUrl !== '') lines.push(tf('充值: {0}', [links.topUpUrl]))
    lines.push('', t('命令: /account login · /account logout · /account usage · /account topup'))
    await app.luaCall('require("dsh_tui").show_lines_float(...)', [t('账号'), lines]).catch(() => {})
    if (arg === 'usage' && typeof links.usageUrl === 'string' && links.usageUrl !== '') {
      if (!openExternal(links.usageUrl)) app.notice(tf('请手动打开: {0}', [links.usageUrl]))
    } else if (arg === 'topup' && typeof links.topUpUrl === 'string' && links.topUpUrl !== '') {
      if (!openExternal(links.topUpUrl)) app.notice(tf('请手动打开: {0}', [links.topUpUrl]))
    }
  } catch (err) {
    app.notice(tf('账号操作失败: {0}', [(err as Error).message]))
  }
}

export function installAccountCommand(app: App): void {
  app.registerCommands([{
    name: '/account',
    desc: t('DeepSeek 账号状态 / 余额 / 浏览器登录'),
    usage: t('[login|logout|usage|topup]'),
    group: t('系统'),
    args: [{ kind: 'oneof', values: ['login', 'logout', 'usage', 'topup'], hint: t('不填则显示账号状态与余额') }],
    fn: (a?: string) => accountCommand(app, a),
  }])
}
