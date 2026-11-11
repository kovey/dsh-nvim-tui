/**
 * Approval picker bridge used by the public `tui.approval.pick()` surface.
 *
 * Kept separate from ext-api so the decision rules (headless, abort, outcome
 * vocabulary) are testable with a fake picker. The host waterfall owns
 * ordering; this helper only renders and returns.
 *
 * @module dsh-nvim-tui/ext-api/approval
 */
import type { App } from '../kernel/app.js'
import type { ExtApprovalOutcome, ExtApprovalRequest } from '../kernel/ext-types.js'

/** Approval picker rows (single source for the public bridge and tests). */
export const approvalPickerItems = (): Array<{ label: string; value: ExtApprovalOutcome; active?: boolean }> => [
  { label: '允许一次（allowed-once）', value: 'allowed-once', active: true },
  { label: '拒绝（rejected）', value: 'rejected' },
  { label: '取消，不做决定（cancelled）', value: 'cancelled' },
]

/** Human-facing title for one approval; reason is bounded before display. */
export const approvalPickerTitle = (request: ExtApprovalRequest, override?: string): string => {
  if (override !== undefined && override !== '') return override
  const reason = request.displayReason?.['zh'] ?? request.displayReason?.['en'] ?? request.reason ?? ''
  const clean = reason.replace(/\s+/g, ' ').trim()
  const shown = clean.length > 160 ? clean.slice(0, 157) + '…' : clean
  return `${request.toolName ?? 'tool'} 需要你的决定${shown === '' ? '' : `\n\n${shown}`}`
}

export type ApprovalApp = Pick<App, 'headless' | 'openPicker'>

export const pickApproval = async (
  app: ApprovalApp,
  request: ExtApprovalRequest,
  opts?: { title?: string },
): Promise<ExtApprovalOutcome> => {
  // Headless still renders pickers for e2e dumps; an approval answerer must
  // never consume a request there. 'unavailable' means "no UI was shown".
  if (app.headless) return 'unavailable'
  if (request.signal?.aborted === true) return 'cancelled'
  const choice = await app.openPicker(
    approvalPickerTitle(request, opts?.title),
    approvalPickerItems(),
    request.signal === undefined ? {} : { signal: request.signal },
  )
  if (choice === null) return 'cancelled'
  return choice === 'allowed-once' || choice === 'rejected' || choice === 'cancelled'
    ? choice
    : 'cancelled'
}
