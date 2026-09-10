#!/usr/bin/env node
/**
 * i18n drift report (audit 2026-09, docs-REVIEW-2026-09 medium item).
 *
 * The runner keeps zh literals in code and looks them up in `EN_DICT`; an
 * unknown key silently falls back to Chinese, so drift is invisible in en
 * mode. This reports the three drift classes without failing the build:
 *
 *   dead        dictionary keys no `t('…')` call site references any more
 *   missing     `t('…')` literals with no dictionary entry (en mode = zh)
 *   dynamic     call sites this scan cannot resolve (t(variable)) — listed
 *               so the numbers above are read with the right caveat
 *
 * Usage: npm run i18n:report
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'src')
/** Also scanned: tests/examples may assert translations. */
const EXTRA_DIRS = ['scripts', 'examples'].map((d) => join(ROOT, d))

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

// -- dictionary keys ---------------------------------------------------------
const i18nPath = join(SRC, 'kernel/i18n.ts')
const i18nSrc = readFileSync(i18nPath, 'utf8')
const dictStart = i18nSrc.indexOf('const EN_DICT')
const dictBody = i18nSrc.slice(dictStart, i18nSrc.indexOf('\n}', dictStart))
const keys = new Set()
for (const line of dictBody.split('\n')) {
  // Quoted key OR bare identifier — CJK characters are valid identifier
  // characters, so the dictionary legitimately contains `新增: 'Added'`.
  const m = line.match(/^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([^\s:'"][^:]*?))\s*:/)
  if (m === null) continue
  const bare = (m[3] ?? '').trim()
  if (m[1] === undefined && m[2] === undefined && (/\s/.test(bare) || /^(const|let|var|export|import|return)$/.test(bare))) continue
  const raw = m[1] ?? m[2] ?? bare
  keys.add(raw.replace(/\\'/g, "'").replace(/\\\\/g, '\\'))
}

// -- call sites --------------------------------------------------------------
const used = new Map()
const dynamic = []
for (const file of [...walk(SRC), ...EXTRA_DIRS.flatMap((d) => { try { return walk(d) } catch { return [] } })]) {
  const text = readFileSync(file, 'utf8')
  const rel = relative(ROOT, file)
  // Two passes: (1) every call whose FIRST argument is a literal — matched
  // independently of what follows, so a nested `t('…')` inside a tf()
  // argument still registers; (2) calls whose first argument is not a
  // literal (reported as dynamic).
  const litRe = /\btf?\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g
  let m
  while ((m = litRe.exec(text)) !== null) {
    const lit = m[1] ?? m[2]
    if (lit === '') continue
    const lineStart = text.lastIndexOf('\n', m.index) + 1
    const line = text.slice(lineStart, text.indexOf('\n', m.index))
    if (/^\s*(?:\*|\/\/)/.test(line)) continue // documentation example
    const key = lit.replace(/\\'/g, "'").replace(/\\\\/g, '\\')
    const list = used.get(key) ?? []
    list.push(rel)
    used.set(key, list)
  }
  const dynRe = /\btf?\(\s*([^'"\s)][^)]{0,40})/g
  while ((m = dynRe.exec(text)) !== null) dynamic.push(`${rel}: ${m[1].slice(0, 40)}`)
}

/** Deliberate probes: the smoke suite asserts the zh-fallback with a literal
 *  that must NOT be in the dictionary. */
const PROBES = new Set(['未被收录的字符串'])

const dead = [...keys].filter((k) => !used.has(k)).sort()
const missing = [...used.keys()].filter((k) => !keys.has(k) && !PROBES.has(k)).sort()

const report = (title, list, limit) => {
  console.log(`\n## ${title}: ${list.length}`)
  for (const item of list.slice(0, limit)) console.log(`  - ${item}`)
  if (list.length > limit) console.log(`  … 其余 ${list.length - limit} 条省略`)
}

console.log('# i18n 漂移报告（en 模式覆盖率）')
console.log(`字典键: ${keys.size} · 被引用: ${used.size} · 动态调用点: ${dynamic.length}`)
report('死键（字典有、代码无引用）', dead, 200)
report('未翻译（代码引用、字典无）', missing, 200)
report('动态调用点（本次扫描无法解析）', dynamic, 20)
// -- unwrapped literals: CJK text that never reaches t()/tf() ----------------
const CJK = /[\u4e00-\u9fff]/
const unwrapped = []
for (const file of walk(SRC)) {
  if (file.endsWith('kernel/i18n.ts')) continue // the dictionary itself
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) return
    const code = line.replace(/\/\/.*$/, '')
    if (!CJK.test(code)) return
    if (!/['"`][^'"`]*[\u4e00-\u9fff]/.test(code)) return
    if (/\bt\(|\btf\(/.test(code)) return
    unwrapped.push(`${relative(ROOT, file)}:${i + 1}  ${trimmed.slice(0, 90)}`)
  })
}
report('未走 t()/tf() 的中文字面量（en 模式仍显示中文）', unwrapped, 25)

console.log('\n说明：未翻译的键在 en 模式静默回落中文；未包装的字面量完全绕过字典。本脚本只报告不失败。')
