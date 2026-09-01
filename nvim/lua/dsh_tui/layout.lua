--- dsh_tui.layout: the window layout — the chat window, the bottom input
--- split with its full frame furniture (winbar = top edge, statuscolumn =
--- left edge, statusline = bottom edge + hint bar, right-edge extmarks),
--- the startup takeover (claiming windows/buffers from the user config), and
--- the named layout presets (default / panel).
local S = require('dsh_tui.state')
local I = require('dsh_tui.input')
local SE = require('dsh_tui.session')
local PP = require('dsh_tui.popups')
local SL = require('dsh_tui.statusline')
local L = {}

local function window_options(win)
  for _, opt in ipairs({ 'number', 'relativenumber', 'cursorline' }) do
    vim.api.nvim_win_set_option(win, opt, false)
  end
  vim.api.nvim_win_set_option(win, 'signcolumn', 'no')
  vim.api.nvim_win_set_option(win, 'foldcolumn', '0')
end

--- Build (or rebuild) the input window: the bottom one-row split with the
--- full frame furniture. Factored out of build() so the WinClosed safety
--- net can restore the input if anything ever closes it (ZZ / :q / plugins).
function L.build_input_window()
  S.buildingLayout = true
  vim.cmd('botright 1split')
  S.buildingLayout = false
  S.input_win = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(S.input_win, S.input_buf)
  window_options(S.input_win)
  vim.api.nvim_win_set_option(S.input_win, 'showmode', false)
  -- The input box keeps its exact rows: tabline flashes (bufferline sets
  -- showtabline=2 mid-startup) and startup plugins opening/closing windows
  -- otherwise redistribute a row INTO the input window (the extra blank row
  -- that disappeared on the first keystroke). Fixed height, always.
  vim.wo[S.input_win].winfixheight = true
  -- Typed text follows the dim palette too — the '❯' prompt (DshTuiPrompt)
  -- keeps its accent and stays the visual anchor.
  vim.wo[S.input_win].winhl = 'Normal:DshTuiDim'
  -- INPUT FRAME: nvim split windows take no float-style borders, so the
  -- frame is window furniture — winbar = top edge, statuscolumn = left edge,
  -- right-aligned extmarks = right edge (input.refresh_frame), statusline =
  -- bottom edge + hint bar. An empty statusline would render as a
  -- StatusLineNC block (a bright bar in most themes), so the hints start at
  -- the LEFT edge, aligned with the input box.
  S.inputWinbar = '%#DshTuiBorder#╭%{%repeat("─", max([winwidth(0)-2, 0]))%}╮'
  pcall(vim.api.nvim_win_set_option, S.input_win, 'winbar', S.inputWinbar)
  -- The bottom edge is one continuous line: the statusline's %= gap is
  -- filled with `─` (window-local fillchars, the chat stats bar is
  -- unaffected) so the border runs from the hints all the way to ╯.
  S.inputStatusline = '%#DshTuiBorder#╰─%#DshTuiStatus# Enter 发送 · C-cr 换行 · C-c 停止 · / 命令菜单 · C-o 面板 %#DshTuiBorder#%=─╯'
  vim.api.nvim_win_set_option(S.input_win, 'statusline', S.inputStatusline)
  S.inputFillchars = 'stl:─,stlnc:─'
  pcall(vim.api.nvim_win_set_option, S.input_win, 'fillchars', S.inputFillchars)
  -- REPL-style prompt: the '❯' lives in the window's STATUS COLUMN, outside
  -- the editable text — it can never be typed over, deleted, or submitted as
  -- message content. (nvim < 0.9: inline virtual-text fallback.)
  if vim.fn.has('nvim-0.9') == 1 then
    vim.wo[S.input_win].statuscolumn = '%#DshTuiBorder#│%s%#DshTuiPrompt#❯ '
  else
    vim.api.nvim_buf_set_extmark(S.input_buf, S.ns, 0, 0, {
      virt_text = { { '❯ ', 'DshTuiPrompt' } },
      virt_text_pos = 'inline',
      hl_mode = 'combine',
    })
  end
  I.resize()

  -- No resident session list: /sessions pops a selectable float with full
  -- session ids. The chat gets the whole screen.
end

--- Mount the layout: the chat window (the current one at startup / after a
--- takeover) + the input split below it, then start typing right away.
function L.build()
  S.buildingLayout = true
  -- Main window (right, top): chat.
  S.chat_win = vim.api.nvim_get_current_win()
  window_options(S.chat_win)
  S.buildingLayout = false
  L.build_input_window()

  -- Start typing right away: the prompt buffer puts us in insert mode.
  I.focus()
  SL.apply()
end

--- Claim the UI: drop windows/buffers opened by the user's config or a
--- dashboard plugin, then rebuild our layout.
function L.takeover()
  if S.reasoningWin and vim.api.nvim_win_is_valid(S.reasoningWin) then
    pcall(vim.api.nvim_win_close, S.reasoningWin, true)
  end
  pcall(vim.cmd, 'silent! only')
  S.reasoningWin = nil
  S.reasoningOpen = false
  -- Swap the current window to a fresh unnamed nofile buffer, THEN wipe the
  -- startup scratch-file buffer. The swap stays SYNCHRONOUS (the scratch
  -- file name must never render in window statuslines — mini.statusline et
  -- al. would flash it on the first frame), but the DELETE is deferred past
  -- the whole VimEnter autocmd batch: other VimEnter callbacks in the user
  -- config (the nvim-tree auto-open template reads data.buf = 1) still hold
  -- the startup buffer and crash with E5111 on a mid-batch wipe.
  -- The scratch buffer is identified BY NAME (argv(0)): the displayed
  -- buffer is not reliable — headless boots can park an unnamed buffer in
  -- the window with the arg file hidden in a second buffer.
  local scratchBuf = nil
  local argvPath = vim.fn.fnamemodify(vim.fn.argv(0), ':p')
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    -- argv(0) may be empty (no file arg): '' normalizes to the cwd, which
    -- would match unnamed buffers — never wipe in that case.
    if vim.fn.argv(0) ~= '' and vim.bo[b].buflisted
      and vim.fn.fnamemodify(vim.api.nvim_buf_get_name(b), ':p') == argvPath then
      scratchBuf = b
      break
    end
  end
  local fresh = vim.api.nvim_create_buf(false, true)
  vim.bo[fresh].buftype = 'nofile'
  vim.bo[fresh].bufhidden = 'wipe'
  pcall(vim.api.nvim_win_set_buf, 0, fresh)
  vim.schedule(function()
    if scratchBuf == nil then return end
    if not vim.api.nvim_buf_is_valid(scratchBuf) then return end
    -- Cooperative: if some plugin split the scratch open during the batch,
    -- leave the buffer alone (a stray listed entry is cheaper than breaking
    -- that plugin's window).
    if vim.fn.bufwinid(scratchBuf) ~= -1 then return end
    pcall(vim.api.nvim_buf_delete, scratchBuf, { force = true })
  end)
end

--- Layout presets: default (chat + input, the chat already owns the whole
--- screen) / panel (reasoning panel open).
function L.apply_layout(name)
  PP.close_lines_float()
  if S.chat_win == nil or not vim.api.nvim_win_is_valid(S.chat_win) then
    return
  end
  name = name or 'default'
  if name == 'panel' then
    if not S.reasoningOpen then
      SE.toggle_reasoning()
    end
    S.layoutName = 'panel'
  else -- default (alias: full)
    if S.reasoningOpen then
      SE.toggle_reasoning()
    end
    S.layoutName = 'default'
  end
  I.focus()
  return S.layoutName
end

return L
