// Real-model end-to-end regression: launch the actual dsh harness with the
// nvim-tui runner in headless mode, feed one prompt, and verify the dump
// contains an assistant response (not an error).
//
//   npm run e2e -- "你好，请只回复：收到"
//
// Requires a working dsh install + credentials (the same env `dsh` uses).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const prompt = process.argv[2] ?? '你好，请只回复两个字：收到'
const dumpPath = path.join(os.tmpdir(), `dsh-nvim-tui-e2e-${process.pid}.txt`)
const timeoutMs = Number(process.env.DSH_NVIM_TUI_E2E_TIMEOUT ?? 180000)

try { fs.unlinkSync(dumpPath) } catch {}

const child = spawn('dsh', ['--profile', 'nvim-tui'], {
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

let out = ''
child.stdout.on('data', (d) => { out += d })
child.stderr.on('data', (d) => { out += d })

const deadline = Date.now() + timeoutMs
const finished = await new Promise((resolve) => {
  const poll = () => {
    if (fs.existsSync(dumpPath)) return resolve('dump')
    if (child.exitCode !== null) return resolve('exit')
    if (Date.now() > deadline) return resolve('timeout')
    setTimeout(poll, 300)
  }
  child.once('exit', () => resolve('exit'))
  poll()
})

if (finished === 'dump') {
  const dump = fs.readFileSync(dumpPath, 'utf8')
  // Judge only the LAST turn (the prompt's turn): anything before the final
  // '── turn ──' is preamble/history.
  const lastTurn = dump.lastIndexOf('── turn ──')
  const tail = lastTurn >= 0 ? dump.slice(lastTurn) : dump
  const bad = /⚠ |no API key|UNSUPPORTED_CONTENT|render flush failed|fatal:/i
  if (!/── turn ──/.test(tail)) {
    console.error('E2E FAIL: no turn rendered in dump')
    console.error(tail.slice(0, 2000))
    process.exit(1)
  }
  if (bad.test(tail)) {
    console.error('E2E FAIL: error markers found in the final turn')
    console.error(tail.slice(0, 4000))
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
