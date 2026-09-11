import { installMarketCommand } from './commands/market.js';
import { installPluginCommand } from './commands/plugin.js';
/** /market [关键词 | refresh] — plugin marketplace: curated
 *  awesome-dsh-plugin catalog sorted by GitHub stars (desc), with
 *  install / update / uninstall through the official `dsh plugin` CLI. */
/** /plugin [install|remove <spec> | list] — direct `dsh plugin` access for
 *  plugins the curated catalog does not list (npm name / owner-repo / git URL). */
/** Live progress float driver: streams log lines + a bottom bar into the
 *  enable/disable through the profile patch layer (HMR, no restart). */
export function installMarketInstall(app) {
    installMarketCommand(app);
    installPluginCommand(app);
}
