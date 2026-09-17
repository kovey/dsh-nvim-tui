/** dsh_tui command: /plugin — direct `dsh plugin` access for packages the
 *  curated marketplace catalog does not list (niche/private/self-hosted
 *  plugins, or a spec you already know).
 *
 *  `/market` is catalog-driven: it can only offer what the registry lists.
 *  This command bypasses the catalog and hands the spec straight to the
 *  official CLI, so any npm name / `owner/repo` / git URL the CLI accepts
 *  works. The marketplace keeps its curated browsing path.
 *
 *  @module dsh-nvim-tui/market/commands/plugin */
import type { App } from '../../kernel/app.js';
/** Parsed `/plugin` argument. Pure — exported for the smoke regression. */
export type PluginSub = {
    kind: 'usage';
} | {
    kind: 'list';
} | {
    kind: 'add';
    spec: string;
} | {
    kind: 'remove';
    spec: string;
} | {
    kind: 'update';
    spec: string;
    latest: boolean;
    ref: string | undefined;
} | {
    kind: 'missing-spec';
    sub: string;
} | {
    kind: 'bad-spec';
    spec: string;
};
/** Split `/plugin` arguments into a subcommand + spec.
 *
 *  Accepts the same verbs the official CLI does (`add`/`remove`, with
 *  `install`/`uninstall`/`rm`/`ls` as familiar aliases). The spec may itself
 *  contain spaces (a local path) and is passed to the CLI verbatim, so a
 *  leading `-` is rejected here: it would be parsed as a CLI flag. */
export declare const parsePluginArgs: (a: string | undefined) => PluginSub;
/** The `#ref` of a git dependency spec, or undefined when there is none.
 *  `undefined` means "no target to move to" for an update.
 *
 *  Accepts both the explicit forms (`github:`, `git+…`, `https://…`) and the
 *  `owner/repo#ref` shorthand users actually type — pnpm normalizes that to
 *  `github:owner/repo#ref` in the manifest, so the shorthand must not be missed
 *  (missing it made `/plugin update owner/repo#v1` look ref-less). */
export declare const gitSpecRef: (spec: string) => string | undefined;
/** /plugin — install/remove/list third-party plugins outside the curated
 *  marketplace catalog. */
export declare const pluginCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installPluginCommand(app: App): void;
