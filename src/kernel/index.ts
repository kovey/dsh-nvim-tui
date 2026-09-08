/**
 * dsh_tui kernel — the public surface every business module imports from.
 *
 * The kernel carries the state/service contract (App/AppSlices), all
 * cross-module types, the wiring buses (nvim notifications / host events),
 * the nvim process facilities (bridge/lifecycle/headless) and shared pure
 * utilities. Dependency rule (check-arch enforced): the kernel never
 * imports business modules; business modules never import each other —
 * they talk through this surface (plus the feed/ render layer).
 *
 * @module dsh-nvim-tui/kernel
 */
export { createApp, BUILD_VERSION, BUILD_STAMP } from './app.js'
export type { App, AppSlices, WritableSlice, CommandSpec, SessionRec, ModelRef, WorkflowRun, ServiceMap } from './app.js'
export * from './types.js'
export { t, setLocale, locale } from './i18n.js'
export { spawnNvim, connectNvim } from './bridge.js'
export { registerNvimNotification, dispatchNvimNotification } from './rpc.js'
export type { NvimNotificationHandler } from './rpc.js'
export { registerHostHandler, wireHostEvents } from './host-events.js'
export type { HostEventHandler } from './host-events.js'
export { installLifecycle } from './lifecycle.js'
export { installHeadless } from './headless.js'
export * from './subagent-clean.js'
export type {
  ExtNvimLayer, ExtSessionEventFilter, ExtEventName, ExtCardOpts, ExtCardHandle,
  ExtFloatOpts, ExtFloatResult, ExtPickerOpts, ExtPanelOpts, ExtPanelHandles,
  ExtRegionOpts, ExtRegionHandles, ExtCommandSpec, ExtLuaLayer, ExtUiLayer, TuiExtApi,
} from './ext-types.js'
