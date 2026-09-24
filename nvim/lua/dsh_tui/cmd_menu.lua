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
  '/layout',
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
  require('dsh_tui.popup_core').lock_jump_keys(buf) -- floats inherit the jumplist: no buffer swaps
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
  -- Hint surfaces follow every keystroke, including the ones that close the
  -- menu (a space after the command name) — that is exactly when the user needs
  -- to know what goes next.
  pcall(CM.refresh_hints, text)
  local prefix = text:match('^(/[%w-]*)')
  if prefix == nil or #text ~= #prefix then
    -- Past the command name: offer the ARGUMENT candidates in the same menu, so
    -- `/plugin <Tab>` picks a subcommand exactly like the command menu picks a
    -- command. A free-form argument has no candidates — then only the hint
    -- surfaces speak (a menu with nothing to choose would be noise).
    local sug = CM.suggest(text)
    if sug ~= nil and #sug.values > 0 then
      local arg_matches = {}
      for _, v in ipairs(sug.values) do
        arg_matches[#arg_matches + 1] = { name = v, desc = sug.arg and (sug.arg.hint or '') or '' }
      end
      S.cmdMatches = arg_matches
      S.cmdIdx = 1
      S.cmdArgMode = true
      -- The token being replaced ('' right after a space → a fresh token).
      S.cmdArgPartial = text:match('(%S*)$') or ''
      local ok = pcall(function()
        if not CM.open() then open_menu() else render() end
      end)
      if not ok then CM.close() end
      return
    end
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
  -- Command-NAME mode: the argument-mode marker must not leak in here, or the
  -- accept path would try to splice an argument into a bare command draft.
  S.cmdArgMode = false
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
--- Find the catalog entry for a command name (nil when unknown).
local function entry_for(name)
  for _, e in ipairs(entries()) do
    if e.name == name then return e end
  end
  return nil
end

--- Parse a draft into { name, tokens, argIndex, partial, hasTrailingSpace }.
--- tokens are the whitespace-separated tokens AFTER the command name; argIndex
--- is 1-based (the argument currently being typed). A trailing space means the
--- user finished a token, so the next one starts empty.
local function parse_draft(text)
  local name = text:match('^(/[%w-]+)')
  if name == nil then return nil end
  local rest = text:sub(#name + 1)
  if rest:sub(1, 1) ~= ' ' then return nil end
  local tokens, partial, trailing = {}, '', false
  for tok in rest:gmatch('%S+') do tokens[#tokens + 1] = tok end
  if rest:match('%s$') then
    trailing = true
  else
    partial = tokens[#tokens] or ''
    if #tokens > 0 then table.remove(tokens) end
  end
  return {
    name = name,
    tokens = tokens,
    argIndex = #tokens + 1,
    partial = partial,
    trailing = trailing,
  }
end

--- Candidates for the token currently being typed, or nil when the command has
--- no argument metadata (then the caller must behave exactly as before).
---
--- @return table|nil { entry, argIndex, arg, values, hint, done }
function CM.suggest(text)
  local p = parse_draft(text or '')
  if p == nil then return nil end
  local e = entry_for(p.name)
  if e == nil or type(e.args) ~= 'table' then return nil end
  local arg = e.args[p.argIndex]
  -- Past the declared arguments: nothing left to suggest, but keep the usage
  -- line visible so the user can still see the full shape.
  if arg == nil then
    return { entry = e, argIndex = p.argIndex, arg = nil, values = {}, done = true }
  end
  local values = {}
  if arg.kind == 'oneof' then
    for _, v in ipairs(arg.values or {}) do
      if v:sub(1, #p.partial) == p.partial then values[#values + 1] = v end
    end
  elseif arg.kind == 'flag' then
    if arg.value:sub(1, #p.partial) == p.partial then values[#values + 1] = arg.value end
  end
  -- Flags are position-INDEPENDENT: users type `--latest` after the spec, i.e.
  -- one argument slot past the one the flag is declared in. Offer every flag
  -- whose name still matches what is being typed, wherever the cursor is.
  -- Measured need: `/plugin install --` must offer `--latest`.
  if p.partial:sub(1, 1) == '-' then
    for _, candidate in ipairs(e.args) do
      if candidate.kind == 'flag' and candidate.value ~= arg.value
        and candidate.value:sub(1, #p.partial) == p.partial then
        values[#values + 1] = candidate.value
      end
    end
  end
  return { entry = e, argIndex = p.argIndex, arg = arg, values = values, done = false }
end

--- One-line "what to type next" text for the hint bar / floating hint.
--- Returns nil when there is nothing useful to show.
function CM.hint(text)
  local s = CM.suggest(text)
  if s == nil then return nil end
  local arg = s.arg
  if arg == nil then return s.entry.usage end
  if arg.kind == 'oneof' then
    local parts = {}
    for _, v in ipairs(arg.values or {}) do parts[#parts + 1] = v end
    local joined = table.concat(parts, ' │ ')
    if arg.hint and arg.hint ~= '' then
      return joined .. '   ' .. arg.hint
    end
    return joined
  end
  if arg.kind == 'flag' then
    return arg.value .. (arg.hint and ('   ' .. arg.hint) or '')
  end
  -- free / file: label plus the producer's explanation.
  local label = arg.label or '<arg>'
  if arg.hint and arg.hint ~= '' then return label .. '   ' .. arg.hint end
  return label
end

--- The static hint bar, restored when a draft has nothing command-specific.
local BASE_HINT = '%#DshTuiBorder#╰─%#DshTuiStatus# Enter 发送 · C-cr 换行 · C-e 全屏 · C-c 停止 · / 命令菜单 · C-o 面板 %#DshTuiBorder#%=─╯'

--- Swap the input window's hint bar between the static key list and the
--- command-specific "what to type next" line. The bar is the input window's
--- statusline: it is always visible while typing, which is exactly where the
--- answer to "what goes here?" belongs.
local function refresh_hint_bar(text)
  if S.input_win == nil or not vim.api.nvim_win_is_valid(S.input_win) then return end
  local hint = (text ~= nil and text:match('^/')) and CM.hint(text) or nil
  local line
  if hint == nil or hint == '' then
    line = BASE_HINT
  else
    -- Keep the trailing edge of the frame: the hint replaces only the middle.
    line = '%#DshTuiBorder#╰─%#DshTuiStatus# ' .. hint
      .. ' %#DshTuiBorder#%=─╯'
  end
  if line == S.cmdHintLine then return end
  S.cmdHintLine = line
  pcall(vim.api.nvim_win_set_option, S.input_win, 'statusline', line)
end

--- Floating "what to type next" panel above the input box, shown only while a
--- command draft has argument metadata. Deliberately passive: it never steals
--- focus and never intercepts keys — the <Tab> menu keeps that job.
local HINT_NS = vim.api.nvim_create_namespace('dsh_tui_cmd_hint')
local hint_buf, hint_win = nil, nil

local function close_float()
  if hint_win ~= nil and vim.api.nvim_win_is_valid(hint_win) then
    pcall(vim.api.nvim_win_close, hint_win, true)
  end
  hint_win = nil
  if hint_buf ~= nil and vim.api.nvim_buf_is_valid(hint_buf) then
    pcall(vim.api.nvim_buf_delete, hint_buf, { force = true })
  end
  hint_buf = nil
end

local function show_float(text)
  local hint = (text ~= nil and text:match('^/')) and CM.hint(text) or nil
  if hint == nil or hint == '' or S.input_win == nil
    or not vim.api.nvim_win_is_valid(S.input_win) then
    close_float()
    return
  end
  pcall(function()
    if hint_buf == nil or not vim.api.nvim_buf_is_valid(hint_buf) then
      hint_buf = vim.api.nvim_create_buf(false, true)
      vim.bo[hint_buf].bufhidden = 'wipe'
    end
    vim.api.nvim_buf_set_lines(hint_buf, 0, -1, false, { ' ' .. hint .. ' ' })
    vim.api.nvim_buf_clear_namespace(hint_buf, HINT_NS, 0, -1)
    vim.api.nvim_buf_set_extmark(hint_buf, HINT_NS, 0, 0, {
      end_col = #hint + 2,
      hl_group = 'DshTuiCmdHint',
    })
    local width = math.min(#hint + 2, math.max(10, vim.o.columns - 4))
    local pos = vim.api.nvim_win_get_position(S.input_win)
    local row = math.max(0, pos[1] - 1)
    local cfg = {
      relative = 'editor',
      row = row,
      col = pos[2],
      width = width,
      height = 1,
      style = 'minimal',
      focusable = false,
      noautocmd = true,
      zindex = 5,
    }
    if hint_win ~= nil and vim.api.nvim_win_is_valid(hint_win) then
      vim.api.nvim_win_set_config(hint_win, cfg)
    else
      hint_win = vim.api.nvim_open_win(hint_buf, false, cfg)
      vim.wo[hint_win].winblend = 0
    end
  end)
end

--- Public: refresh both hint surfaces for a draft (no-op for non-command text).
function CM.refresh_hints(text)
  refresh_hint_bar(text)
  show_float(text)
end

--- Public: close the floating hint (layout rebuilds, submit, teardown).
function CM.close_hint()
  close_float()
end

return CM
