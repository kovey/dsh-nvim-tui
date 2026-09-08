/**
 * dsh_tui plugin-market module: the live progress float driver, the `dsh
 * plugin …` CLI runner with the install diagnosis/repair chains, and the
 * /market command (catalog browser, install / update / uninstall / toggle).
 *
 * @module dsh-nvim-tui/market-install
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
