/**
 * API-key credential check, mirroring the harness llm adapters' resolution
 * (dsh-llm-deepseek resolveApiKey): the provider's `apiKeyEnv` ref resolves
 * through the credentials seam first, then the ambient launch environment.
 * Used by the first-launch onboarding and the /settings overview — never to
 * print or log the key itself (this module only reports presence).
 *
 * @module dsh-nvim-tui/kernel/apikey
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { App } from './app.js'

/** Credentials store location (the file the official Models page writes). */
export function credentialsPath(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml')
}

/** Credential ref (env-var name) the active provider's key resolves
 *  through — mirrors the llm adapters' apiKeyEnv defaults. */
export function keyRefForProvider(provider: string): string {
  const p = provider.toLowerCase()
  if (p.includes('deepseek')) return 'DEEPSEEK_API_KEY'
  if (p.includes('anthropic')) return 'ANTHROPIC_API_KEY'
  if (p.includes('openai')) return 'OPENAI_API_KEY'
  return `${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
}

/** Whether a usable key is configured for the provider: credentials seam
 *  first (stored refs / .env layering), then the ambient env. An unreadable
 *  seam reads as unconfigured — the guide is always safe to show. */
export async function apiKeyConfigured(app: App, provider: string): Promise<boolean> {
  const ref = keyRefForProvider(provider)
  const env = process.env[ref]
  if (typeof env === 'string' && env.trim() !== '') return true
  const cred = app.svc('credentials')
  if (typeof cred?.resolve === 'function') {
    try {
      // Bounded: a wedged credential seam (remote store, mount not ready)
      // used to stall the WHOLE boot sequence — onboarding sits between the
      // TUI becoming visible and announceReady. Unconfigured on timeout.
      const hit = await Promise.race([
        cred.resolve(ref) as Promise<{ value?: unknown } | undefined>,
        app.sleep(2000).then(() => undefined),
      ])
      if (hit !== undefined && hit !== null &&
        typeof hit.value === 'string' && hit.value.trim() !== '') {
        return true
      }
    } catch { /* fall through: presence is unknowable → treat as unconfigured */ }
  }
  return false
}
