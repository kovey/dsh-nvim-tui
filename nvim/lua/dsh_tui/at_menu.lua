--- dsh_tui.at_menu: the @-file-reference completion float. Typing `@` above
--- the input line asks the runner for file/directory candidates (official
--- fileReferences service or a local fs walk); the answer arrives via
--- set(). <CR> accepts: the @token is replaced with the formatted mention
--- (@path / @"path with spaces"). Shares the cmd menu's input-anchored
--- geometry (cmd_menu.win_config) and its highlight groups.
local S = require('dsh_tui.state')
local CM = require('dsh_tui.cmd_menu')
local I = require('dsh_tui.input')
local AM = {}

local NS = vim.api.nvim_create_namespace('dsh_tui_at')
local MAX_H = 8

function AM.open()
  return S.atWin ~= nil and vim.api.nvim_win_is_valid(S.atWin)
end

function AM.close()
  if S.atWin and vim.api.nvim_win_is_valid(S.atWin) then
    pcall(vim.api.nvim_win_close, S.atWin, true)
  end
  S.atWin = nil
  S.atBuf = nil
  S.atItems = {}
  S.atIdx = 0
  S.atTop = 1
  S.atStart = 0
end

local function render()
  local win = S.atWin
  if not (win and vim.api.nvim_win_is_valid(win)) then
    S.atWin = nil
    return
  end
  if not (S.input_win and vim.api.nvim_win_is_valid(S.input_win)) then
    AM.close()
    return
  end
  local n = #S.atItems
  if n == 0 then
    AM.close()
    return
  end
  if S.atIdx < 1 then S.atIdx = 1 end
  if S.atIdx > n then S.atIdx = n end
  local maxH = math.min(MAX_H, n)
  local top = S.atTop or 1
  if top > S.atIdx then top = S.atIdx end
  if top <= S.atIdx - maxH then top = S.atIdx - maxH + 1 end
  S.atTop = top
  local count = math.min(maxH, n - top + 1)
  local width = 24
  local rows = {}
  for i = 0, count - 1 do
    local e = S.atItems[top + i]
    rows[#rows + 1] = e.path
    width = math.max(width, vim.fn.strdisplaywidth(e.path) + 2)
  end
  width = math.min(width, math.max(12, vim.o.columns - 4))
  for i, line in ipairs(rows) do
    rows[i] = line .. string.rep(' ', width - vim.fn.strdisplaywidth(line))
  end
  local buf = S.atBuf
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, rows)
  vim.bo[buf].modifiable = false
  vim.api.nvim_buf_clear_namespace(buf, NS, 0, -1)
  for i = 0, count - 1 do
    if (top + i) == S.atIdx then
      vim.api.nvim_buf_set_extmark(buf, NS, i, 0, {
        hl_group = 'DshTuiCmdSel', end_row = i, end_col = width, priority = 10 })
    end
    vim.api.nvim_buf_set_extmark(buf, NS, i, 0, {
      hl_group = (top + i) == S.atIdx and 'DshTuiCmdSelName' or 'DshTuiCmdName',
      end_col = vim.fn.strdisplaywidth(S.atItems[top + i].path),
      priority = 20 })
  end
  vim.api.nvim_win_set_config(win, CM.win_config(count, width))
end

--- Candidates from the runner (dsh-at-query response). start = '@' offset.
function AM.set(items, start)
  S.atItems = items or {}
  S.atIdx = 1
  S.atTop = 1
  S.atStart = start or 0
  if #S.atItems == 0 then
    AM.close()
    return
  end
  local ok = pcall(function()
    if not AM.open() then
      local buf = vim.api.nvim_create_buf(false, true)
      vim.bo[buf].buftype = 'nofile'
      vim.bo[buf].bufhidden = 'wipe'
      vim.bo[buf].swapfile = false
      vim.b[buf].ministatusline_disable = true
      S.atBuf = buf
      S.atWin = vim.api.nvim_open_win(buf, false,
        CM.win_config(math.min(MAX_H, #S.atItems), 30,
          { noautocmd = true, title = true, titleText = ' @ 提及 ' }))
    end
    render()
  end)
  if not ok then AM.close() end
end

function AM.next()
  if not AM.open() then return end
  S.atIdx = S.atIdx % #S.atItems + 1
  render()
end

function AM.prev()
  if not AM.open() then return end
  S.atIdx = (S.atIdx + #S.atItems - 2) % #S.atItems + 1
  render()
end

--- Accept the selected @-mention: replace the token in the input line.
function AM.accept()
  local sel = S.atItems[S.atIdx]
  local start = S.atStart
  AM.close()
  if sel == nil or S.input_buf == nil or not vim.api.nvim_buf_is_valid(S.input_buf) then
    return
  end
  local lines = vim.api.nvim_buf_get_lines(S.input_buf, 0, -1, false)
  local cur = vim.api.nvim_win_get_cursor(S.input_win)
  local line = lines[cur[1]] or ''
  local mention = sel.mention
  local col = math.min(cur[2], #line)
  local newline = line:sub(1, start) .. mention .. line:sub(col + 1)
  lines[cur[1]] = newline
  vim.api.nvim_buf_set_lines(S.input_buf, 0, -1, false, lines)
  vim.api.nvim_win_set_cursor(S.input_win, { cur[1], start + #mention })
  I.resize()
end

--- Detect an active @token before the cursor; asks the runner for candidates.
function AM.update()
  if S.input_buf == nil or not vim.api.nvim_buf_is_valid(S.input_buf) then
    AM.close()
    return
  end
  local cur = vim.api.nvim_win_get_cursor(S.input_win)
  local line = vim.api.nvim_buf_get_lines(S.input_buf, cur[1] - 1, cur[1], false)[1] or ''
  local before = line:sub(1, cur[2])
  local s, pre, query = before:match('()(%A)@([^%s"\'@]*)$')
  if s == nil then
    AM.close()
    return
  end
  if S.channel then
    vim.rpcnotify(S.channel, 'dsh-at-query', { query = query })
  end
end

return AM
