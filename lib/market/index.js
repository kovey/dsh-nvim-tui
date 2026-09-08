import { installMarketCommand } from './commands/market.js';
/** /market [关键词 | refresh] — plugin marketplace: curated
 *  awesome-dsh-plugin catalog sorted by GitHub stars (desc), with
 *  install / update / uninstall through the official `dsh plugin` CLI. */
/** Live progress float driver: streams log lines + a bottom bar into the
 *  enable/disable through the profile patch layer (HMR, no restart). */
export function installMarketInstall(app) {
    installMarketCommand(app);
}
