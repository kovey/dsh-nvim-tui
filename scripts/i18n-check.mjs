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
  const m = line.match(/^\s*(?:'((?:[^'\\]|\\.)*)'|([A-Za-z_$][\w$]*))\s*:/)
  if (m !== null) keys.add((m[1] ?? m[2]).replace(/\\'/g, "'").replace(/\\\\/g, '\\'))
}

// -- call sites --------------------------------------------------------------
const used = new Map()
const dynamic = []
for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8')
  const rel = relative(ROOT, file)
  const re = /\bt\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")?\s*([^)]*)\)/g
  let m
  while ((m = re.exec(text)) !== null) {
    const lit = m[1] ?? m[2]
    if (lit === undefined) {
      const arg = (m[3] ?? '').trim()
      if (arg !== '') dynamic.push(`${rel}: ${arg.slice(0, 40)}`)
      continue
    }
    const key = lit.replace(/\\'/g, "'").replace(/\\\\/g, '\\')
    const list = used.get(key) ?? []
    list.push(rel)
    used.set(key, list)
  }
}

const dead = [...keys].filter((k) => !used.has(k)).sort()
const missing = [...used.keys()].filter((k) => !keys.has(k)).sort()

const report = (title, list, limit) => {
  console.log(`\n## ${title}: ${list.length}`)
  for (const item of list.slice(0, limit)) console.log(`  - ${item}`)
  if (list.length > limit) console.log(`  … 其余 ${list.length - limit} 条省略`)
}

console.log('# i18n 漂移报告（en 模式覆盖率）')
console.log(`字典键: ${keys.size} · 被引用: ${used.size} · 动态调用点: ${dynamic.length}`)
report('死键（字典有、代码无引用）', dead, 30)
report('未翻译（代码引用、字典无）', missing, 40)
report('动态调用点（本次扫描无法解析）', dynamic, 15)
console.log('\n说明：未翻译的键在 en 模式静默回落中文；本脚本只报告不失败。')
