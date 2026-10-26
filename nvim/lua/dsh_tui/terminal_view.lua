--- dsh_tui.terminal_view: a host-PTY console buffer.
---
--- The host owns the PTY (`ctx.terminals`); this module only renders its
--- scrollback and exposes line-oriented keys. It deliberately does not use
--- nvim's `:terminal` for host sessions: that PTY would be invisible to the
--- model and disconnected from `terminal_*` tools. `/terminal shell` opens a
--- native nvim terminal as the local-only fallback.
---
--- Keys: <CR>/i/a send a line, <C-c> SIGINT, K kill the host session,
--- q closes the view (the PTY keeps running).
--- @module dsh_tui.terminal_view

local M = {}

--- Register the console view with the layout guard so its split window is not
--- treated as a foreign window and wiped (the boot guard otherwise closes
--- unregistered windows on WinEnter).
local function ensure_reg()
  local API = require('dsh_tui.api')
  local S = require('dsh_tui.state')
  local reg = S.extReg['dsh-terminal']
  if reg == nil then
    reg = API.register({ id = 'dsh-terminal', name = 'host terminal' })
  end
  return reg
end

--- id -> { buf, win, tab }
local views = {}

local function valid(handle)
  return handle ~= nil and vim.api.nvim_buf_is_valid(handle)
end

local function find(id)
  local v = views[id]
  if v == nil or not valid(v.buf) then
    views[id] = nil
    return nil
  end
  return v
end

local function focus(v)
  if v.win ~= nil and vim.api.nvim_win_is_valid(v.win) then
    vim.api.nvim_set_current_win(v.win)
  elseif v.tab ~= nil and vim.api.nvim_tabpage_is_valid(v.tab) then
    vim.api.nvim_set_current_tabpage(v.tab)
  end
end

local function rpc(method, id)
  local S = require('dsh_tui.state')
  if S.channel then vim.rpcnotify(S.channel, method, id) end
end

--- Open (or focus) the console buffer for one host session.
function M.open(id, title)
  local existing = find(id)
  if existing ~= nil then
    focus(existing)
    return { buf = existing.buf, win = existing.win }
  end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.bo[buf].modifiable = false
  pcall(vim.api.nvim_buf_set_name, buf, 'terminal://' .. tostring(title or id))
  -- A split, NOT a tab: tabclose left nvim unable to re-enter insert mode via
  -- :startinsert (mode stayed normal until a real key arrived), and the chat
  -- layout is nicer when the terminal and input stay visible together.
  -- noautocmd: the layout guard must not see a half-built foreign window
  -- between split creation and ownership registration.
  local winBefore = vim.api.nvim_get_current_win()
  local splitOk = pcall(vim.cmd, 'noautocmd split')
  local win = vim.api.nvim_get_current_win()
  if not splitOk or win == winBefore then
    pcall(vim.api.nvim_buf_delete, buf, { force = true })
    return false, 'could not create the terminal split'
  end
  vim.api.nvim_win_set_buf(win, buf)
  pcall(vim.cmd, 'resize 15')
  local reg = ensure_reg()
  if reg ~= nil then
    reg.windows[win] = 'tab'
    reg.buffers[buf] = true
  end
  vim.b[buf].dsh_terminal_id = id
  vim.wo[win].number = false
  vim.wo[win].relativenumber = false
  vim.wo[win].signcolumn = 'no'
  vim.wo[win].wrap = false
  vim.wo[win].winbar = ' TERMINAL · <CR> 输入 · <C-c> SIGINT · K kill · q 关闭 '
  vim.api.nvim_buf_set_keymap(buf, 'n', '<CR>', '<Cmd>lua require("dsh_tui").terminal_input()<CR>', { noremap = true, silent = true })
  vim.api.nvim_buf_set_keymap(buf, 'n', 'i', '<Cmd>lua require("dsh_tui").terminal_input()<CR>', { noremap = true, silent = true })
  vim.api.nvim_buf_set_keymap(buf, 'n', 'a', '<Cmd>lua require("dsh_tui").terminal_input()<CR>', { noremap = true, silent = true })
  vim.api.nvim_buf_set_keymap(buf, 'n', '<C-c>', '<Cmd>lua require("dsh_tui").terminal_signal()<CR>', { noremap = true, silent = true })
  vim.api.nvim_buf_set_keymap(buf, 'n', 'K', '<Cmd>lua require("dsh_tui").terminal_kill()<CR>', { noremap = true, silent = true })
  vim.api.nvim_buf_set_keymap(buf, 'n', 'q', '<Cmd>lua require("dsh_tui").terminal_close()<CR>', { noremap = true, silent = true })
  views[id] = { buf = buf, win = win, id = id }
  -- A user can close the split with :q instead of our q mapping; tell the
  -- runner to stop polling, or it would keep reading a PTY with no view.
  vim.api.nvim_create_autocmd('BufWipeout', {
    buffer = buf,
    once = true,
    callback = function()
      local state = require('dsh_tui.state')
      if state.channel then vim.rpcnotify(state.channel, 'dsh-terminal-close', id) end
    end,
  })
  return { buf = buf, win = win }
end

--- Replace the console contents. `status` is a short string shown on the bar.
function M.update(id, text, status)
  local v = find(id)
  if v == nil then return end
  local lines = vim.split(tostring(text or ''), '\n', { plain = true })
  if #lines > 1 and lines[#lines] == '' then table.remove(lines) end
  if #lines == 0 then lines = { '' } end
  local wasBottom = false
  if v.win ~= nil and vim.api.nvim_win_is_valid(v.win) then
    local cur = vim.api.nvim_win_get_cursor(v.win)
    wasBottom = cur[1] >= vim.api.nvim_buf_line_count(v.buf) - 1
  end
  vim.bo[v.buf].modifiable = true
  vim.api.nvim_buf_set_lines(v.buf, 0, -1, false, lines)
  vim.bo[v.buf].modifiable = false
  if v.win ~= nil and vim.api.nvim_win_is_valid(v.win) then
    if wasBottom then
      pcall(vim.api.nvim_win_set_cursor, v.win, { #lines, 0 })
    end
    if type(status) == 'string' and status ~= '' then
      vim.wo[v.win].winbar = ' TERMINAL · ' .. status .. ' · <CR> 输入 · <C-c> SIGINT · K kill · q 关闭 '
    end
  end
end

--- Close the VIEW only; the host PTY keeps running.
function M.close(id)
  local v = find(id)
  if v == nil then return end
  views[id] = nil
  local wasCurrent = v.win ~= nil and vim.api.nvim_win_is_valid(v.win)
    and vim.api.nvim_get_current_win() == v.win
  if v.win ~= nil and vim.api.nvim_win_is_valid(v.win) then
    local reg = require('dsh_tui.state').extReg['dsh-terminal']
    if reg ~= nil then
      reg.windows[v.win] = nil
      reg.buffers[v.buf] = nil
    end
    pcall(vim.api.nvim_win_close, v.win, true)
  end
  -- Hand focus (and insert mode) back to the chat input; the closed window
  -- otherwise leaves whatever nvim picked as the next window active.
  if wasCurrent then
    vim.schedule(function()
      pcall(function() require('dsh_tui.input').focus() end)
    end)
  end
end

--- Native nvim terminal (local shell, NOT visible to the model).
function M.native()
  pcall(vim.cmd, 'noautocmd split')
  local win = vim.api.nvim_get_current_win()
  vim.cmd('terminal')
  pcall(vim.cmd, 'resize 15')
  local reg = ensure_reg()
  if reg ~= nil then
    reg.windows[win] = 'tab'
    reg.buffers[vim.api.nvim_get_current_buf()] = true
  end
end

--- Keybinding entry points: take the session id from the buffer-local
--- `b:dsh_terminal_id`, set by open().
local function id_of_current()
  local id = vim.b.dsh_terminal_id
  return type(id) == 'string' and id or nil
end

function M.input(id)
  local sid = id or id_of_current()
  if sid ~= nil then rpc('dsh-terminal-input', sid) end
end

function M.signal(id)
  local sid = id or id_of_current()
  if sid ~= nil then rpc('dsh-terminal-signal', sid) end
end

function M.kill(id)
  local sid = id or id_of_current()
  if sid ~= nil then rpc('dsh-terminal-kill', sid) end
end

function M.close_current(id)
  local sid = id or id_of_current()
  if sid ~= nil then rpc('dsh-terminal-close', sid) end
end

return M
