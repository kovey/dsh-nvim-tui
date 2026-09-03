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
import path from 'node:path'
import { spawnNvim, connectNvim } from '../lib/bridge.js'
import { FeedRenderer } from '../lib/feed.js'
import { WHALE_RENDER_ROWS, whaleFrames, WHALE_EMOJI_FRAMES, layoutWhaleRows, WHALE_ROWS } from '../lib/whale.js'
import { foldUsage, billedInput, cacheHitRate, estimateCost, formatTokens, formatElapsed, modeLabel, escapeStatusline } from '../lib/stats.js'
import { sniffMediaType, parseImageDataUrl, splitImageDataUrls, imageLabel } from '../lib/images.js'
import { diffTexts, fileDiffsFromMeta } from '../lib/diff.js'
import { t, setLocale, locale } from '../lib/i18n.js'
import { matchIntent } from '../lib/nlcmd.js'
import { ageLabel, isExpired, orderSubagentChildren } from '../lib/subagent-clean.js'
import { runningBadge } from '../lib/statusline.js'
import { readPatchRowIds, packageExists } from '../lib/deps.js'
import os from 'node:os'
import {
  parseStars, buildCatalog, searchCatalog, parsePluginYaml,
  setDisabledRows, readDisabledIds, isNpmName, depMatchesEntry, repoRoot, installSpec,
  classifyPnpmError, firstErrorLine, profileDir,
} from '../lib/market.js'

// console.* is async and its output can be swallowed by non-TTY capture
// environments once the nvim child shares the pipe; write synchronously.
const log = (...a: unknown[]) => fs.writeSync(1, a.join(' ') + '\n')

const { child, sockPath } = await spawnNvim({
  // A "user config" VimEnter autocmd registered AFTER the TUI's own (like
  // the nvim-tree auto-open template): it reads the startup buffer the way
  // such plugins do — the buffer must still be VALID inside the batch.
  extraArgs: [
    '--headless',
    '--cmd',
    'lua vim.api.nvim_create_autocmd("VimEnter", { callback = function() vim.g.smokeStartupBufValid = vim.api.nvim_buf_is_valid(1) end })',
  ],
  loadUserConfig: false,
  isolateXdg: true,
})
const nvim = await connectNvim(sockPath)

/** msgpack-RPC boundary: nvim.lua results are structurally unknown by nature. */
const lua = (code: string, args: unknown[] = []): Promise<any> => nvim.lua(code, args as never[])

// Popup operation hints: nvim >= 0.10 embeds them INTO the popup's bottom
// border (native `footer` config, like the title in the top border); older
// nvim gets the legacy detached 1-row bar below the window (M._footer.win).
const footerState = () => lua(`local f = require("dsh_tui")._footer
  local mcfg = vim.api.nvim_win_get_config(f.mainWin)
  if vim.fn.has('nvim-0.10') == 1 then
    -- footer normalizes to [text, hl] tuples: flatten to the text
    local parts = {}
    if type(mcfg.footer) == 'string' then
      parts = { mcfg.footer }
    elseif type(mcfg.footer) == 'table' then
      for _, t in ipairs(mcfg.footer) do
        table.insert(parts, type(t) == 'table' and t[1] or tostring(t))
      end
    end
    return {
      embedded = true,
      valid = vim.api.nvim_win_is_valid(f.mainWin),
      text = table.concat(parts),
      fpos = mcfg.footer_pos,
      detWin = f.win,
      mheight = mcfg.height,
    }
  end
  local fcfg = vim.api.nvim_win_get_config(f.win)
  return {
    embedded = false,
    valid = vim.api.nvim_win_is_valid(f.win),
    text = vim.api.nvim_buf_get_lines(f.buf, 0, -1, false)[1],
    frow = fcfg.row, fcol = fcfg.col, fwidth = fcfg.width, fheight = fcfg.height,
    mrow = mcfg.row, mheight = mcfg.height, mwidth = mcfg.width,
    winhighlight = vim.wo[f.win].winhighlight or "",
  }`, [])
const assertFooter = async (hintPart: string, label: string) => {
  const fs = await footerState()
  assert.ok(fs.valid, `${label}: footer attached to the popup`)
  assert.ok(String(fs.text).includes(hintPart), `${label}: footer carries the operation hints`)
  if (fs.embedded) {
    assert.equal(fs.fpos, 'left', `${label}: hints sit at the left of the bottom border`)
    assert.equal(fs.detWin ?? null, null, `${label}: no detached footer window`)
    return
  }
  assert.equal(fs.fheight, 1, `${label}: footer is one row tall`)
  assert.equal(fs.fwidth, fs.mwidth, `${label}: footer spans the main window width`)
  assert.equal(fs.frow, fs.mrow + fs.mheight + 2, `${label}: footer sits directly under the main window`)
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
  let ids!: { inputBuf?: number; chatWin?: number; inputWin?: number; reasoningOpen?: boolean; sessionsBuf?: number }
  for (let i = 0; i < 50; i++) {
    ids = await lua('return require("dsh_tui").ids()', [])
    if (Number.isInteger(ids?.inputBuf) && Number.isInteger(ids?.chatWin)) break
    await new Promise((r) => setTimeout(r, 100))
  }
  log('ids:', JSON.stringify(ids))
  assert.ok(Number.isInteger(ids.inputBuf) && Number.isInteger(ids.chatWin))
  assert.equal(ids.sessionsBuf, undefined, 'no resident sessions window anymore')

  // 1b. startup-buffer cooperation (issue #4): user VimEnter callbacks that
  // read the startup buffer (nvim-tree auto-open template) must see it VALID
  // inside the batch — takeover() defers the wipe until after the batch.
  assert.equal(await lua('return vim.g.smokeStartupBufValid', []), true,
    'startup buffer stays valid during other VimEnter callbacks (no mid-batch E5111)')
  // …and the scratch buffer IS wiped right after the batch (no leak).
  const scratchPath = path.join(path.dirname(sockPath), 'scratch')
  let scratchGone = false
  for (let i = 0; i < 30; i++) {
    if ((await lua('return vim.fn.bufexists(...)', [scratchPath])) === 0) {
      scratchGone = true
      break
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.ok(scratchGone, 'startup scratch buffer wiped after the VimEnter batch')

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
  assert.equal((await lua('return require("dsh_tui")._footer.win', [])) ?? null, null, 'footer closes with the session list')

  // active session's buffer shown in the chat window
  await lua('require("dsh_tui").set_active(...)', ['session-bbbb'])
  assert.equal(await lua('return vim.api.nvim_win_get_buf(...)', [ids.chatWin]), chatB.chatBuf)

  // 3. chat buffer must not be undoable
  assert.equal(await nvim.request('nvim_buf_get_option', [chatA.chatBuf, 'undolevels']), -1)
  // tabline hygiene: hidden unless multiple tabs; chat buffers carry names.
  assert.equal(await lua('return vim.o.showtabline', []), 0, 'tabline always hidden in the TUI')
  assert.equal(await lua('return vim.o.laststatus', []), 2, 'statuslines stay on (chat stats + input hints)')
  assert.equal(await lua('return vim.o.titlestring', []), 'dsh', 'terminal title pinned to dsh from the first frame (no scratch/[No Name] flash)')
  // Mouse hygiene: the TUI is keyboard-first — no mouse means no focus-drag
  // of the insert state into popups.
  assert.equal(await lua('return vim.o.mouse', []), '', 'mouse disabled in the TUI (insert state cannot be dragged by clicks)')
  await lua('vim.o.mouse = "a"', [])
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(await lua('return vim.o.mouse', []), '', 'mouse re-enabling is neutralized (lazy plugins cannot flip it back)')

  // 3c. window ownership: a plugin (nvim-tree select / :edit) opening a file
  // into the chat or input window gets the buffer RELOCATED into a new tab
  // (focus follows) and the TUI window is restored — plugins stay isolated.
  const fileBuf = await lua(`local b = vim.api.nvim_create_buf(true, false)
    vim.api.nvim_buf_set_lines(b, 0, -1, false, { 'line1', 'line2' })
    return b`, [])
  const tabsBefore = await lua('return vim.fn.tabpagenr("$")', [])
  await lua('vim.api.nvim_win_set_buf(require("dsh_tui").ids().inputWin, ...)', [fileBuf])
  await new Promise((r) => setTimeout(r, 300))
  const afterInput = await lua(`return {
    tabs = vim.fn.tabpagenr('$'),
    curTabBuf = vim.api.nvim_win_get_buf(0),
    inputBuf = vim.api.nvim_win_get_buf(require("dsh_tui").ids().inputWin),
  }`, [])
  assert.equal(afterInput.tabs, tabsBefore + 1, 'input hijack opens a new tab for the file')
  assert.equal(afterInput.curTabBuf, fileBuf, 'focus follows the file into the new tab')
  assert.equal(afterInput.inputBuf, ids.inputBuf, 'input window restored to the input buffer')
  await lua('vim.cmd("tabclose")', [])
  await new Promise((r) => setTimeout(r, 200))
  await lua('vim.api.nvim_win_set_buf(require("dsh_tui").ids().chatWin, ...)', [fileBuf])
  await new Promise((r) => setTimeout(r, 300))
  const afterChat = await lua(`return {
    tabs = vim.fn.tabpagenr('$'),
    curTabBuf = vim.api.nvim_win_get_buf(0),
    chatBuf = vim.api.nvim_win_get_buf(require("dsh_tui").ids().chatWin),
  }`, [])
  assert.equal(afterChat.tabs, tabsBefore + 1, 'chat hijack opens a new tab for the file')
  assert.equal(afterChat.curTabBuf, fileBuf, 'focus follows the file into the new tab (chat case)')
  assert.equal(afterChat.chatBuf, await lua('return require("dsh_tui").ids().chatBuf', []),
    'chat window restored to the active chat buffer')
  await lua('vim.cmd("tabclose")', [])
  await new Promise((r) => setTimeout(r, 200))
  // 3d. input self-heal: a wiped submit keymap is re-asserted on WinEnter.
  await lua('vim.api.nvim_buf_del_keymap(require("dsh_tui").ids().inputBuf, "i", "<CR>")', [])
  await lua('vim.api.nvim_set_current_win(require("dsh_tui").ids().chatWin)', [])
  await lua('vim.api.nvim_set_current_win(require("dsh_tui").ids().inputWin)', [])
  await new Promise((r) => setTimeout(r, 200))
  const crMap = await lua(`for _, m in ipairs(vim.api.nvim_buf_get_keymap(require("dsh_tui").ids().inputBuf, "i")) do
    if m.lhs == '<CR>' then return true end end
    return false`, [])
  assert.equal(crMap, true, 'input submit keymap self-heals on WinEnter')
  // 3e. input IDENTITY takeover: `:edit file` while the input is empty
  // renames the input buffer IN PLACE and loads the file into it (the id
  // never changes) — the guard must restore the input surface and open the
  // file in a fresh tab.
  const editTarget = path.join(process.cwd(), 'package.json')
  await lua('vim.api.nvim_set_current_win(require("dsh_tui").ids().inputWin)', [])
  await lua(`local b = require("dsh_tui").ids().inputBuf
    vim.api.nvim_buf_set_lines(b, 0, -1, false, { '' })
    vim.bo[b].modified = false`, [])
  await lua('vim.cmd("edit " .. vim.fn.fnameescape(...))', [editTarget])
  await new Promise((r) => setTimeout(r, 400))
  const afterTake = await lua(`local ids = require('dsh_tui').ids()
    return {
      tabs = vim.fn.tabpagenr('$'),
      curName = vim.api.nvim_buf_get_name(vim.api.nvim_get_current_buf()),
      inputName = vim.api.nvim_buf_get_name(ids.inputBuf),
      inputType = vim.bo[ids.inputBuf].buftype,
      winBuf = vim.api.nvim_win_get_buf(ids.inputWin),
    }`, [])
  assert.equal(afterTake.tabs, tabsBefore + 1, ':edit takeover opens the file in a new tab')
  assert.ok(afterTake.inputName === '' && afterTake.inputType === 'nofile',
    'input buffer identity restored after the takeover')
  assert.equal(afterTake.winBuf, ids.inputBuf, 'input window shows the restored input buffer')
  assert.ok(String(afterTake.curName).includes('package.json'), 'focus follows the file into the new tab')
  await lua('vim.cmd("tabclose")', [])
  await new Promise((r) => setTimeout(r, 200))
  // OptionSet guard: even a plugin forcing showtabline=2 gets snapped back.
  await lua('vim.o.showtabline = 2', [])
  assert.equal(await lua('return vim.o.showtabline', []), 0, 'showtabline changes are neutralized instantly (no flash)')
  assert.ok(String(await lua('return vim.api.nvim_buf_get_name(...)', [chatA.chatBuf])).endsWith('dsh-chat-session-aaaa'), 'chat buffer named (no [No Name] tab)')

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

  // 3b. running subagents: ONE compact activity line in the thinking slot
  // (same transient logic — never committed), cleared when the run ends.
  feedA.subagentStart({ runId: 'run-x', provider: 'deepseek-code', id: 'uuid-x' })
  await new Promise((r) => setTimeout(r, 150))
  let subLines = await nvim.request('nvim_buf_get_lines', [chatA.chatBuf, 0, -1, false])
  assert.ok(subLines.some((l: string) => /^◇ deepseek-code · \d+\.\d+s$/.test(l)),
    'subagent activity line renders in the thinking slot')
  feedA.subagentEnd({ runId: 'run-x', provider: 'deepseek-code', id: 'uuid-x', stopReason: 'completed' })
  await new Promise((r) => setTimeout(r, 150))
  subLines = await nvim.request('nvim_buf_get_lines', [chatA.chatBuf, 0, -1, false])
  assert.ok(!subLines.some((l: string) => /^◇ deepseek-code · \d+\.\d+s$/.test(l)),
    'subagent activity line vanishes after the run ends (start/end cards stay)')

  const linesA = await nvim.request('nvim_buf_get_lines', [chatA.chatBuf, 0, -1, false])
  log('chat A lines:', JSON.stringify(linesA))
  assert.ok(linesA.includes('> 你好'), 'user message rendered')
  assert.ok(linesA.some((l: string) => l.includes('Hello from nvim (full) with bold and code')), 'markup stripped in buffer')
  // Chat output is display-only: edit keys are Nop'd (i must not enter
  // insert mode, x/dd/J must not delete or join rows) — the renderer still
  // writes through the API.
  const chatKeys = await lua(`local out = {}
    for _, m in ipairs(vim.api.nvim_buf_get_keymap(${chatA.chatBuf}, "n")) do
      table.insert(out, { lhs = m.lhs, rhs = m.rhs or "" })
    end
    return out`, [])
  const chatKey = (k: string) => chatKeys.find((m: any) => m.lhs === k)
  assert.ok(chatKey('i') && chatKey('i').rhs !== 'i', 'chat i is Nop (no insert mode)')
  assert.ok(chatKey('d') && chatKey('x') && chatKey('J'), 'chat edit/join keys Nop')
  const chatLinesBefore = await nvim.request('nvim_buf_get_lines', [chatA.chatBuf, 0, -1, false])
  await lua('vim.api.nvim_set_current_win(...)', [ids.chatWin])
  await nvim.input('<Esc>') // hand over from the input window's insert mode
  assert.equal((await nvim.request('nvim_get_mode', [])).mode, 'n', 'chat window starts in normal mode')
  await nvim.input('i')
  assert.equal((await nvim.request('nvim_get_mode', [])).mode, 'n', 'chat buffer never enters insert mode')
  await nvim.input('xddJ~')
  assert.deepEqual(await nvim.request('nvim_buf_get_lines', [chatA.chatBuf, 0, -1, false]), chatLinesBefore, 'chat content cannot be deleted/joined')
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

  // 3c. bottom-pinned indicator: while a subagent runs AND the main answer
  // streams, the ◇ activity line stays the LAST buffer row — content streams
  // ABOVE it, never pushing the indicator into the middle of the chat window.
  feedA.applyEvent({ type: 'turn/start', time: 4000, data: {} })
  feedA.subagentStart({ runId: 'run-y', provider: 'deepseek-code', id: 'uuid-y' })
  feedA.applyEvent({ type: 'assistant/chunk', time: 4100, data: { chunk: { type: 'text-delta', text: '主线一\n主线二\n主线三' } } })
  await new Promise((r) => setTimeout(r, 250))
  let pinnedLines = await nvim.request('nvim_buf_get_lines', [chatA.chatBuf, 0, -1, false])
  const actIdx = pinnedLines.findIndex((l: string) => /^◇ deepseek-code · \d+\.\d+s$/.test(l))
  assert.ok(actIdx >= 0, 'subagent indicator present while the main answer streams')
  assert.equal(actIdx, pinnedLines.length - 1, 'subagent indicator pinned at the bottom of the chat view')
  feedA.subagentEnd({ runId: 'run-y', provider: 'deepseek-code', id: 'uuid-y', stopReason: 'completed' })
  feedA.applyEvent({ type: 'assistant/message', time: 4200, data: { message: { content: [{ type: 'text', text: '主线一\n主线二\n主线三' }] } } })
  feedA.applyEvent({ type: 'turn/end', time: 4300, data: {} })
  await new Promise((r) => setTimeout(r, 250))
  pinnedLines = await nvim.request('nvim_buf_get_lines', [chatA.chatBuf, 0, -1, false])
  assert.ok(!pinnedLines.some((l: string) => /^◇ deepseek-code · \d+\.\d+s$/.test(l)),
    'indicator gone after the run ends')

  // 4b. official-client parity rendering (batch 1): todo strip, compaction
  // checkpoint, retry rows, workflow-in-transcript, structured tool results.
  feedA.applyEvent({ type: 'todo/write', time: 1500, data: { todos: [
    { content: '设计 API', status: 'completed' },
    { content: '实现渲染', status: 'in_progress' },
    { content: '写测试', status: 'pending' },
  ] } })
  feedA.applyEvent({ type: 'compaction/start', time: 1600, data: { compactionId: 'c1' } })
  feedA.applyEvent({ type: 'compaction/summary', time: 1650, data: { compactionId: 'c1', shadowedSeqs: [1, 2, 3], shadowedTokenCount: 12000, summary: '前半段是环境搭建' } })
  // dsh 0.1.1-rc.2 shape: summary is ContentBlock[] (regression: the old
  // renderer called .split on it and crashed).
  feedA.applyEvent({ type: 'compaction/summary', time: 1660, data: { compactionId: 'c1b', shadowedSeqs: [4, 5], shadowedTokenCount: 3000, summary: [{ type: 'text', text: '第二段压缩摘要' }] } })
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
  assert.ok(linesA3.includes('    第二段压缩摘要'), 'compaction ContentBlock[] summary folded (0.1.1-rc.2 shape)')
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
  assert.deepEqual(matchIntent('添加任务 写单元测试'), { name: 'todo', arg: '写单元测试' }, 'add-task phrasing routes to /todo')
  assert.equal(matchIntent('状态栏不见了'), null, 'sentence containing 状态栏 goes to the agent, not /status')
  assert.equal(matchIntent('状态栏'), null, 'bare 状态栏 is chat, not /status')
  assert.deepEqual(matchIntent('状态'), { name: 'status', arg: undefined }, 'exact 状态 still routes to /status')
  assert.deepEqual(matchIntent('会话状态'), { name: 'status', arg: undefined }, 'exact 会话状态 still routes')
  assert.deepEqual(matchIntent('打开帮助面板'), { name: 'help', arg: undefined }, 'noun-phrase routing unchanged')
  assert.deepEqual(matchIntent('关于主题'), { name: 'theme', loose: true }, 'ambiguous noun match flags loose for the agent')
  assert.deepEqual(matchIntent('主题'), { name: 'theme', arg: undefined }, 'exact phrase stays instant (no loose flag)')
  assert.deepEqual(matchIntent('切换主题 深色'), { name: 'theme', arg: '深色' }, 'pattern stays instant')
  assert.deepEqual(matchIntent('待办'), { name: 'todo', arg: undefined }, '待办 routes to /todo')
  assert.deepEqual(matchIntent('任务列表'), { name: 'tasks', arg: undefined }, '任务列表 still routes to /tasks (jobs)')
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
  // subagent thought-chain TTL helpers
  const NOW = 1_800_000_000_000
  assert.equal(ageLabel(NOW - 5_000, NOW), '刚刚', 'age under a minute')
  assert.equal(ageLabel(NOW - 300_000, NOW), '5m前', 'age in minutes')
  assert.equal(ageLabel(NOW - 7_200_000, NOW), '2h前', 'age in hours')
  assert.equal(ageLabel(NOW - 3 * 86_400_000, NOW), '3d前', 'age in days')
  assert.equal(ageLabel(undefined, NOW), '', 'unknown age renders empty')
  assert.equal(isExpired(NOW - 100 * 3600 * 1000, 72, NOW), true, 'older than TTL is expired')
  assert.equal(isExpired(NOW - 3600 * 1000, 72, NOW), false, 'younger than TTL survives')
  assert.equal(isExpired(undefined, 72, NOW), false, 'unknown createdAt never expires')
  assert.equal(isExpired(NOW - 999_999_999, 0, NOW), false, 'ttl 0 disables cleanup')
  assert.equal(matchIntent('帮我清屏')?.name, 'clear', 'lead-in stripping keeps the explicit destructive command')
  // conversational variants: verbs/nouns stripped across three match levels
  assert.equal(matchIntent('打开帮助面板')?.name, 'help', '打开帮助面板 → /help')
  assert.equal(matchIntent('查看会话列表')?.name, 'sessions', '查看会话列表 → /sessions')
  assert.equal(matchIntent('显示消息队列')?.name, 'queue', '显示消息队列 → /queue')
  assert.equal(matchIntent('打开插件市场')?.name, 'market', '打开插件市场 → /market')
  assert.equal(matchIntent('请打开设置')?.name, 'settings', '请打开设置 → /settings')
  assert.equal(matchIntent('帮我切换模型 deepseek-chat')?.arg, 'deepseek-chat', '帮我切换模型 x → /model x')
  assert.equal(matchIntent('切换到 deepseek-chat 模型')?.arg, 'deepseek-chat', '切换到 x 模型 → /model x')
  assert.equal(matchIntent('open help panel')?.name, 'help', 'english lead-in + noun stripped')
  assert.equal(matchIntent('我要看下我的记忆')?.name, 'memory', '我要看下我的记忆 → /memory')
  assert.equal(matchIntent('打开设置面板改主题')?.name, 'panel', 'noun-led sentence matches the panel intent (面板 keyword)')

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

  // 6b. task step-progress block: while ANY step is incomplete the trailing
  // `- ✅/⏳/⬜ …` block renders ABOVE the thinking line (dynamic — each new
  // message replaces the live version); once every step is ✅ it falls back
  // into the ordinary tail and commits on turn end (persisted for replays).
  feedB.applyEvent({ type: 'turn/start', time: 7000, data: {} })
  feedB.applyEvent({ type: 'assistant/message', time: 7100, data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '任务全链进度（回调通知需求）:\n- ✅ 功能实现\n- ⏳ code-review\n- ⬜ 补测试' }] } } })
  feedB.applyEvent({ type: 'assistant/chunk', time: 7150, data: { chunk: { type: 'reasoning-delta', text: '推进任务' } } })
  await new Promise((r) => setTimeout(r, 250))
  let stepLines = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  const idxOf = (re: RegExp) => stepLines.findIndex((l: string) => re.test(l))
  let pHeader = idxOf(/^任务全链进度/)
  let pStep = idxOf(/^- ⏳ code-review/)
  let pThink = idxOf(/^·· thinking/)
  assert.ok(pHeader >= 0 && pStep >= 0 && pThink >= 0, 'progress block + thinking line both render')
  assert.ok(pHeader < pThink && pStep < pThink, 'incomplete progress block renders ABOVE the thinking line')
  // a later step re-emits the block, still incomplete → stays lifted
  feedB.applyEvent({ type: 'assistant/message', time: 7200, data: { turn: 2, step: 2, message: { content: [{ type: 'text', text: '任务全链进度（回调通知需求）:\n- ✅ 功能实现\n- ✅ code-review\n- ⏳ 补测试' }] } } })
  feedB.applyEvent({ type: 'assistant/chunk', time: 7250, data: { chunk: { type: 'reasoning-delta', text: '收尾' } } })
  await new Promise((r) => setTimeout(r, 250))
  stepLines = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  pHeader = idxOf(/^任务全链进度/)
  pStep = idxOf(/^- ⏳ 补测试/)
  pThink = idxOf(/^·· thinking/)
  assert.ok(pHeader >= 0 && pStep >= 0 && pThink >= 0, 'updated block + thinking line both render')
  assert.ok(pHeader < pThink, 'updated incomplete block stays ABOVE the thinking line')
  // all ✅ → ordinary tail (ABOVE the bottom-pinned indicator), committed on turn end
  feedB.applyEvent({ type: 'assistant/message', time: 7300, data: { turn: 2, step: 3, message: { content: [{ type: 'text', text: '任务全链进度（回调通知需求）:\n- ✅ 功能实现\n- ✅ code-review\n- ✅ 补测试' }] } } })
  feedB.applyEvent({ type: 'assistant/chunk', time: 7350, data: { chunk: { type: 'reasoning-delta', text: '完成' } } })
  await new Promise((r) => setTimeout(r, 250))
  stepLines = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  const cHeader = idxOf(/^任务全链进度/)
  const cThink = idxOf(/^·· thinking/)
  assert.ok(cHeader >= 0 && cThink >= 0, 'completed block + thinking line both render')
  assert.ok(cHeader < cThink, 'completed block sits in the normal tail (above the bottom-pinned indicator)')
  // the transient indicator is the LAST buffer row — content streams above it
  // and can never displace it into the middle of the chat window
  assert.equal(cThink, stepLines.length - 1, 'activity indicator pinned at the bottom of the chat view')
  feedB.applyEvent({ type: 'turn/end', time: 7400, data: {} })
  await new Promise((r) => setTimeout(r, 250))
  const persisted = await nvim.request('nvim_buf_get_lines', [chatB.chatBuf, 0, -1, false])
  assert.ok(persisted.some((l: string) => l.includes('任务全链进度'))
    && persisted.some((l: string) => l.includes('✅ 补测试')),
    'completed block commits to the chat (persisted for replays)')
  assert.ok(!persisted.some((l: string) => /⏳|⬜/.test(l)),
    'intermediate incomplete versions never land in the chat')

  // 7. <C-o> reasoning panel toggle
  const opened = await lua('return require("dsh_tui").toggle_reasoning()', [])
  assert.equal(opened, true, 'panel opens')
  let idsT = await lua('return require("dsh_tui").ids()', [])
  assert.ok(Number.isInteger(idsT.reasoningWin), 'reasoning window exists')
  assert.equal(idsT.reasoningOpen, true)
  assert.equal(await lua('return vim.api.nvim_win_get_buf(...)', [idsT.reasoningWin]), reasonB.reasoningBuf,
    'panel shows active session reasoning')
  // popup panel: editor-relative float hugging the RIGHT edge (chat keeps
  // its full width), below menus/approvals in z-order
  const panelCfg = await nvim.request('nvim_win_get_config', [idsT.reasoningWin])
  assert.equal(panelCfg.relative, 'editor', 'reasoning panel is a float')
  assert.equal(panelCfg.anchor, 'NE', 'panel anchors to the top-right')
  assert.equal(panelCfg.col, (await lua('return vim.o.columns', [])) - 1, 'panel right edge sits at the screen edge')
  assert.ok(panelCfg.width >= 30 && panelCfg.width <= 52, 'panel width clamped')
  assert.ok(panelCfg.zindex < 50, 'panel sits below menus/approvals')
  assert.ok(String(panelCfg.title).includes('思考'), 'panel carries a title')
  if (await lua('return vim.fn.has("nvim-0.10") == 1', [])) {
    assert.ok(JSON.stringify(panelCfg.footer).includes('C-o'), 'panel bottom border carries the operation hints')
  }
  const chatWBefore = await lua('return vim.api.nvim_win_get_width(require("dsh_tui").ids().chatWin)', [])
  assert.equal(await lua('return vim.api.nvim_win_get_width(require("dsh_tui").ids().chatWin)', []), chatWBefore,
    'chat keeps its full width while the panel is open')
  // the panel spans 3/4 of the screen height (a panel, not a full column)
  const lines0 = await lua('return vim.o.lines', [])
  assert.equal(panelCfg.height, Math.max(3, Math.floor(lines0 * 0.75)), 'panel spans 3/4 of the screen height')
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
  const footerEmbedded = await lua('return vim.fn.has("nvim-0.10") == 1', [])
  assert.equal(skillWins, baseWins + (footerEmbedded ? 1 : 2), 'skill float opened (footer embedded in border on nvim 0.10+)')
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
  const floatTitle = (win: number) => nvim.request('nvim_win_get_config', [win]).then((c: any) => c.title ?? '')

  const waitNote = async (method: string, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const idx = notes.findIndex((n) => n.method === method)
      if (idx >= 0) return notes.splice(idx, 1)[0]
      await new Promise((r) => setTimeout(r, 20))
    }
    return null
  }
  const drainNotes = (method: string) => {
    for (let i = notes.length - 1; i >= 0; i--) {
      if (notes[i].method === method) notes.splice(i, 1)
    }
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
  // file-change diff block renders in the chat with whole-line groups
  feedA.pushDiff('✎ 修改 src/x.ts (+1 −1)', ['- old line', '+ new line', '  ctx'])
  await new Promise((r) => setTimeout(r, 200))
  const diffLines = await nvim.request('nvim_buf_get_lines', [chatA.chatBuf, 0, -1, false])
  assert.ok(diffLines.includes('✎ 修改 src/x.ts (+1 −1)'), 'diff header rendered in chat')
  assert.ok(diffLines.includes('+ new line'), 'diff added line rendered')
  assert.ok(diffLines.includes('- old line'), 'diff removed line rendered')
  const diffMarks: any[] = await nvim.request('nvim_buf_get_extmarks', [chatA.chatBuf, -1, 0, -1, { details: true }])
  const diffGroups = new Set(diffMarks.map((m) => m[3]?.hl_group))
  assert.ok(diffGroups.has('DshTuiDiffAdd') && diffGroups.has('DshTuiDiffDel'),
    'diff lines carry add/del highlight groups')
  // regression: a diff CONTEXT line holding a fence marker (`  ```` from a code
  // block inside an edited file) must NOT toggle the view's fence state —
  // everything after the card stays plain, never sky-blue DshTuiCode
  feedA.pushDiff('✎ 修改 README.md (+1 −1)', ['+ new line', '  ```', '- old line'])
  feedA.applyEvent({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '围栏之后的普通文本\n' } } })
  await new Promise((r) => setTimeout(r, 250))
  const afterFenceLines = await nvim.request('nvim_buf_get_lines', [chatA.chatBuf, 0, -1, false])
  const afterFenceRow = afterFenceLines.indexOf('围栏之后的普通文本')
  assert.ok(afterFenceRow >= 0, 'text after a fence-marker context line renders')
  const afterFenceMarks: any[] = await nvim.request('nvim_buf_get_extmarks', [chatA.chatBuf, -1, 0, -1, { details: true }])
  const codeOnRow = afterFenceMarks.filter((m) => m[1] === afterFenceRow && m[3]?.hl_group === 'DshTuiCode')
  assert.equal(codeOnRow.length, 0, 'fence marker inside diff context must not leak code color below the card')
  // transient activity rows never commit: an echo under a live '·· thinking…'
  // line must not stack a second thinking row into the chat
  feedA.applyEvent({ type: 'turn/start', data: {} })
  await new Promise((r) => setTimeout(r, 950))
  feedA.pushUser('正在思考时发的新问题', []) // the optimistic echo
  await new Promise((r) => setTimeout(r, 200))
  feedA.applyEvent({ type: 'turn/end', data: {} })
  await new Promise((r) => setTimeout(r, 250))
  const echoLines = await nvim.request('nvim_buf_get_lines', [chatA.chatBuf, 0, -1, false])
  const thinkingCount = echoLines.filter((l: string) => l.startsWith('·· thinking')).length
  assert.ok(thinkingCount <= 1, 'no stacked thinking rows after an echo under a live turn')
  assert.ok(echoLines.includes('> 正在思考时发的新问题'), 'echoed bubble rendered')
  const userMarks: any[] = await nvim.request('nvim_buf_get_extmarks', [chatA.chatBuf, -1, 0, -1, { details: true }])
  const userRow = echoLines.indexOf('> 正在思考时发的新问题')
  const userRowHl = userMarks.find((m) => m[1] === userRow && m[3]?.hl_group === 'DshTuiUser')
  assert.ok(userRowHl !== undefined, 'echoed user bubble carries the DshTuiUser color group')
  // host-injected context (non-'user' source) must NOT masquerade as user
  // input: notice form collapses to a dim one-liner, other forms render
  // dimmed — and the kind union is merge-extensible (skill-catalog etc.)
  feedA.applyEvent({ type: 'user/message', data: { content: [{ type: 'text', text: '短通知内容' }], source: { kind: 'plugin', form: 'notice', summary: '策略快照已更新' } } })
  feedA.applyEvent({ type: 'user/message', data: { content: [{ type: 'text', text: 'runtime context line1\nruntime context line2' }], source: { kind: 'plugin', form: 'snapshot' } } })
  feedA.applyEvent({ type: 'user/message', data: { content: [{ type: 'text', text: 'skills catalog body' }], source: { kind: 'skill-catalog', form: 'catalog' } } })
  await new Promise((r) => setTimeout(r, 250))
  const injectedLines = await nvim.request('nvim_buf_get_lines', [chatA.chatBuf, 0, -1, false])
  assert.ok(injectedLines.includes('· 策略快照已更新'), 'plugin notice form renders as a collapsed dim summary')
  assert.ok(injectedLines.includes('· 注入上下文'), 'plugin snapshot form renders under a context header')
  assert.ok(injectedLines.includes('· runtime context line1'), 'plugin snapshot content renders dimmed')
  assert.ok(injectedLines.includes('· skills catalog body'), 'merge-extensible kinds (skill-catalog) render dimmed too')
  assert.ok(!injectedLines.includes('> runtime context line1'), 'injected context never renders as a user bubble')
  assert.ok(!injectedLines.includes('> 策略快照已更新'), 'injected notice never renders as a user bubble')
  const injectedMarks: any[] = await nvim.request('nvim_buf_get_extmarks', [chatA.chatBuf, -1, 0, -1, { details: true }])
  const ctxRow = injectedLines.indexOf('· runtime context line1')
  const userOnCtx = injectedMarks.filter((m) => m[1] === ctxRow && m[3]?.hl_group === 'DshTuiUser')
  assert.equal(userOnCtx.length, 0, 'injected context rows carry no DshTuiUser color')
  // child→parent traffic (alpha.4 bidirectional messaging): subagent sources
  // keep their identity — a ◇ header in the subagent color + dim content rows
  feedA.applyEvent({ type: 'user/message', data: { content: [{ type: 'text', text: '我改好了 src/x.ts，加了一个函数' }], source: { kind: 'agent-message', senderSessionId: 'child-session-12345678' } } })
  feedA.applyEvent({ type: 'user/message', data: { content: [{ type: 'text', text: 'Background subagent child-1 finished.\nIts closing message:\n已完成修改' }], source: { kind: 'subagent-settled', form: 'notice', summary: 'Background subagent child-1 finished.', senderSessionId: 'child-1' } } })
  // fence safety: a child message carrying a fence marker must be prefix-
  // neutralized ('· ```') — it can never toggle the view fence state
  feedA.applyEvent({ type: 'user/message', data: { content: [{ type: 'text', text: '看这段：\n```\n不会被当成围栏\n' }], source: { kind: 'agent-message', senderSessionId: 'child-fence' } } })
  feedA.applyEvent({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '围栏之后仍是普通文本\n' } } })
  await new Promise((r) => setTimeout(r, 250))
  const childLines = await nvim.request('nvim_buf_get_lines', [chatA.chatBuf, 0, -1, false])
  assert.ok(childLines.includes('◇ 子代理 child-se → 本会话'), 'child agent-message renders a subagent header')
  assert.ok(childLines.includes('· 我改好了 src/x.ts，加了一个函数'), 'child message content renders dimmed under the header')
  assert.ok(childLines.includes('◇ 子代理已结束 · Background subagent child-1 finished.'), 'settlement notice renders a subagent summary row')
  assert.ok(childLines.includes('· 已完成修改'), 'settlement closing message renders dimmed (summary first line deduped)')
  assert.equal(childLines.filter((l: string) => l === '· Background subagent child-1 finished.').length, 0, 'settlement summary renders once (no duplicated content line)')
  assert.ok(childLines.includes('· 不会被当成围栏'), 'child fence line renders as dim content, never a fence marker')
  assert.ok(childLines.includes('· ```'), 'child fence marker keeps its visible but neutralized form')
  const childMarks: any[] = await nvim.request('nvim_buf_get_extmarks', [chatA.chatBuf, -1, 0, -1, { details: true }])
  const childHeaderRow = childLines.indexOf('◇ 子代理 child-se → 本会话')
  const subOnHeader = childMarks.filter((m) => m[1] === childHeaderRow && m[3]?.hl_group === 'DshTuiSubagent')
  assert.ok(subOnHeader.length > 0, 'child message header carries the DshTuiSubagent highlight')
  const userOnChild = childMarks.filter((m) => m[1] === childHeaderRow && m[3]?.hl_group === 'DshTuiUser')
  assert.equal(userOnChild.length, 0, 'child message rows never carry DshTuiUser')
  const afterFenceTextRow = childLines.indexOf('围栏之后仍是普通文本')
  const codeOnAfter = childMarks.filter((m) => m[1] === afterFenceTextRow && m[3]?.hl_group === 'DshTuiCode')
  assert.equal(codeOnAfter.length, 0, 'child fence line must not leak code color below the block')
  // an interrupted turn commits its prefix + a visible marker
  feedA.applyEvent({ type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '被打断的前缀' }] }, interrupted: true } })
  await new Promise((r) => setTimeout(r, 250))
  const interruptedLines = await nvim.request('nvim_buf_get_lines', [chatA.chatBuf, 0, -1, false])
  assert.ok(interruptedLines.includes('⚠ 回合被中断'), 'interrupted turn renders a visible marker')
  // stray '- ' bullets in ordinary content must NOT render as diff rows
  const bulletStart = await nvim.request('nvim_buf_line_count', [chatA.chatBuf])
  feedA.applyEvent({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '要点如下：\n- 第一点\n- 第二点\n+ 并不是 diff 的行\n' } } })
  await new Promise((r) => setTimeout(r, 250))
  const bulletMarks: any[] = await nvim.request('nvim_buf_get_extmarks', [chatA.chatBuf, -1, 0, -1, { details: true }])
  const diffStyled = bulletMarks.filter((m) => m[1] >= bulletStart - 1 &&
    (m[3]?.hl_group === 'DshTuiDiffAdd' || m[3]?.hl_group === 'DshTuiDiffDel'))
  assert.equal(diffStyled.length, 0, 'plain +/- bullets outside a diff region get no diff styling')
  // diff blocks always render in the CHAT — even when the session has a
  // reasoning panel buffer (the panel stays the compact activity log)
  const rbuf = await lua('return require("dsh_tui").ensure_reasoning(...)', ['session-aaaa'])
  const freshChatBuf = await lua('return vim.api.nvim_create_buf(false, true)', [])
  const panelFeed = new FeedRenderer(nvim, freshChatBuf, chatA.chatWin, { reasoningBuf: rbuf.reasoningBuf })
  panelFeed.pushDiff('✎ 修改 src/y.ts (+1 −0)', ['+ only added'])
  await new Promise((r) => setTimeout(r, 300))
  const chatAfterPanel = await nvim.request('nvim_buf_get_lines', [freshChatBuf, 0, -1, false])
  assert.ok(chatAfterPanel.includes('✎ 修改 src/y.ts (+1 −0)'), 'diff renders into the chat even with a panel buffer')
  const panelAfterPanel = await nvim.request('nvim_buf_get_lines', [rbuf.reasoningBuf, 0, -1, false])
  assert.ok(!panelAfterPanel.includes('✎ 修改 src/y.ts (+1 −0)'), 'diff stays out of the reasoning panel')
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

  // 9f3. subagent CHAT window: transcript float + editable input row — the
  // user chats with a continuable child like with the main agent (Enter
  // sends through 'dsh-subagent-send', the transcript streams into the
  // upper feed).
  const scIds = await lua('return require("dsh_tui").open_subagent_chat(...)', ['audit-child'])
  assert.ok(Number.isInteger(scIds.buf) && Number.isInteger(scIds.win) &&
    Number.isInteger(scIds.inputBuf) && Number.isInteger(scIds.inputWin),
  'chat opens with transcript + input ids')
  // The chat input lands in insert mode; window/autocmd settling may take a
  // tick or two in headless (WinEnter/InsertEnter handlers), so poll briefly.
  let chatMode = (await nvim.request('nvim_get_mode', [])).mode
  for (let i = 0; i < 20 && chatMode !== 'i'; i++) {
    await new Promise((r) => setTimeout(r, 50))
    chatMode = (await nvim.request('nvim_get_mode', [])).mode
  }
  assert.equal(chatMode, 'i', 'chat input opens in insert mode')
  // The input float sits directly under the transcript float (same col/width),
  // carries its own rounded border (one continuous framed chat box), and the
  // operation hints live in the INPUT's bottom border.
  const scCfg = await nvim.request('nvim_win_get_config', [scIds.win])
  const scICfg = await nvim.request('nvim_win_get_config', [scIds.inputWin])
  assert.equal(scICfg.row, scCfg.row + scCfg.height + 2, 'input float sits right below the transcript')
  assert.equal(scICfg.col, scCfg.col, 'input float aligns with the transcript column')
  assert.equal(scICfg.width, scCfg.width, 'input float spans the transcript width')
  assert.notEqual(scICfg.border, 'none', 'input float carries a rounded border')
  assert.notEqual(scCfg.border, 'none', 'transcript float carries a rounded border')
  if (await lua('return vim.fn.has("nvim-0.10") == 1', [])) {
    assert.ok(String(scICfg.footer).includes('Enter'), 'input bottom border carries the send hints')
  }
  const scInputMaps = await lua(`local out = {}
    for _, m in ipairs(vim.api.nvim_buf_get_keymap(${scIds.inputBuf}, "i")) do
      table.insert(out, { lhs = m.lhs, rhs = m.rhs or "" })
    end
    return out`, [])
  const scKey = (k: string) => scInputMaps.find((m: any) => m.lhs === k)
  assert.ok(scKey('<CR>') && String(scKey('<CR>').rhs).includes('subagent_chat_submit'), 'Enter submits the chat input')
  assert.ok(scKey('<Esc>') && String(scKey('<Esc>').rhs).includes('close_subagent_chat'), 'Esc closes the chat window')
  assert.ok(scKey('<C-CR>'), 'C-CR inserts a literal newline')
  assert.ok(scKey('<Up>') && scKey('<Down>'), 'Up/Down history keys mapped')
  // The runner's FeedRenderer writes the child transcript into the upper buf.
  const scFeed = new FeedRenderer(nvim, scIds.buf, scIds.win, {
    idsProvider: async () => lua('return require("dsh_tui").subagent_chat_ids()', []),
    activeChecker: () => true,
    reasoningBuf: null,
    reasoningView: () => null,
    inlineReasoning: true,
  })
  scFeed.applyEvent({ type: 'turn/start', time: 2000, data: {} })
  scFeed.applyEvent({ type: 'assistant/chunk', time: 2100, data: { chunk: { type: 'text-delta', text: '子代理回复内容' } } })
  scFeed.applyEvent({ type: 'turn/end', time: 2200, data: {} })
  await scFeed.flush()
  const scLines = await nvim.request('nvim_buf_get_lines', [scIds.buf, 0, -1, false])
  assert.ok(scLines.some((l: string) => l.includes('子代理回复内容')), 'child transcript renders into the chat window')
  const scIdsLive = await lua('return require("dsh_tui").subagent_chat_ids()', [])
  assert.ok(scIdsLive && scIdsLive.buf === scIds.buf, 'subagent_chat_ids reports the open window')
  // Submit routes the text to the runner as 'dsh-subagent-send'.
  await lua('vim.api.nvim_buf_set_lines(...)', [scIds.inputBuf, 0, -1, false, ['帮我再检查一遍']])
  await lua('require("dsh_tui").subagent_chat_submit()', [])
  hit = await waitNote('dsh-subagent-send')
  assert.equal(hit?.args?.[0], '帮我再检查一遍', 'submit routes the text to the runner')
  assert.deepEqual(await nvim.request('nvim_buf_get_lines', [scIds.inputBuf, 0, -1, false]), [''], 'chat input resets after submit')
  // Multi-line input grows the input float and shrinks the transcript so
  // the composite block keeps one constant footprint.
  const chatH1 = await lua('return vim.api.nvim_win_get_height(require("dsh_tui")._subagentChat.win)', [])
  await lua('vim.api.nvim_buf_set_lines(...)', [scIds.inputBuf, 0, -1, false, ['第一行', '第二行', '第三行']])
  await lua('require("dsh_tui").subagent_chat_resize()', [])
  assert.equal(await lua('return vim.api.nvim_win_get_height(require("dsh_tui")._subagentChat.inputWin)', []), 3, 'input float grows to 3 rows')
  const chatH3 = await lua('return vim.api.nvim_win_get_height(require("dsh_tui")._subagentChat.win)', [])
  assert.equal(chatH3 + 3, chatH1 + 1, 'composite footprint stays constant (transcript shrinks by the input growth)')
  // Close: windows close, buffers wipe, the runner is notified.
  await lua('require("dsh_tui").close_subagent_chat()', [])
  hit = await waitNote('dsh-subagent-chat-closed')
  assert.ok(hit, 'close notifies the runner (dsh-subagent-chat-closed)')
  assert.equal(await lua('return require("dsh_tui").subagent_chat_ids()', []), null, 'chat ids cleared after close')
  assert.equal(await lua('return vim.api.nvim_buf_is_valid(...)', [scIds.buf]), false, 'transcript buffer wiped on close')
  assert.equal(await lua('return vim.api.nvim_buf_is_valid(...)', [scIds.inputBuf]), false, 'input buffer wiped on close')
  // Mutual exclusion with the read-only view (one float family at a time).
  await lua('require("dsh_tui").open_subagent_chat(...)', ['audit-child'])
  await lua('require("dsh_tui").open_subagent_view(...)', ['deepseek-code'])
  assert.equal(await lua('return require("dsh_tui").subagent_chat_ids()', []), null, 'opening the view closes the chat window')
  await lua('require("dsh_tui").open_subagent_chat(...)', ['audit-child'])
  assert.equal(await lua('return require("dsh_tui").subagent_view_ids()', []), null, 'opening the chat closes the view')
  await lua('require("dsh_tui").close_subagent_chat()', [])
  await waitNote('dsh-subagent-chat-closed')

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

  // 9g1. running badge: background jobs keep a live-looking statusline
  // when the agent is idle (a bare '○ idle' made users think the task died).
  assert.equal(runningBadge(true, 0, 0), '● running', 'main turn badge')
  assert.equal(runningBadge(false, 2, 0), '● running ◇2', 'subagents badge')
  assert.equal(runningBadge(false, 0, 3), '🔧 后台 3', 'background jobs keep a running badge')
  assert.equal(runningBadge(false, 0, 0), null, 'nothing running → idle')

  // 9g2. /deps helpers: patch-row parsing (comments ignored) + package probe.
  const depsPatch = path.join(os.tmpdir(), `deps-patch-${process.pid}.yml`)
  fs.writeFileSync(depsPatch, [
    '# 注释里的 id: feishu 行不能算结构行',
    '- insert:',
    '    - id: agent-presets',
    "      name: '@deepseek-ai/dsh-agent-presets'",
    '# - id: commented-out',
    '- id: session-query-sqlite',
    '  config:',
    '    openAt: first-search',
    '',
  ].join('\n'))
  const patchIds = readPatchRowIds(depsPatch)
  assert.ok(patchIds.has('agent-presets'), 'insert row id parsed')
  assert.ok(patchIds.has('session-query-sqlite'), 'override row id parsed')
  assert.ok(!patchIds.has('feishu'), 'comment mentions are not rows')
  assert.ok(!patchIds.has('commented-out'), 'commented rows are not rows')
  fs.unlinkSync(depsPatch)
  const installProbe = process.env.DSH_NVIM_TUI_INSTALL_ROOT ??
    [path.join(os.homedir(), '.nvm', 'versions', `node/${process.versions.node}`, 'lib', 'node_modules', '@deepseek-ai')]
      .find((p) => fs.existsSync(p))
  if (installProbe !== undefined) {
    process.env.DSH_NVIM_TUI_INSTALL_ROOT = path.dirname(path.dirname(installProbe))
    assert.equal(packageExists('@deepseek-ai/dsh-workspace', 'package.json'), true, 'installed package detected')
    assert.equal(packageExists('@deepseek-ai/dsh-not-a-real-package', 'package.json'), false, 'absent package rejected')
  } else {
    log('skip packageExists probes (no dsh install found)')
  }
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

  // 9g2. file-change diff blocks: LCS hunks, add/del-only, caps, i18n labels
  const editDiff = diffTexts('a\nb\nc\nd', 'a\nB\nc\nd')
  assert.equal(editDiff.stats.added, 1, 'diff counts the added line')
  assert.equal(editDiff.stats.removed, 1, 'diff counts the removed line')
  assert.ok(editDiff.lines.includes('- b'), 'removed line rendered with −')
  assert.ok(editDiff.lines.includes('+ B'), 'added line rendered with +')
  assert.ok(editDiff.lines.includes('  a'), 'context line kept above the change')
  const addDiff = diffTexts(null, 'x\ny')
  assert.equal(addDiff.stats.added, 2, 'new file = all additions')
  assert.ok(addDiff.lines.includes('+ y'), 'new-file lines rendered')
  const delDiff = diffTexts('x\ny', null)
  assert.equal(delDiff.stats.removed, 2, 'deleted file = all removals')
  assert.equal(diffTexts('x', 'x').lines.length, 0, 'identical content renders nothing')
  const bigDiff = diffTexts(null, Array.from({ length: 100 }, (_, i) => 'line' + i).join('\n'))
  assert.ok(bigDiff.truncated, 'oversized block truncates')
  assert.ok(bigDiff.lines.some((l: string) => l.includes('省略')), 'truncation notice shown')
  const metaDiffs = fileDiffsFromMeta({ diffs: [{ path: 'src/a.ts', oldText: 'x', newText: 'y' }, { path: 'src/b.ts', oldText: 'z', newText: 'z' }, { bogus: true }] })
  assert.equal(metaDiffs?.length, 2, 'meta diffs parsed (unchanged + malformed dropped)')
  assert.equal(metaDiffs?.[0]?.path, 'src/a.ts', 'meta diff carries the path')
  assert.equal(fileDiffsFromMeta(undefined), null, 'no meta → null')
  assert.equal(fileDiffsFromMeta({ diffs: [] }), null, 'empty diffs → null')
  const midEdit = diffTexts(Array.from({ length: 50 }, (_, i) => 'l' + i).join('\n'),
    Array.from({ length: 50 }, (_, i) => (i === 25 ? 'changed' : 'l' + i)).join('\n'))
  assert.ok(midEdit.lines.includes('+ changed'), 'middle-of-file edit found')
  assert.ok(midEdit.lines.length < 50, 'distant context trimmed (no whole-file echo)')
  // A single hunk LARGER than the cap must still render its head with real
  // stats — an empty +0 −0 block gets the whole card dropped by the runner
  // (the hidden bug that made some diffs disappear entirely).
  const giantEdit = diffTexts(
    Array.from({ length: 60 }, (_, i) => 'old' + i).join('\n'),
    Array.from({ length: 60 }, (_, i) => 'new' + i).join('\n'))
  assert.ok(giantEdit.truncated, 'giant single-hunk diff truncates')
  assert.ok(giantEdit.lines.length >= 4, 'giant hunk still renders its head')
  assert.ok(giantEdit.stats.added + giantEdit.stats.removed > 0,
    'giant hunk reports real stats (never +0 −0 with content)')
  assert.ok(giantEdit.lines.some((l: string) => l.startsWith('- old')), 'giant hunk head keeps − rows')
  assert.ok(giantEdit.lines.some((l: string) => l.includes('省略')), 'giant hunk shows the omission notice')
  const prev = locale()
  setLocale('en')
  assert.equal(t('修改'), 'Modified', 'diff action label translated')
  setLocale(prev)
  // /subagents ordering: running children first, then newest-first
  const ordered = orderSubagentChildren([
    { id: 'old1', running: false, createdAt: 100 },
    { id: 'run2', running: true, createdAt: 200 },
    { id: 'run1', running: true, createdAt: 100 },
    { id: 'new1', running: false, createdAt: 300 },
  ])
  assert.deepEqual(ordered.map((c) => c.id), ['run2', 'run1', 'new1', 'old1'],
    'running subagents first, newest-first within groups')

  // 9h. @-file-reference menu: accept replaces the token in the input line.
  // Detection must fire at the line START too (首位 @) — the %A guard had no
  // preceding character to match there and the menu never opened.
  drainNotes('dsh-at-query')
  await nvim.request('nvim_win_set_cursor', [ids.inputWin, [1, 3]])
  await nvim.request('nvim_buf_set_lines', [ids.inputBuf, 0, -1, false, ['@fi']])
  await lua('require("dsh_tui").update_at_menu()', [])
  hit = await waitNote('dsh-at-query')
  assert.equal((hit?.args?.[0] as { query?: string })?.query, 'fi', 'line-start @token detected')
  assert.equal((hit?.args?.[0] as { start?: number })?.start, 0, 'line-start @token offset is 0')
  drainNotes('dsh-at-query')
  await nvim.request('nvim_win_set_cursor', [ids.inputWin, [1, 10]])
  await nvim.request('nvim_buf_set_lines', [ids.inputBuf, 0, -1, false, ['请读 @fi']])
  await nvim.request('nvim_win_set_cursor', [ids.inputWin, [1, 10]])
  await lua('require("dsh_tui").update_at_menu()', [])
  hit = await waitNote('dsh-at-query')
  assert.equal((hit?.args?.[0] as { query?: string })?.query, 'fi', 'mid-line @token detected')
  assert.equal((hit?.args?.[0] as { start?: number })?.start, 7, 'mid-line @token offset is the @ byte column')
  await lua('require("dsh_tui").set_at_menu(...)', [[{ path: 'src/a.txt', mention: '@src/a.txt' }, { path: 'src/b.md', mention: '@src/b.md' }], 7])
  assert.ok(await lua('return require("dsh_tui").at_menu_open()', []), 'at-menu opens')
  await lua('require("dsh_tui").at_next()', [])
  await lua('require("dsh_tui").at_accept()', [])
  const atLines = await nvim.request('nvim_buf_get_lines', [ids.inputBuf, 0, -1, false])
  assert.equal(atLines[0], '请读 @src/b.md', 'at-mention accepted into input')
  // navigation keys route to the OPEN at-menu (C-n / C-p / Up / Down) — the
  // same menu-first claim as the /-command menu; without it the keys fall
  // into history cycling and the menu can never change its selection
  await nvim.request('nvim_buf_set_lines', [ids.inputBuf, 0, -1, false, ['@']])
  await nvim.request('nvim_win_set_cursor', [ids.inputWin, [1, 1]])
  await lua('require("dsh_tui").set_at_menu(...)', [[{ path: 'src/a.txt', mention: '@src/a.txt' }, { path: 'src/b.md', mention: '@src/b.md' }, { path: 'src/c.ts', mention: '@src/c.ts' }], 1])
  await lua(`vim.api.nvim_set_current_win(require("dsh_tui").ids().inputWin); vim.cmd('startinsert')`, [])
  await nvim.input('<C-n>')
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(await lua('return require("dsh_tui")._atIdx', []), 2, '<C-n> advances the at-menu selection')
  await nvim.input('<Down>')
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(await lua('return require("dsh_tui")._atIdx', []), 3, '<Down> advances the at-menu selection')
  await nvim.input('<Up>')
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(await lua('return require("dsh_tui")._atIdx', []), 2, '<Up> moves the at-menu selection back')
  await nvim.input('<C-p>')
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(await lua('return require("dsh_tui")._atIdx', []), 1, '<C-p> moves the at-menu selection back')
  assert.ok(await lua('return require("dsh_tui").at_menu_open()', []), 'at-menu stays open through navigation')
  await lua('require("dsh_tui").close_at_menu()', [])
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

  // 9k3. fill_input: /help popup's Enter logic — write the command into the
  // input box and hand back in insert mode (second Enter executes it).
  await lua('require("dsh_tui").fill_input(...)', ['/sessions '])
  assert.equal(await lua('return vim.api.nvim_buf_get_lines(require("dsh_tui").ids().inputBuf, 0, -1, false)[1]', []), '/sessions ', 'fill_input writes the picked command')
  let fillMode = ''
  for (let i = 0; i < 40; i++) {
    fillMode = (await nvim.request('nvim_get_mode', [])).mode
    if (fillMode === 'i') break
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.equal(fillMode, 'i', 'fill_input hands back in insert mode')
  await lua('require("dsh_tui").fill_input(...)', [''])

  // 9k4. blue whale art (A+B): centered wallpaper while empty, bottom
  // watermark once content exists; /whale toggle removes it.
  assert.equal(WHALE_RENDER_ROWS.length, 8, 'whale pixel art has 8 text rows')
  assert.ok(WHALE_RENDER_ROWS.some((r) => r.text.includes('▀') && r.spans.length > 0), 'whale art renders half-block glyphs with color spans')

  const frames = whaleFrames()
  assert.equal(frames.length, 4, 'whale animation has a 4-frame cycle')
  assert.ok(frames.every((f) => f.length === 8), 'every animation frame renders 8 rows')
  assert.notDeepEqual(frames[0], frames[1], 'frame 1 differs (both eyes open + bubbles up)')
  assert.notDeepEqual(frames[2], frames[1], 'frame 2 differs (right wink + bob)')
  assert.equal(WHALE_EMOJI_FRAMES.length, 2, 'emoji watermark cycles the spouting whale + bubble')
  assert.ok(WHALE_EMOJI_FRAMES.every((f) => f.endsWith('🐳')), 'every frame carries the spouting whale emoji')
  assert.ok(WHALE_EMOJI_FRAMES.some((f) => f.includes('🫧')), 'bubble frame leads the cycle')
  const laid = layoutWhaleRows(30, 100)
  assert.ok(laid !== null && laid.length === WHALE_ROWS + Math.floor((30 - WHALE_ROWS) / 2), 'whale layout pads the top for vertical centering')
  assert.equal(laid[0].text, '', 'vertical centering pads the top')
  assert.equal(layoutWhaleRows(3, 20), null, 'tiny window skips the art')
  const whaleBuf = await nvim.request('nvim_create_buf', [false, true])
  const whaleFeed = new FeedRenderer(nvim, whaleBuf, ids.chatWin!, {
    idsProvider: async () => ({ win: ids.chatWin }),
    activeChecker: () => true,
    whale: true,
  })
  await whaleFeed.flush()
  let heroLines = await nvim.request('nvim_buf_get_lines', [whaleBuf, 0, -1, false])
  assert.ok(heroLines.some((l: string) => l.includes('▀')), 'empty state shows the whale wallpaper (half-block body)')
  assert.ok(heroLines.some((l: string) => l.includes('█')), 'whale body rendered')
  const whaleMarks = await nvim.request('nvim_buf_get_extmarks', [whaleBuf, -1, 0, -1, { details: true }])
  const whaleGroups = new Set((whaleMarks as any[]).map((m) => (Array.isArray(m) ? (m[3]?.hl_group ?? m[4]?.hl_group) : undefined)).filter(Boolean))
  assert.ok([...whaleGroups].some((g) => String(g).startsWith('DshTuiWhale')), 'whale glyphs carry per-pixel color groups')
  // Animation: while the wallpaper is up, the ticker advances frames and the
  // buffer changes on its own (wink/bubble/bob cycle).
  const whaleSnapshot = await nvim.request('nvim_buf_get_lines', [whaleBuf, 0, -1, false])
  await new Promise((r) => setTimeout(r, 1100))
  const whaleAnimated = await nvim.request('nvim_buf_get_lines', [whaleBuf, 0, -1, false])
  assert.notDeepEqual(whaleAnimated, whaleSnapshot, 'wallpaper animates (ticker advances frames)')
  whaleFeed.applyEvent({ type: 'user/message', time: 1, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } })
  await whaleFeed.flush()
  heroLines = await nvim.request('nvim_buf_get_lines', [whaleBuf, 0, -1, false])
  assert.ok(heroLines.some((l: string) => l.includes('> hi')), 'content renders above the whale')
  assert.ok(!heroLines.some((l: string) => l.includes('🐳') || l.includes('🫧')), 'no emoji watermark once content exists')
  whaleFeed.setWhale(false)
  await new Promise((r) => setTimeout(r, 80))
  await whaleFeed.flush()
  heroLines = await nvim.request('nvim_buf_get_lines', [whaleBuf, 0, -1, false])
  assert.ok(!heroLines.some((l: string) => l.includes('▀')), 'whale off removes the art')
  // Welcome lines (project intro + usage) render under the whale while empty.
  const welcomeBuf = await nvim.request('nvim_create_buf', [false, true])
  const welcomeFeed = new FeedRenderer(nvim, welcomeBuf, ids.chatWin!, {
    idsProvider: async () => ({ win: ids.chatWin }),
    activeChecker: () => false,
    whale: true,
    welcome: () => ({
      above: [{ text: '███▌', group: 'DshTuiWhaleB-' }, { text: 'Neovim 风格的终端客户端 · v0.2.2', group: 'DshTuiUser' }],
      below: [{ text: '直接输入问题开始对话' }, { text: '  /help 全部命令 · /new 新建会话' }],
    }),
  })
  await welcomeFeed.flush()
  const welcomeLines0 = await nvim.request('nvim_buf_get_lines', [welcomeBuf, 0, -1, false])
  assert.ok(welcomeLines0.some((l: string) => l.includes('▀')), 'welcome state still shows the whale wallpaper')
  assert.ok(welcomeLines0.some((l: string) => l.includes('███▌')), 'welcome shows the big banner letters')
  assert.ok(welcomeLines0.some((l: string) => l.includes('Neovim 风格的终端客户端')), 'welcome shows the project title')
  assert.ok(welcomeLines0.some((l: string) => l.includes('/help 全部命令')), 'welcome shows usage commands')
  welcomeFeed.applyEvent({ type: 'user/message', time: 1, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } })
  await welcomeFeed.flush()
  const welcomeLines1 = await nvim.request('nvim_buf_get_lines', [welcomeBuf, 0, -1, false])
  assert.ok(!welcomeLines1.some((l: string) => l.includes('/help')), 'welcome hides once content arrives')
  await nvim.request('nvim_buf_delete', [welcomeBuf, { force: true }])
  await nvim.request('nvim_buf_delete', [whaleBuf, { force: true }])

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
  // insert-mode cursor accepts the end position (col 2 = after 'i'); the
  // test drives the @-accept path, which always runs with insert active
  await lua(`local ids = require("dsh_tui").ids(); vim.api.nvim_set_current_win(ids.inputWin); vim.cmd('startinsert')`, [])
  await nvim.request('nvim_win_set_cursor', [ids.inputWin, [1, 2]])
  await lua('require("dsh_tui").append_input(...)', ['@note '])
  const appended = await nvim.request('nvim_buf_get_lines', [ids.inputBuf, 0, -1, false])
  assert.equal(appended[0], 'hi@note ', 'append_input inserts at cursor')
  await nvim.request('nvim_buf_set_lines', [ids.inputBuf, 0, -1, false, ['']])

  // 9m. empty-state hero + whale: a feed holding ONLY notice lines (boot
  // banner, "session X" notices) is still empty — the hero renders, the
  // notices ride below it; any real content hides the hero.
  const whaleChat = await nvim.lua('return require("dsh_tui").ensure_chat(...)', ['session-whale']) as { chatBuf: number; chatWin: number }
  const heroStateFeed = new FeedRenderer(nvim, whaleChat.chatBuf, whaleChat.chatWin, {
    activeChecker: () => true,
    whale: true,
    welcome: () => ({
      above: [{ text: '▄███▄ HERO-BANNER' }],
      below: [{ text: 'usage hint line' }],
    }),
  })
  heroStateFeed.appendNotice('boot banner notice')
  await heroStateFeed.flush()
  let heroStateLines = await nvim.request('nvim_buf_get_lines', [whaleChat.chatBuf, 0, -1, false])
  log('whale empty-state:', JSON.stringify(heroStateLines.filter((l: string) => l.trim() !== '').slice(0, 8)))
  assert.ok(heroStateLines.some((l: string) => l.includes('HERO-BANNER')), 'hero renders with only a banner notice')
  assert.ok(heroStateLines.some((l: string) => l.includes('boot banner notice')), 'banner notice stays visible below the hero')
  assert.ok(heroStateLines.some((l: string) => l.includes('usage hint line')), 'usage hints render')
  heroStateFeed.pushUser('你好', [])
  await heroStateFeed.flush()
  heroStateLines = await nvim.request('nvim_buf_get_lines', [whaleChat.chatBuf, 0, -1, false])
  assert.ok(!heroStateLines.some((l: string) => l.includes('HERO-BANNER')), 'hero hides once real content exists')
  heroStateFeed.setWhale(false) // stop the animation interval
  await heroStateFeed.flush()

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

  // 12. window statuslines: input framed, reasoning seamless
  const ids12 = await lua('return require("dsh_tui").ids()', [])
  const slInput = await lua('return vim.api.nvim_win_get_option(require("dsh_tui").ids().inputWin, "statusline")', [])
  assert.ok(slInput.includes('Enter 发送'), 'input window has a styled helper bar')
  assert.ok(!slInput.includes('❯'), 'prompt moved OUT of the input statusline')
  assert.ok(!slInput.includes('StatusLineNC'), 'no raw StatusLineNC block')
  // input FRAME: the hint bar doubles as the bottom edge — ╰ corner first
  // (hints stay left-aligned with the input box), ─╯ at the far right.
  assert.ok(slInput.startsWith('%#DshTuiBorder#╰─%#DshTuiStatus# Enter 发送'), 'hint bar opens the frame bottom edge (╰─ connects to the hints)')
  assert.ok(slInput.includes('%#DshTuiStatus# Enter 发送'), 'hints are left-aligned (aligned with the input box)')
  assert.ok(slInput.includes('%#DshTuiBorder#%=─╯'), 'frame bottom-right corner sits at the far right edge')
  const inputFill = await lua('return vim.wo[require("dsh_tui").ids().inputWin].fillchars', [])
  assert.ok(String(inputFill).includes('stl:─'), 'bottom edge fills the gap with ─ (continuous border)')
  // The '❯' prompt lives in the status COLUMN: visual only, never part of
  // the submitted text, never deletable. The column also carries the frame's
  // LEFT edge (│), and the winbar draws the TOP edge (╭─╮).
  const promptCol = await lua('return vim.wo[require("dsh_tui").ids().inputWin].statuscolumn', [])
  assert.ok(promptCol.includes('❯'), 'input status column carries the ❯ prompt')
  assert.ok(promptCol.includes('│'), 'input status column carries the frame left edge')
  const winbar = await lua('return vim.api.nvim_win_get_option(require("dsh_tui").ids().inputWin, "winbar")', [])
  assert.ok(winbar.includes('╭') && winbar.includes('╮'), 'input winbar draws the frame top edge')
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
  const ffHl = await lua('return vim.api.nvim_get_hl(0, { name = "FloatFooter" })', [])
  assert.equal(ffHl.link, 'DshTuiStatus', 'embedded popup footer keeps the statusline look')
  const popupBg = await lua(`local hex = function(c) return type(c) == 'number' and c or nil end
    return {
      ref = hex(vim.api.nvim_get_hl(0, { name = 'DshTuiBorder', link = false }).bg), -- = editor bg (with fallback)
      nf = hex(vim.api.nvim_get_hl(0, { name = 'NormalFloat', link = false }).bg),
      fb = hex(vim.api.nvim_get_hl(0, { name = 'FloatBorder', link = false }).bg),
    }`, [])
  assert.ok(popupBg.nf != null, 'popup surface gets an explicit background')
  assert.equal(popupBg.nf, popupBg.ref, 'popup surface matches the editor background')
  assert.equal(popupBg.fb, popupBg.ref, 'popup border background matches the editor background')
  // syntax highlighting helpers: fence-language → filetype normalization +
  // no-crash without treesitter (headless smoke env has no user config)
  const ftMap = await lua(`local M = require("dsh_tui")
    return {
      py = M.syntax_ft('py'), js = M.syntax_ft('js'), ts = M.syntax_ft('ts'),
      yml = M.syntax_ft('yml'), sh = M.syntax_ft('bash'), md = M.syntax_ft('markdown'),
      empty = M.syntax_ft(''), junk = M.syntax_ft('zzz-nope'),
    }`, [])
  assert.equal(ftMap.py, 'python', 'py fence → python')
  assert.equal(ftMap.js, 'javascript', 'js fence → javascript')
  assert.equal(ftMap.ts, 'typescript', 'ts fence → typescript')
  assert.equal(ftMap.yml, 'yaml', 'yml fence → yaml')
  assert.equal(ftMap.sh, 'sh', 'bash fence → sh')
  assert.equal(ftMap.md, 'markdown', 'markdown fence → markdown')
  assert.equal(await lua('return require("dsh_tui").syntax_ft("python")', []), 'python', 'full python name maps')
  assert.equal(await lua('return require("dsh_tui").syntax_ft("typescript")', []), 'typescript', 'full typescript name maps')
  assert.equal(await lua('return require("dsh_tui").syntax_ft("php")', []), 'php_only', 'php maps to the code grammar (php = phpdoc)')
  assert.ok(ftMap.empty == null, 'empty lang → nil')
  assert.ok(ftMap.junk == null, 'unknown lang without parser → nil')
  // fenced blocks render markdown-style: no raw ``` markers in the chat, the
  // opening fence becomes a dim language chip
  feedA.applyEvent({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '\nsee:\n```ts\nconst x: number = 1\n```\n' } } })
  await new Promise((r) => setTimeout(r, 700))
  const fencedLines = await nvim.request('nvim_buf_get_lines', [chatA.chatBuf, 0, -1, false])
  assert.ok(!fencedLines.includes('```ts') && !fencedLines.includes('```'), 'raw fence markers stripped from the chat')
  assert.ok(fencedLines.includes('▸ ts'), 'opening fence renders as a language chip')
  assert.ok(fencedLines.includes('const x: number = 1'), 'fenced code content kept')
  const hlOk = await lua(`local ok, err = pcall(require("dsh_tui").highlight_syntax,
    vim.api.nvim_get_current_buf(), vim.api.nvim_create_namespace('smoke-ts'),
    {{ lang = 'python', row = 0, col = 0, lines = { 'def f():' } }})
    return { ok = ok, err = tostring(err) }`, [])
  assert.equal(hlOk.ok, true, 'highlight_syntax never throws (no treesitter → flat fallback)')
  const diffHl = await lua('return { add = vim.api.nvim_get_hl(0, { name = "DshTuiDiffAdd" }), del = vim.api.nvim_get_hl(0, { name = "DshTuiDiffDel" }) }', [])
  assert.equal(diffHl.add.fg, undefined, 'diff add group carries NO fg (text color belongs to syntax tokens)')
  assert.equal(diffHl.del.fg, undefined, 'diff del group carries NO fg (text color belongs to syntax tokens)')
  assert.equal(typeof diffHl.add.bg, 'number', 'diff add row carries a background fill')
  assert.equal(typeof diffHl.del.bg, 'number', 'diff del row carries a background fill')
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
  assert.equal(layoutAfter.inputH, 2, 'input back to one text row after round-trip (winbar + text)')
  // frame RIGHT edge: one right-aligned │ mark per input row, re-synced on
  // row changes (multi-line input grows the frame, not the gutter).
  const frameMarks = () => lua(`return vim.api.nvim_buf_get_extmarks(require("dsh_tui").ids().inputBuf, require("dsh_tui")._frameNs, 0, -1, { details = false })`, [])
  let fm = await frameMarks()
  assert.equal(fm.length, 1, 'one right-edge frame mark per input row')
  await lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "a", "b" }); require("dsh_tui").resize_input()`, [])
  fm = await frameMarks()
  assert.equal(fm.length, 2, 'frame marks follow multi-line input')
  // viewport: after a grow, the topline snaps back to 1 — the new row must
  // render inside the frame, not as a leftover `~` beyond-EOF row without │❯
  const w0 = await lua(`local ids = require('dsh_tui').ids()
    return vim.api.nvim_win_call(ids.inputWin, function() return vim.fn.line('w0') end)`, [])
  assert.equal(w0, 1, 'input viewport snaps to the first line after a grow')
  await lua(`vim.api.nvim_buf_set_lines(require("dsh_tui").ids().inputBuf, 0, -1, false, { "" }); require("dsh_tui").resize_input()`, [])
  // tabline flash regression: a plugin flipping showtabline=2 mid-startup
  // (bufferline) used to redistribute a row into the input window — the
  // extra blank row that vanished on the first keystroke — and the old
  // OptionSet guard blanked the input's winbar (the frame's top edge).
  await lua('vim.o.showtabline = 2', [])
  await new Promise((r) => setTimeout(r, 150))
  const flashProbe = await lua(`local ids = require('dsh_tui').ids()
    local ip = vim.api.nvim_win_get_position(ids.inputWin)
    return {
      showtabline = vim.o.showtabline,
      inputH = vim.api.nvim_win_get_height(ids.inputWin),
      winbar = vim.api.nvim_win_get_option(ids.inputWin, 'winbar'),
      slack = vim.o.lines - vim.o.cmdheight - (ip[1] + vim.api.nvim_win_get_height(ids.inputWin) + 1),
      winfixheight = vim.wo[ids.inputWin].winfixheight,
    }`, [])
  assert.equal(flashProbe.showtabline, 0, 'tabline flash snapped back to hidden')
  assert.equal(flashProbe.inputH, 2, 'input keeps its rows through a tabline flash')
  assert.ok(String(flashProbe.winbar).includes('╭'), 'input winbar survives a tabline flash')
  assert.equal(flashProbe.slack, 0, 'no stray rows below the input after a tabline flash')
  assert.equal(flashProbe.winfixheight, true, 'input window height is fixed')
  // empty-Enter regression: the <Cmd> mapping's hidden cmdline clears the
  // last screen row (the helper bar, cmdheight=0) — submit() must leave the
  // window chrome intact (the scheduled redraw re-paints it)
  await lua('require("dsh_tui").submit()', [])
  await new Promise((r) => setTimeout(r, 80))
  const slAfterEmptySubmit = await lua('return vim.api.nvim_win_get_option(require("dsh_tui").ids().inputWin, "statusline")', [])
  assert.ok(String(slAfterEmptySubmit).includes('Enter 发送'), 'empty submit keeps the helper bar option')

  // 12b. input-window hardening: ZZ inert, no clones, mode preserved, auto-restore
  await lua(`local ids = require("dsh_tui").ids()
    vim.api.nvim_set_current_win(ids.inputWin)
    vim.cmd('startinsert')`, [])
  await new Promise((r) => setTimeout(r, 80))
  log('12b-EARLY INSERT MODE:', await lua('return vim.api.nvim_get_mode().mode .. " insertmode=" .. tostring(vim.o.insertmode)', []))
  const zzMap = await lua(`local out = {}
    for _, m in ipairs(vim.api.nvim_buf_get_keymap(require("dsh_tui").ids().inputBuf, "n")) do
      out[m.lhs] = m.rhs
    end
    return out`, [])
  assert.ok(zzMap.ZZ !== undefined && zzMap.ZZ === '', 'ZZ is inert on the input buffer')
  assert.ok(zzMap.ZQ !== undefined && zzMap.ZQ === '', 'ZQ is inert on the input buffer')
  // window navigation preserves the mode (no forced insert on WinEnter)
  await lua(`vim.api.nvim_set_current_win(require("dsh_tui").ids().inputWin)
    vim.cmd('stopinsert')
    vim.api.nvim_set_current_win(require("dsh_tui").ids().chatWin)
    vim.api.nvim_set_current_win(require("dsh_tui").ids().inputWin)`, [])
  await new Promise((r) => setTimeout(r, 80))
  assert.equal((await lua('return vim.api.nvim_get_mode().mode', [])), 'n',
    'switching back to the input keeps normal mode')
  await lua(`vim.api.nvim_set_current_win(require("dsh_tui").ids().inputWin); vim.cmd('startinsert')`, [])
  await new Promise((r) => setTimeout(r, 80))
  log('BISECT after-mode-test:', await lua('return vim.api.nvim_get_mode().mode', []))
  await lua(`vim.cmd('stopinsert')`, [])
  // :sp from the input must not create a synced clone
  const winsBeforeSp = (await lua('return vim.api.nvim_list_wins()', [])).length
  await lua(`vim.api.nvim_set_current_win(require("dsh_tui").ids().inputWin); vim.cmd('sp')`, [])
  await new Promise((r) => setTimeout(r, 120))
  const clones = await lua(`local ids = require("dsh_tui").ids()
    local n = 0
    for _, w in ipairs(vim.api.nvim_list_wins()) do
      if w ~= ids.inputWin and vim.api.nvim_win_get_buf(w) == ids.inputBuf then n = n + 1 end
    end
    return n`, [])
  assert.equal(clones, 0, ':sp from the input leaves no buffer clone')
  assert.equal((await lua('return vim.api.nvim_list_wins()', [])).length, winsBeforeSp, 'no stray window after :sp')
  await lua(`vim.api.nvim_set_current_win(require("dsh_tui").ids().inputWin); vim.cmd('startinsert')`, [])
  await new Promise((r) => setTimeout(r, 80))
  log('BISECT after-sp:', await lua('return vim.api.nvim_get_mode().mode', []))
  await lua(`vim.cmd('stopinsert')`, [])
  // closing the input window (ZZ path's worst case) auto-restores it
  const oldInputWin = await lua('return require("dsh_tui").ids().inputWin', [])
  await lua('vim.api.nvim_win_close(...)', [oldInputWin, true])
  await new Promise((r) => setTimeout(r, 700))
  const restored = await lua(`local ids = require("dsh_tui").ids()
    return {
      valid = vim.api.nvim_win_is_valid(ids.inputWin),
      buf = vim.api.nvim_win_get_buf(ids.inputWin),
      inputBuf = ids.inputBuf,
      mode = vim.api.nvim_get_mode().mode,
    }`, [])
  assert.equal(restored.valid, true, 'closed input window auto-restores')
  assert.equal(restored.buf, restored.inputBuf, 'restored window shows the input buffer')
  assert.equal(restored.mode, 'i', 'restored input starts in insert mode')
  // ModeChanged enforcement: statusline plugins rewrite on mode flips
  // (pressing i in the input used to wipe the frame + hint bar)
  await lua(`vim.api.nvim_win_set_option(require("dsh_tui").ids().inputWin, "statusline", "")`, [])
  await lua(`vim.cmd('doautocmd ModeChanged n:i')`, [])
  await new Promise((r) => setTimeout(r, 80))
  const slAfterMode = await lua('return vim.api.nvim_win_get_option(require("dsh_tui").ids().inputWin, "statusline")', [])
  assert.ok(String(slAfterMode).includes('Enter 发送'), 'ModeChanged re-asserts the hint bar')
  // display buffers never stay in insert mode (mouse click drags the state)
  await lua(`vim.api.nvim_set_current_win(require("dsh_tui").ids().chatWin)`, [])
  await lua('vim.api.nvim_input("i")', [])
  await new Promise((r) => setTimeout(r, 120))
  assert.equal((await lua('return vim.api.nvim_get_mode().mode', [])), 'n',
    'chat buffer snaps back to normal mode')
  await lua(`vim.api.nvim_set_current_win(require("dsh_tui").ids().inputWin)`, [])
  const dimHl = await lua('return vim.api.nvim_get_hl(0, { name = "DshTuiDim" })', [])
  assert.equal(dimHl.link, 'Comment', 'DshTuiDim follows the theme Comment')
  // popup surfaces sit flat on the editor background: title included — some
  // themes give FloatTitle a literal black bg (a dark block behind titles)
  const flatHl = await lua(`return {
    nf = vim.api.nvim_get_hl(0, { name = "NormalFloat", link = false }).bg,
    fb = vim.api.nvim_get_hl(0, { name = "FloatBorder", link = false }).bg,
    ft = vim.api.nvim_get_hl(0, { name = "FloatTitle", link = false }).bg,
  }`, [])
  assert.equal(flatHl.fb, flatHl.nf, 'popup border background follows the float surface')
  assert.equal(flatHl.ft, flatHl.nf, 'popup title background follows the float surface (no black block)')
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
