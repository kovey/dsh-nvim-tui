/** dsh_tui command: /preview — read-only preview of a local file. Text and
 *  source open in a scrollable float (syntax-highlighted by the user's nvim);
 *  images/PDF/office/binary get metadata plus the native open action, because
 *  a terminal cannot render them without an image plugin. */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, isAbsolute, resolve } from 'node:path'
import { t, tf } from '../../kernel/i18n.js'
import { activeSessionCwd } from '../../kernel/app.js'
import { systemOpenArgv } from './deliverables.js'
import type { App } from '../../kernel/app.js'

const MAX_TEXT = 2 * 1024 * 1024
const MAX_LINES = 2000
const BINARY_EXT = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.zip', '.gz', '.tar', '.zst', '.7z', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.mp3', '.mp4', '.mov', '.wav', '.woff', '.woff2', '.ttf', '.otf'])

const expandHome = (p: string): string => p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p

export const previewCommand = async (app: App, a: string | undefined) => {
  const raw = (a ?? '').trim()
  if (raw === '') { app.notice(t('用法: /preview <路径>')); return }
  const abs = isAbsolute(expandHome(raw)) ? expandHome(raw) : resolve(activeSessionCwd(app), expandHome(raw))
  if (!existsSync(abs)) { app.notice(tf('文件不存在: {0}', [abs])); return }
  let size = 0
  try { size = statSync(abs).size } catch (err) { app.notice(tf('读取失败: {0}', [(err as Error).message])); return }
  const ext = extname(abs).toLowerCase()
  const open = systemOpenArgv(abs)
  const actions = open !== undefined ? [{ key: 'O', label: t('用系统程序打开'), argv: open }] : []
  const header = [`${abs}`, tf('{0} · {1}', [ext === '' ? t('无扩展名') : ext, formatSize(size)])]
  const binary = BINARY_EXT.has(ext)
  if (binary || size > MAX_TEXT) {
    const lines = [...header, '', binary ? t('该类型不能在终端内预览，按 O 用系统程序打开') : t('文件超过 2 MB，按 O 用系统程序打开')]
    await app.luaCall('require("dsh_tui").show_lines_float(...)', [t('预览'), lines, '', actions]).catch(() => {})
    return
  }
  try {
    const data = readFileSync(abs)
    if (data.subarray(0, 8192).includes(0)) {
      await app.luaCall('require("dsh_tui").show_lines_float(...)', [t('预览'), [...header, '', t('二进制文件，按 O 用系统程序打开')], '', actions]).catch(() => {})
      return
    }
    const lines = data.toString('utf8').split('\n')
    if (lines.length > MAX_LINES) lines.splice(MAX_LINES, lines.length - MAX_LINES, tf('…（仅显示前 {0} 行）', [String(MAX_LINES)]))
    await app.luaCall('require("dsh_tui").show_lines_float(...)', [t('预览'), [...header, '', ...lines], abs, actions]).catch(() => {})
  } catch (err) {
    app.notice(tf('预览失败: {0}', [(err as Error).message]))
  }
}

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function installPreviewCommand(app: App): void {
  app.registerCommands([{
    name: '/preview',
    desc: t('只读预览文件（文本/源码；图片/PDF 用系统打开）'),
    usage: t('<路径>'),
    group: t('信息'),
    args: [{ kind: 'free', label: '<路径>', hint: t('文件路径') }],
    fn: (a?: string) => previewCommand(app, a),
  }])
}
