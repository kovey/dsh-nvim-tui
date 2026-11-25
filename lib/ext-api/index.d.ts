import type { App } from '../kernel/app.js';
/** Extension API version (semver, independent of the bundle version). */
export declare const EXT_API_VERSION = "0.2.0";
/** Upper bound for one dsh-ext handler execution: vim.rpcrequest blocks nvim
 *  uninterruptibly, so the runner ALWAYS answers within this window (late
 *  results are discarded) — the bounded answer is the only freeze protection. */
export declare const EXT_HANDLER_TIMEOUT_MS = 30000;
import type { ExtSessionEventFilter } from '../kernel/ext-types.js';
export { approvalPickerItems, approvalPickerTitle, pickApproval } from './approval.js';
export type { ExtNvimLayer, ExtSessionEventFilter, ExtEventName, ExtCardOpts, ExtCardHandle, ExtFloatOpts, ExtFloatResult, ExtPickerOpts, ExtPanelOpts, ExtPanelHandles, ExtRegionOpts, ExtRegionHandles, ExtCommandSpec, ExtLuaLayer, ExtUiLayer, TuiExtApi, ExtApprovalRequest, ExtApprovalOutcome } from '../kernel/ext-types.js';
/** Pure filter match (exported for unit tests). */
export declare function matchSessionEventFilter(filter: ExtSessionEventFilter, sessionId: string, eventType: string): boolean;
/** Install the extension API onto the App (runs before boot; index.ts then
 *  publishes the built surface through the cordis registry). */
export declare function installExtApi(app: App): void;
/** nvim `request` side of the dsh-ext bus (moved out of boot): every
 *  vim.rpcrequest gets a BOUNDED response — nvim blocks uninterruptibly and
 *  cannot cancel from Lua, so a hung handler would freeze the UI forever. An
 *  overrun answers an error and the late result is discarded (single-send
 *  `answered` flag). NOTE: nvim DOES process events while blocked, so
 *  handlers may make nested nvim calls (verified empirically). */
export declare function handleDshExtRequest(app: App, method: string, args: unknown[], resp: {
    send: (r: unknown) => void;
}): void;
/** Extension readiness announce (moved out of boot): resolve the ready
 *  promise, notify Node subscribers, and fire the nvim-side User DshTuiReady
 *  autocmd. */
export declare function announceReady(app: App): void;
