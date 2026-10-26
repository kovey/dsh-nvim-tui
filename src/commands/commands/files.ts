/** dsh_tui command: /files — open nvim's netrw tree rooted at a directory. */
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { t, tf } from '../../kernel/i18n.js'
import { activeSessionCwd } from '../../kernel/app.js'
import type { App } from '../../kernel/app.js'

const expandHome = (p: string): string => p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p

export const filesCommand = async (app: App, a: string | undefined) => {
  const raw = (a ?? '').trim()
  const target = raw === '' ? activeSessionCwd(app) : expandHome(raw)
  const abs = isAbsolute(target) ? target : resolve(activeSessionCwd(app), target)
  if (!existsSync(abs)) { app.notice(tf('路径不存在: {0}', [abs])); return }
  let dir = abs
  try { if (statSync(abs).isFile()) dir = dirname(abs) } catch { /* use as-is */ }
  const ok = await app.luaCall('require("dsh_tui").file_tree(...)', [dir]).catch((err: unknown) => {
    app.notice(tf('打开文件树失败: {0}', [(err as Error).message]))
    return false
  })
  if (ok === false) app.notice(t('netrw 不可用（用户配置可能禁用了它）；可用 /dir 浏览目录'))
}

export function installFilesCommand(app: App): void {
  app.registerCommands([{
    name: '/files',
    desc: t('文件树（nvim netrw；可新建/重命名/删除）'),
    usage: t('[目录]'),
    group: t('信息'),
    args: [{ kind: 'free', label: '[目录]', hint: t('不填则打开会话 cwd') }],
    fn: (a?: string) => filesCommand(app, a),
  }])
}
