// Headless smoke test: spawn nvim --headless with the dsh_tui plugin, connect
// over the socket, and verify the full RPC roundtrip without a DSH host:
//   Node → nvim (lua, buf_set_lines)              ✓
//   nvim → Node (rpcnotify notification)          ✓
//   FeedRenderer transcript → chat buffer lines    ✓
//   chat buffer undo disabled (undolevels = -1)   ✓
//   multi-session: ensure_chat / set_sessions / set_active  ✓
//   require survives rtp resets (package.preload) ✓
// Run: node scripts/smoke.js

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnNvim, connectNvim } from '../lib/bridge.js'
import { FeedRenderer } from '../lib/feed.js'
import { foldUsage, billedInput, cacheHitRate, estimateCost, formatTokens, formatElapsed, modeLabel, escapeStatusline } from '../lib/stats.js'
import { sniffMediaType, parseImageDataUrl, splitImageDataUrls, imageLabel } from '../lib/images.js'

// console.* is async and its output can be swallowed by non-TTY capture
// environments once the nvim child shares the pipe; write synchronously.
const log = (...a) => fs.writeSync(1, a.join(' ') + '\n')

const { child, sockPath } = await spawnNvim({
  extraArgs: ['--headless'],
  loadUserConfig: false,
  isolateXdg: true,
})
const nvim = await connectNvim(sockPath)

try {
  // 1. channel id + Lua attach
  const channelId = await nvim.channelId
  log('channelId:', channelId)

  await nvim.lua('require("dsh_tui").attach(...)', [channelId])
  assert.equal(await nvim.lua('return require("dsh_tui").channel()', []), channelId)

  // VimEnter may not have fired yet (start() mounts the UI there) — poll.
  let ids
  for (let i = 0; i < 50; i++) {
    ids = await nvim.lua('return require("dsh_tui").ids()', [])
    if (Number.isInteger(ids?.inputBuf) && Number.isInteger(ids?.chatWin)) break
    await new Promise((r) => setTimeout(r, 100))
  }
  log('ids:', JSON.stringify(ids))
  assert.ok(Number.isInteger(ids.inputBuf) && Number.isInteger(ids.chatWin))
  assert.equal(ids.sessionsBuf, undefined, 'no resident sessions window anymore')

  // 2. multi-session: two chat buffers, /sessions float with FULL ids,
  // active switching.
  const chatA = await nvim.lua('return require("dsh_tui").ensure_chat(...)', ['session-aaaa'])
  const chatB = await nvim.lua('return require("dsh_tui").ensure_chat(...)', ['session-bbbb'])
  assert.notEqual(chatA.chatBuf, chatB.chatBuf, 'per-session chat buffers')

  await nvim.lua('require("dsh_tui").show_session_list(...)', [[
    { id: 'session-aaaa', title: '会话甲', active: true, kind: 'live' },
    { id: 'session-bbbb', title: '会话乙', active: false, kind: 'live' },
    { id: 'session-hist', title: '旧会话', active: false, kind: 'history' },
  ]])
  assert.equal((await nvim.request('nvim_get_mode', [])).mode, 'n', 'session list opens in normal mode')
  let sessF = await nvim.lua('return require("dsh_tui")._sessBuf', [])
  const listLines = await nvim.request('nvim_buf_get_lines', [sessF, 0, -1, false])
  log('session list float:', JSON.stringify(listLines))
  assert.ok(listLines.some((l) => l.includes('会话甲') && l.includes('session-aaaa')), 'full session id shown')
  assert.ok(listLines.some((l) => l.includes('旧会话') && l.includes('session-hist') && l.includes('历史')), 'history kind shown')
  await nvim.lua('require("dsh_tui").close_session_list()', [])
  assert.equal(await nvim.lua('return require("dsh_tui")._sessWin', []), null, 'session list closed')

  // active session's buffer shown in the chat window
  await nvim.lua('require("dsh_tui").set_active(...)', ['session-bbbb'])
  assert.equal(await nvim.lua('return vim.api.nvim_win_get_buf(...)', [ids.chatWin]), chatB.chatBuf)

  // 3. chat buffer must not be undoable
  assert.equal(await nvim.request('nvim_buf_get_option', [chatA.chatBuf, 'undolevels']), -1)

  // 4. FeedRenderer transcript → chat buffer; inactive feed must not move cursor
  let active = 'session-aaaa'
  const feedA = new FeedRenderer(nvim, chatA.chatBuf, chatA.chatWin, {
    activeChecker: () => active === 'session-aaaa',
  })
  const reasonB = await nvim.lua('return require("dsh_tui").ensure_reasoning(...)', ['session-bbbb'])
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
  assert.ok(linesA.some((l) => l.includes('Hello from nvim (full) with bold and code')), 'markup stripped in buffer')
  assert.ok(linesA.some((l) => l.startsWith('🔧 bash({"cmd":"ls"})')), 'tool/call card')
  assert.ok(linesA.some((l) => l.startsWith('✓ bash · 234ms')), 'tool/result card with elapsed')
  assert.ok(linesA.some((l) => l.startsWith('✗ web_search') && l.includes('TIMEOUT')), 'failed tool card')
  assert.ok(linesA.some((l) => l.includes('◇ subagent deepseek-code')), 'subagent start card')
  assert.ok(linesA.some((l) => l.includes('◇ subagent deepseek-code · completed')), 'subagent end card')
  assert.ok(linesA.some((l) => l.includes('◈ workflow 审计')), 'workflow start card')
  assert.ok(linesA.some((l) => l.includes('◈ ─ 阶段一')), 'workflow phase card')

  // extmark spans: bold + code groups present
  const marks = await nvim.request('nvim_buf_get_extmarks', [chatA.chatBuf, -1, 0, -1, { details: true }])
  const groups = new Set(marks.map((m) => m[3]?.hl_group))
  assert.ok(groups.has('DshTuiBold'), 'bold span highlighted')
  assert.ok(groups.has('DshTuiCode'), 'code span highlighted')
  assert.ok(groups.has('DshTuiTool'), 'tool role highlighted')
  assert.ok(groups.has('DshTuiAssistant'), 'assistant output dimmed (own group)')
  // Row groups must be EXPLICIT same-row ranges (end_col = byte length) —
  // nvim 0.12's real TUI does not draw hl_eol marks, which rendered every
  // chat line plain white in production.
  const rowGroupMarks = marks.filter((m) => m[3]?.hl_group === 'DshTuiAssistant')
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
  assert.ok(!linesA2.some((l) => l.includes('agent working')), 'history replay skips status')
  assert.ok(linesA2.some((l) => l.includes('no API key')), 'finish-error chunk rendered')

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
  assert.ok(linesB2.some((l) => /^·· thinking · \d+\.\d+s$/.test(l)), 'compact progress line in chat')
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
    const cover = reasonMarks.some((m) => m[1] === i && m[3]?.end_row === i &&
      m[3]?.end_col === Buffer.byteLength(line, 'utf8') && typeof m[3]?.hl_group === 'string')
    assert.ok(cover, `panel row ${i} fully highlighted (${JSON.stringify(line)})`)
  }
  feedB.applyEvent({ type: 'assistant/chunk', time: 5300, data: { chunk: { type: 'text-delta', text: '答案是 42' } } })
  await new Promise((r) => setTimeout(r, 120))
  linesB2 = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  assert.ok(!linesB2.some((l) => l.includes('·· thinking')), 'thinking line vanishes from chat after close')
  assert.ok(linesB2.includes('答案是 42'), 'answer follows the transient line')
  reasonLines = await nvim.request('nvim_buf_get_lines', [reasonB.reasoningBuf, 0, -1, false])
  assert.ok(reasonLines.some((l) => l.startsWith('── thinking end')), 'panel footer on close')

  // tool records go to the panel too; chat shows only the live activity line
  feedB.applyEvent({ type: 'tool/call', time: 5600, data: { turn: 1, step: 1, callId: 'c-1', name: 'bash', arguments: '{"cmd":"ls"}' } })
  await new Promise((r) => setTimeout(r, 100))
  let chatDuring = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  assert.ok(chatDuring.some((l) => /^🔧 bash · \d+\.\d+s$/.test(l)), 'chat shows live tool activity line')
  assert.ok(!chatDuring.some((l) => l.includes('{"cmd":"ls"}')), 'tool card NOT in chat')
  feedB.applyEvent({ type: 'tool/result', time: 5800, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'README.md' }], source: { callId: 'c-1' } } } })
  await new Promise((r) => setTimeout(r, 100))
  reasonLines = await nvim.request('nvim_buf_get_lines', [reasonB.reasoningBuf, 0, -1, false])
  log('panel with tools:', JSON.stringify(reasonLines))
  assert.ok(reasonLines.some((l) => l.startsWith('🔧 bash(')), 'tool call in panel')
  assert.ok(reasonLines.some((l) => l.startsWith('✓ bash · 200ms')), 'tool result in panel')
  chatDuring = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  assert.ok(!chatDuring.some((l) => /^🔧 bash ·/.test(l)), 'activity line gone after result')
  feedB.applyEvent({ type: 'turn/end', time: 5500, data: {} })

  // placeholder while a turn is silent
  feedB.applyEvent({ type: 'turn/start', time: 6000, data: {} })
  await new Promise((r) => setTimeout(r, 1400)) // 800ms threshold + ticker flush
  const linesB3 = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  log('placeholder lines:', JSON.stringify(linesB3))
  assert.ok(linesB3.some((l) => /^·· thinking… \d+s$/.test(l)), 'silent turn shows thinking placeholder')
  feedB.applyEvent({ type: 'turn/end', time: 6500, data: {} })

  // 7. <C-o> reasoning panel toggle
  const opened = await nvim.lua('return require("dsh_tui").toggle_reasoning()', [])
  assert.equal(opened, true, 'panel opens')
  let idsT = await nvim.lua('return require("dsh_tui").ids()', [])
  assert.ok(Number.isInteger(idsT.reasoningWin), 'reasoning window exists')
  assert.equal(idsT.reasoningOpen, true)
  assert.equal(await nvim.lua('return vim.api.nvim_win_get_buf(...)', [idsT.reasoningWin]), reasonB.reasoningBuf,
    'panel shows active session reasoning')
  const closed = await nvim.lua('return require("dsh_tui").toggle_reasoning()', [])
  assert.equal(closed, false, 'panel closes')
  idsT = await nvim.lua('return require("dsh_tui").ids()', [])
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
  assert.ok(linesT.some((l) => l.startsWith('┌')), 'table top border')
  assert.ok(linesT.some((l) => l.startsWith('├')), 'table header separator')
  assert.ok(linesT.some((l) => l.includes('日期') && l.includes('AQI')), 'table header rendered')
  assert.ok(linesT.includes('│ 今天 8/19 │  29 │ 🟢 优 │ 无（O₃ 78 稍高） │'), 'aligned row (display-width padded)')
  assert.ok(linesT.some((l) => l.includes('│ 明天 8/20 │  50 │ 🟢 优 │ 无')), 'backtick cell markup stripped')
  assert.ok(!linesT.some((l) => l.includes('**') || l.includes('`')), 'no literal markdown markers in table cells')
  assert.ok(!linesT.some((l) => l.startsWith('└')), 'no bottom border while streaming')
  // close the stream → bottom border appears
  feedB.applyEvent({ type: 'turn/end', time: 7200, data: {} })
  await new Promise((r) => setTimeout(r, 120))
  linesT = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  log('table closed:', JSON.stringify(linesT.slice(-6)))
  log('table closed FULL:', JSON.stringify(linesT))
  assert.ok(linesT.some((l) => l.startsWith('└')), 'bottom border after stream closes')

  // table cells are bold across EVERY row (uniform style); the bold spans
  // must cover cell CONTENT only — a whole-row bold group would bold the
  // '│' separators and render them as thick vertical lines.
  // (nvim 0.12 bug: nvim_buf_get_extmarks with ns=-1 rejects a bounded end
  //  row, so query the full buffer and filter by row here.)
  const headerIdx = linesT.findIndex((l) => l.includes('日期') && l.includes('AQI'))
  assert.ok(headerIdx >= 0, 'table header row present')
  const tableMarks = await nvim.request('nvim_buf_get_extmarks', [chatB.chatBuf, -1, 0, -1, { details: true }])
  for (const rowIdx of [headerIdx, linesT.findIndex((l) => l.includes('今天 8/19')), linesT.findIndex((l) => l.includes('明天 8/20'))]) {
    assert.ok(rowIdx >= 0, 'table row present')
    const boldSpans = tableMarks.filter((m) => m[1] === rowIdx && m[3]?.hl_group === 'DshTuiBold')
    assert.ok(boldSpans.length >= 2, `row ${rowIdx}: cells carry bold spans (uniform style)`)
    const rowByteLen = Buffer.byteLength(linesT[rowIdx], 'utf8')
    for (const m of boldSpans) {
      assert.ok(m[2] > 0, 'bold span does not start on the leading │')
      assert.ok(m[3].end_col <= rowByteLen - 1, 'bold span does not cover the trailing │')
    }
  }

  // inline spans are byte-indexed: CJK bold must cover exactly the text bytes
  feedB.applyEvent({ type: 'assistant/message', time: 7300, data: { turn: 3, step: 1, message: { content: [{ type: 'text', text: '前缀 **中文加粗** 后缀' }] } } })
  await new Promise((r) => setTimeout(r, 120))
  const cjkLines = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  const cjkIdx = cjkLines.findIndex((l) => l.includes('中文加粗'))
  assert.ok(cjkIdx >= 0, 'cjk bold line present')
  const cjkMarks = await nvim.request('nvim_buf_get_extmarks', [chatB.chatBuf, -1, 0, -1, { details: true }])
  const cjkBold = cjkMarks.filter((m) => m[1] === cjkIdx && m[3]?.hl_group === 'DshTuiBold')
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
  const baseWins = (await nvim.lua('return vim.api.nvim_list_wins()', [])).length
  await nvim.lua(`require("dsh_tui").show_skill({ name = "demo", description = "演示技能", whenToUse = "测试", content = "正文" })`, [])
  let skillWins = (await nvim.lua('return vim.api.nvim_list_wins()', [])).length
  assert.equal(skillWins, baseWins + 1, 'skill float window opened')
  await nvim.lua('require("dsh_tui").close_skill()', [])
  skillWins = (await nvim.lua('return vim.api.nvim_list_wins()', [])).length
  assert.equal(skillWins, baseWins, 'skill float closed')

  // 9. M4 interactions: input submit/history/completion, approval, questions,
  // picker (all via the Lua API; the Node wiring is exercised in e2e).
  const notes = []
  const onNote = (method, args) => notes.push({ method, args })
  nvim.on('notification', onNote)
  const waitNote = async (method, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = notes.find((n) => n.method === method)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 20))
    }
    return null
  }

  // 9a. input submit + history
  await nvim.lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "你好世界" })`, [])
  await nvim.lua('require("dsh_tui").submit()', [])
  let hit = await waitNote('dsh-input')
  assert.equal(hit?.args?.[0], '你好世界', 'submit routes dsh-input')
  const inputAfter = await nvim.lua('return vim.api.nvim_buf_get_lines(require("dsh_tui").ids().inputBuf, 0, -1, false)', [])
  assert.deepEqual(inputAfter, [''], 'input reset after submit')
  await nvim.lua('require("dsh_tui").history_move(-1)', [])
  let txt = await nvim.lua('return table.concat(vim.api.nvim_buf_get_lines(require("dsh_tui").ids().inputBuf, 0, -1, false), "\\n")', [])
  assert.equal(txt, '你好世界', 'history up restores last input')

  // 9a2. /sessions float interactions: j/k + <CR> select (full id), <C-n> new.
  await nvim.lua('require("dsh_tui").show_session_list(...)', [[
    { id: 'session-aaaa', title: '会话甲', active: true, kind: 'live' },
    { id: 'session-bbbb', title: '会话乙', active: false, kind: 'live' },
  ]])
  await nvim.lua('require("dsh_tui").session_list_move(1)', [])
  await nvim.lua('require("dsh_tui").session_list_select()', [])
  hit = await waitNote('dsh-session-select')
  assert.equal(hit?.args?.[0], 'session-bbbb', 'session selection routes the full id')
  await nvim.lua('require("dsh_tui").show_session_list(...)', [[
    { id: 'session-aaaa', title: '会话甲', active: true, kind: 'live' },
  ]])
  await nvim.lua('require("dsh_tui").session_list_new()', [])
  hit = await waitNote('dsh-session-new')
  assert.ok(hit, 'new-session request routes from the float')

  // 9b. slash-command completion menu: fallback catalog (before the runner
  // pushes set_commands), auto-open on '/', live filtering, Tab/C-p cycling.
  await nvim.lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "/" })`, [])
  await nvim.lua('require("dsh_tui").update_cmd_menu()', [])
  let menuSt = await nvim.lua('return require("dsh_tui").cmd_menu_state()', [])
  assert.equal(menuSt.open, true, 'menu opens on "/"')
  assert.equal(menuSt.selected, '/exit', 'first fallback command selected')
  assert.ok(menuSt.names.includes('/help') && menuSt.names.includes('/model'), 'fallback catalog lists commands')
  assert.equal(menuSt.names.length, 47, 'all 47 fallback commands listed')

  // the runner's catalog (name + description) replaces the fallback
  await nvim.lua(`require("dsh_tui").set_commands({
    { name = "/exit", desc = "退出 dsh" },
    { name = "/export", desc = "导出转录 md" },
    { name = "/effort", desc = "推理等级" },
    { name = "/model", desc = "选择/切换模型" },
    { name = "/memory", desc = "浏览/删除项目记忆" },
  })`, [])
  await nvim.lua('require("dsh_tui").update_cmd_menu()', [])
  menuSt = await nvim.lua('return require("dsh_tui").cmd_menu_state()', [])
  assert.deepEqual(menuSt.names, ['/exit', '/export', '/effort', '/model', '/memory'], 'catalog listed in order')

  // live filtering narrows the menu to the prefix
  await nvim.lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "/mo" })`, [])
  await nvim.lua('require("dsh_tui").update_cmd_menu()', [])
  menuSt = await nvim.lua('return require("dsh_tui").cmd_menu_state()', [])
  assert.deepEqual(menuSt.names, ['/model'], 'prefix filter narrows the menu')

  // Tab cycles the selection, C-p wraps back, a full name selects itself
  await nvim.lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "/e" })`, [])
  await nvim.lua('require("dsh_tui").update_cmd_menu()', [])
  await nvim.lua('require("dsh_tui").cmd_next()', [])
  menuSt = await nvim.lua('return require("dsh_tui").cmd_menu_state()', [])
  assert.equal(menuSt.selected, '/export', 'Tab advances to the next match')
  await nvim.lua('require("dsh_tui").cmd_prev()', [])
  menuSt = await nvim.lua('return require("dsh_tui").cmd_menu_state()', [])
  assert.equal(menuSt.selected, '/exit', 'C-p moves back')
  await nvim.lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "/effort" })`, [])
  await nvim.lua('require("dsh_tui").update_cmd_menu()', [])
  menuSt = await nvim.lua('return require("dsh_tui").cmd_menu_state()', [])
  assert.equal(menuSt.selected, '/effort', 'fully typed name selects itself')

  // the menu closes once arguments (a space) are typed
  await nvim.lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "/model 42" })`, [])
  await nvim.lua('require("dsh_tui").update_cmd_menu()', [])
  menuSt = await nvim.lua('return require("dsh_tui").cmd_menu_state()', [])
  assert.equal(menuSt.open, false, 'menu closes once arguments are typed')

  // <CR> on a bare prefix fills the selected command (a second <CR> executes)
  await nvim.lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "/mo" })`, [])
  await nvim.lua('require("dsh_tui").update_cmd_menu()', [])
  await nvim.lua('require("dsh_tui").submit()', [])
  txt = await nvim.lua('return table.concat(vim.api.nvim_buf_get_lines(require("dsh_tui").ids().inputBuf, 0, -1, false), "\\n")', [])
  assert.equal(txt, '/model ', 'CR completes the selected command')
  menuSt = await nvim.lua('return require("dsh_tui").cmd_menu_state()', [])
  assert.equal(menuSt.open, false, 'menu closed after completing')

  // <CR> with the full name typed executes the command directly
  await nvim.lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "/model" })`, [])
  await nvim.lua('require("dsh_tui").update_cmd_menu()', [])
  await nvim.lua('require("dsh_tui").submit()', [])
  hit = await waitNote('dsh-command')
  assert.equal(hit?.args?.[0], '/model', 'fully typed command executes directly')
  // plain text never opens the menu
  await nvim.lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "plain" })`, [])
  await nvim.lua('require("dsh_tui").update_cmd_menu()', [])
  menuSt = await nvim.lua('return require("dsh_tui").cmd_menu_state()', [])
  assert.equal(menuSt.open, false, 'no menu for plain text')

  // 9c. completion-menu keymaps exist on the input buffer
  const imaps = await nvim.lua(`local out = {}
    for _, m in ipairs(vim.api.nvim_buf_get_keymap(require("dsh_tui").ids().inputBuf, "i")) do
      table.insert(out, { lhs = m.lhs })
    end
    return out`, [])
  for (const key of ['<C-N>', '<C-P>', '<Tab>', '<S-Tab>', '<Esc>', '<C-V>', '<C-C>']) {
    assert.ok(imaps.some((m) => m.lhs === key), key + ' mapped on the input buffer')
  }

  // 9d. approval window — including a long wrapped reason: the key-hint row
  // must stay inside the window (previously the fixed height clipped it).
  const winsBefore = (await nvim.lua('return vim.api.nvim_list_wins()', [])).length
  await nvim.lua('require("dsh_tui").show_approval(...)', [{ toolName: 'bash', reason: '执行命令 ' + 'x'.repeat(120) }])
  let wins = await nvim.lua('return vim.api.nvim_list_wins()', [])
  assert.ok(wins.length > winsBefore, 'approval float window opened')
  let approvalF = await nvim.lua('return require("dsh_tui")._float', [])
  let approvalFCfg = await nvim.request('nvim_win_get_config', [approvalF.win])
  const approvalFLines = await nvim.request('nvim_buf_get_lines', [approvalF.buf, 0, -1, false])
  const approvalFVisual = approvalFLines.reduce((h, l) => h + Math.max(1, Math.ceil([...l].reduce((w, ch) => w + (/[\u2E80-\uA4CF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u3000-\u303F]/u.test(ch) ? 2 : 1), 0) / approvalFCfg.width)), 0)
  log('approval cfg:', JSON.stringify(approvalFCfg), 'visual rows:', approvalFVisual)
  assert.ok(approvalFCfg.height >= approvalFVisual, 'approval window height covers wrapped content (hints visible)')
  assert.ok(approvalFCfg.height > 6, 'long reason grows the approval window')
  await nvim.lua('require("dsh_tui").approval_decide("y")', [])
  hit = await waitNote('dsh-approval-decided')
  assert.equal(hit?.args?.[0], 'y', 'approval decision routed')

  // 9d. questions flow (two questions, second multi-select) — the float must
  // grow to the real content height, or the option list and the key-hint
  // footer stay clipped (window was created with a 1-line placeholder).
  await nvim.lua(`require("dsh_tui").show_questions({
    { id = "q1", question = "方向？", options = { { label = "A", description = "方案A" }, { label = "B" } } },
    { id = "q2", question = "特性？", multiSelect = true, options = { { label = "x" }, { label = "y" } } },
  })`, [])
  let qfloat = await nvim.lua('return require("dsh_tui")._float', [])
  let qcfg = await nvim.request('nvim_win_get_config', [qfloat.win])
  let qlines = await nvim.request('nvim_buf_get_lines', [qfloat.buf, 0, -1, false])
  log('questions cfg:', JSON.stringify(qcfg), 'lines:', qlines.length)
  assert.ok(qcfg.height >= qlines.length, 'questions window fits all rows incl. key hints')
  assert.ok(qlines.some((l) => l.includes('[j/k]') && l.includes('[Esc]')), 'questions footer shows key hints')
  await nvim.lua('require("dsh_tui").question_move(1)', []) // q1 → option B
  await nvim.lua('require("dsh_tui").question_advance()', []) // q1 done → q2
  await nvim.lua('require("dsh_tui").question_toggle()', []) // q2 toggle x
  await nvim.lua('require("dsh_tui").question_advance()', []) // confirm
  hit = await waitNote('dsh-questions-answered')
  const answers = hit?.args?.[0] ?? []
  log('answers:', JSON.stringify(answers))
  assert.equal(answers[0]?.selected?.[0], 'B', 'single-select answer')
  assert.deepEqual(answers[1]?.selected, ['x'], 'multi-select answer')

  // 9e. picker
  await nvim.lua(`require("dsh_tui").show_picker("选择", { { label = "m1", value = "model-a" }, { label = "m2", value = "model-b" } })`, [])
  // Interactive floats must hand over in NORMAL mode (the input window is in
  // insert mode when the command fires): <CR> selects, it must not type a
  // newline into the picker buffer.
  assert.equal((await nvim.request('nvim_get_mode', [])).mode, 'n', 'picker opens in normal mode')
  await nvim.lua('require("dsh_tui").picker_move(1)', [])
  await nvim.lua('require("dsh_tui").picker_confirm()', [])
  hit = await waitNote('dsh-picker-selected')
  assert.equal(hit?.args?.[0], 'model-b', 'picker selection routed')

  // 9f. subagent transcript view: read-only float + FeedRenderer replay
  // (方案 B: /subagents → child log replay, reasoning inline and dim).
  const svIds = await nvim.lua('return require("dsh_tui").open_subagent_view(...)', ['deepseek-code'])
  assert.ok(Number.isInteger(svIds.buf) && Number.isInteger(svIds.win), 'subagent view opens with buf+win')
  assert.equal((await nvim.request('nvim_get_mode', [])).mode, 'n', 'subagent view opens in normal mode')
  const svMaps = await nvim.lua(`local out = {}
    for _, m in ipairs(vim.api.nvim_buf_get_keymap(${svIds.buf}, "n")) do
      table.insert(out, { lhs = m.lhs, rhs = m.rhs or "" })
    end
    return out`, [])
  const svKey = (k) => svMaps.find((m) => m.lhs === k)
  assert.ok(svKey('q'), 'q closes the subagent view')
  assert.ok(svKey('<Esc>'), 'Esc closes the subagent view')
  // <Nop> maps are stored with an empty rhs.
  assert.ok(svKey('i') && svKey('i').rhs === '', 'insert key Nop (read-only)')
  assert.ok(svKey(':') && svKey(':').rhs === '', 'colon Nop (read-only)')
  const subFeed = new FeedRenderer(nvim, svIds.buf, svIds.win, {
    idsProvider: async () => nvim.lua('return require("dsh_tui").subagent_view_ids()', []),
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
  assert.ok(svLive.some((l) => l.includes('子代理思考：先查目录')), 'reasoning text streams inline while thinking')
  assert.ok(svLive.some((l) => /^·· thinking · \d+\.\d+s$/.test(l)), 'thinking header renders during streaming')
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
  assert.ok(svLines.some((l) => l.includes('子代理思考：先查目录')), 'reasoning rendered inline in subagent view')
  assert.ok(svLines.some((l) => l.startsWith('·· thinking')), 'thinking header rendered inline')
  assert.ok(svLines.some((l) => l.startsWith('🔧 bash(')), 'tool card rendered')
  assert.ok(svLines.some((l) => l.startsWith('✓ bash')), 'tool result rendered')
  assert.ok(svLines.some((l) => l.includes('子代理结论 OK')), 'assistant text rendered')
  const svReasoningMark = (await nvim.request('nvim_buf_get_extmarks', [svIds.buf, -1, 0, -1, { details: true }]))
    .filter((m) => m[3]?.hl_group === 'DshTuiReasoning')
  assert.ok(svReasoningMark.length > 0, 'reasoning header dim-marked in view')
  // Settled replays land on the first thinking block (not the transcript tail).
  const gotoRow = await nvim.lua('return require("dsh_tui").subagent_view_goto_thinking()', [])
  const svCursor = await nvim.request('nvim_win_get_cursor', [svIds.win])
  assert.equal(svCursor[0], gotoRow, 'view cursor lands on the thinking block')
  assert.ok((svLines[gotoRow - 1] ?? '').startsWith('·· thinking'), 'landing row is the thinking header')
  const idsBeforeClose = await nvim.lua('return require("dsh_tui").subagent_view_ids()', [])
  assert.ok(idsBeforeClose && idsBeforeClose.buf === svIds.buf, 'subagent_view_ids reports open view')
  await nvim.lua('require("dsh_tui").close_subagent_view()', [])
  hit = await waitNote('dsh-subagent-view-closed')
  assert.ok(hit, 'close notifies the runner (dsh-subagent-view-closed)')
  const idsAfterClose = await nvim.lua('return require("dsh_tui").subagent_view_ids()', [])
  assert.equal(idsAfterClose, null, 'view ids cleared after close')
  // Re-open after close must work (regression: the first view's buffer
  // survived the close and the second open collided on the buffer name →
  // E95, leaving the picker Enter with no visible effect).
  const svIds2 = await nvim.lua('return require("dsh_tui").open_subagent_view(...)', ['deepseek-code'])
  assert.ok(Number.isInteger(svIds2.buf) && Number.isInteger(svIds2.win), 'subagent view re-opens after close')
  assert.notEqual(svIds2.buf, svIds.buf, 're-open gets a fresh buffer')
  assert.equal(await nvim.lua('return vim.api.nvim_buf_is_valid(...)', [svIds.buf]), false, 'old view buffer wiped on close')
  await nvim.lua('require("dsh_tui").close_subagent_view()', [])
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
  await nvim.lua('require("dsh_tui").set_at_menu(...)', [[{ path: 'src/a.txt', mention: '@src/a.txt' }, { path: 'src/b.md', mention: '@src/b.md' }], 7])
  assert.ok(await nvim.lua('return require("dsh_tui").at_menu_open()', []), 'at-menu opens')
  await nvim.lua('require("dsh_tui").at_next()', [])
  await nvim.lua('require("dsh_tui").at_accept()', [])
  const atLines = await nvim.request('nvim_buf_get_lines', [ids.inputBuf, 0, -1, false])
  assert.equal(atLines[0], '请读 @src/b.md', 'at-mention accepted into input')
  await nvim.request('nvim_buf_set_lines', [ids.inputBuf, 0, -1, false, ['']])

  // 9i. directory picker: navigate to a file → dsh-dir-selected notify.
  await nvim.lua('return require("dsh_tui").show_dir_picker(...)', [process.cwd()])
  assert.equal((await nvim.request('nvim_get_mode', [])).mode, 'n', 'dir picker opens in normal mode')
  const dirState = await nvim.lua(`local M = require("dsh_tui")
    for i, e in ipairs(M._dirRows) do
      if not e.dir and e.name == "package.json" then return { idx = i } end
    end
    return { idx = 0 }`, [])
  assert.ok(dirState.idx > 0, 'package.json visible in dir picker')
  await nvim.lua(`local M = require("dsh_tui") M._dirIdx = ${dirState.idx} M.dir_enter()`, [])
  hit = await waitNote('dsh-dir-selected')
  assert.ok(hit?.args?.[0]?.endsWith('/package.json'), 'dir picker selects a file path')

  // 9j. generic lines float (workflow/settings/trajectory renderer).
  const lf = await nvim.lua('return require("dsh_tui").show_lines_float(...)', ['工作流运行', ['◈ audit · 运行中', '  ─ 阶段一']])
  const lfLines = await nvim.request('nvim_buf_get_lines', [lf.buf, 0, -1, false])
  assert.deepEqual(lfLines, ['◈ audit · 运行中', '  ─ 阶段一'], 'lines float renders rows')
  await nvim.lua('require("dsh_tui").close_lines_float()', [])

  // 9k. layout presets: panel opens the reasoning panel, default closes it
  // (no resident sessions window anymore).
  await nvim.lua('require("dsh_tui").apply_layout(...)', ['panel'])
  assert.equal((await nvim.lua('return require("dsh_tui").ids()', [])).reasoningOpen, true, 'panel layout opens reasoning panel')
  await nvim.lua('require("dsh_tui").apply_layout(...)', ['default'])
  assert.equal((await nvim.lua('return require("dsh_tui").ids()', [])).reasoningOpen, false, 'default layout closes reasoning panel')

  // 9l. bell + file tab + append_input helpers.
  assert.equal(await nvim.lua('return require("dsh_tui").bell()', []), true, 'bell emits')
  const tabCountBefore = await nvim.lua('return vim.fn.tabpagenr("$")', [])
  const okTab = await nvim.lua('return require("dsh_tui").open_file_tab(...)', [process.cwd() + '/package.json'])
  assert.equal(okTab, true, 'file tab opens')
  assert.equal(await nvim.lua('return vim.fn.tabpagenr("$")', []), tabCountBefore + 1, 'new tabpage created')
  await nvim.request('nvim_command', ['tabclose'])
  await nvim.request('nvim_buf_set_lines', [ids.inputBuf, 0, -1, false, ['hi']])
  await nvim.request('nvim_win_set_cursor', [ids.inputWin, [1, 2]])
  await nvim.lua('require("dsh_tui").append_input(...)', ['@note '])
  const appended = await nvim.request('nvim_buf_get_lines', [ids.inputBuf, 0, -1, false])
  assert.equal(appended[0], 'hi@note ', 'append_input inserts at cursor')
  await nvim.request('nvim_buf_set_lines', [ids.inputBuf, 0, -1, false, ['']])

  nvim.off('notification', onNote)

  // 10. statusline/completion opt-outs (user plugins must not take over)
  await nvim.lua('require("dsh_tui").disable_external_completion()', [])
  const opt = await nvim.lua(`local ib = require("dsh_tui").ids().inputBuf
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
  await nvim.lua('require("dsh_tui").set_statusline(...)', ['%#DshTuiStatus# TEST-LEFT %= TEST-RIGHT '])
  let sl = await nvim.lua('return vim.api.nvim_win_get_option(require("dsh_tui").ids().chatWin, "statusline")', [])
  assert.ok(sl.includes('TEST-LEFT'), 'statusline applied to chat window')
  // simulate a statusline plugin rewriting the option on WinEnter
  await nvim.lua('vim.api.nvim_win_set_option(require("dsh_tui").ids().chatWin, "statusline", "")', [])
  await nvim.lua('require("dsh_tui").reschedule_statusline()', [])
  await new Promise((r) => setTimeout(r, 80))
  sl = await nvim.lua('return vim.api.nvim_win_get_option(require("dsh_tui").ids().chatWin, "statusline")', [])
  assert.ok(sl.includes('TEST-LEFT'), 'statusline restored after plugin clobber')
  // global mini.statusline opt-out for the TUI instance
  const g = await nvim.lua('return vim.g.ministatusline_disable', [])
  assert.equal(g, true, 'global mini.statusline disable set')

  // 12. window statuslines: input styled, reasoning seamless
  const ids12 = await nvim.lua('return require("dsh_tui").ids()', [])
  const slInput = await nvim.lua('return vim.api.nvim_win_get_option(require("dsh_tui").ids().inputWin, "statusline")', [])
  assert.ok(slInput.includes('Enter 发送'), 'input window has a styled helper bar')
  assert.ok(!slInput.includes('❯'), 'prompt moved OUT of the input statusline')
  assert.ok(!slInput.includes('StatusLineNC'), 'no raw StatusLineNC block')
  // hints sit at the LEFT edge (aligned with the input box), not the far right
  assert.ok(slInput.startsWith('%#DshTuiStatus# Enter 发送'), 'hints are left-aligned (no %= right split)')
  assert.ok(!slInput.includes('%='), 'no right-alignment split in the hint bar')
  // The '❯' prompt lives in the status COLUMN: visual only, never part of
  // the submitted text, never deletable.
  const promptCol = await nvim.lua('return vim.wo[require("dsh_tui").ids().inputWin].statuscolumn', [])
  assert.ok(promptCol.includes('❯'), 'input status column carries the ❯ prompt')
  assert.equal(ids12.sessionsWin, undefined, 'no sessions window in ids (float only)')
  // Plain-content groups FOLLOW the theme's Comment (the pre-regression dim
  // tone); a bright Comment triggers the blend fallback instead.
  const dims = await nvim.lua(`local out = {}
    for _, g in ipairs({ 'DshTuiAssistant', 'DshTuiReasoning', 'DshTuiNotice', 'DshTuiDivider', 'DshTuiCmdDesc' }) do
      local hl = vim.api.nvim_get_hl(0, { name = g })
      out[g] = { fg = hl.fg, link = hl.link }
    end
    return out`, [])
  for (const g of ['DshTuiAssistant', 'DshTuiReasoning', 'DshTuiNotice', 'DshTuiDivider', 'DshTuiCmdDesc']) {
    assert.equal(dims[g].link, 'Comment', g + ' follows the theme Comment link')
  }
  const inputWinhl = await nvim.lua('return vim.wo[require("dsh_tui").ids().inputWin].winhl', [])
  assert.ok(inputWinhl.includes('Normal:DshTuiDim'), 'input window dims typed text')
  // terminal title: nvim owns the terminal and emits the OSC 2 title itself
  await nvim.lua('require("dsh_tui").set_title("测试会话")', [])
  const title = await nvim.lua('return { t = vim.o.title, ts = vim.o.titlestring }', [])
  assert.equal(title.t, true, 'nvim emits the terminal title')
  assert.ok(title.ts.includes('测试会话'), 'titlestring carries the session title')
  // layout: no dead rows — the cmdline is reclaimed and the chat sits flush
  // against the input (exactly the statusline row between them), even after
  // an input grow/shrink round-trip.
  const layoutProbe = () => nvim.lua(`local ids = require('dsh_tui').ids()
    return {
      cmdheight = vim.o.cmdheight,
      chatEnd = vim.api.nvim_win_get_position(ids.chatWin)[1] + vim.api.nvim_win_get_height(ids.chatWin),
      inputTop = vim.api.nvim_win_get_position(ids.inputWin)[1],
      inputH = vim.api.nvim_win_get_height(ids.inputWin),
    }`, [])
  const layoutBefore = await layoutProbe()
  assert.equal(layoutBefore.cmdheight, 0, 'cmdline row reclaimed')
  assert.equal(layoutBefore.inputTop - layoutBefore.chatEnd, 1, 'chat flush above the input (statusline only)')
  await nvim.lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "a", "b", "c" }); require("dsh_tui").resize_input()`, [])
  await nvim.lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "" }); require("dsh_tui").resize_input()`, [])
  const layoutAfter = await layoutProbe()
  assert.equal(layoutAfter.inputTop - layoutAfter.chatEnd, 1, 'no dead row after input grow/shrink round-trip')
  assert.equal(layoutAfter.inputH, 1, 'input back to one row after round-trip')
  const dimHl = await nvim.lua('return vim.api.nvim_get_hl(0, { name = "DshTuiDim" })', [])
  assert.equal(dimHl.link, 'Comment', 'DshTuiDim follows the theme Comment')
  // a colorscheme (re)applied late must not wash the palette back to white
  await nvim.lua('vim.cmd("colorscheme default")', [])
  await new Promise((r) => setTimeout(r, 100))
  const asstAfter = await nvim.lua('return vim.api.nvim_get_hl(0, { name = "DshTuiAssistant" })', [])
  assert.equal(asstAfter.link, 'Comment', 'palette survives colorscheme re-application')
  // the WHOLE highlight set (role links included) restores after a wipe —
  // lazy colorschemes run `hi clear` late and used to turn everything white
  await nvim.lua('vim.cmd("highlight clear"); require("dsh_tui").applyHighlights()', [])
  const afterWipe = await nvim.lua(`return {
    user = vim.api.nvim_get_hl(0, { name = "DshTuiUser" }),
    asst = vim.api.nvim_get_hl(0, { name = "DshTuiAssistant" }),
    tool = vim.api.nvim_get_hl(0, { name = "DshTuiTool" }),
  }`, [])
  assert.equal(afterWipe.user.link, 'MoreMsg', 'user-message link restored after wipe')
  assert.equal(afterWipe.tool.link, 'Special', 'tool link restored after wipe')
  assert.equal(afterWipe.asst.link, 'Comment', 'assistant dim link restored after wipe')
  // a BRIGHT Comment (white-Comment themes) falls back to the blended gray
  await nvim.lua(`vim.api.nvim_set_hl(0, 'Comment', { fg = 0xffffff })
    require("dsh_tui").applyDimPalette()`, [])
  const fallbackAsst = await nvim.lua('return vim.api.nvim_get_hl(0, { name = "DshTuiAssistant" })', [])
  assert.equal(typeof fallbackAsst.fg, 'number', 'bright Comment falls back to blended dim fg')
  assert.equal(fallbackAsst.link, undefined, 'fallback clears the Comment link')
  await nvim.lua('vim.cmd("colorscheme default")', [])
  await new Promise((r) => setTimeout(r, 100))
  // DshTuiStatus must carry an explicit background (equal to Normal's) —
  // a bold-only group would fall back to the theme's StatusLine bg (white bar).
  const st = await nvim.lua(`local n = vim.api.nvim_get_hl(0, { name = 'Normal' })
    local sl = vim.api.nvim_get_hl(0, { name = 'StatusLine' })
    local s = vim.api.nvim_get_hl(0, { name = 'DshTuiStatus' })
    return { status_bg = s.bg, normal_bg = n.bg, fg = s.fg, statusline_fg = sl.fg, bold = s.bold }`, [])
  assert.equal(st.status_bg, st.normal_bg, 'DshTuiStatus bg matches Normal bg')
  const fills = await nvim.lua(`local n = vim.api.nvim_get_hl(0, { name = 'Normal' })
    local a = vim.api.nvim_get_hl(0, { name = 'StatusLine' })
    local i = vim.api.nvim_get_hl(0, { name = 'StatusLineNC' })
    return { active = a.bg, inactive = i.bg, normal = n.bg }`, [])
  assert.equal(fills.active, fills.normal, 'StatusLine (active) fill = editor bg')
  assert.equal(fills.inactive, fills.normal, 'StatusLineNC (inactive) fill = editor bg')
  assert.equal(typeof st.fg, 'number', 'DshTuiStatus fg is a color')
  assert.equal(st.bold, true, 'DshTuiStatus keeps bold')

  // 13. theme overrides (M5)
  await nvim.lua(`require("dsh_tui").apply_theme({
    DshTuiUser = { fg = "#ff0000", bold = true },
    DshTuiTool = { link = "WarningMsg" },
  })`, [])
  const userHl = await nvim.lua('return vim.api.nvim_get_hl(0, { name = "DshTuiUser" })', [])
  assert.equal(userHl.fg, 16711680, 'theme fg applied') // 0xff0000
  assert.equal(userHl.bold, true, 'theme bold applied')
  const toolHl = await nvim.lua('return vim.api.nvim_get_hl(0, { name = "DshTuiTool" })', [])
  assert.equal(typeof toolHl.link, 'string', 'theme link applied')

  // 10a. P2: CJK typed input via nvim_input (IME path) + large-message
  // flush performance sanity.
  await nvim.lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "" })
    vim.api.nvim_set_current_win(require("dsh_tui").ids().inputWin); vim.cmd("startinsert")`, [])
  await nvim.request('nvim_input', ['中文输入测试 ime-check'])
  await new Promise((r) => setTimeout(r, 120))
  const typed = await nvim.lua('return table.concat(vim.api.nvim_buf_get_lines(require("dsh_tui").ids().inputBuf, 0, -1, false), "\\n")', [])
  assert.ok(typed.includes('中文输入测试 ime-check'), 'CJK text typed through nvim_input lands in the input buffer')
  await nvim.lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "" })`, [])

  const bigText = Array.from({ length: 400 }, (_, i) => `第 ${i} 行 · 性能压测内容 performance sanity check`).join('\n')
  const t0 = Date.now()
  feedB.applyEvent({ type: 'assistant/message', time: 7500, data: { turn: 4, step: 1, message: { content: [{ type: 'text', text: bigText }] } } })
  for (let i = 0; i < 100; i++) {
    const lines = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
    if (lines.some((l) => l.includes('第 399 行'))) break
    await new Promise((r) => setTimeout(r, 40))
  }
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 2500, `400-line message flushed in ${elapsed}ms (< 2500ms)`)
  const bigLines = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  assert.ok(bigLines.some((l) => l.includes('第 399 行')), 'large message fully rendered')

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
  assert.equal(estimateCost('deepseek-v4-pro', u).toFixed(2), '0.32', 'cost estimate')
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
  await nvim.lua(
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
  await nvim.lua(
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
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })))
  try {
    await Promise.race([
      nvim.command('qa!').catch(() => {}),
      new Promise((r) => setTimeout(r, 300)),
    ])
  } catch {}
  const exitInfo = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
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
