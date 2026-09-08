import type { App } from '../kernel/app.js';
/** Extension API version (semver, independent of the bundle version). */
export declare const EXT_API_VERSION = "0.1.0";
/** Default upper bound for one dsh-ext handler execution (both directions).
 *  vim.rpcrequest blocks nvim uninterruptibly and cannot be cancelled from
 *  Lua — the bounded answer is the ONLY freeze protection, so the runner
 *  always answers within this window (timeout → structured error; late
 *  results are discarded). */
export declare const EXT_HANDLER_TIMEOUT_MS = 30000;
import type { ExtSessionEventFilter } from '../kernel/ext-types.js';
export type { ExtNvimLayer, ExtSessionEventFilter, ExtEventName, ExtCardOpts, ExtCardHandle, ExtFloatOpts, ExtFloatResult, ExtPickerOpts, ExtPanelOpts, ExtPanelHandles, ExtRegionOpts, ExtRegionHandles, ExtCommandSpec, ExtLuaLayer, ExtUiLayer, TuiExtApi } from '../kernel/ext-types.js';
/** Pure filter match (exported for unit tests). */
export declare function matchSessionEventFilter(filter: ExtSessionEventFilter, sessionId: string, eventType: string): boolean;
/** Install the extension API onto the App (runs before boot; index.ts then
 *  publishes the built surface through the cordis registry). */
export declare function installExtApi(app: App): void;
/** nvim `request` side of the dsh-ext bus (moved out of boot): every
 *  vim.rpcrequest(channel, 'dsh-ext', …) gets a BOUNDED response —
 *  vim.rpcrequest blocks nvim uninterruptibly (and cannot be cancelled from
 *  Lua), so a hung handler freezes the UI forever. The runner races the
 *  handler against its timeout and answers an error when it overruns; late
 *  handler results are discarded (answered flag guards the single-send
 *  channel). NOTE: nvim DOES process events while blocked in rpcrequest, so
 *  handlers may safely make nested nvim calls (verified empirically). */
export declare function handleDshExtRequest(app: App, method: string, args: unknown[], resp: {
    send: (r: unknown) => void;
}): void;
/** Extension readiness announce (moved out of boot): resolve the ready
 *  promise, notify Node subscribers, and fire the nvim-side User DshTuiReady
 *  autocmd. */
export declare function announceReady(app: App): void;
