--- dsh_tui.subagent_chat: the subagent chat window — a two-part float that
--- chats with ONE continuable subagent like the main chat does with the main
--- agent. The runner's FeedRenderer writes the child's live transcript into
--- the upper read-only buffer (reasoning inline + answer + tool cards); the
--- lower editable input row sends user messages to the child through the
--- runner (`dsh-subagent-send`). Enter sends, <C-CR> inserts a newline,
--- <Up>/<Down> cycle per-window history, Esc/<C-c> close back to the main
--- input, <C-o> still toggles the reasoning panel.
---
--- Geometry: one centered rounded float for the transcript; a second rounded
--- input float directly below it (its top border fills the row under the
--- transcript's bottom border — one continuous framed chat box; the input
--- keeps the main input's frame furniture: statuscolumn │❯ prompt +
--- right-edge marks + dim winhl). The composite block keeps a fixed
--- footprint: multi-line input grows the input float and shrinks the
--- transcript float by the same rows.
local S = require('dsh_tui.state')
local I = require('dsh_tui.input')
local PC = require('dsh_tui.popup_core')
local SAC = {}

-- Single composite state, replaced as a unit when the window opens/closes
-- (the init.lua M._subagentChat lazy alias stays in sync).
S.subagentChat = { buf = nil, win = nil, inputBuf = nil, inputWin = nil, hist = {}, histIdx = nil, draft = nil }

local function width()
  return math.min(120, math.max(40, vim.o.columns - 6))
end

local function height()
  return math.max(8, math.min(40, vim.o.lines - 10))
end

--- Wipe the previous chat window silently (the runner initiated the swap).
local function wipe_previous()
  local prev = S.subagentChat
  if prev.win and vim.api.nvim_win_is_valid(prev.win) then
    pcall(vim.api.nvim_win_close, prev.win, true)
  end
  if prev.inputWin and vim.api.nvim_win_is_valid(prev.inputWin) then
    pcall(vim.api.nvim_win_close, prev.inputWin, true)
  end
  for _, b in ipairs({ prev.buf, prev.inputBuf }) do
    if b and vim.api.nvim_buf_is_valid(b) then
      pcall(vim.api.nvim_buf_delete, b, { force = true })
    end
  end
  S.subagentChat = { buf = nil, win = nil, inputBuf = nil, inputWin = nil, hist = {}, histIdx = nil, draft = nil }
end

--- The input float's right edge: one right-aligned `│` mark per input row
--- (same frame furniture as the main input).
local function refresh_input_frame()
  local sc = S.subagentChat
  if sc.inputBuf == nil or not vim.api.nvim_buf_is_valid(sc.inputBuf) then return end
  vim.api.nvim_buf_clear_namespace(sc.inputBuf, S.frameNs, 0, -1)
  local n = math.max(1, vim.api.nvim_buf_line_count(sc.inputBuf))
  for i = 0, n - 1 do
    pcall(vim.api.nvim_buf_set_extmark, sc.inputBuf, S.frameNs, i, 0, {
      virt_text = { { '│', 'DshTuiBorder' } },
      virt_text_pos = 'right_align',
      hl_mode = 'combine',
      priority = 4096,
    })
  end
end

--- Re-fit the composite block: input rows grow 1..3, the transcript float
--- shrinks by the same delta so the pair keeps one fixed footprint. Both
--- floats carry rounded borders (the input's top border fills the row right
--- under the transcript's bottom border — one continuous framed chat box).
function SAC.resize()
  local sc = S.subagentChat
  if not (sc.win and sc.inputWin and vim.api.nvim_win_is_valid(sc.win)
    and vim.api.nvim_win_is_valid(sc.inputWin)) then
    return
  end
  local lc = vim.api.nvim_buf_line_count(sc.inputBuf)
  local n = math.min(3, math.max(1, lc))
  local cfg = vim.api.nvim_win_get_config(sc.win)
  local icfg = vim.api.nvim_win_get_config(sc.inputWin)
  -- Composite footprint is constant: chat rows + 2 border rows + input rows
  -- + 2 border rows.
  local chatH = math.max(6, height() + 1 - n)
  local row = PC.centered_row(chatH + n + 4)
  if vim.api.nvim_win_get_height(sc.win) ~= chatH or cfg.row ~= row then
    vim.api.nvim_win_set_config(sc.win, vim.tbl_extend('force', cfg, {
      row = row, height = chatH,
    }))
  end
  if vim.api.nvim_win_get_height(sc.inputWin) ~= n then
    vim.api.nvim_win_set_height(sc.inputWin, n)
  end
  local irow = row + chatH + 2
  if icfg.row ~= irow or vim.api.nvim_win_get_height(sc.inputWin) ~= n then
    vim.api.nvim_win_set_config(sc.inputWin, vim.tbl_extend('force', icfg, {
      row = irow, height = n,
    }))
  end
  refresh_input_frame()
end

--- Open (or replace) the chat window for one subagent. Returns the window /
--- buffer ids for the runner's FeedRenderer and send handler.
function SAC.open(title)
  wipe_previous()
  -- One float family at a time: the read-only subagent view closes.
  if S.subagentView.win and vim.api.nvim_win_is_valid(S.subagentView.win) then
    pcall(vim.api.nvim_win_close, S.subagentView.win, true)
  end
  if S.subagentView.buf and vim.api.nvim_buf_is_valid(S.subagentView.buf) then
    pcall(vim.api.nvim_buf_delete, S.subagentView.buf, { force = true })
  end
  S.subagentView = { buf = nil, win = nil }
  PC.detach_footer()

  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(buf, 'dsh-subagent-chat')
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.b[buf].ministatusline_disable = true
  PC.lock_display_keys(buf)

  local w = width()
  local h = height()
  local cfg = {
    relative = 'editor',
    anchor = 'NW',
    row = PC.centered_row(h + 5), -- chat + 2 border rows + 1 input row + 2 border rows
    col = PC.centered_col(w),
    width = w,
    height = h,
    border = 'rounded',
    style = 'minimal',
    zindex = 45,
  }
  if vim.fn.has('nvim-0.9') == 1 then
    cfg.title = ' 子代理对话 · ' .. tostring(title or '') .. ' '
    cfg.title_pos = 'center'
  end
  local win = vim.api.nvim_open_win(buf, false, cfg)
  vim.wo[win].cursorline = true
  vim.wo[win].number = false
  vim.wo[win].signcolumn = 'no'
  vim.keymap.set('n', 'G', '<Cmd>lua require("dsh_tui").subagent_chat_jump("last")<CR>', { buffer = buf })
  vim.keymap.set('n', 'gg', '<Cmd>lua require("dsh_tui").subagent_chat_jump("first")<CR>', { buffer = buf })
  vim.keymap.set('n', 'q', '<Cmd>lua require("dsh_tui").close_subagent_chat()<CR>', { buffer = buf })
  vim.keymap.set('n', '<Esc>', '<Cmd>lua require("dsh_tui").close_subagent_chat()<CR>', { buffer = buf })

  -- The editable input float right below the transcript: it carries its own
  -- rounded border (top border fills the row under the transcript's bottom
  -- border — one continuous framed box) and the operation hints in its
  -- bottom border.
  local inputBuf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(inputBuf, 'dsh-subagent-chat-input')
  vim.bo[inputBuf].buftype = 'nofile'
  vim.bo[inputBuf].bufhidden = 'wipe'
  vim.bo[inputBuf].swapfile = false
  vim.b[inputBuf].ministatusline_disable = true
  vim.api.nvim_buf_set_lines(inputBuf, 0, -1, false, { '' })
  local icfg = {
    relative = 'editor',
    anchor = 'NW',
    row = PC.centered_row(h + 5) + h + 2,
    col = PC.centered_col(w),
    width = w,
    height = 1,
    border = 'rounded',
    style = 'minimal',
    zindex = 46,
  }
  if vim.fn.has('nvim-0.10') == 1 then
    icfg.footer = '[Enter] 发送 · [Esc] 关闭 · [C-o] 面板'
    icfg.footer_pos = 'left'
  end
  local inputWin = vim.api.nvim_open_win(inputBuf, true, icfg)
  vim.wo[inputWin].winhighlight = 'Normal:DshTuiDim'
  vim.wo[inputWin].number = false
  vim.wo[inputWin].signcolumn = 'no'
  vim.wo[inputWin].cursorline = false
  if vim.fn.has('nvim-0.9') == 1 then
    vim.wo[inputWin].statuscolumn = '%#DshTuiBorder#│%s%#DshTuiPrompt#❯ '
  end

  local submit_cmd = '<Cmd>lua require("dsh_tui").subagent_chat_submit()<CR>'
  local close_cmd = '<Cmd>lua require("dsh_tui").close_subagent_chat()<CR>'
  vim.api.nvim_buf_set_keymap(inputBuf, 'i', '<CR>', submit_cmd, { noremap = true })
  vim.api.nvim_buf_set_keymap(inputBuf, 'n', '<CR>', submit_cmd, { noremap = true })
  vim.api.nvim_buf_set_keymap(inputBuf, 'i', '<C-CR>', '<CR>', { noremap = true })
  vim.api.nvim_buf_set_keymap(inputBuf, 'i', '<Esc>', close_cmd, { noremap = true })
  vim.api.nvim_buf_set_keymap(inputBuf, 'i', '<C-c>', close_cmd, { noremap = true })
  vim.keymap.set('i', '<Up>', function() require('dsh_tui').subagent_chat_history(-1) end, { buffer = inputBuf })
  vim.keymap.set('i', '<Down>', function() require('dsh_tui').subagent_chat_history(1) end, { buffer = inputBuf })
  local reason_cmd = '<Cmd>lua require("dsh_tui").toggle_reasoning()<CR>'
  vim.api.nvim_buf_set_keymap(inputBuf, 'i', '<C-o>', reason_cmd, { noremap = true })

  S.subagentChat = { buf = buf, win = win, inputBuf = inputBuf, inputWin = inputWin, hist = {}, histIdx = nil, draft = nil }
  refresh_input_frame()
  vim.cmd('startinsert') -- the input float opens in insert mode
  return { buf = buf, win = win, inputBuf = inputBuf, inputWin = inputWin }
end

--- Send the input text to the runner (rpcnotify) and reset the row.
function SAC.submit()
  local sc = S.subagentChat
  if not (sc.inputBuf and vim.api.nvim_buf_is_valid(sc.inputBuf)) then return end
  local text = table.concat(vim.api.nvim_buf_get_lines(sc.inputBuf, 0, -1, false), '\n')
  text = text:gsub('^%s+', ''):gsub('%s+$', '')
  if text == '' then
    vim.schedule(function() vim.cmd('redraw') end)
    return
  end
  if S.channel then
    vim.rpcnotify(S.channel, 'dsh-subagent-send', text)
  end
  if sc.hist[#sc.hist] ~= text then
    table.insert(sc.hist, text)
  end
  sc.histIdx = nil
  sc.draft = nil
  vim.api.nvim_buf_set_lines(sc.inputBuf, 0, -1, false, { '' })
  SAC.resize()
end

--- <Up>/<Down> history cycling on the chat input (local to this window).
function SAC.history_move(dir)
  local sc = S.subagentChat
  if not (sc.inputBuf and vim.api.nvim_buf_is_valid(sc.inputBuf)) then return end
  local lines = vim.api.nvim_buf_get_lines(sc.inputBuf, 0, -1, false)
  local cur = vim.api.nvim_win_get_cursor(sc.inputWin)
  local line = lines[cur[1]] or ''
  local atEnd = cur[1] == #lines and cur[2] >= #line
  if not atEnd then
    vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes(dir < 0 and '<Up>' or '<Down>', true, false, true), 'n', false)
    return
  end
  if sc.histIdx == nil then
    sc.draft = table.concat(lines, '\n')
    sc.histIdx = #sc.hist
    if sc.histIdx < 1 then
      sc.histIdx = nil
      sc.draft = nil
      return
    end
  else
    sc.histIdx = sc.histIdx + dir
  end
  if sc.histIdx < 1 then
    sc.histIdx = 1
  end
  if sc.histIdx > #sc.hist then
    local draftLines = vim.split(sc.draft or '', '\n', { plain = true })
    vim.api.nvim_buf_set_lines(sc.inputBuf, 0, -1, false, draftLines)
    sc.histIdx = nil
    sc.draft = nil
    vim.api.nvim_win_set_cursor(sc.inputWin, { #draftLines, 0 })
    SAC.resize()
    return
  end
  local histLines = vim.split(sc.hist[sc.histIdx], '\n', { plain = true })
  vim.api.nvim_buf_set_lines(sc.inputBuf, 0, -1, false, histLines)
  vim.api.nvim_win_set_cursor(sc.inputWin, { #histLines, 0 })
  SAC.resize()
end

--- Close the chat window and hand focus back to the main input.
function SAC.close()
  PC.detach_footer()
  wipe_previous()
  if S.channel then
    vim.rpcnotify(S.channel, 'dsh-subagent-chat-closed')
  end
  I.focus()
end

--- Silent close for a runner/lua-initiated swap to another float (no
--- notification, no focus restore — the replacing float owns focus).
function SAC.close_silent()
  PC.detach_footer()
  wipe_previous()
end

--- Current chat ids for the runner's FeedRenderer idsProvider.
function SAC.ids()
  local sc = S.subagentChat
  if sc.win and sc.inputWin and vim.api.nvim_win_is_valid(sc.win) and vim.api.nvim_win_is_valid(sc.inputWin) then
    return { buf = sc.buf, win = sc.win, inputBuf = sc.inputBuf, inputWin = sc.inputWin }
  end
  return nil
end

--- G/gg jump inside the transcript.
function SAC.jump(where)
  local sc = S.subagentChat
  if not (sc.win and sc.buf and vim.api.nvim_win_is_valid(sc.win) and vim.api.nvim_buf_is_valid(sc.buf)) then
    return
  end
  local lines = vim.api.nvim_buf_get_lines(sc.buf, 0, -1, false)
  local row = where == 'last' and math.max(1, #lines) or 1
  vim.api.nvim_win_set_cursor(sc.win, { row, 0 })
end

--- Settled replays land on the FIRST thinking block (same as the read-only
--- subagent view). Returns the 1-based row it landed on.
function SAC.goto_thinking()
  local sc = S.subagentChat
  if not (sc.win and vim.api.nvim_win_is_valid(sc.win)) then
    return nil
  end
  local lines = vim.api.nvim_buf_get_lines(sc.buf, 0, -1, false)
  local row = 1
  for i, l in ipairs(lines) do
    if vim.startswith(l, '·· thinking') then
      row = i
      break
    end
  end
  vim.api.nvim_win_set_cursor(sc.win, { row, 0 })
  return row
end

return SAC
