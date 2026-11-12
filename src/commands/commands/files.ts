/** dsh_tui command: /files — open nvim's netrw tree rooted at a directory. */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { t, tf } from '../../kernel/i18n.js'
import { activeSessionCwd } from '../../kernel/app.js'
import type { App } from '../../kernel/app.js'

const expandHome = (p: string): string => p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p

const SKIP_DIRS = new Set(['.git', 'node_modules', '.dsh', '.dsh-test', 'dist', 'build', '.tmp-swift', '.pnpm-store'])
const SEARCH_LIMIT = 200

/** Bounded filename/path search for the TUI `/files search` picker. */
export const searchWorkspaceFiles = (root: string, query: string, limit = SEARCH_LIMIT): string[] => {
  const needle = query.toLowerCase()
  const out: string[] = []
  const stack = [root]
  let visited = 0
  while (stack.length > 0 && out.length < limit && visited < 20_000) {
    const dir = stack.pop() as string
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(abs)
        continue
      }
      if (!entry.isFile()) continue
      visited++
      const rel = relative(root, abs).split('\\').join('/')
      if (rel.toLowerCase().includes(needle)) out.push(rel)
      if (out.length >= limit || visited >= 20_000) break
    }
  }
  return out.sort()
}

export const filesCommand = async (app: App, a: string | undefined) => {
  const raw = (a ?? '').trim()
  if (raw.startsWith('search ')) {
    const query = raw.slice('search '.length).trim()
    if (query === '') { app.notice(t('用法: /files search <关键词>')); return }
    const cwd = activeSessionCwd(app)
    const hits = searchWorkspaceFiles(cwd, query)
    if (hits.length === 0) { app.notice(tf('没有匹配的文件: {0}', [query])); return }
    const picked = await app.openPicker(tf('文件搜索: {0}', [query]), hits.map((p) => ({ label: p, value: p })))
    if (picked === null) return
    const ok = await app.luaCall('return require("dsh_tui").open_file_tab(...)', [join(cwd, picked)]).catch(() => false)
    if (ok === false) app.notice(tf('打开文件失败: {0}', [picked]))
    return
  }
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
