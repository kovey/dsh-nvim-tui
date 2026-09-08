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
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as tar from 'tar';
/** Resolve the registry base (configurable for mirrors / self-hosting). */
function registryBase(override) {
    return override ?? 'https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main';
}
/** GitHub codeload tarball URL for the registry main branch. */
function codeloadUrl(base) {
    // raw.githubusercontent base → github repo name
    const repo = base.replace(/^https:\/\/raw\.githubusercontent\.com\//, '').replace(/\/main$/, '');
    const parts = repo.split('/');
    const [owner, name] = [parts[0], parts[1]];
    return `https://codeload.github.com/${owner}/${name}/tar.gz/refs/heads/main`;
}
/** Default TTL: 6 hours. */
const DEFAULT_TTL_MS = 6 * 3600 * 1000;
/** Cache path under the runner's DSH_HOME. */
export function marketCachePath() {
    return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'nvim-tui', 'market-catalog.json');
}
/** Strip a YAML key line's value (no dependency on a YAML parser — the
 *  registry files are two-space-indented key: value lines). */
function yamlField(text, key) {
    const re = new RegExp(`^${key}:\\s*(.+)$`, 'm');
    return re.exec(text)?.[1]?.trim();
}
function yamlNestedField(text, key, sub) {
    const re = new RegExp(`${key}:\\s*\\n(?:\\s+[a-z]+:.*\\n)*?\\s+${sub}:\\s*(.+)`, 'm');
    return re.exec(text)?.[1]?.trim().replace(/^["']|["']$/g, '');
}
/** Parse one plugins/<owner>__<name>.yml body into a partial entry. */
export function parsePluginYaml(text, file) {
    // The yaml's own `name` is the display name (owner/repo); the filename
    // encodes monorepo paths with `--` separators — only a fallback.
    const name = yamlField(text, 'name') ?? file.replace(/\.yml$/, '').replace(/__/, '/');
    const url = yamlField(text, 'url') ?? `https://github.com/${name}`;
    const descZh = yamlNestedField(text, 'description', 'zh') ?? '';
    const descEn = yamlNestedField(text, 'description', 'en') ?? descZh;
    const tarball = yamlField(text, 'tarball');
    return {
        name,
        url,
        category: yamlField(text, 'category') ?? 'other',
        descZh,
        descEn,
        ...(tarball !== undefined && tarball !== '' ? { tarball } : {}),
    };
}
/** Parse the registry's stars.json (`{ "<url>": { stars, checkedAt } }`). */
export function parseStars(text) {
    const out = new Map();
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return out;
    }
    if (parsed === null || typeof parsed !== 'object')
        return out;
    for (const [url, v] of Object.entries(parsed)) {
        const stars = v?.stars;
        if (typeof stars === 'number')
            out.set(url, stars);
    }
    return out;
}
/** Merge parsed stars + plugin yamls into one sorted catalog. */
export function buildCatalog(stars, plugins) {
    const byUrl = new Map();
    for (const p of plugins) {
        if (p.url !== undefined)
            byUrl.set(p.url, p);
    }
    const entries = [];
    for (const [url, starCount] of stars) {
        const p = byUrl.get(url) ?? {};
        const name = p.name ?? url.replace(/^https:\/\/github\.com\//, '');
        entries.push({
            name,
            url,
            stars: starCount,
            category: p.category ?? 'other',
            descZh: p.descZh ?? '',
            descEn: p.descEn ?? '',
            ...(p.tarball !== undefined ? { tarball: p.tarball } : {}),
        });
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
            });
        }
    }
    entries.sort((a, b) => b.stars - a.stars || a.name.localeCompare(b.name));
    return entries;
}
/**
 * Download the registry tarball and build the catalog. Network happens here
 * (one request); everything after is disk-local.
 */
export async function fetchCatalog(opts = {}) {
    const base = registryBase(opts.base);
    const url = codeloadUrl(base);
    const timeoutMs = opts.timeoutMs ?? 60000;
    const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': 'dsh-nvim-tui-market' },
    });
    if (!res.ok)
        throw new Error(`registry fetch failed: ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const extracted = await new Promise((resolve, reject) => {
        const files = {};
        // Streaming parse of the tarball; keep only the registry data files.
        const parser = tar.t({
            strict: true,
            onentry: (entry) => {
                if (!entry.path.includes('/data/'))
                    return;
                if (!entry.path.endsWith('.json') && !entry.path.endsWith('.yml'))
                    return;
                const chunks = [];
                entry.on('data', (c) => chunks.push(c));
                entry.on('end', () => {
                    const rel = entry.path.slice(entry.path.indexOf('/data/') + '/data/'.length);
                    files[rel] = Buffer.concat(chunks).toString('utf8');
                });
            },
        });
        parser.on('error', reject);
        parser.on('end', () => resolve(files));
        parser.end(buf);
    });
    const starsText = Object.entries(extracted).find(([k]) => k === 'stars.json')?.[1];
    if (starsText === undefined)
        throw new Error('registry tarball has no data/stars.json');
    const plugins = [];
    for (const [rel, text] of Object.entries(extracted)) {
        if (!rel.startsWith('plugins/') || !rel.endsWith('.yml'))
            continue;
        plugins.push(parsePluginYaml(text, rel.slice('plugins/'.length)));
    }
    return { fetchedAt: Date.now(), entries: buildCatalog(parseStars(starsText), plugins) };
}
/** Read the cached catalog (may be stale or missing). */
export function readCatalog(path = marketCachePath()) {
    try {
        const raw = readFileSync(path, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed?.entries))
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
export function writeCatalog(catalog, path = marketCachePath()) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(catalog));
}
/** Is the cached catalog within its TTL? */
export function isFresh(catalog, ttlMs = DEFAULT_TTL_MS) {
    return catalog !== null && Date.now() - catalog.fetchedAt < ttlMs;
}
/** Filter by a case-insensitive substring over name/description. */
export function searchCatalog(entries, query) {
    const q = query.trim().toLowerCase();
    if (q === '')
        return entries;
    return entries.filter((e) => e.name.toLowerCase().includes(q) ||
        e.descZh.toLowerCase().includes(q) ||
        e.descEn.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q));
}
/** Resolve the running profile name from the dsh process argv. */
export function runningProfileName() {
    const argv = process.argv;
    const idx = argv.indexOf('--profile');
    if (idx >= 0 && argv[idx + 1] !== undefined && !argv[idx + 1].startsWith('-'))
        return argv[idx + 1];
    const eq = argv.find((a) => a.startsWith('--profile='));
    if (eq !== undefined)
        return eq.slice('--profile='.length);
    return undefined;
}
export function readInstalledPlugins(profileName) {
    const dir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', profileName);
    const deps = new Map();
    const versions = new Map();
    try {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        for (const [name, range] of Object.entries(manifest.dependencies ?? {}))
            deps.set(name, String(range));
    }
    catch { }
    for (const name of deps.keys()) {
        try {
            const p = JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8'));
            if (typeof p.version === 'string')
                versions.set(name, p.version);
        }
        catch { }
    }
    return { deps, versions };
}
/** Repo root URL: catalog urls may point at a `/tree/<branch>/<subdir>`
 *  path; pnpm installs need the repository root. */
export function repoRoot(url) {
    return url.replace(/\/tree\/[^/]+\/.*$/, '');
}
/** Which package does a market entry install as? The registry lists GitHub
 *  repos (possibly with `/tree/` subpaths); dsh plugin add accepts release
 *  tarballs and repo-root URLs alike (pnpm resolves them). */
export function installSpec(entry) {
    return entry.tarball ?? repoRoot(entry.url);
}
// -- Phase 2: hot enable/disable rows + update checks -------------------------
/** Profile patch (user layer) path. */
export function patchPath(profileName) {
    return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', profileName, 'cordis.patch.yml');
}
/** Read the user patch file ('' when absent). */
export function readPatch(path) {
    try {
        return readFileSync(path, 'utf8');
    }
    catch {
        return '';
    }
}
/** Parse the disabled ids we manage (exact 2-line marker pairs). */
export function readDisabledIds(text) {
    const out = new Set();
    const lines = text.split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
        const m = /^- id:\s*(\S+)\s*$/.exec(lines[i]);
        if (m !== null && /^\s+disabled:\s*true\s*$/.test(lines[i + 1]))
            out.add(m[1]);
    }
    return out;
}
/**
 * Idempotently set our managed disable rows: remove prior marker pairs for
 * the managed ids, then append fresh `- id: X` + `disabled: true|false`
 * pairs at the end of the user patch layer. HMR re-composes within ~1s.
 */
export function setDisabledRows(text, toggles) {
    const managed = new Set(toggles.map((t) => t.id));
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
        // A top-level `- id: X` row (the patch layer replaces the whole config
        // per id): drop the row and its indented body for managed ids, so the
        // appended toggle pair is the only row for that id.
        const m = /^- id:\s*(\S+)\s*$/.exec(lines[i]);
        if (m !== null && managed.has(m[1])) {
            i++;
            while (i < lines.length && /^\s/.test(lines[i]))
                i++;
            continue;
        }
        out.push(lines[i]);
        i++;
    }
    while (out.length > 0 && out[out.length - 1].trim() === '')
        out.pop();
    for (const t of toggles) {
        out.push(`- id: ${t.id}`, `  disabled: ${t.disabled ? 'true' : 'false'}`);
    }
    return out.join('\n') + '\n';
}
export function writePatch(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
}
// -- update checks (npm registry latest vs installed version) ---------------
const latestCache = new Map();
const LATEST_CACHE_MS = 5 * 60 * 1000;
/** Whether a dependency key is a plain npm package name (skips link:/file:/
 *  URL/git specs, which the registry cannot answer). */
export function isNpmName(depKey) {
    return /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(depKey) && !/^https?:/.test(depKey);
}
/** Latest published version per npm registry (cached 5 min in-memory). */
export async function latestVersion(name, timeoutMs = 8000) {
    const hit = latestCache.get(name);
    if (hit !== undefined && Date.now() - hit.at < LATEST_CACHE_MS)
        return hit.version;
    try {
        const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
            signal: AbortSignal.timeout(timeoutMs),
            headers: { 'user-agent': 'dsh-nvim-tui-market' },
        });
        if (!res.ok) {
            latestCache.set(name, { at: Date.now(), version: undefined });
            return undefined;
        }
        const j = await res.json();
        latestCache.set(name, { at: Date.now(), version: j.version });
        return j.version;
    }
    catch {
        latestCache.set(name, { at: Date.now(), version: undefined });
        return undefined;
    }
}
/** Match one installed dependency key against a market entry: exact name,
 *  catalog url (possibly a /tree/ subpath), or the repo-root url/git spec. */
export function depMatchesEntry(depKey, entry) {
    if (depKey === entry.name || depKey.includes(entry.name))
        return true;
    if (depKey === entry.url || depKey.includes(entry.url))
        return true;
    const root = repoRoot(entry.url);
    if (root !== entry.url && (depKey === root || depKey.includes(root)))
        return true;
    return false;
}
export async function readRepoPackage(url, timeoutMs = 10000) {
    const repo = repoRoot(url).replace(/^https:\/\/github\.com\//, '');
    let branch = 'main';
    const tm = /\/tree\/([^/]+)\//.exec(url);
    if (tm !== null)
        branch = tm[1];
    for (const b of [branch, 'main', 'master']) {
        try {
            const res = await fetch(`https://raw.githubusercontent.com/${repo}/${b}/package.json`, {
                signal: AbortSignal.timeout(timeoutMs),
                headers: { 'user-agent': 'dsh-nvim-tui-market' },
            });
            if (!res.ok)
                continue;
            const j = await res.json();
            return {
                name: typeof j.name === 'string' ? j.name : undefined,
                version: typeof j.version === 'string' ? j.version : undefined,
                hasPrepare: typeof j.scripts?.prepare === 'string',
            };
        }
        catch { }
    }
    return null;
}
/**
 * Repo-verified npm resolution (the dshmarket strategy): when the repo's
 * package is published on npm at the same version, install THAT instead of a
 * git clone. Source-only repos (no committed lib/, no prepare — pnpm ≥10
 * blocks build scripts) install as metadata-only and take the whole host
 * down at the next boot; the npm tarball ships the built lib/.
 */
export async function resolveNpmSpec(entry, timeoutMs = 10000) {
    if (entry.tarball !== undefined)
        return undefined; // author-prebuilt wins
    const info = await readRepoPackage(entry.url, timeoutMs);
    if (info?.name === undefined || info?.version === undefined)
        return undefined;
    try {
        const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(info.name)}/${info.version}`, {
            signal: AbortSignal.timeout(timeoutMs),
            headers: { 'user-agent': 'dsh-nvim-tui-market' },
        });
        if (!res.ok)
            return undefined;
        return `${info.name}@${info.version}`;
    }
    catch {
        return undefined;
    }
}
/** Post-install sanity: the package's declared main entry must exist on
 *  disk. Source-only repos (no committed lib/, no prepare script — pnpm ≥10
 *  blocks build scripts by default) install as metadata-only and would take
 *  the whole host down at the next boot with ERR_MODULE_NOT_FOUND (exactly
 *  the dsh-context incident). Returns the dep name when the entry is
 *  missing, null when healthy. */
export function installedMainMissing(profileName, depKey) {
    const installed = readInstalledPlugins(profileName);
    let pkgName = depKey;
    if (!installed.deps.has(depKey)) {
        for (const key of installed.deps.keys()) {
            if (key.includes(depKey) || depKey.includes(key)) {
                pkgName = key;
                break;
            }
        }
    }
    const dir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', profileName);
    try {
        const manifest = JSON.parse(readFileSync(join(dir, 'node_modules', pkgName, 'package.json'), 'utf8'));
        const main = manifest.main ?? 'index.js';
        if (!existsSync(join(dir, 'node_modules', pkgName, main)))
            return pkgName;
    }
    catch {
        return pkgName;
    }
    return null;
}
/** Open a URL in the OS browser (macOS `open`; others fall back to echo). */
export function openUrl(url) {
    try {
        if (process.platform === 'darwin')
            execFileSync('open', [url]);
        else if (process.platform === 'linux')
            execFileSync('xdg-open', [url]);
    }
    catch { }
}
// -- Phase 3: install progress + auto-repair --------------------------------
/** The profile directory on disk. */
export function profileDir(profileName) {
    return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', profileName);
}
/** First non-empty line of a command tail (for short failure summaries). */
export function firstErrorLine(tail) {
    for (const l of tail.split('\n')) {
        const t = l.trim();
        if (t !== '')
            return t.slice(0, 160);
    }
    return '无输出';
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
export function classifyPnpmError(tail) {
    const t = tail ?? '';
    if (/EAI_AGAIN|ETIMEDOUT|ENOTFOUND|ECONNRESET|ECONNREFUSED|getaddrinfo|fetch failed|network|Temporary failure|socket hang up|EADDRINUSE/i.test(t)) {
        return { kind: 'network', message: '网络错误（连接/解析失败）' };
    }
    if (/ERR_PNPM_NO_MATCHING_VERSION|No matching version|ERR_PNPM_FETCH_404|404 Not Found|not found in the registry|package .* doesn't exist|no such package/i.test(t)) {
        return { kind: 'notfound', message: '该版本/包不存在（registry 404）' };
    }
    if (/ERR_PNPM_OUTDATED_LOCKFILE|frozen-lockfile|lockfile.*(outdated|changed)|Cannot install with/i.test(t)) {
        return { kind: 'lockfile', message: '锁文件与依赖声明不一致' };
    }
    if (/EPERM|EACCES|ERR_PNPM_.*CACHE|Invalid or unexpected token|cache dir|EINTEGRITY|not allowed to access/i.test(t)) {
        return { kind: 'cache', message: '缓存/权限问题（缓存损坏或目录不可写）' };
    }
    if (/Repository not found|remote: Repository|fatal: could not read|Permission denied \(publickey\)|git@github\.com|ERROR: Repository/i.test(t)) {
        return { kind: 'git', message: 'Git 仓库不可访问（私有/不存在/无权限）' };
    }
    return { kind: 'other', message: `未知错误: ${firstErrorLine(t)}` };
}
