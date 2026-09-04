--- dsh_tui.cmd_menu: the slash-command completion float. Typing '/' opens a
--- floating menu above the input line listing every harness command with a
--- description (catalog pushed by the Node runner via set_catalog; a builtin
--- fallback keeps the menu useful before/without it). Keystrokes filter the
--- list live: <Tab>/<C-n> move the selection down, <S-Tab>/<C-p> up, <CR>
--- completes the selected command (or executes it when its name is already
--- typed in full), <Esc> closes the menu and stays in insert mode.
---
--- The @-mention menu (dsh_tui.at_menu) reuses win_config for its geometry.
--- User-intent routing between the two menus (cmd_next / cmd_prev / submit)
--- lives in init.lua — the facade — so this module stays a pure leaf.
local S = require('dsh_tui.state')
local B = require('dsh_tui.buffer')
local CM = {}

local NS = vim.api.nvim_create_namespace('dsh_tui_cmd')
local MAX_H = 10 -- visible rows before the menu scrolls

-- Commands available before the runner pushes its catalog (names only).
local FALLBACK = {
  '/exit', '/quit', '/restart', '/help', '/clear', '/new', '/sessions',
  '/panel', '/fork', '/branch', '/btw', '/model', '/effort',
  '/preset', '/yolo', '/density', '/glance', '/cost', '/export',
  '/config', '/remember', '/memory', '/image', '/doctor', '/theme', '/status',
  '/tasks', '/subagents', '/workflow', '/skills', '/mcp', '/goal',
  '/compact', '/rewind', '/stop', '/steer', '/plan', '/search', '/rename', '/fb',
  '/permission', '/attach', '/deliverables', '/settings', '/trajectory',
  '/layout', '/bell',
}

--- Replace the completion catalog (called by the Node runner after attach).
function CM.set_catalog(list)
  S.cmdCatalog = list
end

local function entries()
  local out = {}
  local base = S.cmdCatalog
  if type(base) == 'table' and #base > 0 then
    for _, e in ipairs(base) do
      out[#out + 1] = e
    end
  else
    for _, n in ipairs(FALLBACK) do
      out[#out + 1] = { name = n, desc = '' }
    end
  end
  -- Lua-side extension commands (api.register_command): merged on every
  -- read, so a later runner catalog refresh can never wipe them.
  for _, c in pairs(S.extCommands) do
    out[#out + 1] = { name = c.name, desc = c.desc or '' }
  end
  return out
end

function CM.open()
  return S.cmdWin ~= nil and vim.api.nvim_win_is_valid(S.cmdWin)
end

--- Close the completion menu (public: submit / keymaps / tests).
function CM.close()
  if S.cmdWin and vim.api.nvim_win_is_valid(S.cmdWin) then
    pcall(vim.api.nvim_win_close, S.cmdWin, true)
  end
  S.cmdWin = nil
  S.cmdBuf = nil
  S.cmdMatches = {}
  S.cmdIdx = 0
  S.cmdTop = 1
end

--- Introspection for keymaps and tests.
function CM.state()
  local names = {}
  for _, e in ipairs(S.cmdMatches) do
    names[#names + 1] = e.name
  end
  return {
    open = CM.open(),
    idx = S.cmdIdx,
    top = S.cmdTop,
    names = names,
    selected = S.cmdMatches[S.cmdIdx] and S.cmdMatches[S.cmdIdx].name or nil,
  }
end

--- The input-anchored geometry shared with the @-mention menu: a float
--- sitting directly above the input window.
function CM.win_config(count, width, extra)
  local cfg = {
    relative = 'win',
    win = S.input_win,
    anchor = 'NW',
    row = -count - 2, -- menu + border rows sit directly above the input
    col = 0,
    width = width,
    height = count,
    border = 'rounded',
    style = 'minimal',
    focusable = false,
  }
  -- Creation-only keys (nvim_win_set_config must not see them on older nvim).
  if extra and extra.noautocmd then
    cfg.noautocmd = true
  end
  if extra and extra.title and vim.fn.has('nvim-0.9') == 1 then
    cfg.title = extra.titleText or ' 命令补全 '
    cfg.title_pos = 'center'
  end
  return cfg
end

local function render()
  local win = S.cmdWin
  if not (win and vim.api.nvim_win_is_valid(win)) then
    S.cmdWin = nil
    return
  end
  if not (S.input_win and vim.api.nvim_win_is_valid(S.input_win)) then
    CM.close()
    return
  end
  local buf = S.cmdBuf
  local n = #S.cmdMatches
  if n == 0 then
    CM.close()
    return
  end
  if S.cmdIdx < 1 then S.cmdIdx = 1 end
  if S.cmdIdx > n then S.cmdIdx = n end
  -- Scroll the window so the selection is always visible (MAX_H rows).
  local maxH = math.min(MAX_H, n)
  local top = S.cmdTop or 1
  if top > S.cmdIdx then top = S.cmdIdx end
  if top <= S.cmdIdx - maxH then top = S.cmdIdx - maxH + 1 end
  S.cmdTop = top
  local count = math.min(maxH, n - top + 1)
  local width = 24
  local rows = {}
  for i = 0, count - 1 do
    local e = S.cmdMatches[top + i]
    local line = e.name .. '  ' .. (e.desc or '')
    width = math.max(width, vim.fn.strdisplaywidth(line) + 2)
    rows[#rows + 1] = line
  end
  width = math.min(width, math.max(12, vim.o.columns - 4))
  for i, line in ipairs(rows) do
    rows[i] = line .. string.rep(' ', width - vim.fn.strdisplaywidth(line))
  end
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, rows)
  vim.bo[buf].modifiable = false
  vim.api.nvim_buf_clear_namespace(buf, NS, 0, -1)
  for i = 0, count - 1 do
    local e = S.cmdMatches[top + i]
    local nameW = vim.fn.strdisplaywidth(e.name)
    local sel = (top + i) == S.cmdIdx
    if sel then
      vim.api.nvim_buf_set_extmark(buf, NS, i, 0, {
        hl_group = 'DshTuiCmdSel',
        end_row = i,
        end_col = width,
        priority = 10,
      })
    end
    vim.api.nvim_buf_set_extmark(buf, NS, i, 0, {
      hl_group = sel and 'DshTuiCmdSelName' or 'DshTuiCmdName',
      end_col = nameW,
      priority = 20,
    })
    vim.api.nvim_buf_set_extmark(buf, NS, i, nameW + 2, {
      hl_group = sel and 'DshTuiCmdSelDesc' or 'DshTuiCmdDesc',
      priority = 20,
    })
  end
  vim.api.nvim_win_set_config(win, CM.win_config(count, width))
end

local function open_menu()
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.bo[buf].undolevels = -1
  vim.b[buf].ministatusline_disable = true
  S.cmdBuf = buf
  S.cmdWin = vim.api.nvim_open_win(buf, false,
    CM.win_config(math.min(MAX_H, #S.cmdMatches), 30, { noautocmd = true, title = true }))
  render()
end

--- Refresh the menu from the input text (TextChangedI hook + tests). When
--- `text` is nil it is read from the input buffer. The menu is visible only
--- while the input is a bare slash prefix (no args).
function CM.update(text)
  if S.input_buf == nil or not vim.api.nvim_buf_is_valid(S.input_buf) then
    return
  end
  text = text or B.input_text()
  local prefix = text:match('^(/[%w-]*)')
  if prefix == nil or #text ~= #prefix then
    CM.close()
    return
  end
  local matches = {}
  for _, e in ipairs(entries()) do
    if e.name:sub(1, #prefix) == prefix then
      matches[#matches + 1] = { name = e.name, desc = e.desc or '' }
    end
  end
  if #matches == 0 then
    CM.close()
    return
  end
  -- Keep the current selection when it survives the new filter, else start
  -- at the first match; a fully typed name always selects itself.
  local prev = S.cmdMatches[S.cmdIdx]
  S.cmdMatches = matches
  S.cmdIdx = 1
  if prev then
    for i, e in ipairs(matches) do
      if e.name == prev.name then
        S.cmdIdx = i
        break
      end
    end
  end
  for i, e in ipairs(matches) do
    if e.name == prefix then
      S.cmdIdx = i
      break
    end
  end
  if S.cmdTop > #matches then S.cmdTop = #matches end
  local ok = pcall(function()
    if not CM.open() then
      open_menu()
    else
      render()
    end
  end)
  if not ok then
    CM.close() -- a broken menu must never break typing
  end
end

--- <Tab>/<C-n>: advance the selection. With no menu open, open it when the
--- input is a bare slash prefix; otherwise insert a literal <Tab>. (The
--- @-mention menu priority is composed in init.lua's cmd_next.)
function CM.next()
  if not CM.open() then
    CM.update()
    if not CM.open() then
      vim.api.nvim_feedkeys(
        vim.api.nvim_replace_termcodes('<Tab>', true, false, true), 'n', false)
    end
    return
  end
  S.cmdIdx = S.cmdIdx % #S.cmdMatches + 1
  render()
end

--- <S-Tab>/<C-p>: move the selection back.
function CM.prev()
  if not CM.open() then
    return
  end
  S.cmdIdx = (S.cmdIdx + #S.cmdMatches - 2) % #S.cmdMatches + 1
  render()
end

return CM
