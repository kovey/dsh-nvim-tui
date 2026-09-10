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

/** /market [关键词 | refresh] — plugin marketplace: curated
 *  awesome-dsh-plugin catalog sorted by GitHub stars (desc), with
 *  install / update / uninstall through the official `dsh plugin` CLI. */

/** Live progress float driver: streams log lines + a bottom bar into the
 *  enable/disable through the profile patch layer (HMR, no restart). */
export function installMarketInstall(app: App): void {
  installMarketCommand(app)
}
