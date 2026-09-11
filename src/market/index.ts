/**
 * dsh_tui plugin-market module entry: it wires the /market command. The
 * catalog fetch/search, the `dsh plugin …` CLI runner, the progress float and
 * the install diagnosis/repair chains live in ./commands/market.ts and
 * ./progress.ts.
 *
 * @module dsh-nvim-tui/market
 */
import type { App } from '../kernel/app.js'
import { installMarketCommand } from './commands/market.js'
import { installPluginCommand } from './commands/plugin.js'

/** /market [关键词 | refresh] — plugin marketplace: curated
 *  awesome-dsh-plugin catalog sorted by GitHub stars (desc), with
 *  install / update / uninstall through the official `dsh plugin` CLI. */

/** /plugin [install|remove <spec> | list] — direct `dsh plugin` access for
 *  plugins the curated catalog does not list (npm name / owner-repo / git URL). */

/** Live progress float driver: streams log lines + a bottom bar into the
 *  enable/disable through the profile patch layer (HMR, no restart). */
export function installMarketInstall(app: App): void {
  installMarketCommand(app)
  installPluginCommand(app)
}
