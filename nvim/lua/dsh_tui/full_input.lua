--- dsh_tui.full_input: the fullscreen input editor.
---
--- <C-e> in the input box opens a near-fullscreen scratch float prefilled
--- with the current draft. Inside the float, Enter inserts a newline (plain
--- file editing); Esc leaves insert mode; in normal mode <CR> sends the
--- content through the REGULAR submit path (hooks / history / command
--- routing unchanged) and closes the float back to the normal input box;
--- q discards and returns (the input box still holds the old draft).
local S = require('dsh_tui.state')
local I = require('dsh_tui.input')
local B = require('dsh_tui.buffer')
local FI = {}

local function is_open()
  return S.fullInput.win ~= nil and vim.api.nvim_win_is_valid(S.fullInput.win)
end

local function close()
  if is_open() then
    pcall(vim.api.nvim_win_close, S.fullInput.win, true)
  end
  S.fullInput.win = nil
  S.fullInput.buf = nil
end

--- Read the float's content and send it via the normal submit pipeline.
local function submit()
  local buf = S.fullInput.buf
  if buf == nil or not vim.api.nvim_buf_is_valid(buf) then return end
  local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  while #lines > 0 and lines[#lines]:match('^%s*$') do table.remove(lines) end
  local text = table.concat(lines, '\n')
  close()
  if text == '' then
    I.focus()
    return
  end
  -- The input box carries the final draft; M.submit() then runs the
  -- unchanged chain (before-submit hooks, @/command menus, history,
  -- dsh-input / dsh-command routing).
  vim.api.nvim_buf_set_lines(S.input_buf, 0, -1, false, vim.split(text, '\n', { plain = true }))
  I.resize()
  require('dsh_tui').submit()
end

--- Open the fullscreen editor (prefilled with the current draft).
function FI.open()
  if is_open() then
    vim.api.nvim_set_current_win(S.fullInput.win)
    vim.cmd('startinsert')
    return
  end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.bo[buf].modifiable = true
  local draft = B.input_text()
  local lines = draft ~= '' and vim.split(draft, '\n', { plain = true }) or { '' }
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  local width = math.max(60, math.min(160, vim.o.columns - 6))
  local height = math.max(10, vim.o.lines - 8)
  local cfg = {
    relative = 'editor',
    anchor = 'NW',
    row = 2,
    col = math.max(0, math.floor((vim.o.columns - width) / 2)),
    width = width,
    height = height,
    border = 'rounded',
    style = 'minimal',
    title = ' 全屏输入 ',
    title_pos = 'center',
    zindex = 40,
  }
  -- footer/footer_pos are nvim 0.10+; every other footer usage guards with
  -- has('nvim-0.10') — this one was the single unguarded site (0.9 <C-e>
  -- crashed on the unknown key).
  if vim.fn.has('nvim-0.10') == 1 then
    cfg.footer = '[Enter 换行]  [Esc 命令模式]  [回车 发送]  [q 丢弃]'
    cfg.footer_pos = 'center'
  end
  local win = vim.api.nvim_open_win(buf, true, cfg)
  S.fullInput = { win = win, buf = buf }
  vim.api.nvim_buf_set_keymap(buf, 'n', '<CR>', '<Cmd>lua require("dsh_tui").full_input_submit()<CR>', { noremap = true })
  vim.api.nvim_buf_set_keymap(buf, 'n', 'q', '<Cmd>lua require("dsh_tui").full_input_close()<CR>', { noremap = true })
  vim.cmd('startinsert')
end

--- Discard (q in normal mode): the input box keeps its old draft.
function FI.close_public()
  close()
  I.focus()
end

function FI.submit_public()
  submit()
end

--- <C-e> in the input box: open when closed, close when open.
function FI.toggle()
  if is_open() then
    FI.close_public()
  else
    FI.open()
  end
end

return FI
