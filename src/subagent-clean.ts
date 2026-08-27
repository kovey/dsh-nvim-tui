/**
 * Subagent thought-chain TTL + cleanup bookkeeping.
 *
 * The dsh host persists settled child-session events forever and exposes no
 * delete API, so the TUI does the cleanup itself:
 *  - expired settled chains are truncated via `sessionPersistence.truncateStored`
 *    (keeps only the first event — the bulk of the stored chain is freed);
 *  - cleaned ids are recorded in `$DSH_HOME/dsh-nvim-tui-subagent-clean.json`
 *    (keyed by parent session) and hidden from the /subagents listing, so the
 *    list stops growing.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Human age suffix for list rows ('' when unknown). */
export function ageLabel(createdAt: number | undefined, now: number = Date.now()): string {
  if (createdAt === undefined || !Number.isFinite(createdAt)) return ''
  const s = Math.max(0, Math.floor((now - createdAt) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)}m前`
  if (s < 86400) return `${Math.floor(s / 3600)}h前`
  return `${Math.floor(s / 86400)}d前`
}

/** Whether a settled chain has passed the retention window (0 = disabled). */
export function isExpired(createdAt: number | undefined, ttlHours: number, now: number = Date.now()): boolean {
  if (ttlHours <= 0) return false
  if (createdAt === undefined || !Number.isFinite(createdAt)) return false
  return now - createdAt > ttlHours * 3600 * 1000
}

/** Cleaned-id ledger path under DSH_HOME. */
function cleanStatePath(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-nvim-tui-subagent-clean.json')
}

/** /subagents list ordering: running children first (the live work is what
 *  matters), then newest-first within each group. */
export function orderSubagentChildren<T extends { running?: boolean; createdAt?: number }>(children: T[]): T[] {
  return [...children].sort((a, b) => {
    if ((a.running ?? false) !== (b.running ?? false)) return a.running ? -1 : 1
    return (b.createdAt ?? 0) - (a.createdAt ?? 0)
  })
}

/** Read the cleaned-id ledger: parentSessionId -> childIds. */
export function readCleanedIds(): Record<string, string[]> {
  try {
    const j = JSON.parse(readFileSync(cleanStatePath(), 'utf8')) as { cleaned?: unknown }
    if (j !== null && typeof j === 'object' && j.cleaned !== null && typeof j.cleaned === 'object') {
      const out: Record<string, string[]> = {}
      for (const [k, v] of Object.entries(j.cleaned as Record<string, unknown>)) {
        if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string')
      }
      return out
    }
  } catch {}
  return {}
}

/** Persist the cleaned-id ledger (best-effort). */
export function writeCleanedIds(cleaned: Record<string, string[]>): void {
  try {
    writeFileSync(cleanStatePath(), JSON.stringify({ cleaned }))
  } catch {}
}
