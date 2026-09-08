/**
 * P2 architecture boundary guard (runs in `npm run check`):
 *  1. App must be kernel-only: the `App` interface carries no legacy flat
 *     state members (any new shared state goes into AppSlices).
 *  2. Every `app.slices.<domain>` reference in src/ must name a real slice.
 *  3. Legacy flat accessors (`app.<oldField>`) must not reappear anywhere.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'

/** Recursive .ts walk (src/ is now a directory tree). */
const walkTs = (dir) => {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walkTs(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

const root = join(dirname(new URL(import.meta.url).pathname), '..')
const fail = (msg) => { console.error('✗ arch-check:', msg); process.exitCode = 1 }

// 1) kernel-only App interface: the legacy fields below must not be declared
//    as flat members of `App` (they live in AppSlices now).
const LEGACY_SENTINELS = [
  'nvim: NeovimClient', 'pickerSettle:',
  'pendingInput: string', 'workflowRuns: Map<string, WorkflowRun>',
  'extApi: TuiExtApi', 'sessions: Map<string, SessionRec>',
  'bellOn: boolean', 'chatWinId: number', 'historyHeaders: Array',
  // (commandSpecs is the KERNEL command registry — sanctioned on the root)
]
const appSrc = readFileSync(join(root, 'src/kernel/app.ts'), 'utf8')
const ifaceStart = appSrc.indexOf('/** The complete cross-module surface')
const ifaceEnd = appSrc.indexOf('/** Build the App object.')
if (ifaceStart === -1 || ifaceEnd === -1 || ifaceStart >= ifaceEnd) {
  fail('arch-check: App interface markers missing (comment text changed?) — refusing to run on an empty slice')
  process.exit(1)
}
const iface = appSrc.slice(ifaceStart, ifaceEnd)
if (!iface.includes('slices: AppSlices')) fail('App interface lost the slices member')
for (const s of LEGACY_SENTINELS) {
  if (iface.includes(s)) fail(`App interface still declares a legacy flat member (${s.split(':')[0]})`)
}

// 2) slice domain names must be real
const SLICES = ['runtime', 'sessions', 'ui', 'ext', 'trans', 'agent']
const domRe = /app\.slices\.([a-z]+)\b/g
for (const f of walkTs(join(root, 'src'))) {
  const src = readFileSync(f, 'utf8')
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
  'src/kernel/app.ts': new Set(), // kernel：无 slice 状态写
  'src/boot/boot.ts': new Set(['runtime']),
  'src/ext-api/index.ts': new Set(['ext']),
  'src/statusline/index.ts': new Set(['ui']),
  'src/sessions/index.ts': new Set(['sessions']),
  'src/subagents/index.ts': new Set(['agent']),
  'src/transcript/index.ts': new Set(['trans', 'ui']),
  'src/commands/index.ts': new Set(['agent']),
  'src/market/index.ts': new Set(),
  'src/deps/index.ts': new Set(),
  'src/kernel/rpc.ts': new Set(),
  'src/kernel/host-events.ts': new Set(),
  'src/boot/session-events.ts': new Set(),
  'src/kernel/lifecycle.ts': new Set(['runtime']),
  'src/kernel/headless.ts': new Set(),
}
const STATE_FIELDS = {
  runtime: ['nvim','child','channelIdValue','disposed','quitting','chatWinId','reasoningOpen','reasoningWinId','feedDisposer','hostDisposers','spinnerTimer','spinnerIndex','idleRefreshTimer'],
  sessions: ['live','activeId','historyHeaders','historyById','sessionEntries','runningSubagents','childParent'],
  ui: ['pendingFileSnaps','renderedDiffCalls','pendingEchoes'],
  ext: ['extApi','extReadyResolve','extSessionSubs','extLuaSubs','extNodeCleanup','pendingCardInput','extNodeHandlers','extStatusSegments'],
  trans: ['workflowRuns'],
  agent: ['pendingInput','pendingImages','pendingRename','pendingQueueEdit','approvalSettle','approvalReq','questionsResolve','pickerSettle','dirSettle','bellOn','subagentView','subagentChat','pendingSubagentFollowup','livePopup'],
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
for (const f of walkTs(join(root, 'src'))) {
  if (f === join(root, 'src/kernel/app.ts')) continue
  const src = readFileSync(f, 'utf8')
  for (const m of src.matchAll(/\bapp\.(nvim|pickerSettle|pendingInput|workflowRuns|bellOn|chatWinId|historyHeaders|extApi|spinnerIndex|activeId|sessions)\b/g)) {
    fail(`${f}: legacy flat access app.${m[1]} (use app.slices.<domain>.${m[1]})`)
  }
}

// 5) kernel 依赖方向（阶段 1）：kernel 文件只允许 import kernel 内部 +
//    以下白名单（feed 渲染层类型在 P2 迁入 feed/ 前暂居根目录）。
const KERNEL_OUTER_ALLOWED = ['../feed/feed.js']
for (const f of walkTs(join(root, 'src/kernel'))) {
  const src = readFileSync(f, 'utf8')
  for (const m of src.matchAll(/from '(\.[^']+)'/g)) {
    const imp = m[1]
    if (imp.startsWith('./')) continue
    if (!KERNEL_OUTER_ALLOWED.includes(imp)) {
      fail(`${relative(root, f)}: kernel import ${imp} is not kernel-internal (kernel must not depend on business modules)`)
    }
  }
}

// 6) feed 依赖方向（阶段 2）：渲染层只允许 import kernel 内部 + feed 内部。
for (const f of walkTs(join(root, 'src/feed'))) {
  const src = readFileSync(f, 'utf8')
  for (const m of src.matchAll(/from '(\.\.[^']+)'/g)) {
    const imp = m[1]
    if (imp.startsWith('../kernel/')) continue
    fail(`${relative(root, f)}: feed import ${imp} is not kernel-internal (feed layer depends on kernel only)`)
  }
}

// 7) 业务模块依赖方向（阶段 3）：模块目录只允许外联 kernel/ 与 feed/
//    （boot/ 是组合层，豁免）。
const MODULE_DIRS = ['sessions', 'subagents', 'transcript', 'statusline', 'ext-api', 'deps', 'market', 'commands']
for (const dir of MODULE_DIRS) {
  for (const f of walkTs(join(root, 'src', dir))) {
    const src = readFileSync(f, 'utf8')
    const own = join(root, 'src', dir)
    for (const m of src.matchAll(/from '(\.\.[^']+)'/g)) {
      const imp = m[1]
      const target = resolve(dirname(f), imp)
      if (target.startsWith(join(root, 'src/kernel')) ||
          target.startsWith(join(root, 'src/feed')) ||
          target.startsWith(own)) continue
      fail(`${relative(root, f)}: module import ${imp} crosses a module boundary (allowed: kernel/ + feed/ + own module)`)
    }
  }
}

// 8) src 根目录只允许 index.ts（模块一律进自己的目录）。
const rootFiles = readdirSync(join(root, 'src'), { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.ts')).map((e) => e.name)
if (rootFiles.length !== 1 || rootFiles[0] !== 'index.ts') {
  fail(`src root must contain ONLY index.ts (found: ${rootFiles.join(', ')})`)
}

console.log('✓ arch-check: App kernel-only, slice domains valid, no legacy flat access, dependency direction clean')
