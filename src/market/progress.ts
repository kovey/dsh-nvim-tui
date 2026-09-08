/**
 * Plugin marketplace data layer (client-side, no host service).
 *
 * Catalog source: the curated awesome-dsh-plugin registry (client-agnostic;
 * every entry declares `dsh.bundle` and installs via `dsh plugin add`):
 *   - data/stars.json           GitHub URL → { stars, checkedAt }
 *   - data/plugins/<owner>__<repo>.yml   name / category / bilingual
 *                                description / optional release tarball
 * The whole registry ships as ONE codeload tarball (~few MB) — downloaded,
 * extracted, flattened into sorted entries, and cached under
 * `$DSH_HOME/nvim-tui/market-catalog.json` with a TTL. Everything after the
 * fetch is local: sorting (stars desc), search, and the picker never touch
 * the network again.
 *
 * @module dsh-nvim-tui/market
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import * as tar from 'tar'
import type { App } from '../kernel/app.js'

/** One market entry (flattened registry record). */
export interface MarketEntry {
  /** `owner/repo` — also the display name. */
  name: string
  /** GitHub repository URL. */
  url: string
  /** GitHub star count (from the registry's aggregated stars.json). */
  stars: number
  category: string
  descZh: string
  descEn: string
  /** Author-supplied prebuilt release tarball, when declared. */
  tarball?: string
}

export interface MarketCatalog {
  fetchedAt: number
  entries: MarketEntry[]
}

/** Resolve the registry base (configurable for mirrors / self-hosting). */
function registryBase(override: string | undefined): string {
  return override ?? 'https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main'
}

/** GitHub codeload tarball URL for the registry main branch. */
function codeloadUrl(base: string): string {
  // raw.githubusercontent base → github repo name
  const repo = base.replace(/^https:\/\/raw\.githubusercontent\.com\//, '').replace(/\/main$/, '')
  const parts = repo.split('/')
  const [owner, name] = [parts[0], parts[1]]
  return `https://codeload.github.com/${owner}/${name}/tar.gz/refs/heads/main`
}

/** Default TTL: 6 hours. */
const DEFAULT_TTL_MS = 6 * 3600 * 1000

/** Cache path under the runner's DSH_HOME. */
export function marketCachePath(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'nvim-tui', 'market-catalog.json')
}

/** Strip a YAML key line's value (no dependency on a YAML parser — the
 *  registry files are two-space-indented key: value lines). */
function yamlField(text: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:\\s*(.+)$`, 'm')
  return re.exec(text)?.[1]?.trim()
}

function yamlNestedField(text: string, key: string, sub: string): string | undefined {
  const re = new RegExp(`${key}:\\s*\\n(?:\\s+[a-z]+:.*\\n)*?\\s+${sub}:\\s*(.+)`, 'm')
  return re.exec(text)?.[1]?.trim().replace(/^["']|["']$/g, '')
}

/** Parse one plugins/<owner>__<name>.yml body into a partial entry. */
export function parsePluginYaml(text: string, file: string): Partial<MarketEntry> {
  // The yaml's own `name` is the display name (owner/repo); the filename
  // encodes monorepo paths with `--` separators — only a fallback.
  const name = yamlField(text, 'name') ?? file.replace(/\.yml$/, '').replace(/__/, '/')
  const url = yamlField(text, 'url') ?? `https://github.com/${name}`
  const descZh = yamlNestedField(text, 'description', 'zh') ?? ''
  const descEn = yamlNestedField(text, 'description', 'en') ?? descZh
  const tarball = yamlField(text, 'tarball')
  return {
    name,
    url,
    category: yamlField(text, 'category') ?? 'other',
    descZh,
    descEn,
    ...(tarball !== undefined && tarball !== '' ? { tarball } : {}),
  }
}

/** Parse the registry's stars.json (`{ "<url>": { stars, checkedAt } }`). */
export function parseStars(text: string): Map<string, number> {
  const out = new Map<string, number>()
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return out }
  if (parsed === null || typeof parsed !== 'object') return out
  for (const [url, v] of Object.entries(parsed as Record<string, unknown>)) {
    const stars = (v as { stars?: unknown })?.stars
    if (typeof stars === 'number') out.set(url, stars)
  }
  return out
}

/** Merge parsed stars + plugin yamls into one sorted catalog. */
export function buildCatalog(
  stars: Map<string, number>,
  plugins: Array<Partial<MarketEntry>>,
): MarketEntry[] {
  const byUrl = new Map<string, Partial<MarketEntry>>()
  for (const p of plugins) {
    if (p.url !== undefined) byUrl.set(p.url, p)
  }
  const entries: MarketEntry[] = []
  for (const [url, starCount] of stars) {
    const p = byUrl.get(url) ?? {}
    const name = p.name ?? url.replace(/^https:\/\/github\.com\//, '')
    entries.push({
      name,
      url,
      stars: starCount,
      category: p.category ?? 'other',
      descZh: p.descZh ?? '',
      descEn: p.descEn ?? '',
      ...(p.tarball !== undefined ? { tarball: p.tarball } : {}),
    })
  }
  // Any plugin with a yaml but no stars entry (new listings) joins at 0.
  for (const p of plugins) {
    if (p.url !== undefined && !stars.has(p.url) && p.name !== undefined) {
      entries.push({
        name: p.name,
        url: p.url,
        stars: 0,
        category: p.category ?? 'other',
        descZh: p.descZh ?? '',
        descEn: p.descEn ?? '',
        ...(p.tarball !== undefined ? { tarball: p.tarball } : {}),
      })
    }
  }
  entries.sort((a, b) => b.stars - a.stars || a.name.localeCompare(b.name))
  return entries
}

/**
 * Download the registry tarball and build the catalog. Network happens here
 * (one request); everything after is disk-local.
 */
export async function fetchCatalog(opts: { base?: string; timeoutMs?: number } = {}): Promise<MarketCatalog> {
  const base = registryBase(opts.base)
  const url = codeloadUrl(base)
  const timeoutMs = opts.timeoutMs ?? 60000
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'dsh-nvim-tui-market' },
  })
  if (!res.ok) throw new Error(`registry fetch failed: ${res.status} ${res.statusText}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const extracted = await new Promise<Record<string, string>>((resolve, reject) => {
    const files: Record<string, string> = {}
    // Streaming parse of the tarball; keep only the registry data files.
    const parser = tar.t({
      strict: true,
      onentry: (entry: import('tar').ReadEntry) => {
        if (!entry.path.includes('/data/')) return
        if (!entry.path.endsWith('.json') && !entry.path.endsWith('.yml')) return
        const chunks: Buffer[] = []
        entry.on('data', (c: Buffer) => chunks.push(c))
        entry.on('end', () => {
          const rel = entry.path.slice(entry.path.indexOf('/data/') + '/data/'.length)
          files[rel] = Buffer.concat(chunks).toString('utf8')
        })
      },
    })
    parser.on('error', reject)
    parser.on('end', () => resolve(files))
    parser.end(buf)
  })
  const starsText = Object.entries(extracted).find(([k]) => k === 'stars.json')?.[1]
  if (starsText === undefined) throw new Error('registry tarball has no data/stars.json')
  const plugins: Array<Partial<MarketEntry>> = []
  for (const [rel, text] of Object.entries(extracted)) {
    if (!rel.startsWith('plugins/') || !rel.endsWith('.yml')) continue
    plugins.push(parsePluginYaml(text, rel.slice('plugins/'.length)))
  }
  return { fetchedAt: Date.now(), entries: buildCatalog(parseStars(starsText), plugins) }
}

/** Read the cached catalog (may be stale or missing). */
export function readCatalog(path = marketCachePath()): MarketCatalog | null {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as MarketCatalog
    if (!Array.isArray(parsed?.entries)) return null
    return parsed
  } catch {
    return null
  }
}

export function writeCatalog(catalog: MarketCatalog, path = marketCachePath()): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(catalog))
}

/** Is the cached catalog within its TTL? */
export function isFresh(catalog: MarketCatalog | null, ttlMs: number = DEFAULT_TTL_MS): boolean {
  return catalog !== null && Date.now() - catalog.fetchedAt < ttlMs
}

/** Filter by a case-insensitive substring over name/description. */
export function searchCatalog(entries: MarketEntry[], query: string): MarketEntry[] {
  const q = query.trim().toLowerCase()
  if (q === '') return entries
  return entries.filter((e) =>
    e.name.toLowerCase().includes(q) ||
    e.descZh.toLowerCase().includes(q) ||
    e.descEn.toLowerCase().includes(q) ||
    e.category.toLowerCase().includes(q))
}

/** Resolve the running profile name from the dsh process argv. */
export function runningProfileName(): string | undefined {
  const argv = process.argv
  const idx = argv.indexOf('--profile')
  if (idx >= 0 && argv[idx + 1] !== undefined && !argv[idx + 1].startsWith('-')) return argv[idx + 1]
  const eq = argv.find((a) => a.startsWith('--profile='))
  if (eq !== undefined) return eq.slice('--profile='.length)
  return undefined
}

/** Installed-state snapshot for the running profile (fs-based). */
export interface InstalledPlugins {
  /** dependency name → declared semver from the profile manifest */
  deps: Map<string, string>
  /** dependency name → installed version (node_modules manifest) */
  versions: Map<string, string>
}

export function readInstalledPlugins(profileName: string): InstalledPlugins {
  const dir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', profileName)
  const deps = new Map<string, string>()
  const versions = new Map<string, string>()
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) deps.set(name, String(range))
  } catch {}
  for (const name of deps.keys()) {
    try {
      const p = JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8')) as { version?: string }
      if (typeof p.version === 'string') versions.set(name, p.version)
    } catch {}
  }
  return { deps, versions }
}

/** Repo root URL: catalog urls may point at a `/tree/<branch>/<subdir>`
 *  path; pnpm installs need the repository root. */
export function repoRoot(url: string): string {
  return url.replace(/\/tree\/[^/]+\/.*$/, '')
}

/** Which package does a market entry install as? The registry lists GitHub
 *  repos (possibly with `/tree/` subpaths); dsh plugin add accepts release
 *  tarballs and repo-root URLs alike (pnpm resolves them). */
export function installSpec(entry: MarketEntry): string {
  return entry.tarball ?? repoRoot(entry.url)
}

// -- Phase 2: hot enable/disable rows + update checks -------------------------

/** Profile patch (user layer) path. */
export function patchPath(profileName: string): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', profileName, 'cordis.patch.yml')
}

/** Read the user patch file ('' when absent). */
export function readPatch(path: string): string {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

/** Parse the disabled ids we manage: a row `- id: X` whose BODY contains a
 *  `disabled: true` line (the body may also carry config keys — the marker
 *  is not required to be the immediate next line). */
export function readDisabledIds(text: string): Set<string> {
  const out = new Set<string>()
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^- id:\s*(\S+)\s*$/.exec(lines[i])
    if (m === null) continue
    let j = i + 1
    while (j < lines.length && /^\s/.test(lines[j])) {
      if (/^\s*disabled:\s*true\s*$/.test(lines[j])) { out.add(m[1]); break }
      j++
    }
  }
  return out
}

/**
 * Idempotently set our managed disable rows: remove prior marker pairs for
 * the managed ids, then append fresh `- id: X` + `disabled: true|false`
 * pairs at the end of the user patch layer. HMR re-composes within ~1s.
 */
export function setDisabledRows(text: string, toggles: Array<{ id: string; disabled: boolean }>): string {
  const byId = new Map(toggles.map((t) => [t.id, t.disabled]))
  const managed = new Set(byId.keys())
  const lines = text.split('\n')
  const out: string[] = []
  const seen = new Set<string>()
  let i = 0
  while (i < lines.length) {
    // A top-level `- id: X` row: KEEP its body (config keys survive the
    // toggle — a disable must not destroy feishu credentials / openAt
    // overrides) and re-inject the disabled marker inside it.
    const m = /^- id:\s*(\S+)\s*$/.exec(lines[i])
    if (m !== null && managed.has(m[1])) {
      const id = m[1]
      seen.add(id)
      const body: string[] = []
      i++
      while (i < lines.length && /^\s/.test(lines[i])) { body.push(lines[i]); i++ }
      const kept = body.filter((l) => !/^\s*disabled:\s*/.test(l))
      out.push(`- id: ${id}`)
      out.push(...kept, `  disabled: ${byId.get(id) ? 'true' : 'false'}`)
      continue
    }
    out.push(lines[i])
    i++
  }
  for (const t of toggles) {
    if (!seen.has(t.id)) out.push(`- id: ${t.id}`, `  disabled: ${t.disabled ? 'true' : 'false'}`)
  }
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  return out.join('\n') + '\n'
}

export function writePatch(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

// -- update checks (npm registry latest vs installed version) ---------------

const latestCache = new Map<string, { at: number; version?: string }>()
const LATEST_CACHE_MS = 5 * 60 * 1000

/** Whether a dependency key is a plain npm package name (skips link:/file:/
 *  URL/git specs, which the registry cannot answer). */
export function isNpmName(depKey: string): boolean {
  return /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(depKey) && !/^https?:/.test(depKey)
}

/** Latest published version per npm registry (cached 5 min in-memory). */
export async function latestVersion(name: string, timeoutMs = 8000): Promise<string | undefined> {
  const hit = latestCache.get(name)
  if (hit !== undefined && Date.now() - hit.at < LATEST_CACHE_MS) return hit.version
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'dsh-nvim-tui-market' },
    })
    if (!res.ok) { latestCache.set(name, { at: Date.now(), version: undefined }); return undefined }
    const j = await res.json() as { version?: string }
    latestCache.set(name, { at: Date.now(), version: j.version })
    return j.version
  } catch {
    latestCache.set(name, { at: Date.now(), version: undefined })
    return undefined
  }
}

/** Match one installed dependency key against a market entry: exact name,
 *  catalog url (possibly a /tree/ subpath), or the repo-root url/git spec. */
export function depMatchesEntry(depKey: string, entry: MarketEntry): boolean {
  if (depKey === entry.name || depKey.includes(entry.name)) return true
  if (depKey === entry.url || depKey.includes(entry.url)) return true
  const root = repoRoot(entry.url)
  if (root !== entry.url && (depKey === root || depKey.includes(root))) return true
  return false
}

/** Read the repo's package.json (default branch from the catalog url). */
export interface RepoPackageInfo {
  name?: string
  version?: string
  hasPrepare?: boolean
}

export async function readRepoPackage(url: string, timeoutMs = 10000): Promise<RepoPackageInfo | null> {
  const repo = repoRoot(url).replace(/^https:\/\/github\.com\//, '')
  let branch = 'main'
  const tm = /\/tree\/([^/]+)\//.exec(url)
  if (tm !== null) branch = tm[1]
  for (const b of [branch, 'main', 'master']) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${repo}/${b}/package.json`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': 'dsh-nvim-tui-market' },
      })
      if (!res.ok) continue
      const j = await res.json() as { name?: unknown; version?: unknown; scripts?: { prepare?: unknown } }
      return {
        name: typeof j.name === 'string' ? j.name : undefined,
        version: typeof j.version === 'string' ? j.version : undefined,
        hasPrepare: typeof j.scripts?.prepare === 'string',
      }
    } catch {}
  }
  return null
}

/**
 * Repo-verified npm resolution (the dshmarket strategy): when the repo's
 * package is published on npm at the same version, install THAT instead of a
 * git clone. Source-only repos (no committed lib/, no prepare — pnpm ≥10
 * blocks build scripts) install as metadata-only and take the whole host
 * down at the next boot; the npm tarball ships the built lib/.
 */
export async function resolveNpmSpec(entry: MarketEntry, timeoutMs = 10000): Promise<string | undefined> {
  if (entry.tarball !== undefined) return undefined // author-prebuilt wins
  const info = await readRepoPackage(entry.url, timeoutMs)
  if (info?.name === undefined || info?.version === undefined) return undefined
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(info.name)}/${info.version}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'dsh-nvim-tui-market' },
    })
    if (!res.ok) return undefined
    return `${info.name}@${info.version}`
  } catch {
    return undefined
  }
}

/** Post-install sanity: the package's declared main entry must exist on
 *  disk. Source-only repos (no committed lib/, no prepare script — pnpm ≥10
 *  blocks build scripts by default) install as metadata-only and would take
 *  the whole host down at the next boot with ERR_MODULE_NOT_FOUND (exactly
 *  the dsh-context incident). Returns the dep name when the entry is
 *  missing, null when healthy. */
export function installedMainMissing(profileName: string, depKey: string): string | null {
  const installed = readInstalledPlugins(profileName)
  let pkgName = depKey
  if (!installed.deps.has(depKey)) {
    for (const key of installed.deps.keys()) {
      if (key.includes(depKey) || depKey.includes(key)) { pkgName = key; break }
    }
  }
  const dir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', profileName)
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'node_modules', pkgName, 'package.json'), 'utf8')) as { main?: string }
    const main = manifest.main ?? 'index.js'
    if (!existsSync(join(dir, 'node_modules', pkgName, main))) return pkgName
  } catch {
    return pkgName
  }
  return null
}

/** Open a URL in the OS browser (macOS `open`; others fall back to echo). */
export function openUrl(url: string): void {
  try {
    if (process.platform === 'darwin') execFileSync('open', [url])
    else if (process.platform === 'linux') execFileSync('xdg-open', [url])
  } catch {}
}

// -- Phase 3: install progress + auto-repair --------------------------------

/** The profile directory on disk. */
export function profileDir(profileName: string): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', profileName)
}

export type PnpmFailureKind = 'network' | 'notfound' | 'lockfile' | 'cache' | 'git' | 'other'

export interface PnpmFailure {
  kind: PnpmFailureKind
  message: string
}

/** First non-empty line of a command tail (for short failure summaries). */
export function firstErrorLine(tail: string): string {
  for (const l of tail.split('\n')) {
    const t = l.trim()
    if (t !== '') return t.slice(0, 160)
  }
  return '无输出'
}

/**
 * Classify a `dsh plugin …` / pnpm failure tail into a repairable class.
 * Each class maps to an automatic remedy in the install flow:
 *  - network    → wait and retry
 *  - notfound   → fall back to another source (npm publish / repo / tarball)
 *  - lockfile   → back up the profile pnpm-lock.yaml and retry
 *  - cache      → retry with a fresh npm cache dir (npm_config_cache)
 *  - git        → fall back to the npm publish when the repo is unreachable
 */
export function classifyPnpmError(tail: string): PnpmFailure {
  const t = tail ?? ''
  if (/EAI_AGAIN|ETIMEDOUT|ENOTFOUND|ECONNRESET|ECONNREFUSED|getaddrinfo|fetch failed|network|Temporary failure|socket hang up|EADDRINUSE/i.test(t)) {
    return { kind: 'network', message: '网络错误（连接/解析失败）' }
  }
  if (/ERR_PNPM_NO_MATCHING_VERSION|No matching version|ERR_PNPM_FETCH_404|404 Not Found|not found in the registry|package .* doesn't exist|no such package/i.test(t)) {
    return { kind: 'notfound', message: '该版本/包不存在（registry 404）' }
  }
  if (/ERR_PNPM_OUTDATED_LOCKFILE|frozen-lockfile|lockfile.*(outdated|changed)|Cannot install with/i.test(t)) {
    return { kind: 'lockfile', message: '锁文件与依赖声明不一致' }
  }
  if (/EPERM|EACCES|ERR_PNPM_.*CACHE|Invalid or unexpected token|cache dir|EINTEGRITY|not allowed to access/i.test(t)) {
    return { kind: 'cache', message: '缓存/权限问题（缓存损坏或目录不可写）' }
  }
  if (/Repository not found|remote: Repository|fatal: could not read|Permission denied \(publickey\)|git@github\.com|ERROR: Repository/i.test(t)) {
    return { kind: 'git', message: 'Git 仓库不可访问（私有/不存在/无权限）' }
  }
  return { kind: 'other', message: `未知错误: ${firstErrorLine(t)}` }
}

// -- install progress UI helpers (moved from the module index) --
/** Open the nvim progress window so long pnpm runs never look stuck. */
export const openProgress = (app: App, title: string) => {
  let lines: string[] = ['正在启动…']
  let bar = '▸ 准备中'
  let lastPush = 0
  void app.luaCall('require("dsh_tui").show_progress(...)', [title, lines]).catch(() => {})
  const push = (): void => {
    const now = Date.now()
    if (now - lastPush < 120) return
    lastPush = now
    void app.luaCall('require("dsh_tui").progress_update(...)', [lines.slice(-60), bar]).catch(() => {})
  }
  push()
  return {
    log: (l: string): void => {
      lines.push(l)
      if (lines.length > 80) lines.splice(0, lines.length - 80)
      push()
    },
    bar: (b: string): void => { bar = b; push() },
    close: (delayMs = 0): void => {
      setTimeout(() => { void app.luaCall('require("dsh_tui").close_progress()', []).catch(() => {}) }, delayMs)
    },
  }
}

/** Spawn `dsh plugin …`, streaming its output into the progress float. */
export const runPluginCliP = (
  profileName: string,
  args: string[],
  pg: { log: (l: string) => void },
  envExtra: Record<string, string> = {},
): Promise<{ code: number | null; tail: string }> => new Promise((resolve) => {
  const child = spawn('dsh', ['plugin', '--profile', profileName, ...args], {
    env: { ...process.env, ...envExtra },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // A wedged CLI (lock wait / hung network / interactive prompt) must not
  // hang the progress float forever: hard-stop after 5 minutes.
  const killer = setTimeout(() => {
    try { child.kill('SIGTERM') } catch { /* already gone */ }
  }, 5 * 60_000)
  let out = ''
  const bump = (chunk: string): void => {
    out = (out + chunk).slice(-4000)
    const tail = out.trim().split('\n')
    const last = tail[tail.length - 1]
    if (last !== undefined && last !== '') pg.log(last)
  }
  child.stdout.on('data', (d: Buffer) => bump(d.toString()))
  child.stderr.on('data', (d: Buffer) => bump(d.toString()))
  child.on('error', (e) => { clearTimeout(killer); pg.log('无法启动 dsh CLI: ' + e.message); resolve({ code: null, tail: out }) })
  child.on('exit', (code) => {
    clearTimeout(killer)
    if (code === null && child.killed) pg.log('dsh CLI 超时已终止')
    resolve({ code, tail: out })
  })
})

/** Post-install verification + the entry-file auto-repair chain (the
 *  dsh-context incident): a source-only repo installs without its main
 *  entry → swap to the npm publish / release tarball automatically. */
export const verifyOrRepairMain = async (
  entry: MarketEntry,
  profileName: string,
  spec: string,
  pg: { log: (l: string) => void; bar: (b: string) => void },
  runs: Set<string>,
): Promise<boolean> => {
  const missing = installedMainMissing(profileName, spec)
  if (missing === null) {
    pg.log('✓ 入口文件校验通过')
    return true
  }
  pg.log(`⚠ 缺少入口文件（${missing}）→ 自动寻找可用的预构建包…`)
  const candidates: Array<{ spec: string; label: string }> = []
  const npmSpec = await resolveNpmSpec(entry)
  if (npmSpec !== undefined) candidates.push({ spec: npmSpec, label: 'npm 发布版' })
  if (entry.tarball !== undefined) candidates.push({ spec: entry.tarball, label: 'GitHub Release tarball' })
  for (const c of candidates) {
    if (runs.has(c.spec) || c.spec === spec) continue
    pg.log(`· 换用 ${c.label}: ${c.spec}`)
    pg.bar(`↻ 自动修复：改用 ${c.label}…`)
    await runPluginCliP(profileName, ['remove', missing], pg)
    const r = await runPluginCliP(profileName, ['add', c.spec], pg)
    runs.add(c.spec)
    if (r.code === 0 && installedMainMissing(profileName, c.spec) === null) {
      pg.bar('✓ 已自动修复（入口文件校验通过）')
      return true
    }
    pg.log(`✗ ${c.label} 安装后仍未通过校验`)
  }
  pg.bar('⚠ 已安装但入口缺失（建议反馈给插件作者）')
  return false
}

/** Install with automatic diagnosis + remedy chains (bounded attempt
 *  budget, every remedy is logged into the progress float). */
export const installWithRepair = async (
  app: App,
  entry: MarketEntry,
  profileName: string,
  initialSpec: string,
  pg: { log: (l: string) => void; bar: (b: string) => void },
): Promise<void> => {
  const runs = new Set<string>()
  let spec = initialSpec
  const run = async (s: string, tag: string, env?: Record<string, string>) => {
    if (runs.size >= 4) return { code: -1 as number | null, tail: '尝试次数已达上限' }
    pg.log(`· dsh plugin add ${s}${tag !== '' ? `（${tag}）` : ''}`)
    runs.add(s)
    const r = await runPluginCliP(profileName, ['add', s], pg, env)
    pg.log(r.code === 0 ? '✓ 命令成功' : `✗ 退出码 ${r.code ?? '?'} · ${firstErrorLine(r.tail)}`)
    return r
  }
  let r = await run(spec, '初始安装')
  if (r.code === 0) {
    await verifyOrRepairMain(entry, profileName, spec, pg, runs)
    return
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const f = classifyPnpmError(r.tail)
    pg.log(`· 诊断: ${f.message}`)
    if (f.kind === 'network') {
      pg.bar('↻ 网络错误 · 2s 后自动重试…')
      await app.sleep(2000)
      r = await run(spec, '网络重试')
    } else if (f.kind === 'cache') {
      pg.bar('↻ 缓存/权限问题 · 改用临时缓存重试…')
      r = await run(spec, '临时 npm 缓存', { npm_config_cache: '/tmp/dsh-pnpm-cache' })
    } else if (f.kind === 'lockfile') {
      const lock = join(profileDir(profileName), 'pnpm-lock.yaml')
      try {
        renameSync(lock, `${lock}.bak-${Date.now()}`)
        pg.log('· 已备份 pnpm-lock.yaml')
      } catch { pg.log('· 锁文件不存在，无需备份') }
      pg.bar('↻ 锁文件冲突 · 备份后重试…')
      r = await run(spec, '锁文件修复重试')
    } else if (f.kind === 'notfound') {
      // The failed spec likely CAME from resolveNpmSpec (the ① step), so a
      // bare re-resolve returns the same dead spec — walk the candidate
      // chain EXCLUDING it (tarball / repo root are reachable again).
      const cands = [
        await resolveNpmSpec(entry),
        entry.tarball,
        repoRoot(entry.url),
      ].filter((c): c is string => typeof c === 'string' && c !== '' && c !== spec && !runs.has(c))
      const alt = cands[0]
      if (alt !== undefined) {
        pg.bar('↻ 该版本不存在 · 自动换源…')
        spec = alt
        r = await run(alt, '自动换源')
      } else {
        pg.bar('✗ 找不到可用安装源（npm/源码/Release 均不可用）')
        return
      }
    } else if (f.kind === 'git') {
      const npmSpec = await resolveNpmSpec(entry)
      if (npmSpec !== undefined && !runs.has(npmSpec)) {
        pg.bar('↻ 仓库不可访问 · 改用 npm 发布版…')
        spec = npmSpec
        r = await run(npmSpec, 'npm 发布版修复')
      } else {
        pg.bar('✗ 仓库不可访问且 npm 无发布版（请检查网络或反馈作者）')
        return
      }
    } else {
      if (attempt === 0) {
        pg.bar('↻ 未知错误 · 重试一次…')
        r = await run(spec, '重试')
      } else {
        pg.bar(`✗ 安装失败（已自动尝试 ${runs.size} 次，详情见上方日志）`)
        return
      }
    }
    if (r.code === 0) {
      await verifyOrRepairMain(entry, profileName, spec, pg, runs)
      return
    }
  }
  pg.bar(`✗ 安装失败（已自动尝试 ${runs.size} 次，详情见上方日志）`)
}
