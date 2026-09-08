import type { App } from '../../kernel/app.js';
/** /permission [name] — switch the session's permission preset (the
 *  official dsh-permission-presets service: sandbox mode + approval
 *  policy pair; the profile's patch must mount the `permission` row). */
export declare const permissionCommand: (app: App, a: string | undefined) => Promise<void>;
export declare function installPermissionCommand(app: App): void;
