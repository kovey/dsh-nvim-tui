-- dsh_tui: the Neovim-side UI of dsh-nvim-tui.
--
-- Three-window layout:
--   +--------------+---------------------------+
--   | sessions     | chat (active session)     |
--   | (24 cols)    |                           |
--   |              +---------------------------+
--   |              | input (buftype=prompt)    |
--   +--------------+---------------------------+
--
-- The Node runner drives this side over msgpack-RPC: it hands us its channel
-- id via attach(), creates one chat buffer per session (ensure_chat), renders
-- the session list (set_sessions), switches the visible chat (set_active),
-- renders DSH events into the right chat buffer (buf_set_lines), and receives
-- user input / slash commands / session selection as rpcnotify.

local M = {}

local chat_win
local input_buf, input_win

M._channel = nil
M._started = false
M._chats = {}          -- session id -> chat buffer
M._reasoningBufs = {}  -- session id -> reasoning buffer
M._reasoningWin = nil  -- the (optional) reasoning panel window
M._reasoningOpen = false
M._activeId = nil
M._sessionLines = {}   -- list line number -> session id
M._ns = vim.api.nvim_create_namespace('dsh_tui')

M._statuslineText = nil

local function apply_statusline()
  if chat_win and vim.api.nvim_win_is_valid(chat_win) and M._statuslineText ~= nil then
    -- pcall: a malformed string must never pop the E539 hit-enter prompt.
    pcall(vim.api.nvim_win_set_option, chat_win, 'statusline', M._statuslineText)
  end
end

--- Set the chat window statusline (Node drives the content). The text is
--- stored so window events can re-apply it — statusline plugins
--- (mini.statusline, lualine, …) rewrite the option on every WinEnter.
function M.set_statusline(text)
  M._statuslineText = text or ''
  apply_statusline()
end

--- Terminal title (OSC 2): the runner keeps it in sync with the active
--- session so the terminal tab/window title shows what you're working on.
function M.set_title(text)
  vim.o.titlestring = (text ~= nil and text ~= '') and ('dsh · ' .. text) or 'dsh'
end

--- Re-apply after the event batch (the LAST writer wins).
function M.reschedule_statusline()
  vim.schedule(function() apply_statusline() end)
end

local function chat_buffer_options(buf)
  vim.bo[buf].buftype = 'nofile'
  -- 'hide' not 'wipe': these buffers must survive being hidden — the
  -- reasoning panel's buffer is hidden whenever the panel closes and each
  -- chat buffer is hidden when another session becomes active. 'wipe' would
  -- unload them, invalidate the ids the runner captured, and silently break
  -- every later flush (no highlights, dead panel).
  vim.bo[buf].bufhidden = 'hide'
  vim.bo[buf].swapfile = false
  vim.bo[buf].undolevels = -1 -- chat history must never be undoable ('u')
  -- Statusline plugins (mini.statusline, lualine, …) re-render the statusline
  -- on every event and would overwrite our per-window option. mini.statusline
  -- documents a per-buffer opt-out; lualine ignores disabled buffers too.
  vim.b[buf].ministatusline_disable = true
end

--- Disable the user's completion plugins (nvim-cmp etc.) for the input
--- buffer. cmp.setup.buffer applies to the CURRENT buffer, so this runs
--- inside nvim_buf_call; cmp itself lazy-loads on InsertEnter, so callers
--- retry at several later points until the override sticks.
function M.disable_external_completion()
  if input_buf == nil or not vim.api.nvim_buf_is_valid(input_buf) then
    return
  end
  vim.api.nvim_buf_call(input_buf, function()
    vim.bo.completefunc = ''
    vim.bo.omnifunc = ''
    local ok, cmp = pcall(require, 'cmp')
    if ok and type(cmp) == 'table' and type(cmp.setup) == 'table'
      and type(cmp.setup.buffer) == 'function' then
      pcall(cmp.setup.buffer, { enabled = false })
    end
  end)
end

local function make_input_buffer()
  input_buf = vim.api.nvim_create_buf(false, true)
  vim.bo[input_buf].bufhidden = 'wipe'
  vim.bo[input_buf].swapfile = false
  vim.api.nvim_buf_set_lines(input_buf, 0, -1, false, { '' })
  -- Statusline plugins (mini.statusline et al.) must not render on our
  -- windows — the per-buffer opt-out applies to every dsh_tui buffer.
  vim.b[input_buf].ministatusline_disable = true
  M.disable_external_completion()
end

M._history = {}
M._histIdx = nil
M._draft = nil

local function input_text()
  return table.concat(vim.api.nvim_buf_get_lines(input_buf, 0, -1, false), '\n')
end

local function set_input_text(text)
  local lines = vim.split(text, '\n', { plain = true })
  if #lines == 0 then
    lines = { '' }
  end
  vim.api.nvim_buf_set_lines(input_buf, 0, -1, false, lines)
  vim.api.nvim_win_set_cursor(input_win, { #lines, #(lines[#lines] or '') + 1 })
  M.resize_input()
  M.update_cmd_menu()
end

--- Dynamic input height: 1..6 rows following the content. The freed/taken
--- rows are applied to the CHAT window explicitly — nvim's split tree would
--- otherwise redistribute them to the sessions window, leaving a dead gap
--- row between the chat and the input.
function M.resize_input()
  local n = math.min(6, math.max(1, vim.api.nvim_buf_line_count(input_buf)))
  if input_win and vim.api.nvim_win_is_valid(input_win) then
    -- Input window occupies n content rows + its statusline (the hint bar).
    vim.api.nvim_win_set_height(input_win, n)
    if chat_win and vim.api.nvim_win_is_valid(chat_win) then
      local chatH = vim.o.lines - vim.o.cmdheight - (n + 1)
      if chatH >= 1 then
        vim.api.nvim_win_set_height(chat_win, chatH)
      end
    end
  end
end

--- Submit the input buffer (keymap <CR>): route slash commands, else send.
--- With the completion menu open, <CR> first completes the selected command
--- (or executes it directly when its name is already typed in full).
function M.submit()
  local text = input_text():gsub('^%s+', ''):gsub('%s+$', '')
  if text == '' then
    M.close_cmd_menu()
    M.close_at_menu()
    return
  end
  if M.at_menu_open() then
    M.at_accept()
    return
  end
  if M.cmd_menu_state().open then
    local sel = M._cmdMatches[M._cmdIdx]
    M.close_cmd_menu()
    if sel and text ~= sel.name then
      -- A bare prefix is being typed: fill the selected command and let the
      -- user continue with its arguments (a second <CR> executes it).
      set_input_text(sel.name .. ' ')
      return
    end
  end
  if M._channel then
    if text:match('^/') then
      vim.rpcnotify(M._channel, 'dsh-command', text)
    else
      vim.rpcnotify(M._channel, 'dsh-input', text)
    end
  end
  if M._history[#M._history] ~= text then
    table.insert(M._history, text)
  end
  M._histIdx = nil
  M._draft = nil
  vim.api.nvim_buf_set_lines(input_buf, 0, -1, false, { '' })
  M.resize_input()
end

local function at_last_line_end()
  local cur = vim.api.nvim_win_get_cursor(input_win)
  local line = vim.api.nvim_buf_get_lines(input_buf, cur[1] - 1, cur[1], false)[1] or ''
  -- col 0 on an empty last line counts as its end (insert-mode cursor).
  return cur[1] == vim.api.nvim_buf_line_count(input_buf) and cur[2] >= #line
end

--- <Up>/<Down> history cycling (only at the last line's end; otherwise the
--- default movement is fed through).
function M.history_move(dir)
  if not at_last_line_end() then
    vim.api.nvim_feedkeys(
      vim.api.nvim_replace_termcodes(dir < 0 and '<Up>' or '<Down>', true, false, true), 'n', false)
    return
  end
  if M._histIdx == nil then
    M._draft = input_text()
    M._histIdx = #M._history
    if M._histIdx < 1 then
      M._histIdx = nil
      M._draft = nil
      return
    end
  else
    M._histIdx = M._histIdx + dir
  end
  if M._histIdx < 1 then
    M._histIdx = 1
  end
  if M._histIdx > #M._history then
    set_input_text(M._draft or '')
    M._histIdx = nil
    M._draft = nil
    return
  end
  set_input_text(M._history[M._histIdx])
end

-- ===========================================================================
-- Slash-command completion menu
-- ===========================================================================
-- Typing '/' opens a floating menu above the input line listing every
-- harness command with a description (catalog pushed by the Node runner via
-- set_commands; a builtin fallback keeps the menu useful before/without it).
-- Keystrokes filter the list live: <Tab>/<C-n> move the selection down,
-- <S-Tab>/<C-p> up, <CR> completes the selected command (or executes it when
-- its name is already typed in full), <Esc> closes the menu and stays in
-- insert mode.

M._cmdCatalog = nil        -- { { name = ..., desc = ... }, ... } from the runner
M._cmdWin = nil            -- floating menu window
M._cmdBuf = nil            -- floating menu buffer
M._cmdMatches = {}         -- entries matching the current prefix
M._cmdIdx = 0              -- 1-based selection index
M._cmdTop = 1              -- first visible row

local CMD_NS = vim.api.nvim_create_namespace('dsh_tui_cmd')
local CMD_MAX_H = 10 -- visible rows before the menu scrolls

-- Commands available before the runner pushes its catalog (names only).
local CMD_FALLBACK = {
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
function M.set_commands(list)
  M._cmdCatalog = list
end

local function cmd_entries()
  if type(M._cmdCatalog) == 'table' and #M._cmdCatalog > 0 then
    return M._cmdCatalog
  end
  local out = {}
  for _, n in ipairs(CMD_FALLBACK) do
    out[#out + 1] = { name = n, desc = '' }
  end
  return out
end

local function cmd_menu_open()
  return M._cmdWin ~= nil and vim.api.nvim_win_is_valid(M._cmdWin)
end

--- Close the completion menu (public: submit / keymaps / tests).
function M.close_cmd_menu()
  if M._cmdWin and vim.api.nvim_win_is_valid(M._cmdWin) then
    pcall(vim.api.nvim_win_close, M._cmdWin, true)
  end
  M._cmdWin = nil
  M._cmdBuf = nil
  M._cmdMatches = {}
  M._cmdIdx = 0
  M._cmdTop = 1
end

--- Introspection for keymaps and tests.
function M.cmd_menu_state()
  local names = {}
  for _, e in ipairs(M._cmdMatches) do
    names[#names + 1] = e.name
  end
  return {
    open = cmd_menu_open(),
    idx = M._cmdIdx,
    top = M._cmdTop,
    names = names,
    selected = M._cmdMatches[M._cmdIdx] and M._cmdMatches[M._cmdIdx].name or nil,
  }
end

local function cmd_win_config(count, width, extra)
  local cfg = {
    relative = 'win',
    win = input_win,
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
    cfg.title = ' 命令补全 '
    cfg.title_pos = 'center'
  end
  return cfg
end

local function render_cmd_menu()
  local win = M._cmdWin
  if not (win and vim.api.nvim_win_is_valid(win)) then
    M._cmdWin = nil
    return
  end
  if not (input_win and vim.api.nvim_win_is_valid(input_win)) then
    M.close_cmd_menu()
    return
  end
  local buf = M._cmdBuf
  local n = #M._cmdMatches
  if n == 0 then
    M.close_cmd_menu()
    return
  end
  if M._cmdIdx < 1 then M._cmdIdx = 1 end
  if M._cmdIdx > n then M._cmdIdx = n end
  -- Scroll the window so the selection is always visible (CMD_MAX_H rows).
  local maxH = math.min(CMD_MAX_H, n)
  local top = M._cmdTop or 1
  if top > M._cmdIdx then top = M._cmdIdx end
  if top <= M._cmdIdx - maxH then top = M._cmdIdx - maxH + 1 end
  M._cmdTop = top
  local count = math.min(maxH, n - top + 1)
  local width = 24
  local rows = {}
  for i = 0, count - 1 do
    local e = M._cmdMatches[top + i]
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
  vim.api.nvim_buf_clear_namespace(buf, CMD_NS, 0, -1)
  for i = 0, count - 1 do
    local e = M._cmdMatches[top + i]
    local nameW = vim.fn.strdisplaywidth(e.name)
    local sel = (top + i) == M._cmdIdx
    if sel then
      vim.api.nvim_buf_set_extmark(buf, CMD_NS, i, 0, {
        hl_group = 'DshTuiCmdSel',
        end_row = i,
        end_col = width,
        priority = 10,
      })
    end
    vim.api.nvim_buf_set_extmark(buf, CMD_NS, i, 0, {
      hl_group = sel and 'DshTuiCmdSelName' or 'DshTuiCmdName',
      end_col = nameW,
      priority = 20,
    })
    vim.api.nvim_buf_set_extmark(buf, CMD_NS, i, nameW + 2, {
      hl_group = sel and 'DshTuiCmdSelDesc' or 'DshTuiCmdDesc',
      priority = 20,
    })
  end
  vim.api.nvim_win_set_config(win, cmd_win_config(count, width))
end

local function open_cmd_menu()
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.bo[buf].undolevels = -1
  vim.b[buf].ministatusline_disable = true
  M._cmdBuf = buf
  M._cmdWin = vim.api.nvim_open_win(buf, false,
    cmd_win_config(math.min(CMD_MAX_H, #M._cmdMatches), 30, { noautocmd = true, title = true }))
  render_cmd_menu()
end

--- Refresh the menu from the current input text (TextChangedI hook + tests).
--- The menu is visible only while the input is a bare slash prefix (no args).
function M.update_cmd_menu()
  if input_buf == nil or not vim.api.nvim_buf_is_valid(input_buf) then
    return
  end
  local text = input_text()
  local prefix = text:match('^(/[%w-]*)')
  if prefix == nil or #text ~= #prefix then
    M.close_cmd_menu()
    return
  end
  local matches = {}
  for _, e in ipairs(cmd_entries()) do
    if e.name:sub(1, #prefix) == prefix then
      matches[#matches + 1] = { name = e.name, desc = e.desc or '' }
    end
  end
  if #matches == 0 then
    M.close_cmd_menu()
    return
  end
  -- Keep the current selection when it survives the new filter, else start
  -- at the first match; a fully typed name always selects itself.
  local prev = M._cmdMatches[M._cmdIdx]
  M._cmdMatches = matches
  M._cmdIdx = 1
  if prev then
    for i, e in ipairs(matches) do
      if e.name == prev.name then
        M._cmdIdx = i
        break
      end
    end
  end
  for i, e in ipairs(matches) do
    if e.name == prefix then
      M._cmdIdx = i
      break
    end
  end
  if M._cmdTop > #matches then M._cmdTop = #matches end
  local ok = pcall(function()
    if not cmd_menu_open() then
      open_cmd_menu()
    else
      render_cmd_menu()
    end
  end)
  if not ok then
    M.close_cmd_menu() -- a broken menu must never break typing
  end
end

--- <Tab>/<C-n>: advance the selection. With no menu open, open it when the
--- input is a bare slash prefix; otherwise insert a literal <Tab>.
function M.cmd_next()
  if M.at_menu_open() then
    M.at_next()
    return
  end
  if not cmd_menu_open() then
    M.update_cmd_menu()
    if not cmd_menu_open() then
      vim.api.nvim_feedkeys(
        vim.api.nvim_replace_termcodes('<Tab>', true, false, true), 'n', false)
    end
    return
  end
  M._cmdIdx = M._cmdIdx % #M._cmdMatches + 1
  render_cmd_menu()
end

--- <S-Tab>/<C-p>: move the selection back.
function M.cmd_prev()
  if M.at_menu_open() then
    M.at_prev()
    return
  end
  if not cmd_menu_open() then
    return
  end
  M._cmdIdx = (M._cmdIdx + #M._cmdMatches - 2) % #M._cmdMatches + 1
  render_cmd_menu()
end

--- <C-v> clipboard-image paste: ask the runner to read the clipboard image
--- (macOS pbpaste) and queue it for the next submit.
function M.paste_image()
  if M._channel then
    vim.rpcnotify(M._channel, 'dsh-paste-image')
  end
end

--- <C-c> stop: ask the runner to abort the running turn (no-op when idle).
function M.abort_turn()
  if M._channel then
    vim.rpcnotify(M._channel, 'dsh-abort')
  end
end

--- Scrollable skill-detail float (from /skills). Esc/q closes.
function M.show_skill(info)
  local lines = { '🛠 ' .. tostring(info.name or '') .. ' — ' .. tostring(info.description or '') }
  if info.whenToUse ~= nil and info.whenToUse ~= '' then
    lines[#lines + 1] = '适用: ' .. tostring(info.whenToUse)
  end
  lines[#lines + 1] = ''
  for _, l in ipairs(vim.split(tostring(info.content or ''), '\n', { plain = true })) do
    lines[#lines + 1] = l
  end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  local cfg = {
    relative = 'editor',
    row = 1,
    col = 2,
    width = math.min(120, math.max(40, vim.o.columns - 4)),
    height = math.min(32, math.max(8, vim.o.lines - 4)),
    border = 'rounded',
    style = 'minimal',
  }
  if vim.fn.has('nvim-0.9') == 1 then
    cfg.title = ' 技能详情 '
    cfg.title_pos = 'center'
  end
  local win = vim.api.nvim_open_win(buf, true, cfg)
  vim.wo[win].cursorline = true
  vim.keymap.set('n', 'q', '<Cmd>lua require("dsh_tui").close_skill()<CR>', { buffer = buf })
  vim.keymap.set('n', '<Esc>', '<Cmd>lua require("dsh_tui").close_skill()<CR>', { buffer = buf })
  vim.api.nvim_win_set_cursor(win, { 1, 0 })
  vim.cmd('stopinsert') -- the input window hands over in insert mode
  M._skillWin = win
end

--- Close the skill-detail float (also restores focus to the input).
function M.close_skill()
  if M._skillWin and vim.api.nvim_win_is_valid(M._skillWin) then
    pcall(vim.api.nvim_win_close, M._skillWin, true)
  end
  M._skillWin = nil
  if input_win and vim.api.nvim_win_is_valid(input_win) then
    vim.api.nvim_set_current_win(input_win)
    vim.cmd('startinsert')
  end
end

-- ---------------------------------------------------------------------------
-- Subagent transcript view: one read-only float whose buffer the runner's
-- FeedRenderer replays a child session into (reasoning inline + chat + tool
-- cards). q/Esc close; editing keys are Nop'd (the buffer stays modifiable
-- because the renderer writes through the API, which respects 'modifiable').
-- ---------------------------------------------------------------------------
M._subagentView = { buf = nil, win = nil }

function M.open_subagent_view(title)
  -- Replace any previous view silently (the runner initiated the swap).
  -- The old buffer must be wiped too: with 'hide' it survives the window
  -- close, and the NEXT open's nvim_buf_set_name would collide on
  -- 'dsh-subagent-view' (E95) — the second open silently failed.
  local prev = M._subagentView
  if prev.win and vim.api.nvim_win_is_valid(prev.win) then
    pcall(vim.api.nvim_win_close, prev.win, true)
  end
  if prev.buf and vim.api.nvim_buf_is_valid(prev.buf) then
    pcall(vim.api.nvim_buf_delete, prev.buf, { force = true })
  end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(buf, 'dsh-subagent-view')
  vim.bo[buf].buftype = 'nofile'
  -- 'wipe' not 'hide': the view buffer is single-use — wiping it on close
  -- is what keeps the buffer name free for the next open.
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  local cfg = {
    relative = 'editor',
    row = 2,
    col = 2,
    width = math.min(120, math.max(40, vim.o.columns - 4)),
    height = math.min(40, math.max(8, vim.o.lines - 4)),
    border = 'rounded',
    style = 'minimal',
    zindex = 45,
  }
  if vim.fn.has('nvim-0.9') == 1 then
    cfg.title = ' 子代理 · ' .. tostring(title or '') .. ' '
    cfg.title_pos = 'center'
  end
  local win = vim.api.nvim_open_win(buf, true, cfg)
  vim.wo[win].cursorline = true
  vim.wo[win].number = false
  vim.wo[win].signcolumn = 'no'
  vim.cmd('stopinsert') -- input window hands over in insert mode
  for _, k in ipairs({ 'i', 'a', 'o', 'O', 'I', 'A', 'r', 'R', 's', 'S', 'c', 'C', 'd', 'D', 'x', 'X', 'p', 'P', '<Insert>', ':' }) do
    vim.keymap.set('n', k, '<Nop>', { buffer = buf })
  end
  vim.keymap.set('n', 'q', '<Cmd>lua require("dsh_tui").close_subagent_view()<CR>', { buffer = buf })
  vim.keymap.set('n', '<Esc>', '<Cmd>lua require("dsh_tui").close_subagent_view()<CR>', { buffer = buf })
  M._subagentView = { buf = buf, win = win }
  return { buf = buf, win = win }
end

--- User-facing close (q/Esc): notify the runner so it stops routing events.
function M.close_subagent_view()
  local sv = M._subagentView
  if sv.win and vim.api.nvim_win_is_valid(sv.win) then
    pcall(vim.api.nvim_win_close, sv.win, true)
  end
  if sv.buf and vim.api.nvim_buf_is_valid(sv.buf) then
    -- Wipe the single-use replay buffer so a later open never hits
    -- E95 (buffer name already exists) on 'dsh-subagent-view'.
    pcall(vim.api.nvim_buf_delete, sv.buf, { force = true })
  end
  M._subagentView = { buf = nil, win = nil }
  if M._channel then
    vim.rpcnotify(M._channel, 'dsh-subagent-view-closed')
  end
  if input_win and vim.api.nvim_win_is_valid(input_win) then
    vim.api.nvim_set_current_win(input_win)
    vim.cmd('startinsert')
  end
end

--- Current view ids (for the runner's FeedRenderer idsProvider).
function M.subagent_view_ids()
  local sv = M._subagentView
  if sv.win and vim.api.nvim_win_is_valid(sv.win) then
    return { buf = sv.buf, win = sv.win }
  end
  return nil
end

--- Settled replays land on the FIRST thinking block: the window otherwise
--- opens scrolled to the transcript tail (the final answer), so the thinking
--- details look missing. Returns the 1-based row it landed on.
function M.subagent_view_goto_thinking()
  local sv = M._subagentView
  if not (sv.win and vim.api.nvim_win_is_valid(sv.win)) then
    return nil
  end
  local lines = vim.api.nvim_buf_get_lines(sv.buf, 0, -1, false)
  local row = 1
  for i, l in ipairs(lines) do
    if vim.startswith(l, '·· thinking') then
      row = i
      break
    end
  end
  vim.api.nvim_win_set_cursor(sv.win, { row, 0 })
  return row
end

-- ---------------------------------------------------------------------------
-- @-file-reference completion menu: typing `@` above the input line shows
-- file/directory candidates (pushed by the runner, official fileReferences
-- service or a local fs walk). <CR> accepts: the @token is replaced with the
-- formatted mention (@path / @"path with spaces").
-- ---------------------------------------------------------------------------
M._atWin = nil
M._atBuf = nil
M._atItems = {}   -- { path, mention }
M._atIdx = 0
M._atTop = 1
M._atStart = 0    -- byte offset of '@' in the input line (0-based)

local AT_MAX_H = 8

function M.at_menu_open()
  return M._atWin ~= nil and vim.api.nvim_win_is_valid(M._atWin)
end

function M.close_at_menu()
  if M._atWin and vim.api.nvim_win_is_valid(M._atWin) then
    pcall(vim.api.nvim_win_close, M._atWin, true)
  end
  M._atWin = nil
  M._atBuf = nil
  M._atItems = {}
  M._atIdx = 0
  M._atTop = 1
  M._atStart = 0
end

local function render_at_menu()
  local win = M._atWin
  if not (win and vim.api.nvim_win_is_valid(win)) then
    M._atWin = nil
    return
  end
  if not (input_win and vim.api.nvim_win_is_valid(input_win)) then
    M.close_at_menu()
    return
  end
  local n = #M._atItems
  if n == 0 then
    M.close_at_menu()
    return
  end
  if M._atIdx < 1 then M._atIdx = 1 end
  if M._atIdx > n then M._atIdx = n end
  local maxH = math.min(AT_MAX_H, n)
  local top = M._atTop or 1
  if top > M._atIdx then top = M._atIdx end
  if top <= M._atIdx - maxH then top = M._atIdx - maxH + 1 end
  M._atTop = top
  local count = math.min(maxH, n - top + 1)
  local width = 24
  local rows = {}
  for i = 0, count - 1 do
    local e = M._atItems[top + i]
    rows[#rows + 1] = e.path
    width = math.max(width, vim.fn.strdisplaywidth(e.path) + 2)
  end
  width = math.min(width, math.max(12, vim.o.columns - 4))
  for i, line in ipairs(rows) do
    rows[i] = line .. string.rep(' ', width - vim.fn.strdisplaywidth(line))
  end
  local buf = M._atBuf
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, rows)
  vim.bo[buf].modifiable = false
  vim.api.nvim_buf_clear_namespace(buf, CMD_NS, 0, -1)
  for i = 0, count - 1 do
    if (top + i) == M._atIdx then
      vim.api.nvim_buf_set_extmark(buf, CMD_NS, i, 0, {
        hl_group = 'DshTuiCmdSel', end_row = i, end_col = width, priority = 10 })
    end
    vim.api.nvim_buf_set_extmark(buf, CMD_NS, i, 0, {
      hl_group = (top + i) == M._atIdx and 'DshTuiCmdSelName' or 'DshTuiCmdName',
      end_col = vim.fn.strdisplaywidth(M._atItems[top + i].path),
      priority = 20 })
  end
  vim.api.nvim_win_set_config(win, cmd_win_config(count, width))
end

--- Candidates from the runner (dsh-at-query response). start = '@' offset.
function M.set_at_menu(items, start)
  M._atItems = items or {}
  M._atIdx = 1
  M._atTop = 1
  M._atStart = start or 0
  if #M._atItems == 0 then
    M.close_at_menu()
    return
  end
  local ok = pcall(function()
    if not M.at_menu_open() then
      local buf = vim.api.nvim_create_buf(false, true)
      vim.bo[buf].buftype = 'nofile'
      vim.bo[buf].bufhidden = 'wipe'
      vim.bo[buf].swapfile = false
      vim.b[buf].ministatusline_disable = true
      M._atBuf = buf
      M._atWin = vim.api.nvim_open_win(buf, false,
        cmd_win_config(math.min(AT_MAX_H, #M._atItems), 30, { noautocmd = true }))
    end
    render_at_menu()
  end)
  if not ok then M.close_at_menu() end
end

function M.at_next()
  if not M.at_menu_open() then return end
  M._atIdx = M._atIdx % #M._atItems + 1
  render_at_menu()
end

function M.at_prev()
  if not M.at_menu_open() then return end
  M._atIdx = (M._atIdx + #M._atItems - 2) % #M._atItems + 1
  render_at_menu()
end

--- Accept the selected @-mention: replace the token in the input line.
function M.at_accept()
  local sel = M._atItems[M._atIdx]
  local start = M._atStart
  M.close_at_menu()
  if sel == nil or input_buf == nil or not vim.api.nvim_buf_is_valid(input_buf) then
    return
  end
  local lines = vim.api.nvim_buf_get_lines(input_buf, 0, -1, false)
  local cur = vim.api.nvim_win_get_cursor(input_win)
  local line = lines[cur[1]] or ''
  local mention = sel.mention
  local col = math.min(cur[2], #line)
  local newline = line:sub(1, start) .. mention .. line:sub(col + 1)
  lines[cur[1]] = newline
  vim.api.nvim_buf_set_lines(input_buf, 0, -1, false, lines)
  vim.api.nvim_win_set_cursor(input_win, { cur[1], start + #mention })
  M.resize_input()
end

--- Detect an active @token before the cursor; asks the runner for candidates.
function M.update_at_menu()
  if input_buf == nil or not vim.api.nvim_buf_is_valid(input_buf) then
    M.close_at_menu()
    return
  end
  local cur = vim.api.nvim_win_get_cursor(input_win)
  local line = vim.api.nvim_buf_get_lines(input_buf, cur[1] - 1, cur[1], false)[1] or ''
  local before = line:sub(1, cur[2])
  local s, pre, query = before:match('()(%A)@([^%s"\'@]*)$')
  if s == nil then
    M.close_at_menu()
    return
  end
  if M._channel then
    vim.rpcnotify(M._channel, 'dsh-at-query', { query = query })
  end
end

-- ---------------------------------------------------------------------------
-- Directory picker: navigable float. Enter descends / selects, <BS> goes up,
-- q/Esc cancel. Selection returns via 'dsh-dir-selected'.
-- ---------------------------------------------------------------------------
M._dirWin = nil
M._dirBuf = nil
M._dirPath = nil
M._dirRows = {}   -- display rows
M._dirIdx = 1
M._dirTop = 1

local function dir_entries(path)
  local ok, names = pcall(vim.fn.readdir, path)
  if not ok then return nil end
  local dirs, files = {}, {}
  for _, n in ipairs(names) do
    local full = path .. '/' .. n
    if vim.fn.isdirectory(full) == 1 then dirs[#dirs + 1] = { name = n, dir = true } end
  end
  for _, n in ipairs(names) do
    local full = path .. '/' .. n
    if vim.fn.isdirectory(full) ~= 1 then files[#files + 1] = { name = n, dir = false } end
  end
  table.sort(dirs, function(a, b) return a.name < b.name end)
  table.sort(files, function(a, b) return a.name < b.name end)
  local out = {}
  for _, d in ipairs(dirs) do out[#out + 1] = d end
  for _, f in ipairs(files) do out[#out + 1] = f end
  return out
end

local function render_dir_picker()
  local win = M._dirWin
  if not (win and vim.api.nvim_win_is_valid(win)) then return end
  local entries = dir_entries(M._dirPath)
  if entries == nil then
    M.close_dir_picker()
    return
  end
  M._dirRows = entries
  if M._dirIdx > #entries then M._dirIdx = math.max(1, #entries) end
  if #entries == 0 then M._dirIdx = 0 end
  local maxH = 10
  local top = M._dirTop
  if M._dirIdx > 0 then
    if top > M._dirIdx then top = M._dirIdx end
    if top <= M._dirIdx - maxH then top = M._dirIdx - maxH + 1 end
  end
  M._dirTop = top
  local rows = { '📁 ' .. M._dirPath .. '/', '' }
  for i = top, math.min(#entries, top + maxH - 1) do
    local e = entries[i]
    local mark = i == M._dirIdx and '▸ ' or '  '
    rows[#rows + 1] = mark .. e.name .. (e.dir and '/' or '')
  end
  rows[#rows + 1] = ''
  rows[#rows + 1] = '[j/k] 移动  [Enter] 进入/选择  [BS] 上级  [Esc] 取消'
  vim.bo[M._dirBuf].modifiable = true
  vim.api.nvim_buf_set_lines(M._dirBuf, 0, -1, false, rows)
  vim.bo[M._dirBuf].modifiable = false
  if M._dirIdx > 0 then
    vim.api.nvim_win_set_cursor(win, { 3 + (M._dirIdx - top), 0 })
  end
end

--- startPath: absolute or relative directory to start in.
function M.show_dir_picker(startPath)
  M.close_dir_picker()
  M._dirPath = vim.fn.fnamemodify(startPath or vim.fn.getcwd(), ':p'):gsub('/$', '')
  if vim.fn.isdirectory(M._dirPath) ~= 1 then
    M._dirPath = vim.fn.getcwd()
  end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.bo[buf].modifiable = false
  vim.b[buf].ministatusline_disable = true
  M._dirBuf = buf
  M._dirIdx = 1
  M._dirTop = 1
  M._dirWin = vim.api.nvim_open_win(buf, true, {
    relative = 'editor',
    row = 4,
    col = math.max(0, math.floor(vim.o.columns / 2) - 36),
    width = 72,
    height = math.min(14, math.max(6, vim.o.lines - 8)),
    border = 'rounded',
    style = 'minimal',
    title = ' 目录选择 ',
    title_pos = 'center',
  })
  vim.cmd('stopinsert') -- input window hands over in insert mode
  local k = function(key, cmd)
    vim.keymap.set('n', key, '<Cmd>lua ' .. cmd .. '<CR>', { buffer = buf })
  end
  k('j', 'require("dsh_tui").dir_move(1)')
  k('k', 'require("dsh_tui").dir_move(-1)')
  k('<CR>', 'require("dsh_tui").dir_enter()')
  k('<BS>', 'require("dsh_tui").dir_up()')
  k('q', 'require("dsh_tui").close_dir_picker()')
  k('<Esc>', 'require("dsh_tui").close_dir_picker()')
  render_dir_picker()
end

function M.dir_move(dir)
  if M._dirIdx == 0 then return end
  M._dirIdx = math.max(1, math.min(#M._dirRows, M._dirIdx + dir))
  render_dir_picker()
end

function M.dir_enter()
  local e = M._dirRows[M._dirIdx]
  if e == nil then return end
  if e.dir then
    M._dirPath = M._dirPath .. '/' .. e.name
    M._dirIdx = 1
    M._dirTop = 1
    render_dir_picker()
  else
    local full = M._dirPath .. '/' .. e.name
    M.close_dir_picker()
    if M._channel then
      vim.rpcnotify(M._channel, 'dsh-dir-selected', full)
    end
  end
end

function M.dir_up()
  local parent = M._dirPath:match('^(.*)/[^/]+$')
  if parent == nil or parent == '' then
    M.close_dir_picker()
    return
  end
  M._dirPath = parent
  M._dirIdx = 1
  M._dirTop = 1
  render_dir_picker()
end

function M.close_dir_picker()
  if M._dirWin and vim.api.nvim_win_is_valid(M._dirWin) then
    pcall(vim.api.nvim_win_close, M._dirWin, true)
  end
  M._dirWin = nil
  M._dirBuf = nil
  M._dirPath = nil
  M._dirRows = {}
  M._dirIdx = 1
  M._dirTop = 1
end

-- ---------------------------------------------------------------------------
-- Generic scrollable info float (workflow view, settings overview, …).
-- ---------------------------------------------------------------------------
--- Generic read-only lines float (workflow / settings / trajectory).
--- `editPath` (optional): map i/o to open that file in a new tab — the
--- settings overview's edit shortcut. Without it i/o are Nop'd so a read-only
--- float never answers an edit attempt with a raw E21 error.
function M.show_lines_float(title, lines, editPath)
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines or {})
  vim.bo[buf].modifiable = false
  local cfg = {
    relative = 'editor',
    row = 2,
    col = 2,
    width = math.min(110, math.max(40, vim.o.columns - 4)),
    height = math.min(36, math.max(6, vim.o.lines - 4)),
    border = 'rounded',
    style = 'minimal',
  }
  if vim.fn.has('nvim-0.9') == 1 then
    cfg.title = ' ' .. tostring(title or '') .. ' '
    cfg.title_pos = 'center'
  end
  local win = vim.api.nvim_open_win(buf, true, cfg)
  vim.wo[win].cursorline = true
  vim.keymap.set('n', 'q', '<Cmd>lua require("dsh_tui").close_lines_float()<CR>', { buffer = buf })
  vim.keymap.set('n', '<Esc>', '<Cmd>lua require("dsh_tui").close_lines_float()<CR>', { buffer = buf })
  if type(editPath) == 'string' and editPath ~= '' then
    vim.keymap.set('n', 'i', function()
      vim.cmd('tabedit ' .. vim.fn.fnameescape(editPath))
      M.close_lines_float()
    end, { buffer = buf })
    vim.keymap.set('n', 'o', function()
      vim.cmd('tabedit ' .. vim.fn.fnameescape(editPath))
      M.close_lines_float()
    end, { buffer = buf })
  else
    -- Read-only float: an edit attempt must not surface a raw E21.
    vim.keymap.set('n', 'i', '<Nop>', { buffer = buf })
    vim.keymap.set('n', 'o', '<Nop>', { buffer = buf })
  end
  vim.cmd('stopinsert') -- input window hands over in insert mode
  M._linesWin = win
  return { buf = buf, win = win }
end

function M.close_lines_float()
  if M._linesWin and vim.api.nvim_win_is_valid(M._linesWin) then
    pcall(vim.api.nvim_win_close, M._linesWin, true)
  end
  M._linesWin = nil
end

-- ---------------------------------------------------------------------------
-- Layout presets (no resident session list — sessions live in the /sessions
-- float): default (chat + input) / panel (reasoning panel open).
-- ---------------------------------------------------------------------------
M._layoutName = 'default'

function M.apply_layout(name)
  M.close_lines_float()
  if chat_win == nil or not vim.api.nvim_win_is_valid(chat_win) then
    return
  end
  name = name or 'default'
  if name == 'panel' then
    if not M._reasoningOpen then
      M.toggle_reasoning()
    end
    M._layoutName = 'panel'
  else -- default (alias: full — chat already owns the whole screen)
    if M._reasoningOpen then
      M.toggle_reasoning()
    end
    M._layoutName = 'default'
  end
  if input_win and vim.api.nvim_win_is_valid(input_win) then
    vim.api.nvim_set_current_win(input_win)
    vim.cmd('startinsert')
  end
  return M._layoutName
end

--- Terminal bell (turn finished, approvals): BEL on nvim's stdout.
function M.bell()
  local ok = pcall(vim.api.nvim_out_write, '\x07')
  return ok
end

--- Append text to the input line at the cursor (runner: /attach mentions).
function M.append_input(text)
  if input_buf == nil or not vim.api.nvim_buf_is_valid(input_buf) then
    return
  end
  local lines = vim.api.nvim_buf_get_lines(input_buf, 0, -1, false)
  local cur = vim.api.nvim_win_get_cursor(input_win)
  local line = lines[cur[1]] or ''
  lines[cur[1]] = line:sub(1, cur[2]) .. text .. line:sub(cur[2] + 1)
  vim.api.nvim_buf_set_lines(input_buf, 0, -1, false, lines)
  vim.api.nvim_win_set_cursor(input_win, { cur[1], cur[2] + #text })
  vim.cmd('startinsert')
  M.resize_input()
end

--- Open a file in a NEW nvim tab (deliverables / settings document) — the TUI
--- layout stays untouched; closing the tab returns to the TUI.
function M.open_file_tab(path)
  local ok = pcall(vim.cmd, 'tabedit ' .. vim.fn.fnameescape(path))
  if not ok then
    if M._channel then
      vim.rpcnotify(M._channel, 'dsh-open-failed', path)
    end
  end
  return ok
end

local function window_options(win)
  for _, opt in ipairs({ 'number', 'relativenumber', 'cursorline' }) do
    vim.api.nvim_win_set_option(win, opt, false)
  end
  vim.api.nvim_win_set_option(win, 'signcolumn', 'no')
  vim.api.nvim_win_set_option(win, 'foldcolumn', '0')
end

local function layout()
  -- Main window (right, top): chat.
  chat_win = vim.api.nvim_get_current_win()
  window_options(chat_win)

  -- Bottom right: one-line prompt input.
  vim.cmd('botright 1split')
  input_win = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(input_win, input_buf)
  window_options(input_win)
  vim.api.nvim_win_set_option(input_win, 'showmode', false)
  -- Typed text follows the dim palette too — the '❯' prompt (DshTuiPrompt)
  -- keeps its accent and stays the visual anchor.
  vim.wo[input_win].winhl = 'Normal:DshTuiDim'
  -- An empty statusline renders as a StatusLineNC block (a bright bar in
  -- most themes). The input window gets a styled helper bar instead; the
  -- hints start at the LEFT edge (aligned with the input box) so the eye
  -- doesn't have to jump to the far right.
  vim.api.nvim_win_set_option(input_win, 'statusline',
    '%#DshTuiStatus# Enter 发送 · C-cr 换行 · C-c 停止 · / 命令菜单 · C-o 面板 ')
  -- REPL-style prompt: the '❯' lives in the window's STATUS COLUMN, outside
  -- the editable text — it can never be typed over, deleted, or submitted as
  -- message content. (nvim < 0.9: inline virtual-text fallback.)
  if vim.fn.has('nvim-0.9') == 1 then
    vim.wo[input_win].statuscolumn = '%#DshTuiPrompt#❯ '
  else
    vim.api.nvim_buf_set_extmark(input_buf, M._ns, 0, 0, {
      virt_text = { { '❯ ', 'DshTuiPrompt' } },
      virt_text_pos = 'inline',
      hl_mode = 'combine',
    })
  end
  M.resize_input()

  -- No resident session list: /sessions pops a selectable float with full
  -- session ids. The chat gets the whole screen.

  -- Start typing right away: the prompt buffer puts us in insert mode.
  vim.api.nvim_set_current_win(input_win)
  vim.cmd('startinsert')
  apply_statusline()
end

local function install_keymaps()
  local quit_cmd = '<Cmd>lua require("dsh_tui").quit()<CR>'
  vim.api.nvim_buf_set_keymap(input_buf, 'i', '<C-q>', quit_cmd, { noremap = true })
  vim.api.nvim_buf_set_keymap(input_buf, 'n', '<C-q>', quit_cmd, { noremap = true })

  -- Input buffer (insert mode): <CR> submits, <C-CR> inserts a literal
  -- newline (multi-line input), <Up>/<Down> cycle history; <Tab>/<C-n>/
  -- <C-p>/<S-Tab> navigate the slash-command completion menu while it is
  -- open, <Esc> closes it first (a second <Esc> leaves insert mode).
  local submit_cmd = '<Cmd>lua require("dsh_tui").submit()<CR>'
  vim.api.nvim_buf_set_keymap(input_buf, 'i', '<CR>', submit_cmd, { noremap = true })
  vim.api.nvim_buf_set_keymap(input_buf, 'n', '<CR>', submit_cmd, { noremap = true })
  vim.api.nvim_buf_set_keymap(input_buf, 'i', '<C-CR>', '<CR>', { noremap = true })
  vim.keymap.set('i', '<Up>', function() require('dsh_tui').history_move(-1) end, { buffer = input_buf })
  vim.keymap.set('i', '<Down>', function() require('dsh_tui').history_move(1) end, { buffer = input_buf })
  vim.keymap.set('i', '<C-n>', function()
    if require('dsh_tui').cmd_menu_state().open then
      require('dsh_tui').cmd_next()
    else
      require('dsh_tui').history_move(1)
    end
  end, { buffer = input_buf })
  vim.keymap.set('i', '<C-p>', function()
    if require('dsh_tui').cmd_menu_state().open then
      require('dsh_tui').cmd_prev()
    else
      require('dsh_tui').history_move(-1)
    end
  end, { buffer = input_buf })
  vim.keymap.set('i', '<Tab>', function() require('dsh_tui').cmd_next() end, { buffer = input_buf })
  vim.keymap.set('i', '<S-Tab>', function() require('dsh_tui').cmd_prev() end, { buffer = input_buf })
  -- <C-v> queues the macOS clipboard image for the next submit (runner side
  -- reads pbpaste). Text paste (Cmd+V / bracketed paste) is unaffected.
  vim.api.nvim_buf_set_keymap(input_buf, 'i', '<C-v>',
    '<Cmd>lua require("dsh_tui").paste_image()<CR>', { noremap = true })
  vim.api.nvim_buf_set_keymap(input_buf, 'n', '<C-v>',
    '<Cmd>lua require("dsh_tui").paste_image()<CR>', { noremap = true })
  -- <C-c> asks the runner to abort the running turn (idle → notice).
  vim.api.nvim_buf_set_keymap(input_buf, 'i', '<C-c>',
    '<Cmd>lua require("dsh_tui").abort_turn()<CR>', { noremap = true })
  vim.api.nvim_buf_set_keymap(input_buf, 'n', '<C-c>',
    '<Cmd>lua require("dsh_tui").abort_turn()<CR>', { noremap = true })
  vim.keymap.set('i', '<Esc>', function()
    if require('dsh_tui').at_menu_open() then
      require('dsh_tui').close_at_menu()
    elseif require('dsh_tui').cmd_menu_state().open then
      require('dsh_tui').close_cmd_menu()
    else
      vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<Esc>', true, false, true), 'n', false)
    end
  end, { buffer = input_buf })

  -- <C-o> toggles the activity panel (overrides jumplist/insert-default
  -- only inside our own buffers).
  local reason_cmd = '<Cmd>lua require("dsh_tui").toggle_reasoning()<CR>'
  vim.api.nvim_buf_set_keymap(input_buf, 'i', '<C-o>', reason_cmd, { noremap = true })
  vim.api.nvim_buf_set_keymap(input_buf, 'n', '<C-o>', reason_cmd, { noremap = true })
end

local function install_autocmds()
  -- Whenever the input window gains focus, make sure we are in insert mode —
  -- otherwise '/' would start a search instead of typing a slash command.
  vim.api.nvim_create_autocmd('WinEnter', {
    callback = function()
      if input_win == nil then
        return
      end
      if vim.api.nvim_get_current_win() == input_win
        and vim.api.nvim_get_mode().mode ~= 'i' then
        vim.cmd('startinsert')
      end
    end,
  })
  vim.api.nvim_create_autocmd('TextChanged', {
    buffer = input_buf,
    callback = function()
      M.resize_input()
      M.update_cmd_menu()
      if not M.cmd_menu_state().open then M.update_at_menu() end
    end,
  })
  vim.api.nvim_create_autocmd('TextChangedI', {
    buffer = input_buf,
    callback = function()
      M.resize_input()
      M.update_cmd_menu()
      if not M.cmd_menu_state().open then M.update_at_menu() end
    end,
  })
  -- Leaving insert mode (second <Esc>, <C-c>, a float taking focus…) closes
  -- the completion menus; re-entering refreshes them against the input text.
  vim.api.nvim_create_autocmd('InsertLeave', {
    buffer = input_buf,
    callback = function()
      M.close_cmd_menu()
      M.close_at_menu()
    end,
  })
  -- Completion plugins lazy-load (nvim-cmp on InsertEnter); retry the
  -- per-buffer disable at every later opportunity until it sticks.
  vim.api.nvim_create_autocmd('User', {
    pattern = 'VeryLazy',
    once = true,
    callback = function() M.disable_external_completion() end,
  })
  vim.api.nvim_create_autocmd('InsertEnter', {
    buffer = input_buf,
    callback = function()
      vim.defer_fn(function()
        M.disable_external_completion()
        M.update_cmd_menu()
      end, 50)
    end,
  })
  vim.api.nvim_create_autocmd({ 'WinEnter', 'BufEnter', 'TabEnter' }, {
    callback = function() M.reschedule_statusline() end,
  })
  -- A colorscheme (re)applied after start() — lazy setups, mid-session
  -- switches — must not wash the highlights back to pure white.
  vim.api.nvim_create_autocmd('ColorScheme', {
    callback = function() M.applyHighlights() end,
  })
  vim.defer_fn(function() M.disable_external_completion() end, 300)
  vim.defer_fn(function() M.disable_external_completion() end, 1200)
end

--- Claim the UI: drop windows/buffers opened by the user's config or a
--- dashboard plugin, then rebuild our layout.
local function takeover()
  pcall(vim.cmd, 'silent! only')
  M._reasoningWin = nil
  M._reasoningOpen = false
  local current = vim.api.nvim_get_current_buf()
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    if b ~= current and vim.bo[b].buflisted then
      pcall(vim.api.nvim_buf_delete, b, { force = true })
    end
  end
end

--- ALL DshTui* highlight definitions (role links + dim palette) in one
--- re-appliable function. Lazy plugin managers can apply the user's
--- colorscheme AFTER our VimEnter mount — its `hi clear` wipes every custom
--- group and the whole TUI falls back to plain white. We re-apply on
--- ColorScheme and on deferred timers so the palette survives any ordering.
function M.applyHighlights()
  -- Role/span highlight groups; `default link` adapts to the user's colorscheme.
  vim.cmd('highlight default link DshTuiActiveSession Title')
  vim.cmd('highlight default link DshTuiNotice Comment')
  vim.cmd('highlight default link DshTuiUser MoreMsg')
  vim.cmd('highlight default link DshTuiAssistant Comment') -- harness output: dimmer than Normal
  vim.cmd('highlight default link DshTuiDivider Comment')
  vim.cmd('highlight default link DshTuiError ErrorMsg')
  vim.cmd('highlight default link DshTuiTool Special')
  vim.cmd('highlight default link DshTuiSubagent Type')
  vim.cmd('highlight default link DshTuiWorkflow Identifier')
  vim.cmd('highlight default link DshTuiCode Special')
  vim.cmd('highlight default link DshTuiBold Bold')
  vim.cmd('highlight default link DshTuiPrompt DshTuiUser') -- input-line '❯'
  -- Slash-command completion menu: the selection reuses the pum look.
  vim.cmd('highlight default link DshTuiCmdName MoreMsg')
  vim.cmd('highlight default link DshTuiCmdDesc Comment')
  vim.cmd('highlight default link DshTuiCmdSel PmenuSel')
  vim.cmd('highlight default link DshTuiCmdSelName PmenuSel')
  vim.cmd('highlight default link DshTuiCmdSelDesc PmenuSel')
  -- Markdown structure: headings stand out, quotes dim italic, links underline.
  vim.cmd('highlight default link DshTuiHeading Title')
  vim.cmd('highlight default DshTuiQuote gui=italic cterm=italic')
  vim.cmd('highlight default link DshTuiQuote Comment')
  vim.cmd('highlight default DshTuiLink gui=underline cterm=underline')
  M.applyDimPalette()
end

--- The TUI's palette: statusline fills + explicit dim foregrounds for plain
--- content (assistant output, thinking text, notices, dividers, list windows,
--- menu descriptions, typed input). The plain content FOLLOWS the theme's
--- Comment (the pre-regression look — molokai's tinted dim gray, not a flat
--- blend); only when the theme's Comment is bright or missing do we fall back
--- to blending Normal toward its background, so a white-Comment theme can
--- never glare again.
--- Re-applied on ColorScheme so late/lazy colorscheme applications (or a
--- mid-session switch) cannot wash the dims back to pure white.
function M.applyDimPalette()
  local normal_hl = vim.api.nvim_get_hl(0, { name = 'Normal' })
  local status_hl = vim.api.nvim_get_hl(0, { name = 'StatusLine' })
  local comment_hl = vim.api.nvim_get_hl(0, { name = 'Comment' })
  local function blend24(c1, c2, t)
    if type(c1) ~= 'number' or type(c2) ~= 'number' then return c1 end
    local function ch(c, s)
      return math.floor((c / 2 ^ s) % 256)
    end
    local r = math.floor(ch(c1, 16) + (ch(c2, 16) - ch(c1, 16)) * t + 0.5)
    local g = math.floor(ch(c1, 8) + (ch(c2, 8) - ch(c1, 8)) * t + 0.5)
    local b = math.floor(ch(c1, 0) + (ch(c2, 0) - ch(c1, 0)) * t + 0.5)
    return r * 65536 + g * 256 + b
  end
  -- nvim_get_hl returns colors as 24-bit numbers OR hex strings depending on
  -- how the colorscheme declared them — normalize so blends never bail out
  -- on a string color and silently fall back to the bright theme color.
  local function color24(c)
    if type(c) == 'number' then return c end
    if type(c) == 'string' then
      local r, g, b = c:match('^#(%x%x)(%x%x)(%x%x)$')
      if r then
        return tonumber(r, 16) * 65536 + tonumber(g, 16) * 256 + tonumber(b, 16)
      end
    end
    return nil
  end
  local function luma(c)
    return (math.floor(c / 65536) % 256) * 0.299
      + (math.floor(c / 256) % 256) * 0.587
      + (c % 256) * 0.114
  end
  local status_fg = color24(status_hl.fg)
  local normal_fg = color24(normal_hl.fg)
  local normal_bg = color24(normal_hl.bg) or 0x1e1e1e
  local comment_fg = color24(comment_hl.fg)
  -- nil → keep the theme's Comment link; a number → blend fallback (used
  -- only when the theme's Comment is missing or brighter than Normal text).
  local plain_fg = nil
  if type(normal_fg) == 'number' then
    if type(comment_fg) ~= 'number' or luma(comment_fg) > luma(normal_fg) then
      plain_fg = blend24(normal_fg, normal_bg, 0.55)
    end
  end
  -- The statusline ROW FILL uses StatusLine (active) / StatusLineNC
  -- (inactive) — bright in many themes (the white-bar illusion). This nvim
  -- instance IS the TUI, so both groups get the editor background here.
  vim.api.nvim_set_hl(0, 'StatusLine', { fg = status_fg or 0xa8a8a8, bg = normal_bg })
  vim.api.nvim_set_hl(0, 'StatusLineNC', { fg = status_fg or 0x8a8a8a, bg = normal_bg })
  vim.api.nvim_set_hl(0, 'DshTuiStatus', {
    fg = (status_fg and normal_fg and blend24(status_fg, normal_fg, 0.45)) or 0xc8c8c8,
    bg = normal_bg,
    bold = true,
  })
  local function setDimGroup(group, ratio)
    if plain_fg == nil then
      vim.cmd('highlight default link ' .. group .. ' Comment')
    else
      vim.api.nvim_set_hl(0, group,
        { fg = ratio == 0.55 and plain_fg or blend24(normal_fg, normal_bg, ratio) })
    end
  end
  setDimGroup('DshTuiAssistant', 0.55) -- chat plain text (the bulk of content)
  setDimGroup('DshTuiReasoning', 0.50) -- thinking text / panel body
  setDimGroup('DshTuiNotice', 0.65) -- runner notices ('· …')
  setDimGroup('DshTuiDivider', 0.72) -- '── turn ──' separators
  setDimGroup('DshTuiCmdDesc', 0.65) -- completion-menu descriptions
  setDimGroup('DshTuiDim', 0.60) -- unhighlighted text in list windows
end

--- Entry: runs at VimEnter (after the user's config/plugins loaded).
function M.start()
  if M._started then
    return -- idempotent (e.g. reloaded in dev)
  end
  M._started = true
  -- This nvim instance is the dsh TUI: statusline plugins must not manage
  -- ANY window here (they rewrite the option on every WinEnter). The user's
  -- normal nvim sessions are unaffected.
  vim.g.ministatusline_disable = true
  -- Terminal title: nvim owns the terminal, so it must emit the OSC 2 title
  -- itself (the runner pushes the content via set_title).
  vim.o.title = true
  vim.o.titlestring = 'dsh'
  -- The cmdline row is dead space here (notices render in the chat) — reclaim
  -- it so the input hint bar is the very last screen row (nvim 0.9+).
  if vim.fn.has('nvim-0.9') == 1 then
    vim.o.cmdheight = 0
  end
  M.applyHighlights()
  takeover()
  make_input_buffer()
  layout()
  install_keymaps()
  install_autocmds()

  -- Some plugins open windows asynchronously after VimEnter (dashboards…).
  -- Re-claim the layout if one of our windows got replaced.
  local function reclaim()
    if not (chat_win and vim.api.nvim_win_is_valid(chat_win)
      and input_win and vim.api.nvim_win_is_valid(input_win)) then
      takeover()
      layout()
    end
  end
  vim.defer_fn(reclaim, 300)
  vim.defer_fn(reclaim, 1200)
  -- Belt-and-braces: lazy plugins can `hi clear` late without a ColorScheme
  -- event — re-assert the whole highlight set after the dust settles.
  vim.defer_fn(function() M.applyHighlights() end, 300)
  vim.defer_fn(function() M.applyHighlights() end, 1200)
end

--- Called by the Node runner once it has connected and knows its channel id.
function M.attach(channel_id)
  M._channel = channel_id
end

--- Create (or return) the chat buffer for one session.
--- Returns { chatBuf, chatWin } — chatWin is the shared chat window.
function M.ensure_chat(id)
  local buf = M._chats[id]
  if not buf or not vim.api.nvim_buf_is_valid(buf) then
    buf = vim.api.nvim_create_buf(false, true)
    chat_buffer_options(buf)
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, { '…' })
    -- <C-o> toggles the reasoning panel from the chat buffer too.
    vim.api.nvim_buf_set_keymap(buf, 'n', '<C-o>',
      '<Cmd>lua require("dsh_tui").toggle_reasoning()<CR>', { noremap = true })
    M._chats[id] = buf
  end
  return { chatBuf = buf, chatWin = chat_win }
end

--- Create (or return) the reasoning (thinking) buffer for one session.
--- Returns { reasoningBuf, reasoningWin, reasoningOpen }.
function M.ensure_reasoning(id)
  local buf = M._reasoningBufs[id]
  if not buf or not vim.api.nvim_buf_is_valid(buf) then
    buf = vim.api.nvim_create_buf(false, true)
    chat_buffer_options(buf)
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, { '·· 思考与工具记录（<C-o> 收起）' })
    vim.api.nvim_buf_set_keymap(buf, 'n', '<C-o>',
      '<Cmd>lua require("dsh_tui").toggle_reasoning()<CR>', { noremap = true })
    M._reasoningBufs[id] = buf
  end
  return {
    reasoningBuf = buf,
    reasoningWin = M._reasoningWin,
    reasoningOpen = M._reasoningOpen,
  }
end

--- Open/close the reasoning panel (right of the chat window). Keymap <C-o>.
function M.toggle_reasoning()
  if M._reasoningWin and vim.api.nvim_win_is_valid(M._reasoningWin) then
    pcall(vim.api.nvim_win_close, M._reasoningWin, true)
    M._reasoningWin = nil
    M._reasoningOpen = false
  else
    vim.api.nvim_set_current_win(chat_win)
    vim.cmd('rightbelow 52vsplit')
    M._reasoningWin = vim.api.nvim_get_current_win()
    local buf = M._activeId and M._reasoningBufs[M._activeId]
    if buf and vim.api.nvim_buf_is_valid(buf) then
      vim.api.nvim_win_set_buf(M._reasoningWin, buf)
    end
    window_options(M._reasoningWin)
    vim.api.nvim_win_set_option(M._reasoningWin, 'winfixwidth', true)
    vim.api.nvim_win_set_option(M._reasoningWin, 'statusline', '%#Normal# ')
    M._reasoningOpen = true
    -- Focus back on typing.
    if input_win and vim.api.nvim_win_is_valid(input_win) then
      vim.api.nvim_set_current_win(input_win)
      vim.cmd('startinsert')
    end
  end
  if M._channel then
    vim.rpcnotify(M._channel, 'dsh-reasoning-toggled', M._reasoningOpen)
  end
  return M._reasoningOpen
end

--- Session list float (/sessions): entries { {id, title, active, kind} } with
--- FULL session ids. j/k move, <CR> selects (dsh-session-selected), <C-n> asks
--- for a new session, q/Esc close.
M._sessWin = nil
M._sessBuf = nil
M._sessEntries = {}
M._sessIdx = 1
M._sessTop = 1

function M.show_session_list(entries)
  M.close_session_list()
  M._sessEntries = entries or {}
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.b[buf].ministatusline_disable = true
  M._sessBuf = buf
  local idx = 1
  for i, e in ipairs(M._sessEntries) do
    if e.active then idx = i end
  end
  M._sessIdx = idx
  M._sessTop = 1
  M._sessWin = vim.api.nvim_open_win(buf, true, {
    relative = 'editor',
    row = 3,
    col = math.max(0, math.floor(vim.o.columns / 2) - 44),
    width = 88,
    height = math.min(16, math.max(5, vim.o.lines - 6)),
    border = 'rounded',
    style = 'minimal',
    title = ' 会话列表（/sessions） ',
    title_pos = 'center',
  })
  vim.wo[M._sessWin].cursorline = true
  local k = function(key, cmd)
    vim.keymap.set('n', key, '<Cmd>lua ' .. cmd .. '<CR>', { buffer = buf })
  end
  k('j', 'require("dsh_tui").session_list_move(1)')
  k('k', 'require("dsh_tui").session_list_move(-1)')
  k('<CR>', 'require("dsh_tui").session_list_select()')
  k('<C-n>', 'require("dsh_tui").session_list_new()')
  k('q', 'require("dsh_tui").close_session_list()')
  k('<Esc>', 'require("dsh_tui").close_session_list()')
  vim.cmd('stopinsert') -- input window hands over in insert mode
  M.render_session_list()
end

function M.render_session_list()
  local buf = M._sessBuf
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then return end
  local entries = M._sessEntries
  local n = #entries
  if n == 0 then
    vim.bo[buf].modifiable = true
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, { '（没有会话）', '', '[C-n] 新建会话  [Esc] 关闭' })
    vim.bo[buf].modifiable = false
    return
  end
  if M._sessIdx > n then M._sessIdx = n end
  if M._sessIdx < 1 then M._sessIdx = 1 end
  local maxH = 12
  local top = M._sessTop
  if top > M._sessIdx then top = M._sessIdx end
  if top <= M._sessIdx - maxH then top = M._sessIdx - maxH + 1 end
  M._sessTop = top
  local rows = { '▸ = 当前会话 · Enter 切换 · C-n 新建 · q/Esc 关闭', '' }
  local firstRow = 3
  for i = top, math.min(n, top + maxH - 1) do
    local e = entries[i]
    local mark = i == M._sessIdx and '▸ ' or '  '
    local title = type(e.title) == 'string' and e.title ~= '' and e.title or '（无标题）'
    local kind = e.kind == 'history' and ' 历史' or (e.active and ' 当前' or '')
    rows[#rows + 1] = mark .. title .. ' · ' .. tostring(e.id or '') .. kind
    if e.active then firstRow = i - top + 2 end
  end
  rows[#rows + 1] = ''
  rows[#rows + 1] = '[j/k] 移动  [Enter] 切换  [C-n] 新建  [Esc] 关闭'
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, rows)
  vim.bo[buf].modifiable = false
  if M._sessWin and vim.api.nvim_win_is_valid(M._sessWin) then
    vim.api.nvim_win_set_cursor(M._sessWin, { 2 + (M._sessIdx - top), 0 })
  end
end

function M.session_list_move(dir)
  if #M._sessEntries == 0 then return end
  M._sessIdx = math.max(1, math.min(#M._sessEntries, M._sessIdx + dir))
  M.render_session_list()
end

function M.session_list_select()
  local e = M._sessEntries[M._sessIdx]
  M.close_session_list()
  if e and M._channel then
    vim.rpcnotify(M._channel, 'dsh-session-select', e.id)
  end
end

function M.session_list_new()
  M.close_session_list()
  if M._channel then
    vim.rpcnotify(M._channel, 'dsh-session-new')
  end
end

function M.close_session_list()
  if M._sessWin and vim.api.nvim_win_is_valid(M._sessWin) then
    pcall(vim.api.nvim_win_close, M._sessWin, true)
  end
  M._sessWin = nil
  M._sessBuf = nil
  M._sessEntries = {}
  M._sessIdx = 1
  M._sessTop = 1
  if input_win and vim.api.nvim_win_is_valid(input_win) then
    vim.api.nvim_set_current_win(input_win)
    vim.cmd('startinsert')
  end
end

--- Switch the visible chat to this session (the runner owns the entry list).
function M.set_active(id)
  M._activeId = id
  local buf = M._chats[id]
  if buf and vim.api.nvim_buf_is_valid(buf) and chat_win and vim.api.nvim_win_is_valid(chat_win) then
    vim.api.nvim_win_set_buf(chat_win, buf)
  end
  -- Keep the reasoning panel on this session's thinking buffer.
  if M._reasoningWin and vim.api.nvim_win_is_valid(M._reasoningWin) then
    local rbuf = M._reasoningBufs[id]
    if rbuf and vim.api.nvim_buf_is_valid(rbuf) then
      vim.api.nvim_win_set_buf(M._reasoningWin, rbuf)
    end
  end
  -- A session-list float tracking the old session is now stale: close it.
  M.close_session_list()
end

--- Buffer/window ids for the runner's renderer.
function M.ids()
  local chatBuf = M._activeId and M._chats[M._activeId] or nil
  return {
    chatBuf = chatBuf,
    chatWin = chat_win,
    inputBuf = input_buf,
    inputWin = input_win,
    reasoningWin = M._reasoningWin,
    reasoningOpen = M._reasoningOpen,
  }
end

--- Ask the runner to shut down (dispose agents + exit dsh).
function M.quit()
  if M._channel then
    vim.rpcnotify(M._channel, 'dsh-quit')
  else
    vim.cmd('qa!')
  end
end

--- Apply theme overrides: map of highlight group -> attributes.
--- Each entry: { fg=, bg=, bold=, italic=, underline= } or { link = 'Group' }.
function M.apply_theme(theme)
  if type(theme) ~= 'table' then
    return
  end
  for group, attrs in pairs(theme) do
    if type(group) == 'string' and type(attrs) == 'table' then
      if type(attrs.link) == 'string' then
        pcall(vim.api.nvim_set_hl, 0, group, { link = attrs.link })
      else
        local spec = {}
        if type(attrs.fg) == 'string' then spec.fg = attrs.fg end
        if type(attrs.bg) == 'string' then spec.bg = attrs.bg end
        if type(attrs.bold) == 'boolean' then spec.bold = attrs.bold end
        if type(attrs.italic) == 'boolean' then spec.italic = attrs.italic end
        if type(attrs.underline) == 'boolean' then spec.underline = attrs.underline end
        if next(spec) ~= nil then
          pcall(vim.api.nvim_set_hl, 0, group, spec)
        end
      end
    end
  end
end

--- Accessor for tests.
function M.channel()
  return M._channel
end

-- ===========================================================================
-- Floating interaction windows (approval / questions / picker)
-- ===========================================================================

M._float = { win = nil, buf = nil, kind = nil, state = nil }

local function close_float()
  if M._float.win and vim.api.nvim_win_is_valid(M._float.win) then
    pcall(vim.api.nvim_win_close, M._float.win, true)
  end
  M._float = { win = nil, buf = nil, kind = nil, state = nil }
  if input_win and vim.api.nvim_win_is_valid(input_win) then
    vim.api.nvim_set_current_win(input_win)
    vim.cmd('startinsert')
  end
end

-- Rows a line occupies in a float of `width` cells (CJK glyphs count 2
-- cells; an empty line still takes one row). Floats do not auto-grow, so the
-- window height must be computed from the WRAPPED layout — sizing by the raw
-- line count clipped the bottom rows (the key hints) whenever a tool reason
-- or option description wrapped.
local function line_rows(line, width)
  return math.max(1, math.ceil(vim.fn.strdisplaywidth(line) / width))
end

-- Total visual height of `lines` wrapped at `width`, clamped to a sane
-- window size and to the editor, so the float always fits on screen.
local function float_height(lines, width)
  local h = 0
  for _, l in ipairs(lines) do
    h = h + line_rows(l, width)
  end
  local cap = math.min(24, math.max(3, vim.o.lines - 2))
  return math.max(3, math.min(cap, h))
end

local function open_float(lines, opts)
  close_float()
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  local width = math.max(40, math.min(100, opts.width or 64))
  local height = float_height(lines, width)
  local win = vim.api.nvim_open_win(buf, true, {
    relative = 'editor',
    row = math.max(0, math.floor((vim.o.lines - height) / 2) - 2),
    col = math.max(0, math.floor((vim.o.columns - width) / 2)),
    width = width,
    height = height,
    border = 'rounded',
    style = 'minimal',
  })
  vim.wo[win].cursorline = true
  vim.wo[win].number = false
  vim.wo[win].signcolumn = 'no'
  vim.cmd('stopinsert') -- interactive float: normal-mode keys must work
  M._float.win = win
  M._float.buf = buf
  return buf, win
end

local function float_key(buf, key, cmd)
  vim.api.nvim_buf_set_keymap(buf, 'n', key, '<Cmd>lua ' .. cmd .. '<CR>', { noremap = true })
end

--- Approval request (from approval/request). entry: {toolName, reason}.
function M.show_approval(entry)
  local lines = {
    '⚠ 审批请求',
    '',
    '工具: ' .. tostring(entry.toolName or '?'),
    '说明: ' .. tostring(entry.reason or '无'),
    '',
    '[y] 允许一次    [n] 拒绝    [Esc] 拒绝',
  }
  local buf = open_float(lines, { width = 72 })
  M._float.kind = 'approval'
  float_key(buf, 'y', 'require("dsh_tui").approval_decide("y")')
  float_key(buf, 'n', 'require("dsh_tui").approval_decide("n")')
  float_key(buf, '<Esc>', 'require("dsh_tui").approval_decide("n")')
  -- If the reason wrapped so much that the window is height-capped, anchor
  -- the view at the bottom: the key hints must ALWAYS be on screen (the
  -- full request is also echoed into the chat feed).
  local last = vim.api.nvim_buf_line_count(buf)
  if vim.api.nvim_win_get_height(M._float.win) < last then
    vim.api.nvim_win_set_cursor(M._float.win, { last, 0 })
  end
end

function M.approval_decide(value)
  if M._float.kind ~= 'approval' then
    return
  end
  close_float()
  if M._channel then
    vim.rpcnotify(M._channel, 'dsh-approval-decided', value)
  end
end

--- User questions. questions: { {id, question, detail, header, options: {{label, description}}, multiSelect} }.
function M.show_questions(questions)
  local qs = {}
  for _, q in ipairs(questions or {}) do
    local opts = {}
    for _, o in ipairs(q.options or {}) do
      table.insert(opts, { label = tostring(o.label), description = o.description })
    end
    table.insert(qs, {
      id = tostring(q.id),
      question = tostring(q.question),
      detail = q.detail,
      header = q.header,
      options = opts,
      multiSelect = q.multiSelect == true,
    })
  end
  open_float({ '…' }, { width = 80 })
  M._float.kind = 'questions'
  M._float.state = { questions = qs, qIdx = 1, optIdx = 1, selected = {}, optRows = {} }
  M.redraw_questions()
  local function install()
    local buf = M._float.buf
    if not buf then
      return
    end
    float_key(buf, 'j', 'require("dsh_tui").question_move(1)')
    float_key(buf, 'k', 'require("dsh_tui").question_move(-1)')
    float_key(buf, '<Space>', 'require("dsh_tui").question_toggle()')
    float_key(buf, '<CR>', 'require("dsh_tui").question_advance()')
    float_key(buf, '<Esc>', 'require("dsh_tui").questions_cancel()')
  end
  install()
end

function M.redraw_questions()
  local st = M._float.state
  if not st or M._float.kind ~= 'questions' then
    return
  end
  local q = st.questions[st.qIdx]
  if not q then
    M.questions_confirm()
    return
  end
  local lines = {}
  if q.header then
    table.insert(lines, q.header)
  end
  table.insert(lines, 'Q' .. st.qIdx .. '/' .. #st.questions .. ': ' .. q.question)
  if q.detail then
    table.insert(lines, q.detail)
  end
  table.insert(lines, '')
  local optRows = {}
  for i, o in ipairs(q.options) do
    local mark = st.selected[q.id] and st.selected[q.id][o.label] and '●' or '○'
    table.insert(lines, (i == st.optIdx and '▸ ' or '  ') .. mark .. ' ' .. o.label)
    table.insert(optRows, #lines)
    if o.description then
      table.insert(lines, '    ' .. tostring(o.description))
    end
  end
  if #q.options == 0 then
    table.insert(lines, '（无选项，回车继续）')
  end
  table.insert(lines, '')
  table.insert(lines, q.multiSelect and '[Space] 选择  [j/k] 移动  [Enter] ' ..
    (st.qIdx == #st.questions and '确认' or '下一题') .. '  [Esc] 取消'
    or '[j/k] 选择  [Enter] ' .. (st.qIdx == #st.questions and '确认' or '下一题') .. '  [Esc] 取消')
  vim.api.nvim_buf_set_lines(M._float.buf, 0, -1, false, lines)
  -- The float was created with a one-line placeholder: grow/shrink it to the
  -- question's real wrapped height, or the options and the key-hint footer
  -- stay clipped below the window (no visible hints).
  local fwin = M._float.win
  if fwin and vim.api.nvim_win_is_valid(fwin) then
    local cfg = vim.api.nvim_win_get_config(fwin)
    local height = float_height(lines, cfg.width)
    if cfg.height ~= height then
      vim.api.nvim_win_set_config(fwin, {
        relative = cfg.relative,
        row = math.max(0, math.floor((vim.o.lines - height) / 2) - 2),
        col = cfg.col,
        width = cfg.width,
        height = height,
      })
    end
  end
  st.optRows = optRows
  if #optRows > 0 then
    vim.api.nvim_win_set_cursor(M._float.win, { optRows[st.optIdx], 0 })
  end
end

function M.question_move(dir)
  local st = M._float.state
  local q = st.questions[st.qIdx]
  if #q.options == 0 then
    return
  end
  st.optIdx = math.max(1, math.min(#q.options, st.optIdx + dir))
  M.redraw_questions()
end

function M.question_toggle()
  local st = M._float.state
  local q = st.questions[st.qIdx]
  if not q.multiSelect or #q.options == 0 then
    return
  end
  local o = q.options[st.optIdx]
  st.selected[q.id] = st.selected[q.id] or {}
  if st.selected[q.id][o.label] then
    st.selected[q.id][o.label] = nil
  else
    st.selected[q.id][o.label] = true
  end
  M.redraw_questions()
end

function M.question_advance()
  local st = M._float.state
  local q = st.questions[st.qIdx]
  if not q.multiSelect and #q.options > 0 then
    local o = q.options[st.optIdx]
    st.selected[q.id] = { [o.label] = true }
  end
  if st.qIdx < #st.questions then
    st.qIdx = st.qIdx + 1
    st.optIdx = 1
    M.redraw_questions()
  else
    M.questions_confirm()
  end
end

function M.questions_confirm()
  local st = M._float.state
  local answers = {}
  for _, q in ipairs(st.questions) do
    local selected = {}
    for _, o in ipairs(q.options) do
      if st.selected[q.id] and st.selected[q.id][o.label] then
        table.insert(selected, o.label)
      end
    end
    if #selected == 0 and #q.options > 0 and not q.multiSelect then
      table.insert(selected, q.options[1].label)
    end
    table.insert(answers, { id = q.id, selected = selected })
  end
  close_float()
  if M._channel then
    vim.rpcnotify(M._channel, 'dsh-questions-answered', answers)
  end
end

function M.questions_cancel()
  close_float()
  if M._channel then
    vim.rpcnotify(M._channel, 'dsh-questions-cancelled')
  end
end

--- Generic picker. items: { {label, value, active} }.
function M.show_picker(title, items)
  local lines = { title, '' }
  local values = {}
  local activeRow = 3
  for i, it in ipairs(items or {}) do
    if type(it) == 'table' and type(it.label) == 'string' then
      table.insert(lines, (it.active and '▸ ' or '  ') .. it.label)
      table.insert(values, it.value)
      if it.active then
        activeRow = #lines
      end
    end
  end
  table.insert(lines, '')
  table.insert(lines, '[j/k] 移动  [Enter] 选择  [Esc] 取消')
  local buf = open_float(lines, { width = 72 })
  M._float.kind = 'picker'
  M._float.state = { values = values, idx = 1, firstRow = 3 }
  if activeRow >= 3 then
    M._float.state.idx = activeRow - 2
  end
  vim.api.nvim_win_set_cursor(M._float.win, { M._float.state.firstRow + M._float.state.idx - 1, 0 })
  float_key(buf, 'j', 'require("dsh_tui").picker_move(1)')
  float_key(buf, 'k', 'require("dsh_tui").picker_move(-1)')
  float_key(buf, '<CR>', 'require("dsh_tui").picker_confirm()')
  float_key(buf, '<Esc>', 'require("dsh_tui").picker_cancel()')
end

function M.picker_move(dir)
  local st = M._float.state
  st.idx = math.max(1, math.min(#st.values, st.idx + dir))
  vim.api.nvim_win_set_cursor(M._float.win, { st.firstRow + st.idx - 1, 0 })
end

function M.picker_confirm()
  local st = M._float.state
  local value = st.values[st.idx]
  close_float()
  if M._channel and value ~= nil then
    vim.rpcnotify(M._channel, 'dsh-picker-selected', value)
  end
end

function M.picker_cancel()
  close_float()
  if M._channel then
    vim.rpcnotify(M._channel, 'dsh-picker-cancelled')
  end
end

return M
