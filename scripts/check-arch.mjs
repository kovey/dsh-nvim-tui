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
  'app.exitDiag =', 'app.closeNvimWindow =', 'app.teardown =', 'app.quit =',
]
for (const s of MOVED_SERVICES) {
  if (appSrc.includes(s)) fail(`createApp re-implements a moved service (${s.split(' =')[0]})`)
}

// 3b) I2: slice STATE defaults also moved into the owner modules —
//    createApp only provides empty domain shells.
const MOVED_STATE = [
  'live: new Map()', 'spinnerIndex: 0', 'pendingInput: []',
  'workflowRuns: new Map()', 'bellOn: true', 'extNodeHandlers: new Map()',
  'hostDisposers: []', 'pendingEchoes: new Map()', 'extSessionSubs: []',
  'historyHeaders: []', 'pendingImages: []',
  // (registerCommands/commandCatalog/refreshCommandCatalog are KERNEL
  //  bootstrap facilities — every module registers specs at install time)
]
for (const s of MOVED_STATE) {
  if (appSrc.includes(s)) fail(`createApp still seeds slice state (${s}) — inject it in the owner module`)
}

// 3c) 跨域状态写收口：readonly 状态字段只允许 owner 文件写入（经
//     WritableSlice 视图）；非 owner 文件的直接赋值是架构违规——跨域
//     变更必须走域操作方法（setXxx/settleXxx）。
const STATE_OWNERS = {
  'src/app.ts': new Set(), // kernel：无 slice 状态写
  'src/boot.ts': new Set(['runtime']),
  'src/ext-api.ts': new Set(['ext']),
  'src/statusline.ts': new Set(['ui']),
  'src/sessions.ts': new Set(['sessions']),
  'src/subagents.ts': new Set(['agent']),
  'src/transcript.ts': new Set(['trans', 'ui']),
  'src/commands.ts': new Set(['agent']),
  'src/market-install.ts': new Set(),
  'src/deps.ts': new Set(),
}
const STATE_FIELDS = {
  runtime: ['nvim','child','channelIdValue','disposed','quitting','chatWinId','reasoningOpen','reasoningWinId','feedDisposer','hostDisposers','spinnerTimer','spinnerIndex','idleRefreshTimer'],
  sessions: ['live','activeId','historyHeaders','historyById','sessionEntries','runningSubagents','childParent'],
  ui: ['pendingFileSnaps','renderedDiffCalls','pendingEchoes'],
  ext: ['extApi','extReadyResolve','extSessionSubs','extLuaSubs','extNodeCleanup','pendingCardInput','extNodeHandlers','extStatusSegments'],
  trans: ['workflowRuns'],
  agent: ['pendingInput','pendingImages','pendingRename','pendingQueueEdit','approvalSettle','approvalReq','questionsResolve','pickerSettle','dirSettle','bellOn','subagentView','subagentChat','pendingSubagentFollowup'],
}
for (const [file, owned] of Object.entries(STATE_OWNERS)) {
  const src = readFileSync(join(root, file), 'utf8')
  for (const [dom, fields] of Object.entries(STATE_FIELDS)) {
    if (owned.has(dom)) continue
    for (const f of fields) {
      const re = new RegExp(`app\\.slices\\.${dom}\\.${f}\\s*=(?!=)`)
      const m = src.match(re)
      if (m) {
        const ln = src.slice(0, m.index).split('\n').length
        fail(`${file}:${ln} cross-domain state write app.slices.${dom}.${f} (readonly — use the domain ops)`)
      }
    }
  }
}

// 4) legacy flat access must not reappear (outside app.ts's own internal
//    slice-literal implementations which are exempt)
for (const f of readdirSync(join(root, 'src')).filter((n) => n.endsWith('.ts'))) {
  if (f === 'app.ts') continue
  const src = readFileSync(join(root, 'src', f), 'utf8')
  for (const m of src.matchAll(/\bapp\.(nvim|pickerSettle|pendingInput|workflowRuns|bellOn|chatWinId|historyHeaders|extApi|spinnerIndex|activeId|sessions)\b/g)) {
    fail(`${f}: legacy flat access app.${m[1]} (use app.slices.<domain>.${m[1]})`)
  }
}

console.log('✓ arch-check: App kernel-only, slice domains valid, no legacy flat access')
