import type { App } from '../../kernel/app.js';
/** Open one browser URL without waiting for it. Returns false when the platform
 *  has no opener; the caller then prints the URL instead of pretending. */
export declare const openExternal: (url: string) => boolean;
/** Reserve a loopback port for the host's OAuth callback server. */
export declare const freeLoopbackPort: () => Promise<number>;
export declare const accountCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installAccountCommand(app: App): void;
