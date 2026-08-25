/** One market entry (flattened registry record). */
export interface MarketEntry {
    /** `owner/repo` — also the display name. */
    name: string;
    /** GitHub repository URL. */
    url: string;
    /** GitHub star count (from the registry's aggregated stars.json). */
    stars: number;
    category: string;
    descZh: string;
    descEn: string;
    /** Author-supplied prebuilt release tarball, when declared. */
    tarball?: string;
}
export interface MarketCatalog {
    fetchedAt: number;
    entries: MarketEntry[];
}
/** Resolve the registry base (configurable for mirrors / self-hosting). */
export declare function registryBase(override: string | undefined): string;
/** Default TTL: 6 hours. */
export declare const DEFAULT_TTL_MS: number;
/** Cache path under the runner's DSH_HOME. */
export declare function marketCachePath(): string;
/** Parse one plugins/<owner>__<name>.yml body into a partial entry. */
export declare function parsePluginYaml(text: string, file: string): Partial<MarketEntry>;
/** Parse the registry's stars.json (`{ "<url>": { stars, checkedAt } }`). */
export declare function parseStars(text: string): Map<string, number>;
/** Merge parsed stars + plugin yamls into one sorted catalog. */
export declare function buildCatalog(stars: Map<string, number>, plugins: Array<Partial<MarketEntry>>): MarketEntry[];
/**
 * Download the registry tarball and build the catalog. Network happens here
 * (one request); everything after is disk-local.
 */
export declare function fetchCatalog(opts?: {
    base?: string;
    timeoutMs?: number;
}): Promise<MarketCatalog>;
/** Read the cached catalog (may be stale or missing). */
export declare function readCatalog(path?: string): MarketCatalog | null;
export declare function writeCatalog(catalog: MarketCatalog, path?: string): void;
/** Is the cached catalog within its TTL? */
export declare function isFresh(catalog: MarketCatalog | null, ttlMs?: number): boolean;
/** Filter by a case-insensitive substring over name/description. */
export declare function searchCatalog(entries: MarketEntry[], query: string): MarketEntry[];
/** Resolve the running profile name from the dsh process argv. */
export declare function runningProfileName(): string | undefined;
/** Installed-state snapshot for the running profile (fs-based). */
export interface InstalledPlugins {
    /** dependency name → declared semver from the profile manifest */
    deps: Map<string, string>;
    /** dependency name → installed version (node_modules manifest) */
    versions: Map<string, string>;
}
export declare function readInstalledPlugins(profileName: string): InstalledPlugins;
/** Repo root URL: catalog urls may point at a `/tree/<branch>/<subdir>`
 *  path; pnpm installs need the repository root. */
export declare function repoRoot(url: string): string;
/** Which package does a market entry install as? The registry lists GitHub
 *  repos (possibly with `/tree/` subpaths); dsh plugin add accepts release
 *  tarballs and repo-root URLs alike (pnpm resolves them). */
export declare function installSpec(entry: MarketEntry): string;
/** Profile patch (user layer) path. */
export declare function patchPath(profileName: string): string;
/** Read the user patch file ('' when absent). */
export declare function readPatch(path: string): string;
/** Parse the disabled ids we manage (exact 2-line marker pairs). */
export declare function readDisabledIds(text: string): Set<string>;
/**
 * Idempotently set our managed disable rows: remove prior marker pairs for
 * the managed ids, then append fresh `- id: X` + `disabled: true|false`
 * pairs at the end of the user patch layer. HMR re-composes within ~1s.
 */
export declare function setDisabledRows(text: string, toggles: Array<{
    id: string;
    disabled: boolean;
}>): string;
export declare function writePatch(path: string, text: string): void;
/** Whether a dependency key is a plain npm package name (skips link:/file:/
 *  URL/git specs, which the registry cannot answer). */
export declare function isNpmName(depKey: string): boolean;
/** Latest published version per npm registry (cached 5 min in-memory). */
export declare function latestVersion(name: string, timeoutMs?: number): Promise<string | undefined>;
/** Match one installed dependency key against a market entry: exact name,
 *  catalog url (possibly a /tree/ subpath), or the repo-root url/git spec. */
export declare function depMatchesEntry(depKey: string, entry: MarketEntry): boolean;
/** Read the repo's package.json (default branch from the catalog url). */
export interface RepoPackageInfo {
    name?: string;
    version?: string;
    hasPrepare?: boolean;
}
export declare function readRepoPackage(url: string, timeoutMs?: number): Promise<RepoPackageInfo | null>;
/**
 * Repo-verified npm resolution (the dshmarket strategy): when the repo's
 * package is published on npm at the same version, install THAT instead of a
 * git clone. Source-only repos (no committed lib/, no prepare — pnpm ≥10
 * blocks build scripts) install as metadata-only and take the whole host
 * down at the next boot; the npm tarball ships the built lib/.
 */
export declare function resolveNpmSpec(entry: MarketEntry, timeoutMs?: number): Promise<string | undefined>;
/** Post-install sanity: the package's declared main entry must exist on
 *  disk. Source-only repos (no committed lib/, no prepare script — pnpm ≥10
 *  blocks build scripts by default) install as metadata-only and would take
 *  the whole host down at the next boot with ERR_MODULE_NOT_FOUND (exactly
 *  the dsh-context incident). Returns the dep name when the entry is
 *  missing, null when healthy. */
export declare function installedMainMissing(profileName: string, depKey: string): string | null;
/** Open a URL in the OS browser (macOS `open`; others fall back to echo). */
export declare function openUrl(url: string): void;
/** The profile directory on disk. */
export declare function profileDir(profileName: string): string;
export type PnpmFailureKind = 'network' | 'notfound' | 'lockfile' | 'cache' | 'git' | 'other';
export interface PnpmFailure {
    kind: PnpmFailureKind;
    message: string;
}
/** First non-empty line of a command tail (for short failure summaries). */
export declare function firstErrorLine(tail: string): string;
/**
 * Classify a `dsh plugin …` / pnpm failure tail into a repairable class.
 * Each class maps to an automatic remedy in the install flow:
 *  - network    → wait and retry
 *  - notfound   → fall back to another source (npm publish / repo / tarball)
 *  - lockfile   → back up the profile pnpm-lock.yaml and retry
 *  - cache      → retry with a fresh npm cache dir (npm_config_cache)
 *  - git        → fall back to the npm publish when the repo is unreachable
 */
export declare function classifyPnpmError(tail: string): PnpmFailure;
