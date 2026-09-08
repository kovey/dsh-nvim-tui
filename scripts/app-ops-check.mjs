/**
 * Runtime guard for the domain-ops closure: after the full install chain,
 * EVERY op declared on the slices must be a real function (Object.assign
 * injection is invisible to tsc — this catches missing implementations).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp } from '../lib/kernel/app.js'
import { installRuntime } from '../lib/boot/boot.js'
import { installExtApi } from '../lib/ext-api/index.js'
import { installStatusline } from '../lib/statusline/index.js'
import { installSessions } from '../lib/sessions/index.js'
import { installSubagents } from '../lib/subagents/index.js'
import { installTranscript } from '../lib/transcript/index.js'
import { installCommands } from '../lib/commands/index.js'

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

// OP_LISTS is DERIVED from the AppSlices declaration (lib/kernel/app.d.ts):
// every non-readonly FUNCTION member of a slice is an owner op — a new op
// added to the interface is automatically covered, and a missing Object.assign
// injection is caught without a hand-maintained list.
const OP_LISTS = {}
{
  const dts = readFileSync(join(root, 'lib/kernel/app.d.ts'), 'utf8')
  const ifaceStart = dts.indexOf('interface AppSlices')
  const ifaceEnd = dts.indexOf('/** Writable view', ifaceStart)
  const iface = dts.slice(ifaceStart, ifaceEnd)
  // split into domain blocks: "  runtime: {", "  sessions: {", ...
  const domRe = /^  (\w+): \{/gm
  let m
  const doms = []
  while ((m = domRe.exec(iface)) !== null) doms.push([m[1], m.index])
  for (let d = 0; d < doms.length; d++) {
    const [name, start] = doms[d]
    const end = d + 1 < doms.length ? doms[d + 1][1] : iface.length
    const block = iface.slice(start, end)
    // op members: name(args): returnType  — skip readonly state fields
    const ops = []
    for (const om of block.matchAll(/^    (?!readonly )(\w+)\(/gm)) ops.push(om[1])
    OP_LISTS[name] = ops
  }
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
const totalOps = Object.values(OP_LISTS).reduce((a, l) => a + l.length, 0)
console.log(`✓ app-ops-check: ${totalOps} domain ops all injected (derived from AppSlices), roundtrips sane`)
