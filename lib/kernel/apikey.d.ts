import type { App } from './app.js';
/** Credentials store location (the file the official Models page writes). */
export declare function credentialsPath(): string;
/** Credential ref (env-var name) the active provider's key resolves
 *  through — mirrors the llm adapters' apiKeyEnv defaults. */
export declare function keyRefForProvider(provider: string): string;
/** Whether a usable key is configured for the provider: credentials seam
 *  first (stored refs / .env layering), then the ambient env. An unreadable
 *  seam reads as unconfigured — the guide is always safe to show. */
export declare function apiKeyConfigured(app: App, provider: string): Promise<boolean>;
