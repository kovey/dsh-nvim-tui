/**
 * Runtime guard for the domain-ops closure: after the full install chain,
 * EVERY op declared on the slices must be a real function (Object.assign
 * injection is invisible to tsc — this catches missing implementations).
 */
import { createApp } from '../lib/kernel/app.js'
import { installRuntime } from '../lib/boot.js'
import { installExtApi } from '../lib/ext-api.js'
import { installStatusline } from '../lib/statusline.js'
import { installSessions } from '../lib/sessions.js'
import { installSubagents } from '../lib/subagents.js'
import { installTranscript } from '../lib/transcript.js'
import { installCommands } from '../lib/commands.js'

const ctx = { effect: () => () => {}, get: () => undefined }
const runtimeCtx = {
  get: () => undefined,
  agentDefaultModel: { currentSelection: () => 'auto' },
  sessions: { list: () => [], flush: async () => {}, get: () => undefined },
}
const app = createApp(ctx, runtimeCtx, {})
installRuntime(app)
installExtApi(app)
installStatusline(app)
installSessions(app)
installSubagents(app)
installTranscript(app)
installCommands(app)

const OP_LISTS = {
  'runtime': ['setChatWin', 'setReasoning', 'spinnerSet', 'spinnerStep'],
  'ext': ['setPendingCardInput', 'fireExtReady'],
  'agent': ['setApproval', 'settleApproval', 'setPickerSettle', 'settlePicker',
    'setQuestions', 'settleQuestions', 'rejectQuestions', 'setDirSettle',
    'resolveDirPicker', 'setPendingRename', 'setPendingQueueEdit',
    'setSubagentView', 'setSubagentChat'],
}
let failed = 0
for (const [dom, ops] of Object.entries(OP_LISTS)) {
  for (const op of ops) {
    if (typeof app.slices[dom]?.[op] !== 'function') {
      console.error(`✗ missing op: app.slices.${dom}.${op}`)
      failed++
    }
  }
}
// smoke the ext ops roundtrip (the pair boot relies on)
app.slices.ext.setPendingCardInput({ mark: 1, actionIdx: 2, prompt: 'p' })
if (app.slices.ext.pendingCardInput?.actionIdx !== 2) { console.error('✗ setPendingCardInput roundtrip'); failed++ }
app.slices.ext.setPendingCardInput(null)
let readyFired = false
app.slices.ext.fireExtReady() // no resolver yet → no-op
app.slices.runtime.spinnerStep(3)
if (app.slices.runtime.spinnerIndex !== 1) { console.error('✗ spinnerStep modulo'); failed++ }
app.slices.runtime.spinnerStep(3)
if (app.slices.runtime.spinnerIndex !== 2) { console.error('✗ spinnerStep modulo 2'); failed++ }
app.slices.runtime.spinnerStep(3)
if (app.slices.runtime.spinnerIndex !== 0) { console.error('✗ spinnerStep wraps'); failed++ }
if (failed > 0) process.exit(1)
console.log('✓ app-ops-check: 19 domain ops all injected, roundtrips sane')
