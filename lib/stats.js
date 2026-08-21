/**
 * Statusline statistics: token formatting, cost estimation (built-in public
 * price table), and per-event usage folding.
 *
 * Reference: tianshu's glance segments — usage accumulates per session from
 * `assistant/message` events' `data.usage` (disjoint TokenUsage counts);
 * cache hit rate and context ratio derive from the billed input.
 */

/** Built-in price table (USD per 1M tokens, 2025 public pricing). */
const MODEL_PRICES = {
  'deepseek-v4-flash': { input: 0.27, output: 1.1, cacheRead: 0.07 },
  'deepseek-v4-pro': { input: 0.55, output: 2.19, cacheRead: 0.14 },
}

export const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** Fold one TokenUsage record into the session accumulator. */
export function foldUsage(acc, usage) {
  return {
    input: acc.input + (usage.inputTokens ?? 0),
    output: acc.output + (usage.outputTokens ?? 0),
    cacheRead: acc.cacheRead + (usage.cacheReadTokens ?? 0),
    cacheWrite: acc.cacheWrite + (usage.cacheWriteTokens ?? 0),
  }
}

/** Billed input tokens (input + cache reads + cache writes). */
export function billedInput(usage) {
  return usage.input + usage.cacheRead + usage.cacheWrite
}

/** Cache hit ratio, null when the adapter never reported cache fields. */
export function cacheHitRate(usage, cacheReported) {
  if (!cacheReported) return null
  const billed = billedInput(usage)
  if (billed <= 0) return null
  return usage.cacheRead / billed
}

/** Estimated USD cost; undefined for unknown models or zero tokens. */
export function estimateCost(modelName, usage) {
  const price = MODEL_PRICES[modelName]
  if (price === undefined) return undefined
  if (billedInput(usage) <= 0 && usage.output <= 0) return undefined
  const cost = (usage.input * price.input +
    usage.cacheRead * (price.cacheRead ?? price.input) +
    usage.cacheWrite * price.input +
    usage.output * price.output) / 1e6
  return Math.round(cost * 100) / 100
}

/** 512600 → '512.6k'; 1000000 → '1.00M'. */
export function formatTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}

/** 102510 ms → '1m 42s'; 95000 → '1m 35s'; 234 → '234ms'. */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 1) return `${Math.max(0, Math.floor(ms))}ms`
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m >= 60) {
    const h = Math.floor(m / 60)
    return `${h}h ${m % 60}m`
  }
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/** Escape a literal % for the statusline format (% is the item prefix). */
export function escapeStatusline(s) {
  return String(s).replace(/%/g, '%%')
}

/** Human permission-mode label (SandboxMode). */
export function modeLabel(mode) {
  switch (mode) {
    case 'read-only': return 'read-only'
    case 'workspace-write': return 'normal'
    case 'danger-full-access': return 'full-access'
    default: return mode ?? '?'
  }
}
