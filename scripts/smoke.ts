// Headless smoke test: spawn nvim --headless with the dsh_tui plugin, connect
// over the socket, and verify the full RPC roundtrip without a DSH host:
//   Node → nvim (lua, buf_set_lines)              ✓
//   nvim → Node (rpcnotify notification)          ✓
//   FeedRenderer transcript → chat buffer lines    ✓
//   chat buffer undo disabled (undolevels = -1)   ✓
//   multi-session: ensure_chat / set_sessions / set_active  ✓
//   require survives rtp resets (package.preload) ✓
// Run: npm run smoke

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnNvim, connectNvim } from '../lib/bridge.js'
import { FeedRenderer } from '../lib/feed.js'
import { foldUsage, billedInput, cacheHitRate, estimateCost, formatTokens, formatElapsed, modeLabel, escapeStatusline } from '../lib/stats.js'
import { sniffMediaType, parseImageDataUrl, splitImageDataUrls, imageLabel } from '../lib/images.js'
import { t, setLocale, locale } from '../lib/i18n.js'
import { matchIntent } from '../lib/nlcmd.js'
import {
  parseStars, buildCatalog, searchCatalog, parsePluginYaml,
  setDisabledRows, readDisabledIds, isNpmName, depMatchesEntry, repoRoot, installSpec,
  classifyPnpmError, firstErrorLine, profileDir,
} from '../lib/market.js'

// console.* is async and its output can be swallowed by non-TTY capture
// environments once the nvim child shares the pipe; write synchronously.
const log = (...a: unknown[]) => fs.writeSync(1, a.join(' ') + '\n')

const { child, sockPath } = await spawnNvim({
  extraArgs: ['--headless'],
  loadUserConfig: false,
  isolateXdg: true,
})
const nvim = await connectNvim(sockPath)

/** msgpack-RPC boundary: nvim.lua results are structurally unknown by nature. */
const lua = (code: string, args: unknown[] = []): Promise<any> => nvim.lua(code, args as never[])

// The hint bar lives OUTSIDE and BELOW the popup window (M._footer): one
// row, same width, one row under the main window's bottom border.
const footerState = () => lua(`local f = require("dsh_tui")._footer
  local mcfg = vim.api.nvim_win_get_config(f.mainWin)
  local fcfg = vim.api.nvim_win_get_config(f.win)
  return {
    valid = vim.api.nvim_win_is_valid(f.win),
    text = vim.api.nvim_buf_get_lines(f.buf, 0, -1, false)[1],
    frow = fcfg.row, fcol = fcfg.col, fwidth = fcfg.width, fheight = fcfg.height,
    mrow = mcfg.row, mheight = mcfg.height, mwidth = mcfg.width,
    winhighlight = vim.wo[f.win].winhighlight or "",
  }`, [])
const assertFooter = async (hintPart: string, label: string) => {
  const fs = await footerState()
  assert.ok(fs.valid, `${label}: footer bar opens below the window`)
  assert.equal(fs.fheight, 1, `${label}: footer is one row tall`)
  assert.equal(fs.fwidth, fs.mwidth, `${label}: footer spans the main window width`)
  assert.equal(fs.frow, fs.mrow + fs.mheight + 2, `${label}: footer sits directly under the main window`)
  assert.ok(String(fs.text).includes(hintPart), `${label}: footer carries the operation hints`)
  assert.ok(String(fs.winhighlight).includes('DshTuiStatus'), `${label}: footer uses the statusline highlight`)
}
// Every popup opens centered on the editor: row = (lines - height) / 2 - 2,
// col = (columns - width) / 2, both clamped at the top-left.
const assertCentered = async (winLua: string, label: string) => {
  const cfg = await lua(`return vim.api.nvim_win_get_config(${winLua})`, [])
  const lines = await lua('return vim.o.lines', [])
  const cols = await lua('return vim.o.columns', [])
  assert.equal(cfg.row, Math.max(0, Math.floor((lines - cfg.height) / 2) - 2), `${label}: popup vertically centered`)
  assert.equal(cfg.col, Math.max(0, Math.floor((cols - cfg.width) / 2)), `${label}: popup horizontally centered`)
}
const assertModeN = async (label: string) => {
  for (let i = 0; i < 40; i++) {
    if ((await nvim.request('nvim_get_mode', [])).mode === 'n') return
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.fail(label + ': mode stayed out of normal')
}

try {
  // 1. channel id + Lua attach
  const channelId = await nvim.channelId
  log('channelId:', channelId)

  await lua('require("dsh_tui").attach(...)', [channelId])
  assert.equal(await lua('return require("dsh_tui").channel()', []), channelId)

  // VimEnter may not have fired yet (start() mounts the UI there) — poll.
  let ids
  for (let i = 0; i < 50; i++) {
    ids = await lua('return require("dsh_tui").ids()', [])
    if (Number.isInteger(ids?.inputBuf) && Number.isInteger(ids?.chatWin)) break
    await new Promise((r) => setTimeout(r, 100))
  }
  log('ids:', JSON.stringify(ids))
  assert.ok(Number.isInteger(ids.inputBuf) && Number.isInteger(ids.chatWin))
  assert.equal(ids.sessionsBuf, undefined, 'no resident sessions window anymore')

  // 2. multi-session: two chat buffers, /sessions float with FULL ids,
  // active switching.
  const chatA = await lua('return require("dsh_tui").ensure_chat(...)', ['session-aaaa'])
  const chatB = await lua('return require("dsh_tui").ensure_chat(...)', ['session-bbbb'])
  assert.notEqual(chatA.chatBuf, chatB.chatBuf, 'per-session chat buffers')

  await lua('require("dsh_tui").show_session_list(...)', [[
    { id: 'session-aaaa', title: '会话甲', active: true, kind: 'live' },
    { id: 'session-bbbb', title: '会话乙', active: false, kind: 'live' },
    { id: 'session-hist', title: '旧会话', active: false, kind: 'history' },
  ]])
  await assertModeN('session list opens in normal mode')
  let sessF = await lua('return require("dsh_tui")._sessBuf', [])
  const listLines = await nvim.request('nvim_buf_get_lines', [sessF, 0, -1, false])
  log('session list float:', JSON.stringify(listLines))
  assert.ok(listLines.some((l: string) => l.includes('会话甲') && l.includes('session-aaaa')), 'full session id shown')
  assert.ok(listLines.some((l: string) => l.includes('旧会话') && l.includes('session-hist') && l.includes('历史')), 'history kind shown')
  assert.equal(await lua('return vim.api.nvim_win_get_height(require("dsh_tui")._sessWin)', []), listLines.length, 'session window exactly fits content')
  await assertFooter('[Enter]', 'session list')
  await assertCentered('require("dsh_tui")._sessWin', 'session list')
  await lua('require("dsh_tui").close_session_list()', [])
  assert.equal(await lua('return require("dsh_tui")._sessWin', []), null, 'session list closed')
  assert.equal(await lua('return require("dsh_tui")._footer.win', []), null, 'footer closes with the session list')

  // active session's buffer shown in the chat window
  await lua('require("dsh_tui").set_active(...)', ['session-bbbb'])
  assert.equal(await lua('return vim.api.nvim_win_get_buf(...)', [ids.chatWin]), chatB.chatBuf)

  // 3. chat buffer must not be undoable
  assert.equal(await nvim.request('nvim_buf_get_option', [chatA.chatBuf, 'undolevels']), -1)

  // 4. FeedRenderer transcript → chat buffer; inactive feed must not move cursor
  let active = 'session-aaaa'
  const feedA = new FeedRenderer(nvim, chatA.chatBuf, chatA.chatWin, {
    activeChecker: () => active === 'session-aaaa',
  })
  const reasonB = await lua('return require("dsh_tui").ensure_reasoning(...)', ['session-bbbb'])
  const feedB = new FeedRenderer(nvim, chatB.chatBuf, chatB.chatWin, {
    activeChecker: () => active === 'session-bbbb',
    reasoningBuf: reasonB.reasoningBuf,
    reasoningView: () => ({ open: false, win: null }),
  })
  feedA.appendNotice('connected')
  feedA.applyEvent({ type: 'user/message', data: { content: [{ type: 'text', text: '你好' }] } })
  feedA.applyEvent({ type: 'turn/start', data: {} })
  feedA.applyEvent({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'Hello from ' } } })
  feedA.applyEvent({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'nvim' } } })
  feedA.applyEvent({ type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Hello from nvim (full) with **bold** and `code`' }] } } })
  feedA.applyEvent({ type: 'tool/call', time: 1000, data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"cmd":"ls"}' } })
  feedA.applyEvent({ type: 'tool/result', time: 1234, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'README.md' }], source: { callId: 'call-1' } } } })
  feedA.applyEvent({ type: 'tool/call', time: 2000, data: { turn: 1, step: 1, callId: 'call-2', name: 'web_search', arguments: '{"q":"x"}' } })
  feedA.applyEvent({ type: 'tool/result', time: 2999, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'boom' }], source: { callId: 'call-2' } }, error: { name: 'TimeoutError', code: 'TIMEOUT' } } })
  feedA.subagentStart({ runId: 'r1', provider: 'deepseek-code', id: 'uuid-child-1' })
  feedA.subagentEnd({ runId: 'r1', provider: 'deepseek-code', id: 'uuid-child-1', stopReason: 'completed' })
  feedA.workflowStart({ id: 'wf-1', meta: { name: '审计' } })
  feedA.workflowPhase({ id: 'wf-1', meta: {} }, '阶段一')
  feedA.workflowEnd({ id: 'wf-1', meta: {} }, { stopReason: 'completed' })
  feedB.appendNotice('b-notice')
  await new Promise((r) => setTimeout(r, 150)) // let the 40ms throttle flush

  const linesA = await nvim.request('nvim_buf_get_lines', [chatA.chatBuf, 0, -1, false])
  log('chat A lines:', JSON.stringify(linesA))
  assert.ok(linesA.includes('> 你好'), 'user message rendered')
  assert.ok(linesA.some((l: string) => l.includes('Hello from nvim (full) with bold and code')), 'markup stripped in buffer')
  assert.ok(linesA.some((l: string) => l.startsWith('🔧 bash({"cmd":"ls"})')), 'tool/call card')
  assert.ok(linesA.some((l: string) => l.startsWith('✓ bash · 234ms')), 'tool/result card with elapsed')
  assert.ok(linesA.some((l: string) => l.startsWith('✗ web_search') && l.includes('TIMEOUT')), 'failed tool card')
  assert.ok(linesA.some((l: string) => l.includes('◇ subagent deepseek-code')), 'subagent start card')
  assert.ok(linesA.some((l: string) => l.includes('◇ subagent deepseek-code · completed')), 'subagent end card')
  assert.ok(linesA.some((l: string) => l.includes('◈ workflow 审计')), 'workflow start card')
  assert.ok(linesA.some((l: string) => l.includes('◈ ─ 阶段一')), 'workflow phase card')

  // extmark spans: bold + code groups present
  const marks = await nvim.request('nvim_buf_get_extmarks', [chatA.chatBuf, -1, 0, -1, { details: true }])
  const groups = new Set(marks.map((m: any) => m[3]?.hl_group))
  assert.ok(groups.has('DshTuiBold'), 'bold span highlighted')
  assert.ok(groups.has('DshTuiCode'), 'code span highlighted')
  assert.ok(groups.has('DshTuiTool'), 'tool role highlighted')
  assert.ok(groups.has('DshTuiAssistant'), 'assistant output dimmed (own group)')
  // Row groups must be EXPLICIT same-row ranges (end_col = byte length) —
  // nvim 0.12's real TUI does not draw hl_eol marks, which rendered every
  // chat line plain white in production.
  const rowGroupMarks = marks.filter((m: any) => m[3]?.hl_group === 'DshTuiAssistant')
  assert.ok(rowGroupMarks.length > 0, 'assistant row-group marks exist')
  const chatLines = await nvim.request('nvim_buf_get_lines', [chatA.chatBuf, 0, -1, false])
  for (const m of rowGroupMarks) {
    assert.equal(m[3]?.hl_eol, false, 'row groups are not hl_eol marks')
    if ((chatLines[m[1]] ?? '').length > 0) {
      assert.ok(m[3]?.end_col > 0, 'row groups carry an explicit end_col (non-empty line)')
    }
  }
  const linesB = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  assert.deepEqual(linesB, ['· b-notice'], 'inactive session got its own feed')

  // history replay skips agent/status chatter
  feedA.applyEvent({ type: 'agent/status', data: { status: 'working' } }, { history: true })
  // finish-error chunks must surface (turn died → user must see why)
  feedA.applyEvent({ type: 'assistant/chunk', data: { turn: 2, step: 1, chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'no API key' } } } } })
  await new Promise((r) => setTimeout(r, 100))
  const linesA2 = await nvim.request('nvim_buf_get_lines', [chatA.chatBuf, 0, -1, false])
  log('chat A lines after finish:', JSON.stringify(linesA2))
  assert.ok(!linesA2.some((l: string) => l.includes('agent working')), 'history replay skips status')
  assert.ok(linesA2.some((l: string) => l.includes('no API key')), 'finish-error chunk rendered')

  // 4b. official-client parity rendering (batch 1): todo strip, compaction
  // checkpoint, retry rows, workflow-in-transcript, structured tool results.
  feedA.applyEvent({ type: 'todo/write', time: 1500, data: { todos: [
    { content: '设计 API', status: 'completed' },
    { content: '实现渲染', status: 'in_progress' },
    { content: '写测试', status: 'pending' },
  ] } })
  feedA.applyEvent({ type: 'compaction/start', time: 1600, data: { compactionId: 'c1' } })
  feedA.applyEvent({ type: 'compaction/summary', time: 1650, data: { compactionId: 'c1', shadowedSeqs: [1, 2, 3], shadowedTokenCount: 12000, summary: '前半段是环境搭建' } })
  feedA.applyEvent({ type: 'llm/retry', time: 1700, data: { retryId: 'r1', retry: 2, maxRetries: 5, mode: 'normal', delayMs: 3000, failure: { message: '429 rate limited' } } })
  feedA.applyEvent({ type: 'llm/retry-started', time: 1730, data: { retryId: 'r1', retry: 2 } })
  feedA.applyEvent({ type: 'tool-workflow/run-start', time: 1800, data: { runId: 'wf-9', name: '审计' } })
  feedA.applyEvent({ type: 'tool-workflow/agent-start', time: 1810, data: { runId: 'wf-9', seq: 1, label: 'audit-a', phase: '扫描' } })
  feedA.applyEvent({ type: 'tool-workflow/agent-end', time: 1820, data: { runId: 'wf-9', seq: 1, outcome: 'completed' } })
  feedA.applyEvent({ type: 'tool-workflow/run-end', time: 1830, data: { runId: 'wf-9', stopReason: 'completed' } })
  feedA.applyEvent({ type: 'tool/call', time: 1900, data: { callId: 'c-9', name: 'web_search', arguments: '{"query":"dsh"}' } })
  feedA.applyEvent({ type: 'tool/result', time: 1950, data: { message: { content: [{ type: 'text', text: JSON.stringify([{ title: 'dsh 官网', url: 'https://example.com', snippet: 'DeepSeek Harness' }]) }], source: { callId: 'c-9' } } } })
  await new Promise((r) => setTimeout(r, 150))
  const linesA3 = await nvim.request('nvim_buf_get_lines', [chatA.chatBuf, 0, -1, false])
  log('parity batch1:', JSON.stringify(linesA3.slice(-16)))
  assert.ok(linesA3.includes('📋 待办 3 项 · 1 完成 · 1 进行中 · 1 待办'), 'todo strip header')
  assert.ok(linesA3.includes('  ✓ 设计 API') && linesA3.includes('  … 实现渲染') && linesA3.includes('  · 写测试'), 'todo items with status marks')
  assert.ok(linesA3.some((l: string) => l.includes('⋯ 上下文压缩 · 3 条历史 · ≈12.0k tokens')), 'compaction checkpoint row')
  assert.ok(linesA3.includes('    前半段是环境搭建'), 'compaction summary folded')
  assert.ok(linesA3.some((l: string) => l.includes('↻ 重试 #2/5') && l.includes('3s 后重试') && l.includes('429 rate limited')), 'retry status row')
  assert.ok(linesA3.includes('↻ 重试 #2 已发起'), 'retry started row')
  assert.ok(linesA3.some((l: string) => l.startsWith('◈ workflow 审计')), 'workflow run row in transcript')
  assert.ok(linesA3.includes('  ◇ #1 audit-a · 扫描') && linesA3.includes('  ◇ #1 · completed'), 'workflow member rows')
  assert.ok(linesA3.includes('  · dsh 官网 · https://example.com · DeepSeek Harness'), 'structured tool result itemized')

  // 4c. i18n: en dictionary switches user-facing strings; unknown keys fall
  // back to the zh literal.
  setLocale('en')
  assert.equal(t('无活跃会话'), 'no active session', 'core notice translated to en')
  assert.equal(t('📋 待办'), '📋 Todo', 'todo label translated')
  assert.equal(t('未被收录的字符串'), '未被收录的字符串', 'unknown key falls back to zh literal')
  setLocale('zh')
  assert.equal(t('无活跃会话'), '无活跃会话', 'zh locale returns the literal')
  assert.equal(locale(), 'zh', 'locale() reports the current locale')

  // 4d. market data layer (pure helpers, offline fixtures).
  const yamlA = `url: https://github.com/A/b-plugin
name: A/b-plugin
category: ui
description:
  en: Rotates status labels.
  zh: 轮换状态标签。
tarball: https://github.com/A/b-plugin/releases/latest/download/b.tgz`
  const yamlB = `url: https://github.com/C/d-plugin
name: C/d-plugin
category: memory
description:
  zh: "项目记忆插件。"
  en: "Project memory plugin."`
  const pA = parsePluginYaml(yamlA, 'A__b-plugin.yml')
  assert.equal(pA.name, 'A/b-plugin', 'yaml name normalized')
  assert.equal(pA.category, 'ui', 'yaml category')
  assert.equal(pA.descZh, '轮换状态标签。', 'yaml zh description')
  assert.equal(pA.descEn, 'Rotates status labels.', 'yaml en description')
  assert.equal(pA.tarball, 'https://github.com/A/b-plugin/releases/latest/download/b.tgz', 'yaml tarball kept')
  const pB = parsePluginYaml(yamlB, 'C__d-plugin.yml')
  assert.equal(pB.descZh, '项目记忆插件。', 'quoted zh description unquoted')
  const stars = parseStars(JSON.stringify({
    'https://github.com/A/b-plugin': { stars: 42, checkedAt: '2026-08-19' },
    'https://github.com/B/c-plugin': { stars: 7, checkedAt: '2026-08-19' },
  }))
  assert.equal(stars.get('https://github.com/A/b-plugin'), 42, 'stars parsed')
  const cat = buildCatalog(stars, [pA, pB, { name: 'B/c-plugin', url: 'https://github.com/B/c-plugin' }])
  assert.equal(cat[0].name, 'A/b-plugin', 'sorted by stars desc first')
  assert.equal(cat[0].stars, 42, 'top entry carries stars')
  assert.ok(cat.some((e) => e.name === 'C/d-plugin' && e.stars === 0), 'yaml-only entry joins at 0 stars')
  assert.deepEqual(searchCatalog(cat, 'rotates').map((e) => e.name), ['A/b-plugin'], 'en description search')
  assert.deepEqual(searchCatalog(cat, '记忆').map((e) => e.name), ['C/d-plugin'], 'zh description search')
  assert.deepEqual(searchCatalog(cat, 'MEMORY').map((e) => e.name), ['C/d-plugin'], 'category search case-insensitive')
  // phase-2 helpers: hot-toggle patch rows, npm-name detection, dep matching
  let patch = '- id: keep-me\n  config: { a: 1 }\n'
  patch = setDisabledRows(patch, [{ id: 'keep-me', disabled: true }])
  assert.ok(patch.includes('- id: keep-me\n  disabled: true'), 'toggle row appended')
  assert.ok(!patch.includes('config: { a: 1 }'), 'managed marker pair replaces prior rows for the id')
  assert.deepEqual([...readDisabledIds(patch)], ['keep-me'], 'disabled ids parsed')
  patch = setDisabledRows(patch, [{ id: 'keep-me', disabled: false }])
  assert.ok(patch.includes('disabled: false'), 'enable row written')
  assert.deepEqual([...readDisabledIds(patch)], [], 'enabled id leaves the disabled set')
  assert.ok(!patch.includes('disabled: true'), 'stale disable row removed idempotently')
  assert.equal(isNpmName('dsh-market'), true, 'plain npm name detected')
  assert.equal(isNpmName('@scope/pkg'), true, 'scoped npm name detected')
  assert.equal(isNpmName('link:./x'), false, 'link spec rejected')
  assert.equal(isNpmName('https://github.com/a/b'), false, 'url spec rejected')
  assert.equal(depMatchesEntry('dshmarket', { name: 'dsh-market/dsh-market', url: 'https://github.com/dsh-market/dsh-market', stars: 1, category: 'm', descZh: '', descEn: '' }), false, 'no false positive by suffix alone')
  assert.equal(depMatchesEntry('https://github.com/dsh-market/dsh-market', { name: 'dsh-market/dsh-market', url: 'https://github.com/dsh-market/dsh-market', stars: 1, category: 'm', descZh: '', descEn: '' }), true, 'url spec matches entry')
  const treeEntry = { name: 'volcengine/OpenViking', url: 'https://github.com/volcengine/OpenViking/tree/main/examples/dsh-memory-plugin', stars: 1, category: 'm', descZh: '', descEn: '', tarball: 'https://github.com/volcengine/OpenViking/releases/latest/download/x.tgz' }
  assert.equal(repoRoot(treeEntry.url), 'https://github.com/volcengine/OpenViking', 'tree subpath stripped to repo root')
  assert.equal(depMatchesEntry('https://github.com/volcengine/OpenViking', treeEntry), true, 'repo-root dep matches tree-path entry')
  assert.equal(installSpec(treeEntry), treeEntry.tarball, 'tarball wins as the install spec')
  assert.equal(installSpec({ ...treeEntry, tarball: undefined }), 'https://github.com/volcengine/OpenViking', 'repo root used when no tarball')
  // phase-3: failure classification drives the automatic remedy chains
  assert.equal(classifyPnpmError('ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/x: 404 Not Found').kind, 'notfound', '404 classified as notfound')
  assert.equal(classifyPnpmError('ERR_PNPM_NO_MATCHING_VERSION No matching version found for x@9.9.9').kind, 'notfound', 'no-matching-version classified as notfound')
  assert.equal(classifyPnpmError('ERR_PNPM_OUTDATED_LOCKFILE Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date').kind, 'lockfile', 'outdated lockfile classified')
  assert.equal(classifyPnpmError(' ERR_PNPM_FETCH_501  GET https://registry.npmjs.org/x: ETIMEDOUT').kind, 'network', 'timeout classified as network')
  assert.equal(classifyPnpmError('ERR_PNPM_FETCH_501 EAI_AGAIN registry.npmjs.org').kind, 'network', 'dns failure classified as network')
  assert.equal(classifyPnpmError('EPERM: operation not permitted, unlink /root/.npm/_cacache').kind, 'cache', 'EPERM on cache classified as cache')
  assert.equal(classifyPnpmError('EINTEGRITY: sha512 integrity check failed for x').kind, 'cache', 'integrity failure classified as cache')
  assert.equal(classifyPnpmError('ERROR: Repository not found. fatal: could not read from remote repository.').kind, 'git', 'missing repo classified as git')
  assert.equal(classifyPnpmError('git@github.com: Permission denied (publickey).').kind, 'git', 'git auth failure classified')
  assert.equal(classifyPnpmError('some totally weird output').kind, 'other', 'unknown output classified as other')
  assert.equal(firstErrorLine('\n\n  ERR something \nnext\n'), 'ERR something', 'first non-empty line extracted')
  assert.ok(profileDir('nvim-tui').endsWith('/profiles/nvim-tui'), 'profileDir resolves under DSH_HOME/.dsh')
  // phase-4: natural-language command router
  assert.deepEqual(matchIntent('会话列表'), { name: 'sessions', arg: undefined }, 'exact zh alias routes')
  assert.deepEqual(matchIntent('help'), { name: 'help', arg: undefined }, 'exact en alias routes')
  assert.deepEqual(matchIntent('切换模型 deepseek-chat'), { name: 'model', arg: 'deepseek-chat' }, 'model pattern captures arg')
  assert.deepEqual(matchIntent('用 deepseek-chat'), { name: 'model', arg: 'deepseek-chat' }, 'id-like model arg without 模型 keyword')
  assert.equal(matchIntent('用中文回复我'), null, 'bare 用 + sentence is chat, not a model switch')
  assert.deepEqual(matchIntent('主题换成 vivid'), { name: 'theme', arg: 'vivid' }, 'theme alternation picks the longest prefix')
  assert.deepEqual(matchIntent('语言 英文'), { name: 'locale', arg: 'en' }, 'locale arg mapped')
  assert.deepEqual(matchIntent('中文'), { name: 'locale', arg: 'zh' }, 'bare 中文 switches language')
  assert.deepEqual(matchIntent('删除工作区 abc123'), { name: 'workspace', arg: 'delete abc123' }, 'workspace delete composed')
  assert.deepEqual(matchIntent('添加工作区'), { name: 'workspace', arg: undefined }, 'bare workspace add opens the popup')
  assert.deepEqual(matchIntent('记住 明天九点开会'), { name: 'remember', arg: '明天九点开会' }, 'remember arg captured')
  assert.deepEqual(matchIntent('状态栏显示 tokens'), { name: 'glance', arg: 'tokens' }, 'glance arg captured')
  assert.deepEqual(matchIntent('反馈 up 很好用'), { name: 'fb', arg: 'up 很好用' }, 'fb composed')
  assert.deepEqual(matchIntent('侧问 这个设计怎么样'), { name: 'btw', arg: '这个设计怎么样' }, 'btw arg captured')
  assert.equal(matchIntent('怎么清空会话？'), null, 'questions always go to the agent')
  assert.equal(matchIntent('> 会话列表'), null, '> forces chat')
  assert.equal(matchIntent('这是一条很长很长的普通消息，超过六十个字符就应该直接发给智能体而不是被识别成命令，因为自然语言命令匹配必须保持克制避免误拦截。'), null, 'long input stays chat')
  assert.equal(matchIntent('清屏')?.name, 'clear', 'destructive exact phrase works')
  assert.equal(matchIntent('帮我清屏'), null, 'destructive commands never fire on loose matches')

  // 5. /clear empties the active feed
  active = 'session-bbbb'
  feedB.clear()
  await new Promise((r) => setTimeout(r, 100))
  const cleared = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  assert.deepEqual(cleared, [''], 'clear() emptied the chat buffer')

  // 6. thinking visibility: reasoning stream renders dim, closes with elapsed,
  // and a silent turn shows a ticking placeholder.
  feedB.applyEvent({ type: 'turn/start', time: 5000, data: {} })
  feedB.applyEvent({ type: 'assistant/chunk', time: 5100, data: { chunk: { type: 'reasoning-delta', text: '让我想想' } } })
  feedB.applyEvent({ type: 'assistant/chunk', time: 5200, data: { chunk: { type: 'reasoning-delta', text: '再想想' } } })
  await new Promise((r) => setTimeout(r, 120))
  let linesB2 = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  log('chat during reasoning:', JSON.stringify(linesB2))
  assert.ok(linesB2.some((l: string) => /^·· thinking · \d+\.\d+s$/.test(l)), 'compact progress line in chat')
  assert.ok(!linesB2.includes('让我想想再想想'), 'reasoning text NOT in chat')
  let reasonLines = await nvim.request('nvim_buf_get_lines', [reasonB.reasoningBuf, 0, -1, false])
  log('reasoning panel:', JSON.stringify(reasonLines))
  assert.ok(reasonLines.includes('让我想想再想想'), 'reasoning stream in panel buffer')
  // A delta with an embedded newline grows the previous last row AND appends
  // a new one — the fast path must rewrite both correctly.
  feedB.applyEvent({ type: 'assistant/chunk', time: 5250, data: { chunk: { type: 'reasoning-delta', text: '\n第三行来了' } } })
  await new Promise((r) => setTimeout(r, 120))
  reasonLines = await nvim.request('nvim_buf_get_lines', [reasonB.reasoningBuf, 0, -1, false])
  log('reasoning panel (multi-line):', JSON.stringify(reasonLines))
  assert.ok(reasonLines.includes('让我想想再想想'), 'grown row kept in panel')
  assert.ok(reasonLines.includes('第三行来了'), 'new row appended in panel')
  // Every non-empty panel row must be FULLY covered by its dim group mark:
  // extmark end_cols are frozen once set, so an in-place rewrite that skips
  // the refresh leaves the freshly streamed tail unhighlighted — pure white
  // on the theme's Normal instead of the dim panel color.
  const reasonMarks = await nvim.request('nvim_buf_get_extmarks', [reasonB.reasoningBuf, -1, 0, -1, { details: true }])
  for (let i = 0; i < reasonLines.length; i++) {
    const line = reasonLines[i] ?? ''
    if (line.length === 0) continue
    const cover = reasonMarks.some((m: any) => m[1] === i && m[3]?.end_row === i &&
      m[3]?.end_col === Buffer.byteLength(line, 'utf8') && typeof m[3]?.hl_group === 'string')
    assert.ok(cover, `panel row ${i} fully highlighted (${JSON.stringify(line)})`)
  }
  feedB.applyEvent({ type: 'assistant/chunk', time: 5300, data: { chunk: { type: 'text-delta', text: '答案是 42' } } })
  await new Promise((r) => setTimeout(r, 120))
  linesB2 = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  assert.ok(!linesB2.some((l: string) => l.includes('·· thinking')), 'thinking line vanishes from chat after close')
  assert.ok(linesB2.includes('答案是 42'), 'answer follows the transient line')
  reasonLines = await nvim.request('nvim_buf_get_lines', [reasonB.reasoningBuf, 0, -1, false])
  assert.ok(reasonLines.some((l: string) => l.startsWith('── thinking end')), 'panel footer on close')

  // tool records go to the panel too; chat shows only the live activity line
  feedB.applyEvent({ type: 'tool/call', time: 5600, data: { turn: 1, step: 1, callId: 'c-1', name: 'bash', arguments: '{"cmd":"ls"}' } })
  await new Promise((r) => setTimeout(r, 100))
  let chatDuring = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  assert.ok(chatDuring.some((l: string) => /^🔧 bash · \d+\.\d+s$/.test(l)), 'chat shows live tool activity line')
  assert.ok(!chatDuring.some((l: string) => l.includes('{"cmd":"ls"}')), 'tool card NOT in chat')
  feedB.applyEvent({ type: 'tool/result', time: 5800, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'README.md' }], source: { callId: 'c-1' } } } })
  await new Promise((r) => setTimeout(r, 100))
  reasonLines = await nvim.request('nvim_buf_get_lines', [reasonB.reasoningBuf, 0, -1, false])
  log('panel with tools:', JSON.stringify(reasonLines))
  assert.ok(reasonLines.some((l: string) => l.startsWith('🔧 bash(')), 'tool call in panel')
  assert.ok(reasonLines.some((l: string) => l.startsWith('✓ bash · 200ms')), 'tool result in panel')
  chatDuring = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  assert.ok(!chatDuring.some((l: string) => /^🔧 bash ·/.test(l)), 'activity line gone after result')
  feedB.applyEvent({ type: 'turn/end', time: 5500, data: {} })

  // placeholder while a turn is silent
  feedB.applyEvent({ type: 'turn/start', time: 6000, data: {} })
  await new Promise((r) => setTimeout(r, 1400)) // 800ms threshold + ticker flush
  const linesB3 = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  log('placeholder lines:', JSON.stringify(linesB3))
  assert.ok(linesB3.some((l: string) => /^·· thinking… \d+s$/.test(l)), 'silent turn shows thinking placeholder')
  feedB.applyEvent({ type: 'turn/end', time: 6500, data: {} })

  // 7. <C-o> reasoning panel toggle
  const opened = await lua('return require("dsh_tui").toggle_reasoning()', [])
  assert.equal(opened, true, 'panel opens')
  let idsT = await lua('return require("dsh_tui").ids()', [])
  assert.ok(Number.isInteger(idsT.reasoningWin), 'reasoning window exists')
  assert.equal(idsT.reasoningOpen, true)
  assert.equal(await lua('return vim.api.nvim_win_get_buf(...)', [idsT.reasoningWin]), reasonB.reasoningBuf,
    'panel shows active session reasoning')
  const closed = await lua('return require("dsh_tui").toggle_reasoning()', [])
  assert.equal(closed, false, 'panel closes')
  idsT = await lua('return require("dsh_tui").ids()', [])
  assert.equal(idsT.reasoningOpen, false)

  // 8. markdown table → aligned box-drawing table (Claude-TUI style)
  const tableText = [
    '| 日期 | AQI | 等级 | 主要污染物 |',
    '|------|-----|------|-----------|',
    '| **今天** 8/19 | 29 | 🟢 优 | 无（O₃ 78 稍高） |',
    '| 明天 8/20 | 50 | 🟢 优 | `无` |',
  ].join('\n')
  feedB.applyEvent({ type: 'assistant/message', time: 7000, data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: tableText }] } } })
  await new Promise((r) => setTimeout(r, 120))
  let linesT = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  log('table streaming:', JSON.stringify(linesT.slice(-7)))
  assert.ok(linesT.some((l: string) => l.startsWith('┌')), 'table top border')
  assert.ok(linesT.some((l: string) => l.startsWith('├')), 'table header separator')
  assert.ok(linesT.some((l: string) => l.includes('日期') && l.includes('AQI')), 'table header rendered')
  assert.ok(linesT.includes('│ 今天 8/19 │  29 │ 🟢 优 │ 无（O₃ 78 稍高） │'), 'aligned row (display-width padded)')
  assert.ok(linesT.some((l: string) => l.includes('│ 明天 8/20 │  50 │ 🟢 优 │ 无')), 'backtick cell markup stripped')
  assert.ok(!linesT.some((l: string) => l.includes('**') || l.includes('`')), 'no literal markdown markers in table cells')
  assert.ok(!linesT.some((l: string) => l.startsWith('└')), 'no bottom border while streaming')
  // close the stream → bottom border appears
  feedB.applyEvent({ type: 'turn/end', time: 7200, data: {} })
  await new Promise((r) => setTimeout(r, 120))
  linesT = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  log('table closed:', JSON.stringify(linesT.slice(-6)))
  log('table closed FULL:', JSON.stringify(linesT))
  assert.ok(linesT.some((l: string) => l.startsWith('└')), 'bottom border after stream closes')

  // The WHOLE table renders bold (uniform stroke weight): every table row —
  // top border, header, separator, body, bottom border — carries one
  // full-row DshTuiBold group from column 0 to the row's byte length, so
  // cells, '│' separators, '─' strokes and corners all match. (Regression:
  // borders used to be dim DshTuiDivider and separators unbolded, which
  // made '─'/corners render thinner than '│' — a half-bold frame.)
  // (nvim 0.12 bug: nvim_buf_get_extmarks with ns=-1 rejects a bounded end
  //  row, so query the full buffer and filter by row here.)
  const tableRowIdxs = [
    linesT.findIndex((l: string) => l.startsWith('┌')),
    linesT.findIndex((l: string) => l.includes('日期') && l.includes('AQI')),
    linesT.findIndex((l: string) => l.startsWith('├')),
    linesT.findIndex((l: string) => l.includes('今天 8/19')),
    linesT.findIndex((l: string) => l.includes('明天 8/20')),
    linesT.findIndex((l: string) => l.startsWith('└')),
  ]
  const tableMarks = await nvim.request('nvim_buf_get_extmarks', [chatB.chatBuf, -1, 0, -1, { details: true }])
  for (const rowIdx of tableRowIdxs) {
    assert.ok(rowIdx >= 0, 'table row present')
    const rowByteLen = Buffer.byteLength(linesT[rowIdx], 'utf8')
    const fullBold = tableMarks.some((m: any) => m[1] === rowIdx && m[3]?.hl_group === 'DshTuiBold' &&
      m[3]?.end_row === rowIdx && m[2] === 0 && m[3]?.end_col === rowByteLen)
    assert.ok(fullBold, `row ${rowIdx}: whole-row bold group covers cells + separators`)
    assert.ok(!tableMarks.some((m: any) => m[1] === rowIdx && m[3]?.hl_group === 'DshTuiDivider'),
      `row ${rowIdx}: table rows no longer dim (DshTuiDivider)`)
  }

  // inline spans are byte-indexed: CJK bold must cover exactly the text bytes
  feedB.applyEvent({ type: 'assistant/message', time: 7300, data: { turn: 3, step: 1, message: { content: [{ type: 'text', text: '前缀 **中文加粗** 后缀' }] } } })
  await new Promise((r) => setTimeout(r, 120))
  const cjkLines = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  const cjkIdx = cjkLines.findIndex((l: string) => l.includes('中文加粗'))
  assert.ok(cjkIdx >= 0, 'cjk bold line present')
  const cjkMarks = await nvim.request('nvim_buf_get_extmarks', [chatB.chatBuf, -1, 0, -1, { details: true }])
  const cjkBold = cjkMarks.filter((m: any) => m[1] === cjkIdx && m[3]?.hl_group === 'DshTuiBold')
  assert.equal(cjkBold.length, 1, 'one bold span on the cjk line')
  assert.equal(cjkBold[0][2], Buffer.byteLength('前缀 ', 'utf8'), 'bold span starts after the prefix (byte offset)')
  assert.equal(cjkBold[0][3].end_col - cjkBold[0][2], Buffer.byteLength('中文加粗', 'utf8'), 'bold span covers exactly the CJK text bytes')

  // image attachments render as 📎 label lines inside the user bubble
  feedB.applyEvent({ type: 'user/message', time: 7400, data: { message: { content: [
    { type: 'text', text: '看这张图' },
    { type: 'image', attachment: { mediaType: 'image/png', bytes: 1234, width: 640, height: 480 } },
  ] } } })
  await new Promise((r) => setTimeout(r, 120))
  const imgLines = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  assert.ok(imgLines.includes('> 看这张图'), 'image message text rendered')
  assert.ok(imgLines.includes('> 📎 图片 (image/png · 640×480 · 1.2KB)'), 'image attachment label rendered')

  // steer lines render with the ➤ marker
  feedB.pushBlock('steer', '换个方案试试')
  await new Promise((r) => setTimeout(r, 120))
  const steerLines = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  assert.ok(steerLines.includes('➤ 换个方案试试'), 'steer directive rendered with marker')

  // skill-detail float opens and closes
  const baseWins = (await lua('return vim.api.nvim_list_wins()', [])).length
  await lua(`require("dsh_tui").show_skill({ name = "demo", description = "演示技能", whenToUse = "测试", content = "正文" })`, [])
  let skillWins = (await lua('return vim.api.nvim_list_wins()', [])).length
  assert.equal(skillWins, baseWins + 2, 'skill float + footer bar opened')
  const skillBuf = await lua('return vim.api.nvim_win_get_buf(require("dsh_tui")._skillWin)', [])
  const skillLines = await nvim.request('nvim_buf_get_lines', [skillBuf, 0, -1, false])
  assert.equal(await lua('return vim.api.nvim_win_get_height(require("dsh_tui")._skillWin)', []), skillLines.length, 'skill window exactly fits content')
  await assertFooter('[q]', 'skill')
  await assertCentered('require("dsh_tui")._skillWin', 'skill')
  await lua('require("dsh_tui").close_skill()', [])
  skillWins = (await lua('return vim.api.nvim_list_wins()', [])).length
  assert.equal(skillWins, baseWins, 'skill float closed')

  // 9. M4 interactions: input submit/history/completion, approval, questions,
  // picker (all via the Lua API; the Node wiring is exercised in e2e).
  const notes: Array<{ method: string; args: unknown[] }> = []
  const onNote = (method: string, args: unknown[]): void => { notes.push({ method, args }) }
  nvim.on('notification', onNote)
  // Popup hints are pinned as the LAST row of the popup window (visible
  // regardless of scroll); each popup carries a function title.
  const lastLine = (buf: number) => lua('local b = ... local l = vim.api.nvim_buf_get_lines(b, 0, -1, false) return l[#l]', [buf])
  const floatTitle = (win: number) => nvim.request('nvim_win_get_config', [win]).then((c: any) => c.title ?? '')

  const waitNote = async (method: string, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = notes.find((n) => n.method === method)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 20))
    }
    return null
  }

  // 9a. input submit + history
  await lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "你好世界" })`, [])
  await lua('require("dsh_tui").submit()', [])
  let hit = await waitNote('dsh-input')
  assert.equal(hit?.args?.[0], '你好世界', 'submit routes dsh-input')
  const inputAfter = await lua('return vim.api.nvim_buf_get_lines(require("dsh_tui").ids().inputBuf, 0, -1, false)', [])
  assert.deepEqual(inputAfter, [''], 'input reset after submit')
  await lua('require("dsh_tui").history_move(-1)', [])
  let txt = await lua('return table.concat(vim.api.nvim_buf_get_lines(require("dsh_tui").ids().inputBuf, 0, -1, false), "\\n")', [])
  assert.equal(txt, '你好世界', 'history up restores last input')

  // 9a2. /sessions float interactions: j/k + <CR> select (full id), <C-n> new.
  await lua('require("dsh_tui").show_session_list(...)', [[
    { id: 'session-aaaa', title: '会话甲', active: true, kind: 'live' },
    { id: 'session-bbbb', title: '会话乙', active: false, kind: 'live' },
  ]])
  await lua('require("dsh_tui").session_list_move(1)', [])
  await lua('require("dsh_tui").session_list_select()', [])
  hit = await waitNote('dsh-session-select')
  assert.equal(hit?.args?.[0], 'session-bbbb', 'session selection routes the full id')
  await lua('require("dsh_tui").show_session_list(...)', [[
    { id: 'session-aaaa', title: '会话甲', active: true, kind: 'live' },
  ]])
  await lua('require("dsh_tui").session_list_new()', [])
  hit = await waitNote('dsh-session-new')
  assert.ok(hit, 'new-session request routes from the float')

  // 9b. slash-command completion menu: fallback catalog (before the runner
  // pushes set_commands), auto-open on '/', live filtering, Tab/C-p cycling.
  await lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "/" })`, [])
  await lua('require("dsh_tui").update_cmd_menu()', [])
  let menuSt = await lua('return require("dsh_tui").cmd_menu_state()', [])
  assert.equal(menuSt.open, true, 'menu opens on "/"')
  assert.equal(menuSt.selected, '/exit', 'first fallback command selected')
  assert.ok(menuSt.names.includes('/help') && menuSt.names.includes('/model'), 'fallback catalog lists commands')
  assert.equal(menuSt.names.length, 47, 'all 47 fallback commands listed')

  // the runner's catalog (name + description) replaces the fallback
  await lua(`require("dsh_tui").set_commands({
    { name = "/exit", desc = "退出 dsh" },
    { name = "/export", desc = "导出转录 md" },
    { name = "/effort", desc = "推理等级" },
    { name = "/model", desc = "选择/切换模型" },
    { name = "/memory", desc = "浏览/删除项目记忆" },
  })`, [])
  await lua('require("dsh_tui").update_cmd_menu()', [])
  menuSt = await lua('return require("dsh_tui").cmd_menu_state()', [])
  assert.deepEqual(menuSt.names, ['/exit', '/export', '/effort', '/model', '/memory'], 'catalog listed in order')

  // live filtering narrows the menu to the prefix
  await lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "/mo" })`, [])
  await lua('require("dsh_tui").update_cmd_menu()', [])
  menuSt = await lua('return require("dsh_tui").cmd_menu_state()', [])
  assert.deepEqual(menuSt.names, ['/model'], 'prefix filter narrows the menu')

  // Tab cycles the selection, C-p wraps back, a full name selects itself
  await lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "/e" })`, [])
  await lua('require("dsh_tui").update_cmd_menu()', [])
  await lua('require("dsh_tui").cmd_next()', [])
  menuSt = await lua('return require("dsh_tui").cmd_menu_state()', [])
  assert.equal(menuSt.selected, '/export', 'Tab advances to the next match')
  await lua('require("dsh_tui").cmd_prev()', [])
  menuSt = await lua('return require("dsh_tui").cmd_menu_state()', [])
  assert.equal(menuSt.selected, '/exit', 'C-p moves back')
  await lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "/effort" })`, [])
  await lua('require("dsh_tui").update_cmd_menu()', [])
  menuSt = await lua('return require("dsh_tui").cmd_menu_state()', [])
  assert.equal(menuSt.selected, '/effort', 'fully typed name selects itself')

  // the menu closes once arguments (a space) are typed
  await lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "/model 42" })`, [])
  await lua('require("dsh_tui").update_cmd_menu()', [])
  menuSt = await lua('return require("dsh_tui").cmd_menu_state()', [])
  assert.equal(menuSt.open, false, 'menu closes once arguments are typed')

  // <CR> on a bare prefix fills the selected command (a second <CR> executes)
  await lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "/mo" })`, [])
  await lua('require("dsh_tui").update_cmd_menu()', [])
  await lua('require("dsh_tui").submit()', [])
  txt = await lua('return table.concat(vim.api.nvim_buf_get_lines(require("dsh_tui").ids().inputBuf, 0, -1, false), "\\n")', [])
  assert.equal(txt, '/model ', 'CR completes the selected command')
  menuSt = await lua('return require("dsh_tui").cmd_menu_state()', [])
  assert.equal(menuSt.open, false, 'menu closed after completing')

  // <CR> with the full name typed executes the command directly
  await lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "/model" })`, [])
  await lua('require("dsh_tui").update_cmd_menu()', [])
  await lua('require("dsh_tui").submit()', [])
  hit = await waitNote('dsh-command')
  assert.equal(hit?.args?.[0], '/model', 'fully typed command executes directly')
  // plain text never opens the menu
  await lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "plain" })`, [])
  await lua('require("dsh_tui").update_cmd_menu()', [])
  menuSt = await lua('return require("dsh_tui").cmd_menu_state()', [])
  assert.equal(menuSt.open, false, 'no menu for plain text')

  // 9c. completion-menu keymaps exist on the input buffer
  const imaps = await lua(`local out = {}
    for _, m in ipairs(vim.api.nvim_buf_get_keymap(require("dsh_tui").ids().inputBuf, "i")) do
      table.insert(out, { lhs = m.lhs })
    end
    return out`, [])
  for (const key of ['<C-N>', '<C-P>', '<Tab>', '<S-Tab>', '<Esc>', '<C-V>', '<C-C>']) {
    assert.ok(imaps.some((m: any) => m.lhs === key), key + ' mapped on the input buffer')
  }

  // 9d. approval window — including a long wrapped reason: the key-hint row
  // must stay inside the window (previously the fixed height clipped it).
  const winsBefore = (await lua('return vim.api.nvim_list_wins()', [])).length
  await lua('require("dsh_tui").show_approval(...)', [{ toolName: 'bash', reason: '执行命令 ' + 'x'.repeat(120) }])
  let wins = await lua('return vim.api.nvim_list_wins()', [])
  assert.ok(wins.length > winsBefore, 'approval float window opened')
  let approvalF = await lua('return require("dsh_tui")._float', [])
  let approvalFCfg = await nvim.request('nvim_win_get_config', [approvalF.win])
  const approvalFLines = await nvim.request('nvim_buf_get_lines', [approvalF.buf, 0, -1, false])
  const approvalFVisual = approvalFLines.reduce((h: number, l: string) => h + Math.max(1, Math.ceil([...l].reduce((w, ch) => w + (/[\u2E80-\uA4CF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u3000-\u303F]/u.test(ch) ? 2 : 1), 0) / approvalFCfg.width)), 0)
  log('approval cfg:', JSON.stringify(approvalFCfg), 'visual rows:', approvalFVisual)
  assert.ok(approvalFCfg.height >= approvalFVisual, 'approval window height covers wrapped content')
  assert.ok(approvalFCfg.height >= 4, 'long reason grows the approval window')
  assert.ok(String(await floatTitle(approvalF.win)).includes('审批请求'), 'approval float carries a function title')
  await assertFooter('[y]', 'approval')
  await assertCentered('require("dsh_tui")._float.win', 'approval')
  assert.equal(await lua('return vim.bo[require("dsh_tui")._float.buf].modifiable', []), false, 'approval buffer is read-only')
  await lua('require("dsh_tui").approval_decide("y")', [])
  hit = await waitNote('dsh-approval-decided')
  assert.equal(hit?.args?.[0], 'y', 'approval decision routed')
  // [a] 总是（自动模式）: routes 'always' (the runner then allows this once
  // and switches the session approval policy to 'never').
  await lua('require("dsh_tui").show_approval(...)', [{ toolName: 'bash', reason: 'again' }])
  const approvalMaps = await lua(`local out = {}
    for _, m in ipairs(vim.api.nvim_buf_get_keymap(require("dsh_tui")._float.buf, "n")) do
      table.insert(out, m.lhs)
    end
    return out`, [])
  assert.ok(approvalMaps.includes('a'), 'approval popup maps the always key')
  await lua('require("dsh_tui").approval_decide("always")', [])
  const alwaysDeadline = Date.now() + 2000
  let alwaysHit: { args?: unknown[] } | null = null
  while (Date.now() < alwaysDeadline) {
    const decisions = notes.filter((n) => n.method === 'dsh-approval-decided')
    const last = decisions[decisions.length - 1]
    if (last?.args?.[0] === 'always') { alwaysHit = last; break }
    await new Promise((r) => setTimeout(r, 20))
  }
  assert.ok(alwaysHit !== null, 'always decision routed for the automatic-mode switch')

  // 9d. questions flow (two questions, second multi-select) — the float must
  // grow to the real content height, or the option list and the key-hint
  // footer stay clipped (window was created with a 1-line placeholder).
  await lua(`require("dsh_tui").show_questions({
    { id = "q1", question = "方向？", options = { { label = "A", description = "方案A" }, { label = "B" } } },
    { id = "q2", question = "特性？", multiSelect = true, options = { { label = "x" }, { label = "y" } } },
  })`, [])
  let qfloat = await lua('return require("dsh_tui")._float', [])
  let qcfg = await nvim.request('nvim_win_get_config', [qfloat.win])
  let qlines = await nvim.request('nvim_buf_get_lines', [qfloat.buf, 0, -1, false])
  log('questions cfg:', JSON.stringify(qcfg), 'lines:', qlines.length)
  assert.ok(qcfg.height >= qlines.length, 'questions window fits all rows incl. key hints')
  await assertFooter('[Enter]', 'questions')
  await assertCentered('require("dsh_tui")._float.win', 'questions')
  await lua('require("dsh_tui").question_move(1)', []) // q1 → option B
  await lua('require("dsh_tui").question_advance()', []) // q1 done → q2
  await lua('require("dsh_tui").question_toggle()', []) // q2 toggle x
  await lua('require("dsh_tui").question_advance()', []) // confirm
  hit = await waitNote('dsh-questions-answered')
  const answers = (hit?.args?.[0] ?? []) as Array<{ selected?: string[] }>
  log('answers:', JSON.stringify(answers))
  assert.equal(answers[0]?.selected?.[0], 'B', 'single-select answer')
  assert.deepEqual(answers[1]?.selected, ['x'], 'multi-select answer')

  // 9e. picker
  await lua(`require("dsh_tui").show_picker("选择", { { label = "m1", value = "model-a" }, { label = "m2", value = "model-b" } })`, [])
  // Hints live in a footer bar OUTSIDE and below the window (always visible
  // while scrolling), the function title rides the border title, and the
  // width adapts to the longest row instead of a fixed 72.
  let pickerBuf = await lua('return require("dsh_tui")._float.buf', [])
  const pickerLines = await nvim.request('nvim_buf_get_lines', [pickerBuf, 0, -1, false])
  assert.deepEqual(pickerLines, ['m1', 'm2'], 'picker buffer holds the items only')
  assert.equal(await lua('return vim.api.nvim_win_get_height(require("dsh_tui")._float.win)', []), pickerLines.length, 'picker window exactly fits content (no gap below)')
  assert.ok(String(await floatTitle(await lua('return require("dsh_tui")._float.win', []))).includes('选择'), 'picker float carries a function title')
  await assertFooter('[j/k]', 'picker')
  await assertCentered('require("dsh_tui")._float.win', 'picker')
  // Read-only lock: i must not enter insert mode, x/dd must not delete.
  const pickerMaps = await lua(`local out = {}
    for _, m in ipairs(vim.api.nvim_buf_get_keymap(require("dsh_tui")._float.buf, "n")) do
      table.insert(out, { lhs = m.lhs, rhs = m.rhs or "" })
    end
    return out`, [])
  const pickerKey = (k: string) => pickerMaps.find((m: any) => m.lhs === k)
  assert.ok(pickerKey('i') && pickerKey('i').rhs !== 'i', 'picker i is Nop (no insert mode)')
  assert.ok(pickerKey('d') && pickerKey('x') && pickerKey(':'), 'picker edit keys Nop')
  assert.equal(await lua('return vim.bo[require("dsh_tui")._float.buf].modifiable', []), false, 'picker buffer is not modifiable')
  await nvim.input('i')
  assert.equal((await nvim.request('nvim_get_mode', [])).mode, 'n', 'i does not enter insert mode in the picker')
  await nvim.input('xdd')
  assert.deepEqual(await nvim.request('nvim_buf_get_lines', [pickerBuf, 0, -1, false]), pickerLines, 'x/dd cannot delete picker content')
  // Plain buffer: every entry is a real line, so nvim's own navigation keys
  // work — G must reach the LAST ENTRY, and the window caps at 22 rows on a
  // tall editor.
  await lua('require("dsh_tui").picker_cancel()', [])
  const uiClient = await connectNvim(sockPath)
  await uiClient.uiAttach(80, 50, {})
  await new Promise((r) => setTimeout(r, 50))
  const many = Array.from({ length: 30 }, (_, i) => ({ label: 'item-' + i, value: 'v' + i }))
  await lua('require("dsh_tui").show_picker(...)', ['长列表', many])
  const pickerCfg = await nvim.request('nvim_win_get_config', [(await lua('return require("dsh_tui")._float.win', []))])
  assert.ok(pickerCfg.width >= 72, 'picker width at least the default')
  pickerBuf = await lua('return require("dsh_tui")._float.buf', [])
  const longLines = await nvim.request('nvim_buf_get_lines', [pickerBuf, 0, -1, false])
  assert.equal(longLines.length, 30, 'all 30 entries are real buffer lines')
  assert.equal(await lua('return vim.api.nvim_win_get_height(require("dsh_tui")._float.win)', []), 22, 'long picker window caps at the slice cap')
  await assertFooter('[j/k]', 'long picker')
  // shift+G (nvim's own jump-to-bottom) must land on the last entry.
  await nvim.input('G')
  let pickerCursor = await lua('return vim.api.nvim_win_get_cursor(require("dsh_tui")._float.win)', [])
  assert.deepEqual(pickerCursor, [30, 0], 'G jumps to the last entry')
  await assertFooter('[j/k]', 'long picker after G')
  await nvim.input('gg')
  pickerCursor = await lua('return vim.api.nvim_win_get_cursor(require("dsh_tui")._float.win)', [])
  assert.deepEqual(pickerCursor, [1, 0], 'gg jumps to the first entry')
  for (let i = 0; i < 30; i++) await lua('require("dsh_tui").picker_move(1)', [])
  pickerCursor = await lua('return vim.api.nvim_win_get_cursor(require("dsh_tui")._float.win)', [])
  assert.deepEqual(pickerCursor, [30, 0], 'cursor clamps at the last entry')
  await uiClient.uiTryResize(80, 24)
  await lua('require("dsh_tui").picker_cancel()', [])
  await lua('require("dsh_tui").show_picker(...)', ['宽', [{ label: 'x'.repeat(100), value: 'long' }]])
  const longCfg = await nvim.request('nvim_win_get_config', [(await lua('return require("dsh_tui")._float.win', []))])
  const cols = await lua('return vim.o.columns', [])
  assert.ok(longCfg.width === Math.min(Math.max(72, 102), Math.max(40, cols - 4)), 'picker width adapts to the longest row (clamped to the editor)')
  await lua('require("dsh_tui").picker_cancel()', [])
  await lua(`require("dsh_tui").show_picker("选择", { { label = "m1", value = "model-a" }, { label = "m2", value = "model-b" } })`, [])
  // Interactive floats must hand over in NORMAL mode (the input window is in
  // insert mode when the command fires): <CR> selects, it must not type a
  // newline into the picker buffer.
  await assertModeN('picker opens in normal mode')
  await lua('require("dsh_tui").picker_move(1)', [])
  await lua('require("dsh_tui").picker_confirm()', [])
  hit = await waitNote('dsh-picker-selected')
  assert.equal(hit?.args?.[0], 'model-b', 'picker selection routed')

  // 9f. subagent transcript view: read-only float + FeedRenderer replay
  // (方案 B: /subagents → child log replay, reasoning inline and dim).
  const svIds = await lua('return require("dsh_tui").open_subagent_view(...)', ['deepseek-code'])
  assert.ok(Number.isInteger(svIds.buf) && Number.isInteger(svIds.win), 'subagent view opens with buf+win')
  await assertModeN('subagent view opens in normal mode')
  // Same popup logic as /sessions: footer hint bar below the window,
  // G/gg jumps, content-fitted height that grows with the replay.
  await assertFooter('[q]', 'subagent view')
  await assertCentered('require("dsh_tui")._subagentView.win', 'subagent view')
  const svMaps = await lua(`local out = {}
    for _, m in ipairs(vim.api.nvim_buf_get_keymap(${svIds.buf}, "n")) do
      table.insert(out, { lhs = m.lhs, rhs = m.rhs or "" })
    end
    return out`, [])
  const svKey = (k: string) => svMaps.find((m: any) => m.lhs === k)
  assert.ok(svKey('q'), 'q closes the subagent view')
  assert.ok(svKey('<Esc>'), 'Esc closes the subagent view')
  assert.ok(svKey('G') && svKey('gg'), 'G/gg jump keys mapped like sessions')
  // <Nop> maps are stored with an empty rhs.
  assert.ok(svKey('i') && svKey('i').rhs === '', 'insert key Nop (read-only)')
  assert.ok(svKey(':') && svKey(':').rhs === '', 'colon Nop (read-only)')
  const subFeed = new FeedRenderer(nvim, svIds.buf, svIds.win, {
    idsProvider: async () => lua('return require("dsh_tui").subagent_view_ids()', []),
    activeChecker: () => true,
    reasoningBuf: null,
    reasoningView: () => null,
    inlineReasoning: true,
  })
  subFeed.applyEvent({ type: 'turn/start', time: 1000, data: {} })
  subFeed.applyEvent({ type: 'assistant/chunk', time: 1100, data: { chunk: { type: 'reasoning-delta', text: '子代理思考：先查目录' } } })
  // The thinking text must stream inline WHILE it is being generated
  // (regression: only the compact header rendered during streaming and the
  // whole block landed in one shot when thinking closed).
  await subFeed.flush()
  const svLive = await nvim.request('nvim_buf_get_lines', [svIds.buf, 0, -1, false])
  log('subagent view live thinking:', JSON.stringify(svLive))
  assert.ok(svLive.some((l: string) => l.includes('子代理思考：先查目录')), 'reasoning text streams inline while thinking')
  assert.ok(svLive.some((l: string) => /^·· thinking · \d+\.\d+s$/.test(l)), 'thinking header renders during streaming')
  subFeed.applyEvent({ type: 'assistant/chunk', time: 1150, data: { chunk: { type: 'reasoning-delta', text: '\n再查一下配置' } } })
  await subFeed.flush()
  const svLive2 = await nvim.request('nvim_buf_get_lines', [svIds.buf, 0, -1, false])
  assert.ok(svLive2.includes('再查一下配置'), 'growing reasoning tail keeps streaming inline')
  subFeed.applyEvent({ type: 'tool/call', time: 1200, data: { callId: 'sc-1', name: 'bash', arguments: '{"cmd":"ls"}' } })
  subFeed.applyEvent({ type: 'tool/result', time: 1300, data: { message: { content: [{ type: 'text', text: 'a.txt' }], source: { callId: 'sc-1' } } } })
  subFeed.applyEvent({ type: 'assistant/chunk', time: 1400, data: { chunk: { type: 'text-delta', text: '子代理结论 OK' } } })
  subFeed.applyEvent({ type: 'turn/end', time: 1500, data: {} })
  await subFeed.flush()
  const svLines = await nvim.request('nvim_buf_get_lines', [svIds.buf, 0, -1, false])
  log('subagent view lines:', JSON.stringify(svLines))
  assert.ok(svLines.some((l: string) => l.includes('子代理思考：先查目录')), 'reasoning rendered inline in subagent view')
  assert.ok(svLines.some((l: string) => l.startsWith('·· thinking')), 'thinking header rendered inline')
  assert.ok(svLines.some((l: string) => l.startsWith('🔧 bash(')), 'tool card rendered')
  assert.ok(svLines.some((l: string) => l.startsWith('✓ bash')), 'tool result rendered')
  assert.ok(svLines.some((l: string) => l.includes('子代理结论 OK')), 'assistant text rendered')
  // The window grew with the replay (deferred resize via on_lines): height
  // equals the transcript line count and the footer stays anchored below.
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(await lua('return vim.api.nvim_win_get_height(require("dsh_tui")._subagentView.win)', []), svLines.length, 'subagent view height fits the replayed content')
  await assertFooter('[q]', 'subagent view after replay')
  const svReasoningMark = (await nvim.request('nvim_buf_get_extmarks', [svIds.buf, -1, 0, -1, { details: true }]))
    .filter((m: any) => m[3]?.hl_group === 'DshTuiReasoning')
  assert.ok(svReasoningMark.length > 0, 'reasoning header dim-marked in view')
  // Settled replays land on the first thinking block (not the transcript tail).
  const gotoRow = await lua('return require("dsh_tui").subagent_view_goto_thinking()', [])
  const svCursor = await nvim.request('nvim_win_get_cursor', [svIds.win])
  assert.equal(svCursor[0], gotoRow, 'view cursor lands on the thinking block')
  assert.ok((svLines[gotoRow - 1] ?? '').startsWith('·· thinking'), 'landing row is the thinking header')
  const idsBeforeClose = await lua('return require("dsh_tui").subagent_view_ids()', [])
  assert.ok(idsBeforeClose && idsBeforeClose.buf === svIds.buf, 'subagent_view_ids reports open view')
  await lua('require("dsh_tui").close_subagent_view()', [])
  hit = await waitNote('dsh-subagent-view-closed')
  assert.ok(hit, 'close notifies the runner (dsh-subagent-view-closed)')
  const idsAfterClose = await lua('return require("dsh_tui").subagent_view_ids()', [])
  assert.equal(idsAfterClose, null, 'view ids cleared after close')
  // Re-open after close must work (regression: the first view's buffer
  // survived the close and the second open collided on the buffer name →
  // E95, leaving the picker Enter with no visible effect).
  const svIds2 = await lua('return require("dsh_tui").open_subagent_view(...)', ['deepseek-code'])
  assert.ok(Number.isInteger(svIds2.buf) && Number.isInteger(svIds2.win), 'subagent view re-opens after close')
  assert.notEqual(svIds2.buf, svIds.buf, 're-open gets a fresh buffer')
  assert.equal(await lua('return vim.api.nvim_buf_is_valid(...)', [svIds.buf]), false, 'old view buffer wiped on close')
  await lua('require("dsh_tui").close_subagent_view()', [])
  await waitNote('dsh-subagent-view-closed')

  // Multi-line notices must collapse to one line (an embedded newline in a
  // buffer "line" makes nvim_buf_set_lines throw E5108, which silently
  // killed the flush — regression from the E95 failure notice).
  feedB.appendNotice('第一行\n第二行\n\tstack trace')
  await new Promise((r) => setTimeout(r, 120))
  const noticeLines = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  assert.ok(noticeLines.includes('· 第一行 第二行 stack trace'), 'multi-line notice collapsed to one line')
  feedB.appendNotice('still renders after')
  await new Promise((r) => setTimeout(r, 120))
  const noticeLines2 = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  assert.ok(noticeLines2.includes('· still renders after'), 'feed keeps rendering after the collapsed notice')

  // 9g. markdown structure: headings/quotes/links parse into groups/spans;
  // user lines keep their `> ` prefix (not treated as blockquotes).
  // Duration formatting: raw milliseconds become human-readable units.
  assert.equal(formatElapsed(102510), '1m 42s', '102510ms → 1m 42s')
  assert.equal(formatElapsed(234), '234ms', 'sub-second stays in ms')
  assert.equal(formatElapsed(65000), '1m 5s', '65s → 1m 5s')
  assert.equal(formatElapsed(3600000 + 30000), '1h 0m', 'hours form')
  const mdHead = FeedRenderer.parseLine('## 标题行', false, true)
  assert.equal(mdHead.text, '标题行', 'heading markers stripped')
  assert.equal(mdHead.group, 'DshTuiHeading', 'heading group')
  const mdQuote = FeedRenderer.parseLine('> 引用的内容', false, true)
  assert.equal(mdQuote.text, '引用的内容', 'blockquote marker stripped')
  assert.equal(mdQuote.group, 'DshTuiQuote', 'blockquote group')
  const mdUser = FeedRenderer.parseLine('> 用户说的话', false, false)
  assert.equal(mdUser.text, '> 用户说的话', 'user line keeps its prefix')
  assert.equal(mdUser.group, undefined, 'user line has no quote group')
  const mdLink = FeedRenderer.parseLine('见 [文档](docs/x.md) 说明', false, true)
  assert.ok(mdLink.spans.some((s) => s.group === 'DshTuiLink'), 'link span rendered')
  assert.ok(!mdLink.text.includes('(docs/x.md)'), 'link URL stripped')
  assert.ok(mdLink.text.includes('文档'), 'link text kept')

  // 9h. @-file-reference menu: accept replaces the token in the input line.
  await nvim.request('nvim_buf_set_lines', [ids.inputBuf, 0, -1, false, ['请读 @fi']])
  await nvim.request('nvim_win_set_cursor', [ids.inputWin, [1, 10]])
  await lua('require("dsh_tui").set_at_menu(...)', [[{ path: 'src/a.txt', mention: '@src/a.txt' }, { path: 'src/b.md', mention: '@src/b.md' }], 7])
  assert.ok(await lua('return require("dsh_tui").at_menu_open()', []), 'at-menu opens')
  await lua('require("dsh_tui").at_next()', [])
  await lua('require("dsh_tui").at_accept()', [])
  const atLines = await nvim.request('nvim_buf_get_lines', [ids.inputBuf, 0, -1, false])
  assert.equal(atLines[0], '请读 @src/b.md', 'at-mention accepted into input')
  await nvim.request('nvim_buf_set_lines', [ids.inputBuf, 0, -1, false, ['']])

  // 9i. directory picker: navigate to a file → dsh-dir-selected notify.
  await lua('return require("dsh_tui").show_dir_picker(...)', [process.cwd()])
  await assertModeN('dir picker opens in normal mode')
  const dirState = await lua(`local M = require("dsh_tui")
    for i, e in ipairs(M._dirRows) do
      if not e.dir and e.name == "package.json" then return { idx = i } end
    end
    return { idx = 0 }`, [])
  assert.ok(dirState.idx > 0, 'package.json visible in dir picker')
  const dirBuf = await lua('return require("dsh_tui")._dirBuf', [])
  const dirLines = await nvim.request('nvim_buf_get_lines', [dirBuf, 0, -1, false])
  assert.equal(await lua('return vim.api.nvim_win_get_height(require("dsh_tui")._dirWin)', []), Math.min(14, dirLines.length), 'dir window height fits content up to its cap')
  await assertFooter('[Enter]', 'dir picker')
  await assertCentered('require("dsh_tui")._dirWin', 'dir picker')
  // Enter derives the entry from the cursor row (native j/k/G navigation).
  await lua(`local M = require("dsh_tui") vim.api.nvim_win_set_cursor(M._dirWin, { ${dirState.idx} + 2, 0 }) M.dir_enter()`, [])
  hit = await waitNote('dsh-dir-selected')
  assert.ok(String(hit?.args?.[0] ?? '').endsWith('/package.json'), 'dir picker selects a file path')

  // 9j. generic lines float (workflow/settings/trajectory renderer).
  const lf = await lua('return require("dsh_tui").show_lines_float(...)', ['工作流运行', ['◈ audit · 运行中', '  ─ 阶段一']])
  const lfLines = await nvim.request('nvim_buf_get_lines', [lf.buf, 0, -1, false])
  assert.deepEqual(lfLines, ['◈ audit · 运行中', '  ─ 阶段一'], 'lines float renders rows')
  assert.equal(await lua('return vim.api.nvim_win_get_height(require("dsh_tui")._linesWin)', []), lfLines.length, 'lines float window exactly fits content (no gap below)')
  await assertFooter('[q]', 'lines float')
  await assertCentered('require("dsh_tui")._linesWin', 'lines float')
  // Without an editPath, i/o are Nop'd (read-only float must not answer an
  // edit attempt with a raw E21); with an editPath they open the file tab.
  const lfMaps = await lua(`local out = {}
    for _, m in ipairs(vim.api.nvim_buf_get_keymap(${lf.buf}, "n")) do
      -- msgpack cannot carry a Lua callback back to the client — report a flag.
      table.insert(out, { lhs = m.lhs, rhs = m.rhs or "", hasCallback = type(m.callback) == 'function' })
    end
    return out`, [])
  const lfI = lfMaps.find((m: any) => m.lhs === 'i')
  assert.ok(lfI && lfI.rhs === '' && !lfI.hasCallback, 'lines float i is Nop without editPath')
  await lua('require("dsh_tui").close_lines_float()', [])
  const lf2 = await lua('return require("dsh_tui").show_lines_float(...)', ['设置', ['▸ agent-default-model'], '/tmp/settings.yaml'])
  const lf2Maps = await lua(`local out = {}
    for _, m in ipairs(vim.api.nvim_buf_get_keymap(${lf2.buf}, "n")) do
      table.insert(out, { lhs = m.lhs, hasCallback = type(m.callback) == 'function' })
    end
    return out`, [])
  const lf2I = lf2Maps.find((m: any) => m.lhs === 'i')
  assert.ok(lf2I && lf2I.hasCallback, 'lines float i opens the edit file when editPath is given')
  await lua('require("dsh_tui").close_lines_float()', [])

  // 9k2. install progress float: live log tail + bottom bar row (marketplace
  // install streams into it so pnpm runs never look stuck).
  const prog = await lua('return require("dsh_tui").show_progress(...)', ['安装 demo-plugin', ['① 解析安装源…']])
  assert.ok(Number.isInteger(prog.buf) && Number.isInteger(prog.win), 'progress float opens')
  await assertCentered('require("dsh_tui")._progress.win', 'progress')
  await lua('require("dsh_tui").progress_update(...)', [['① 解析安装源…', '· 使用 npm 发布版: x@1.0.0', '② 安装依赖…', '✓ 命令成功'], '▸ 60% 安装依赖…'])
  const progLines = await nvim.request('nvim_buf_get_lines', [prog.buf, 0, -1, false])
  assert.ok(String(progLines[progLines.length - 1]).startsWith('▸ 60%'), 'progress bar row is the last row')
  assert.ok(progLines.slice(0, -1).includes('✓ 命令成功'), 'progress window shows install log lines')
  await lua('require("dsh_tui").progress_update(...)', [Array.from({ length: 40 }, (_, i) => 'log-' + i), 'bar-end'])
  const progLines2 = await nvim.request('nvim_buf_get_lines', [prog.buf, 0, -1, false])
  assert.ok(String(progLines2[progLines2.length - 1]).startsWith('bar-end'), 'bar stays the last row after a log flood')
  assert.ok(progLines2.includes('log-39'), 'latest log line visible (tailed view)')
  assert.equal(await lua('return vim.api.nvim_win_get_height(require("dsh_tui")._progress.win)', []), progLines2.length, 'progress window holds exactly the visible tail')
  await lua('require("dsh_tui").close_progress()', [])
  assert.equal(await lua('return require("dsh_tui")._progress.win', []), null, 'progress float closes')

  // 9k. layout presets: panel opens the reasoning panel, default closes it
  // (no resident sessions window anymore).
  await lua('require("dsh_tui").apply_layout(...)', ['panel'])
  assert.equal((await lua('return require("dsh_tui").ids()', [])).reasoningOpen, true, 'panel layout opens reasoning panel')
  await lua('require("dsh_tui").apply_layout(...)', ['default'])
  assert.equal((await lua('return require("dsh_tui").ids()', [])).reasoningOpen, false, 'default layout closes reasoning panel')

  // 9l. bell + file tab + append_input helpers.
  assert.equal(await lua('return require("dsh_tui").bell()', []), true, 'bell emits')
  const tabCountBefore = await lua('return vim.fn.tabpagenr("$")', [])
  const okTab = await lua('return require("dsh_tui").open_file_tab(...)', [process.cwd() + '/package.json'])
  assert.equal(okTab, true, 'file tab opens')
  assert.equal(await lua('return vim.fn.tabpagenr("$")', []), tabCountBefore + 1, 'new tabpage created')
  await nvim.request('nvim_command', ['tabclose'])
  await nvim.request('nvim_buf_set_lines', [ids.inputBuf, 0, -1, false, ['hi']])
  await nvim.request('nvim_win_set_cursor', [ids.inputWin, [1, 2]])
  await lua('require("dsh_tui").append_input(...)', ['@note '])
  const appended = await nvim.request('nvim_buf_get_lines', [ids.inputBuf, 0, -1, false])
  assert.equal(appended[0], 'hi@note ', 'append_input inserts at cursor')
  await nvim.request('nvim_buf_set_lines', [ids.inputBuf, 0, -1, false, ['']])

  nvim.off('notification', onNote)

  // 10. statusline/completion opt-outs (user plugins must not take over)
  await lua('require("dsh_tui").disable_external_completion()', [])
  const opt = await lua(`local ib = require("dsh_tui").ids().inputBuf
    return vim.api.nvim_buf_call(ib, function()
      return {
        ministatusline_disable = vim.b.ministatusline_disable,
        complete = vim.bo.completefunc,
        omni = vim.bo.omnifunc,
      }
    end)`, [])
  log('after disable:', JSON.stringify(opt))
  assert.equal(opt.ministatusline_disable, true, 'input buffer opts out of mini.statusline')
  assert.equal(opt.complete, '', 'completefunc cleared')
  assert.equal(opt.omni, '', 'omnifunc cleared')

  // 11. statusline ownership: survives plugin clobbering on window switches
  await lua('require("dsh_tui").set_statusline(...)', ['%#DshTuiStatus# TEST-LEFT %= TEST-RIGHT '])
  let sl = await lua('return vim.api.nvim_win_get_option(require("dsh_tui").ids().chatWin, "statusline")', [])
  assert.ok(sl.includes('TEST-LEFT'), 'statusline applied to chat window')
  // simulate a statusline plugin rewriting the option on WinEnter
  await lua('vim.api.nvim_win_set_option(require("dsh_tui").ids().chatWin, "statusline", "")', [])
  await lua('require("dsh_tui").reschedule_statusline()', [])
  await new Promise((r) => setTimeout(r, 80))
  sl = await lua('return vim.api.nvim_win_get_option(require("dsh_tui").ids().chatWin, "statusline")', [])
  assert.ok(sl.includes('TEST-LEFT'), 'statusline restored after plugin clobber')
  // global mini.statusline opt-out for the TUI instance
  const g = await lua('return vim.g.ministatusline_disable', [])
  assert.equal(g, true, 'global mini.statusline disable set')

  // 12. window statuslines: input styled, reasoning seamless
  const ids12 = await lua('return require("dsh_tui").ids()', [])
  const slInput = await lua('return vim.api.nvim_win_get_option(require("dsh_tui").ids().inputWin, "statusline")', [])
  assert.ok(slInput.includes('Enter 发送'), 'input window has a styled helper bar')
  assert.ok(!slInput.includes('❯'), 'prompt moved OUT of the input statusline')
  assert.ok(!slInput.includes('StatusLineNC'), 'no raw StatusLineNC block')
  // hints sit at the LEFT edge (aligned with the input box), not the far right
  assert.ok(slInput.startsWith('%#DshTuiStatus# Enter 发送'), 'hints are left-aligned (no %= right split)')
  assert.ok(!slInput.includes('%='), 'no right-alignment split in the hint bar')
  // The '❯' prompt lives in the status COLUMN: visual only, never part of
  // the submitted text, never deletable.
  const promptCol = await lua('return vim.wo[require("dsh_tui").ids().inputWin].statuscolumn', [])
  assert.ok(promptCol.includes('❯'), 'input status column carries the ❯ prompt')
  assert.equal(ids12.sessionsWin, undefined, 'no sessions window in ids (float only)')
  // Plain-content groups FOLLOW the theme's Comment (the pre-regression dim
  // tone); a bright Comment triggers the blend fallback instead.
  const dims = await lua(`local out = {}
    for _, g in ipairs({ 'DshTuiAssistant', 'DshTuiReasoning', 'DshTuiNotice', 'DshTuiDivider', 'DshTuiCmdDesc' }) do
      local hl = vim.api.nvim_get_hl(0, { name = g })
      out[g] = { fg = hl.fg, link = hl.link }
    end
    return out`, [])
  for (const g of ['DshTuiAssistant', 'DshTuiReasoning', 'DshTuiNotice', 'DshTuiDivider', 'DshTuiCmdDesc']) {
    assert.equal(dims[g].link, 'Comment', g + ' follows the theme Comment link')
  }
  const inputWinhl = await lua('return vim.wo[require("dsh_tui").ids().inputWin].winhl', [])
  assert.ok(inputWinhl.includes('Normal:DshTuiDim'), 'input window dims typed text')
  // terminal title: nvim owns the terminal and emits the OSC 2 title itself
  await lua('require("dsh_tui").set_title("测试会话")', [])
  const title = await lua('return { t = vim.o.title, ts = vim.o.titlestring }', [])
  assert.equal(title.t, true, 'nvim emits the terminal title')
  assert.ok(title.ts.includes('测试会话'), 'titlestring carries the session title')
  // layout: no dead rows — the cmdline is reclaimed and the chat sits flush
  // against the input (exactly the statusline row between them), even after
  // an input grow/shrink round-trip.
  const layoutProbe = () => lua(`local ids = require('dsh_tui').ids()
    return {
      cmdheight = vim.o.cmdheight,
      chatEnd = vim.api.nvim_win_get_position(ids.chatWin)[1] + vim.api.nvim_win_get_height(ids.chatWin),
      inputTop = vim.api.nvim_win_get_position(ids.inputWin)[1],
      inputH = vim.api.nvim_win_get_height(ids.inputWin),
    }`, [])
  const layoutBefore = await layoutProbe()
  assert.equal(layoutBefore.cmdheight, 0, 'cmdline row reclaimed')
  assert.equal(layoutBefore.inputTop - layoutBefore.chatEnd, 1, 'chat flush above the input (statusline only)')
  await lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "a", "b", "c" }); require("dsh_tui").resize_input()`, [])
  await lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "" }); require("dsh_tui").resize_input()`, [])
  const layoutAfter = await layoutProbe()
  assert.equal(layoutAfter.inputTop - layoutAfter.chatEnd, 1, 'no dead row after input grow/shrink round-trip')
  assert.equal(layoutAfter.inputH, 1, 'input back to one row after round-trip')
  const dimHl = await lua('return vim.api.nvim_get_hl(0, { name = "DshTuiDim" })', [])
  assert.equal(dimHl.link, 'Comment', 'DshTuiDim follows the theme Comment')
  // a colorscheme (re)applied late must not wash the palette back to white
  await lua('vim.cmd("colorscheme default")', [])
  await new Promise((r) => setTimeout(r, 100))
  const asstAfter = await lua('return vim.api.nvim_get_hl(0, { name = "DshTuiAssistant" })', [])
  assert.equal(asstAfter.link, 'Comment', 'palette survives colorscheme re-application')
  // the WHOLE highlight set (role links included) restores after a wipe —
  // lazy colorschemes run `hi clear` late and used to turn everything white
  await lua('vim.cmd("highlight clear"); require("dsh_tui").applyHighlights()', [])
  const afterWipe = await lua(`return {
    user = vim.api.nvim_get_hl(0, { name = "DshTuiUser" }),
    asst = vim.api.nvim_get_hl(0, { name = "DshTuiAssistant" }),
    tool = vim.api.nvim_get_hl(0, { name = "DshTuiTool" }),
  }`, [])
  assert.equal(afterWipe.user.link, 'MoreMsg', 'user-message link restored after wipe')
  assert.equal(afterWipe.tool.link, 'Special', 'tool link restored after wipe')
  assert.equal(afterWipe.asst.link, 'Comment', 'assistant dim link restored after wipe')
  // a BRIGHT Comment (white-Comment themes) falls back to the blended gray
  await lua(`vim.api.nvim_set_hl(0, 'Comment', { fg = 0xffffff })
    require("dsh_tui").applyDimPalette()`, [])
  const fallbackAsst = await lua('return vim.api.nvim_get_hl(0, { name = "DshTuiAssistant" })', [])
  assert.equal(typeof fallbackAsst.fg, 'number', 'bright Comment falls back to blended dim fg')
  assert.equal(fallbackAsst.link, undefined, 'fallback clears the Comment link')
  await lua('vim.cmd("colorscheme default")', [])
  await new Promise((r) => setTimeout(r, 100))
  // DshTuiStatus must carry an explicit background (equal to Normal's) —
  // a bold-only group would fall back to the theme's StatusLine bg (white bar).
  const st = await lua(`local n = vim.api.nvim_get_hl(0, { name = 'Normal' })
    local sl = vim.api.nvim_get_hl(0, { name = 'StatusLine' })
    local s = vim.api.nvim_get_hl(0, { name = 'DshTuiStatus' })
    return { status_bg = s.bg, normal_bg = n.bg, fg = s.fg, statusline_fg = sl.fg, bold = s.bold }`, [])
  assert.equal(st.status_bg, st.normal_bg, 'DshTuiStatus bg matches Normal bg')
  const fills = await lua(`local n = vim.api.nvim_get_hl(0, { name = 'Normal' })
    local a = vim.api.nvim_get_hl(0, { name = 'StatusLine' })
    local i = vim.api.nvim_get_hl(0, { name = 'StatusLineNC' })
    return { active = a.bg, inactive = i.bg, normal = n.bg }`, [])
  assert.equal(fills.active, fills.normal, 'StatusLine (active) fill = editor bg')
  assert.equal(fills.inactive, fills.normal, 'StatusLineNC (inactive) fill = editor bg')
  assert.equal(typeof st.fg, 'number', 'DshTuiStatus fg is a color')
  assert.equal(st.bold, true, 'DshTuiStatus keeps bold')

  // 13. theme overrides (M5)
  await lua(`require("dsh_tui").apply_theme({
    DshTuiUser = { fg = "#ff0000", bold = true },
    DshTuiTool = { link = "WarningMsg" },
  })`, [])
  const userHl = await lua('return vim.api.nvim_get_hl(0, { name = "DshTuiUser" })', [])
  assert.equal(userHl.fg, 16711680, 'theme fg applied') // 0xff0000
  assert.equal(userHl.bold, true, 'theme bold applied')
  const toolHl = await lua('return vim.api.nvim_get_hl(0, { name = "DshTuiTool" })', [])
  assert.equal(typeof toolHl.link, 'string', 'theme link applied')

  // 10a. P2: CJK typed input via nvim_input (IME path) + large-message
  // flush performance sanity.
  await lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "" })
    vim.api.nvim_set_current_win(require("dsh_tui").ids().inputWin); vim.cmd("startinsert")`, [])
  await nvim.request('nvim_input', ['中文输入测试 ime-check'])
  await new Promise((r) => setTimeout(r, 120))
  const typed = await lua('return table.concat(vim.api.nvim_buf_get_lines(require("dsh_tui").ids().inputBuf, 0, -1, false), "\\n")', [])
  assert.ok(typed.includes('中文输入测试 ime-check'), 'CJK text typed through nvim_input lands in the input buffer')
  await lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "" })`, [])

  const bigText = Array.from({ length: 400 }, (_, i) => `第 ${i} 行 · 性能压测内容 performance sanity check`).join('\n')
  const t0 = Date.now()
  feedB.applyEvent({ type: 'assistant/message', time: 7500, data: { turn: 4, step: 1, message: { content: [{ type: 'text', text: bigText }] } } })
  for (let i = 0; i < 100; i++) {
    const lines = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
    if (lines.some((l: string) => l.includes('第 399 行'))) break
    await new Promise((r) => setTimeout(r, 40))
  }
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 2500, `400-line message flushed in ${elapsed}ms (< 2500ms)`)
  const bigLines = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  assert.ok(bigLines.some((l: string) => l.includes('第 399 行')), 'large message fully rendered')

  // 10b. image helpers (multimodal input path)
  assert.equal(sniffMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), 'image/png', 'png sniffed')
  assert.equal(sniffMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00])), 'image/jpeg', 'jpeg sniffed')
  assert.equal(sniffMediaType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'image/gif', 'gif sniffed')
  assert.equal(sniffMediaType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])), 'image/webp', 'webp sniffed')
  assert.equal(sniffMediaType(new Uint8Array([0x00, 0x01, 0x02])), null, 'unknown format rejected')
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const parsed = parseImageDataUrl(`data:image/png;base64,${pngBytes.toString('base64')}`)
  assert.equal(parsed?.mediaType, 'image/png', 'data url parsed')
  assert.deepEqual([...parsed.data], [...pngBytes], 'data url decoded to bytes')
  assert.equal(parseImageDataUrl('data:image/svg+xml;base64,AAAA'), null, 'unsupported media type rejected')
  assert.equal(parseImageDataUrl('not-a-data-url'), null, 'plain text rejected')
  const split = splitImageDataUrls(`你好 data:image/png;base64,${pngBytes.toString('base64')} 再见`)
  assert.equal(split.text, '你好 再见', 'data url stripped from prompt text')
  assert.equal(split.images.length, 1, 'one image extracted from paste')
  assert.equal(imageLabel({ mediaType: 'image/png', bytes: 1024, width: 640, height: 480 }), '📎 图片 (image/png · 640×480 · 1.0KB)', 'image label formatting')

  // 11. stats: token/cost/cache/format helpers (M5 statusline)
  let u = foldUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    { inputTokens: 500000, outputTokens: 12600, cacheReadTokens: 100000, cacheWriteTokens: 0 })
  assert.equal(billedInput(u), 600000, 'billed input includes cache reads')
  assert.equal(cacheHitRate(u, true), 100000 / 600000, 'cache hit rate')
  assert.equal(estimateCost('deepseek-v4-pro', u)!.toFixed(2), '0.32', 'cost estimate')
  assert.equal(formatTokens(512600), '512.6k', 'token formatting k')
  assert.equal(formatTokens(1000000), '1.00M', 'token formatting M')
  assert.equal(formatElapsed(555000), '9m 15s', 'elapsed formatting')
  assert.equal(formatElapsed(95000), '1m 35s', 'elapsed formatting minutes')
  assert.equal(modeLabel('workspace-write'), 'normal', 'mode label mapping')
  assert.equal(escapeStatusline('缓存 100%'), '缓存 100%%', 'percent escaped for statusline')
  assert.equal(modeLabel('danger-full-access'), 'full-access', 'mode label full access')
  assert.equal(cacheHitRate(u, false), null, 'no cache fields → no rate')

  // 12. require() must survive rtp resets (lazy.nvim rebuilds runtimepath and
  // enables vim.loader — package.preload keeps dsh_tui resolvable).
  await lua(
    'pcall(vim.loader.enable); vim.opt.rtp = { "/tmp/nonexistent" }; return require("dsh_tui").ids()',
    [],
  )
  log('require survives rtp reset: ok')

  // 7. nvim → Node notification
  const notified = new Promise((resolve) => {
    nvim.on('notification', (method, args) => {
      if (method === 'dsh-test') resolve(args[0])
    })
  })
  await lua(
    'vim.rpcnotify(require("dsh_tui").channel(), "dsh-test", 42)',
    [],
  )
  const got = await notified
  assert.equal(got, 42, 'rpcnotify roundtrip')
  log('rpcnotify roundtrip ok:', got)

  log('SMOKE PASS')
} finally {
  // Graceful close — the TUI's /exit path relies on ':qa!' so nvim never
  // prints "Nvim: Caught deadly signal 'SIGTERM'". The exit listener is
  // registered BEFORE the qa! — nvim can exit before the RPC roundtrip ends.
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.once('exit', (code: number | null, signal: string | null) => resolve({ code, signal })))
  try {
    await Promise.race([
      nvim.command('qa!').catch(() => {}),
      new Promise((r) => setTimeout(r, 300)),
    ])
  } catch {}
  const exitInfo = await Promise.race<{ code: number | null; signal: string | null } | null>([
    exited,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
  ])
  if (exitInfo === null) {
    child.kill()
  } else {
    assert.equal(exitInfo.code, 0, 'graceful :qa! exits with code 0')
    assert.equal(exitInfo.signal, null, 'no signal on graceful exit')
    log('graceful exit: ok')
  }
  // Let the process exit naturally — process.exit() truncates async stdout
  // writes on pipes and would swallow the logs above.
  await new Promise((r) => setTimeout(r, 200))
}
