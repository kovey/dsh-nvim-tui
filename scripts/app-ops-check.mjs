/**
 * Runtime guard for the domain-ops closure: after the full install chain,
 * EVERY op declared on the slices must be a real function (Object.assign
 * injection is invisible to tsc — this catches missing implementations).
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
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
  const domRe = /^    (\w+): \{/gm
  let m
  const doms = []
  while ((m = domRe.exec(iface)) !== null) doms.push([m[1], m.index])
  for (let d = 0; d < doms.length; d++) {
    const [name, start] = doms[d]
    const end = d + 1 < doms.length ? doms[d + 1][1] : iface.length
    const block = iface.slice(start, end)
    // op members: name(args): returnType  — skip readonly state fields
    const ops = []
    for (const om of block.matchAll(/^        (?!readonly )(\w+):\s*\(/gm)) ops.push(om[1])
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
// -- 4) STATE SEEDING probe (the livePopup-crash family): every readonly
//    STATE field (non-function member) declared on AppSlices must be seeded
//    by its owner install — an undefined at runtime means `x !== null`
//    guards leak through (TypeError 'reading kind' on every todo/write or
//    heartbeat) and auto-resume dies with the fallback notice.
{
  const dts = readFileSync(join(root, 'lib/kernel/app.d.ts'), 'utf8')
  const ifaceStart = dts.indexOf('interface AppSlices')
  const ifaceEnd = dts.indexOf('/** Writable view', ifaceStart)
  const iface = dts.slice(ifaceStart, ifaceEnd)
  const domRe = /^    (\w+): \{/gm
  let m
  const doms = []
  while ((m = domRe.exec(iface)) !== null) doms.push([m[1], m.index])
  for (let d = 0; d < doms.length; d++) {
    const [name, start] = doms[d]
    const end = d + 1 < doms.length ? doms[d + 1][1] : iface.length
    const block = iface.slice(start, end)
    // state fields: `readonly name: TYPE;` — TYPE may nest braces/arrows, so
    // scan char-by-char from the colon to the depth-0 semicolon. Function
    // members (ops/services, covered by the OP probe) open with '('.
    const memberRe = /^        readonly (\w+):/gm
    while ((m = memberRe.exec(block)) !== null) {
      const field = m[1]
      let depth = 0
      let i = m.index + m[0].length
      let typeText = ''
      for (; i < block.length; i++) {
        const c = block[i]
        if (c === '{') depth++
        else if (c === '}') depth--
        else if (c === ';' && depth === 0) break
        typeText += c
      }
      if (typeText.trim().startsWith('(')) continue
      const v = app.slices[name]?.[field]
      if (v === undefined) {
        console.error(`✗ unseeded slice state: app.slices.${name}.${field} is undefined (owner install must seed it)`)
        failed++
      }
    }
  }
}
// -- 3) explicit regression: todo/write fold must not throw even when
//    livePopup is undefined (the pre-seed crash) — guards stay effective.
{
  app.slices.agent.setLivePopup(null)
  const fakeRec = { id: 'probe-session' }
  try {
    app.slices.ui.foldEvent(fakeRec, { type: 'todo/write', time: 0, data: { todos: [{ content: 'x', status: 'pending' }] } })
  } catch (e) {
    console.error('✗ todo/write fold threw with seeded livePopup:', e.message)
    failed++
  }
  app.slices.agent.setLivePopup(undefined)
  try {
    app.slices.ui.foldEvent(fakeRec, { type: 'todo/write', time: 1, data: { todos: [{ content: 'y', status: 'pending' }] } })
  } catch (e) {
    console.error('✗ todo/write fold threw with undefined livePopup:', e.message)
    failed++
  }
  app.slices.agent.setLivePopup(null)
}

if (failed > 0) process.exit(1)
const totalOps = Object.values(OP_LISTS).reduce((a, l) => a + l.length, 0)
console.log(`✓ app-ops-check: ${totalOps} domain ops all injected (derived from AppSlices), roundtrips sane`)
