// Real-model end-to-end regression: launch the actual dsh harness with the
// nvim-tui runner in headless mode, feed one prompt, and verify the dump
// contains an assistant response (not an error).
//
//   npm run e2e -- "你好，请只回复：收到"
//
// Requires a working dsh install + credentials (the same env `dsh` uses).
// Runs via Node's native type stripping (Node >= 23.6).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { judgeDump } from './e2e-judge.ts'

const prompt = process.argv[2] ?? '你好，请只回复两个字：收到'
const dumpPath = path.join(os.tmpdir(), `dsh-nvim-tui-e2e-${process.pid}.txt`)
const timeoutMs = Number(process.env['DSH_NVIM_TUI_E2E_TIMEOUT'] ?? 180000)
// Overridable harness entry (e.g. DSH_BIN=/tmp/dsh-alpha-prefix/node_modules/.bin/dsh
// DSH_NVIM_TUI_PROFILE=nvim-tui-a2 for alpha verification) — defaults to PATH `dsh`.
const dshBin = process.env['DSH_BIN'] ?? 'dsh'
const profile = process.env['DSH_NVIM_TUI_PROFILE'] ?? 'nvim-tui'

try { fs.unlinkSync(dumpPath) } catch {}

const child = spawn(dshBin, ['--profile', profile], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    DSH_NVIM_TUI_HEADLESS: '1',
    DSH_NVIM_TUI_PROMPT: prompt,
    DSH_NVIM_TUI_DUMP: dumpPath,
    // A fresh session keeps the dump free of replayed history (a resumed
    // session would re-render old errors and false-positive the check).
    DSH_NVIM_TUI_RESUME_LATEST: '0',
  },
})

child.on('error', (e) => {
  console.error('E2E FAIL: cannot spawn dsh (' + e.message + ') — is @deepseek-ai/dsh installed?')
  process.exit(1)
})
let out = ''
child.stdout.on('data', (d: Buffer) => { out += d.toString() })
child.stderr.on('data', (d: Buffer) => { out += d.toString() })

const deadline = Date.now() + timeoutMs
const finished = await new Promise<'dump' | 'exit' | 'timeout'>((resolve) => {
  const poll = (): void => {
    if (fs.existsSync(dumpPath)) return resolve('dump')
    if (child.exitCode !== null) return resolve('exit')
    if (Date.now() > deadline) return resolve('timeout')
    setTimeout(poll, 300)
  }
  child.once('exit', () => resolve('exit'))
  poll()
})

if (finished === 'dump') {
  // The dump proves the UI rendered, NOT that the harness exited cleanly:
  // wait for the child and fail on any non-zero exit (pre-review: a harness
  // crash right after the dump still printed E2E PASS).
  const exited: Promise<number | null> = new Promise((resolve) => {
    if (child.exitCode !== null) { resolve(child.exitCode); return }
    child.once('exit', (code) => resolve(code))
  })
  const exitCode = await Promise.race<number | null | 'hung'>([
    exited,
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 15000)),
  ])
  if (exitCode === 'hung') {
    child.kill('SIGKILL')
    console.error('E2E FAIL: harness did not exit within 15s after writing the dump')
    process.exit(1)
  }
  if (exitCode !== 0) {
    console.error(`E2E FAIL: harness exited with code ${exitCode} after the dump\n` + out.slice(-3000))
    process.exit(1)
  }
  const dump = fs.readFileSync(dumpPath, 'utf8')
  // The judgement rule lives in ./e2e-judge.ts so it is unit-testable (the
  // smoke suite exercises it); it used to be inline and every heuristic bug in
  // it — a bare '·' read, an over-broad '· ' filter — only surfaced when a real
  // run misjudged.
  const failure = judgeDump(dump)
  if (failure !== null) {
    console.error(`E2E FAIL: ${failure}`)
    const lastTurn = dump.lastIndexOf('── turn ──')
    console.error((lastTurn >= 0 ? dump.slice(lastTurn) : dump).slice(0, 4000))
    process.exit(1)
  }
  console.log('E2E PASS — dump:', dumpPath)
  process.exit(0)
}

if (finished === 'timeout') {
  child.kill('SIGKILL')
  console.error(`E2E FAIL: timeout after ${timeoutMs}ms; harness output:\n` + out.slice(-3000))
  process.exit(1)
}

console.error('E2E FAIL: harness exited before the dump was written (exit ' + child.exitCode + ')\n' + out.slice(-3000))
process.exit(1)
