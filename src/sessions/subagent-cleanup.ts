/** Free a settled child's stored bulk on hosts that still expose raw
 *  artifacts (pre-0.1.5). Kept separate from the lifecycle module so the
 *  cleanup branch does not deepen every call site.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { encodeHeaderOnlyLog } from '../kernel/subagent-clean.js'
import type { SessionPersistenceService } from '../kernel/types.js'

const isZstdArtifact = (path: string): boolean => {
  try {
    const head = readFileSync(path).subarray(0, 4)
    return head.length === 4 && head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd
  } catch {
    return false
  }
}

export const truncateStoredRaw = async (
  persistence: SessionPersistenceService | undefined,
  childId: string,
): Promise<void> => {
  if (persistence?.supportsRawArtifacts !== true) return
  const inspection = await persistence.inspect?.(childId)
  const meta = inspection?.meta
  if (meta?.id !== childId) return
  const loc = persistence.locate?.(meta)
  const path = typeof loc?.path === 'string' ? loc.path : undefined
  const raw = await persistence.readRaw?.(childId)
  const headerLine = (raw?.content ?? '').split('\n', 1)[0] ?? ''
  if (path !== undefined && headerLine !== '' && isZstdArtifact(path)) {
    writeFileSync(path + '.tmp', encodeHeaderOnlyLog(headerLine))
    renameSync(path + '.tmp', path)
  }
}
