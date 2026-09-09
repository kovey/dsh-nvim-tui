import type { App } from '../kernel/app.js';
/** Boot-time onboarding check: full guide once, compact reminder after. */
export declare function maybeOnboard(app: App): Promise<void>;
