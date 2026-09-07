/**
 * P2 architecture boundary guard (runs in `npm run check`):
 *  1. App must be kernel-only: the `App` interface carries no legacy flat
 *     state members (any new shared state goes into AppSlices).
 *  2. Every `app.slices.<domain>` reference in src/ must name a real slice.
 *  3. Legacy flat accessors (`app.<oldField>`) must not reappear anywhere.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const root = join(dirname(new URL(import.meta.url).pathname), '..')
const fail = (msg) => { console.error('✗ arch-check:', msg); process.exitCode = 1 }

// 1) kernel-only App interface: the legacy fields below must not be declared
//    as flat members of `App` (they live in AppSlices now).
const LEGACY_SENTINELS = [
  'nvim: NeovimClient', 'commandSpecs: CommandSpec', 'pickerSettle:',
  'pendingInput: string', 'workflowRuns: Map<string, WorkflowRun>',
  'extApi: TuiExtApi', 'sessions: Map<string, SessionRec>',
  'bellOn: boolean', 'chatWinId: number', 'historyHeaders: Array',
]
const appSrc = readFileSync(join(root, 'src/app.ts'), 'utf8')
const ifaceStart = appSrc.indexOf('/** The complete cross-module surface.')
const ifaceEnd = appSrc.indexOf('/** Build the App object.')
const iface = appSrc.slice(ifaceStart, ifaceEnd)
if (!iface.includes('slices: AppSlices')) fail('App interface lost the slices member')
for (const s of LEGACY_SENTINELS) {
  if (iface.includes(s)) fail(`App interface still declares a legacy flat member (${s.split(':')[0]})`)
}

// 2) slice domain names must be real
const SLICES = ['runtime', 'sessions', 'ui', 'ext', 'trans', 'agent']
const domRe = /app\.slices\.([a-z]+)\b/g
for (const f of readdirSync(join(root, 'src')).filter((n) => n.endsWith('.ts'))) {
  const src = readFileSync(join(root, 'src', f), 'utf8')
  for (const m of src.matchAll(domRe)) {
    if (!SLICES.includes(m[1])) fail(`${f}: unknown slice domain '${m[1]}'`)
  }
}

// 3) createApp must stay a SHELL: the core-service implementations moved
//    into their owner modules (I1) — any of these assignments reappearing
//    in app.ts means an implementation crept back into the kernel factory.
const MOVED_SERVICES = [
  'app.slices.sessions.readState =', 'app.slices.sessions.recordState =',
  'app.slices.sessions.refreshHistory =', 'app.slices.sessions.refreshList =',
  'app.slices.ui.readFileSnapshot =', 'app.slices.ui.maybePushFileDiff =',
  'app.slices.ui.feedForSubagent =', 'app.slices.agent.refreshCommandCatalog =',
  'app.slices.agent.registerCommands =', 'app.slices.agent.commandCatalog =',
  'app.exitDiag =', 'app.closeNvimWindow =', 'app.teardown =', 'app.quit =',
]
for (const s of MOVED_SERVICES) {
  if (appSrc.includes(s)) fail(`createApp re-implements a moved service (${s.split(' =')[0]})`)
}

// 4) legacy flat access must not reappear (outside app.ts's own internal
//    slice-literal implementations which are exempt)
for (const f of readdirSync(join(root, 'src')).filter((n) => n.endsWith('.ts'))) {
  if (f === 'app.ts') continue
  const src = readFileSync(join(root, 'src', f), 'utf8')
  for (const m of src.matchAll(/\bapp\.(nvim|commandSpecs|pickerSettle|pendingInput|workflowRuns|bellOn|chatWinId|historyHeaders|extApi|spinnerIndex|activeId|sessions)\b/g)) {
    fail(`${f}: legacy flat access app.${m[1]} (use app.slices.<domain>.${m[1]})`)
  }
}

console.log('✓ arch-check: App kernel-only, slice domains valid, no legacy flat access')
