import type { App } from '../../kernel/app.js';
/** /preset [id] — agent presets (标准/PTC/极简/创造 + user roots).
 *  Mirrors the official `agentPresets.select` flow (dsh-host-apiproxy):
 *  a session's composition is fixed once any turn has run, so switching
 *  afterwards is a caller error (agent-preset-locked). On a blank
 *  session the switch must re-link the live agent (recompose) AND record
 *  `agent-preset/selected` in the session log — the log event alone does
 *  not move the running agent. */
export declare const presetCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installPresetCommand(app: App): void;
